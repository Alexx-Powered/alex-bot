import unittest
from amap_places import candidates


class AmapPlacesTest(unittest.TestCase):
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
