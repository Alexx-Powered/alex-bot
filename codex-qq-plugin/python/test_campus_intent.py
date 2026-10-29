import tempfile
import unittest
from pathlib import Path
from PIL import Image
from campus_intent import classroom_report_intent,resolve_intent,recognized_classroom_request,recovery_date
from campus_report import render_region_day,day_rows
from test_campus_regions import data


class IntentTests(unittest.TestCase):
    def test_recovery_dates_use_beijing_clock_and_refuse_ambiguous_dates(self):
        now='2026-10-29T17:00:00+00:00'
        for text,expected in [('今天空教室','2026-10-30'),('明天空教室','2026-10-31'),('后天的课表','2026-11-01'),('2026-11-02空教室','2026-11-02'),('下周的空教室',None),('明天后天教室',None),('11月1号空教室',None)]:
            self.assertEqual(recovery_date(text,now),expected)
    def test_recovery_recognizes_only_classroom_requests(self):
        for text in ['今天主M和新主楼A座空教室情况','今天三号楼情况','现在推荐个教室自习']:
            self.assertTrue(recognized_classroom_request.invoke({'text':text}))
        for text in ['让Tibo升级服务器','大肥鱼吃白饭了吗','教室英文怎么说','空教室英文怎么说','主楼着火了']:
            self.assertFalse(recognized_classroom_request.invoke({'text':text}))
    def test_day_overviews_do_not_require_literal_full_day_word(self):
        for text in ['今天三号楼的空教室情况','看看今天三号楼哪些教室空闲','查询今日教室课表','明天主M和新主楼A座的情况','现在查一下今天三号楼的情况','2026-10-29三号楼空教室一览','今天三号楼空教室情况，顺便推荐一下']:
            for origin in ['query','recommend']:
                result=classroom_report_intent.invoke(dict(text=text,requested='compact',origin=origin))
                self.assertEqual(result['view'],'full',text)

    def test_current_or_session_recommendations_keep_compact_view(self):
        for text,session in [('我现在去哪个教室自习','now'),('现在有什么空教室能去','now'),('给我推荐个能自习的教室','now'),('今天推荐个能自习的教室','now'),('目前空教室情况','now'),('今天晚上主M推荐几个','evening'),('下午有哪些可用教室','afternoon')]:
            result=resolve_intent(text,'full','query')
            self.assertEqual(result,dict(view='compact',session=session))

    def test_explicit_full_day_beats_incidental_now_and_defaults_follow_tool_intent(self):
        self.assertEqual(resolve_intent('现在抓取今天全天报告')['view'],'full')
        self.assertEqual(resolve_intent(origin='query')['view'],'full')
        self.assertEqual(resolve_intent(origin='recommend')['view'],'compact')

    def test_region_full_day_preserves_all_fourteen_periods_and_all_rooms(self):
        source=data();regions=['主楼','主M','新主楼A座']
        rows=day_rows(source,regions)
        self.assertEqual({row['region'] for row in rows},set(regions))
        self.assertTrue(all(row['free_periods']==list(range(1,15)) for row in rows))
        self.assertFalse(any(row['room']=='204' for row in day_rows(source,['三号楼'])))
        with tempfile.TemporaryDirectory() as directory:
            artifact=render_region_day(source,directory,regions,demo=True)
            with Image.open(Path(directory)/'campus-output'/(artifact+'.png')) as image:
                self.assertEqual(image.width,1800);self.assertLessEqual(image.height,16000)


if __name__=='__main__':unittest.main()
