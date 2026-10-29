import tempfile
import unittest
from pathlib import Path
from PIL import Image
from unittest.mock import patch
from types import SimpleNamespace
from campus_recommendations import recommend,verified_explanation
from campus_compact import render_compact
from test_campus_recommendations import snapshot


def multi():
    data=snapshot();data['buildings']=['三号楼','主楼','新主楼']
    for building,room in [('主楼','201'),('主楼','204'),('新主楼','A101')]:
        data['rooms'].append(dict(building=building,room=room,free_periods=list(range(1,15)),busy_periods=[]))
    return data


class CompactTests(unittest.TestCase):
    def test_fresh_query_respects_explicit_region_even_when_model_omits_it(self):
        from campus_worker import process
        with tempfile.TemporaryDirectory() as directory,patch('campus_worker.Path.cwd',return_value=Path(directory)),patch('campus_worker.build_query_tool',return_value=SimpleNamespace(invoke=lambda _:multi())),patch('campus_compact.render_compact',wraps=render_compact) as render:
            result=process(dict(type='campus',mode='report',args={},request_text='查新主楼空教室'))
            self.assertIsNotNone(result['artifact_id']);self.assertEqual(render.call_args.args[0]['building'],'新主楼')
    def test_default_does_not_inherit_region_from_model_or_history(self):
        result=recommend(multi(),dict(building='主楼'),'2026-10-29T16:36:00+08:00','现在去哪个教室')
        self.assertEqual(result['building'],'三号楼')
        self.assertTrue(all(r['building']=='三号楼' for r in result['candidates']))

    def test_explicit_buildings_and_longest_match(self):
        for question,building in [('主楼推荐去哪','主楼'),('新主楼晚上推荐几个','新主楼')]:
            result=recommend(multi(),dict(session='evening'),'2026-10-29T16:36:00+08:00',question)
            self.assertEqual(result['building'],building)
            self.assertTrue(all(r['building']==building and not r['small'] for r in result['candidates']))
        result=recommend(multi(),dict(building='主楼'),'2026-10-29T16:36:00+08:00')
        self.assertIn('204',[r['room'] for r in result['candidates']])

    def test_missing_building_and_unsupported_campus_never_fall_back(self):
        for building,text in [('五号楼','五号楼现在哪间空闲'),('三号楼','沙河现在去哪')]:
            result=recommend(multi(),dict(building=building),'2026-10-29T16:36:00+08:00',text)
            self.assertEqual(result['code'],'CAMPUS_BUILDING_NOT_FOUND');self.assertEqual(result['candidates'],[])

    def test_full_campus_preserves_building_identity(self):
        result=recommend(multi(),dict(limit=12),'2026-10-29T16:36:00+08:00','学院路全部教学楼推荐')
        self.assertEqual(result['building'],'全部')
        self.assertEqual(len({(r['building'],r['room']) for r in result['candidates']}),len(result['candidates']))

    def test_render_real_compact_png_with_advice_for_alpha_room(self):
        result=recommend(multi(),dict(building='新主楼',session='evening'),'2026-10-29T16:36:00+08:00')
        self.assertTrue(verified_explanation(result,'可以选A101，等开放后进入。'))
        with tempfile.TemporaryDirectory() as directory:
            artifact=render_compact(result,directory,'可以选A101，等开放后进入。')
            with Image.open(Path(directory)/'campus-output'/(artifact+'.png')) as image:
                self.assertEqual(image.width,1080);self.assertGreater(image.height,200);self.assertLess(image.height,3000)


if __name__=='__main__':unittest.main()
