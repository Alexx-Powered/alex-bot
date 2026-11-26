import unittest
from campus_regions import room_region,resolve_regions,REGIONS
from campus_recommendations import recommend
from test_campus_recommendations import snapshot


def data():
    result=snapshot();result['buildings']=['三号楼','主楼','新主楼']
    for building,room in [('主楼','主201'),('主楼','主M201'),('主楼','主北201'),('主楼','主南201')]+[('新主楼',letter+'101') for letter in 'ABCEFG']:
        result['rooms'].append(dict(building=building,room=room,free_periods=list(range(1,15)),busy_periods=[]))
    return result


class RegionTests(unittest.TestCase):
    def test_source_room_prefixes_split_main_building_and_new_seats(self):
        for room,region in [('主201','主楼'),('主M201','主M'),('主北201','主北'),('主南201','主南')]:
            self.assertEqual(room_region('主楼',room),region)
        for letter in 'ABCDEFG':self.assertEqual(room_region('新主楼',letter+'101'),'新主楼'+letter+'座')
        self.assertIsNone(room_region('新主楼','未识别教室'))

    def test_alias_and_each_region_is_independent(self):
        for text,region in [('老主楼现在哪空闲','主楼'),('主楼推荐','主楼'),('主118附近','主楼'),('主m推荐','主M'),('主中推荐','主M'),('主北推荐','主北'),('主南推荐','主南')]:
            report=recommend(data(),{},'2026-10-29T16:36:00+08:00',text)
            self.assertEqual(report['regions'],[region]);self.assertEqual({r['region'] for r in report['candidates']},{region})

    def test_main_and_new_region_combinations(self):
        report=recommend(data(),dict(limit=12),'2026-10-29T16:36:00+08:00','查主楼、主M、主北、主南和新主楼AC座')
        wanted={'主楼','主M','主北','主南','新主楼A座','新主楼C座'}
        self.assertEqual(set(report['regions']),wanted)
        self.assertEqual({r['region'] for r in report['candidates']},wanted)
        self.assertEqual(report['building'],'组合区域')

    def test_repeated_seats_compact_letters_and_ranges(self):
        for text,letters in [('新主楼A座和C座','AC'),('新主楼ABCDEFG座','ABCDEFG'),('新主楼A到C座','ABC'),('新主楼A座到C座','ABC'),('新主楼a、g座','AG')]:
            selected,_=resolve_regions(data(),text=text)
            self.assertEqual(set(selected),{'新主楼'+letter+'座' for letter in letters})

    def test_generic_new_and_all_campus_expand_regions(self):
        self.assertEqual(resolve_regions(data(),text='新主楼推荐')[0],REGIONS[5:])
        self.assertEqual(resolve_regions(data(),text='学院路全部教学楼')[0],REGIONS)

    def test_default_ignores_historical_model_selection(self):
        selected,_=resolve_regions(data(),regions=['主M','新主楼A座'],text='现在推荐去哪间教室')
        self.assertEqual(selected,['三号楼'])

    def test_missing_region_is_reported_when_other_requested_regions_have_data(self):
        report=recommend(data(),{},'2026-10-29T16:36:00+08:00','主北和新主楼D座')
        self.assertTrue(report['ok']);self.assertEqual(report['missing_regions'],['新主楼D座'])
        self.assertEqual({r['region'] for r in report['candidates']},{'主北'})
        self.assertIn('暂无教室数据',report['message'])
        empty=recommend(data(),dict(regions=['新主楼D座']),'2026-10-29T16:36:00+08:00')
        self.assertFalse(empty['ok']);self.assertEqual(empty['missing_regions'],['新主楼D座'])

    def test_direct_tool_regions_and_unknown_seat(self):
        report=recommend(data(),dict(regions=['主M','新主楼G座']),'2026-10-29T16:36:00+08:00')
        self.assertEqual(set(report['regions']),{'主M','新主楼G座'})
        unknown=recommend(data(),{},'2026-10-29T16:36:00+08:00','新主楼H座')
        self.assertEqual(unknown['code'],'CAMPUS_BUILDING_NOT_FOUND')


if __name__=='__main__':unittest.main()
