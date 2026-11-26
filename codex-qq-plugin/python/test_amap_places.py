import unittest
from unittest.mock import patch
from amap_places import candidates, search


class AmapPlacesTest(unittest.TestCase):
    def test_county_geocode_requires_matching_address_and_administrative_level(self):
        row = dict(formatted_address='山西省阳泉市盂县', level='区县', location='113.412279,38.086041')
        payload = dict(status='1', geocodes=[dict(row, level='道路'), dict(row, location=[]), row])
        with patch('amap_places.credential', return_value='test'), patch('amap_places.fetch', return_value=payload) as fetch:
            place, = search('盂县')
            fetch.assert_called_once_with('v3/geocode/geo', key='test', address='盂县', output='json')
            self.assertEqual(place['name'], row['formatted_address'])
            self.assertTrue(113.40 < place['longitude'] < 113.412279)
            self.assertEqual(search('山西省盂县镇'), [])

    def test_landform_and_settlement_keep_distinct_points(self):
        # Synthetic provider response, including a third, similarly named business.
        def row(name, kind, ident, xy):
            return dict(name=name,type=kind,id=ident,location=xy,cityname='样本市')
        payload=dict(status='1',pois=[
            row('样本岭村','地名地址信息;普通地名;村庄级地名','V1','114.84,39.72'),
            row('样本岭','购物服务;商店','S1','114.83,39.73'),
            row('样本岭','地名地址信息;自然地名;山','M1','114.85,39.74')])
        mountain,=candidates(payload,'样本岭')
        village,=candidates(payload,'样本岭村')
        self.assertEqual((mountain['id'],village['id']),('amap-M1','amap-V1'))
        self.assertGreater(mountain['latitude']-village['latitude'],0.019)
        self.assertTrue(114.84 < mountain['longitude'] < 114.85)
        self.assertEqual(candidates(payload,'另一省样本岭'),[])
        self.assertEqual(candidates(payload,'样本市样本岭'),[mountain])

    def test_auth_errors_are_not_empty_successes(self):
        with self.assertRaisesRegex(ValueError,'AMAP_UNAVAILABLE'):
            candidates({'status':'0','pois':[]},'样本岭')
