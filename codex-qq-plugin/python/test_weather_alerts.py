import unittest
from datetime import datetime
from unittest.mock import patch
from weather_alerts import TZ, areas, parse_command, parse_feed, relation, resolve, weather_alerts

NOW = datetime(2026, 11, 8, 1, 0, tzinfo=TZ)


def warning(code='110108', color='蓝色', stamp='20261108003000', body='预计未来6小时有大风，请注意防范。'):
    return {'id': code + '41600000_' + stamp, 'headline': '海淀区气象台发布大风' + color + '预警',
            'description': body, 'title': '北京市海淀区发布大风' + color + '预警',
            'effective': '2026/11/08 02:00', 'type': 'p000700' + {'蓝色': '4', '黄色': '3', '橙色': '2', '红色': '1'}[color]}


class Warnings(unittest.TestCase):
    def parse(self, rows, codes=None, previous=None):
        return parse_feed({'code': 0, 'data': rows}, codes or ['110108'], previous, NOW)

    def test_commands_without_model_and_spaces(self):
        for text in ['/开启实时预警 北京海淀', '/开启 实时预警 北京市海淀区', '开启实时预警 海淀']:
            result = weather_alerts.invoke({'action': 'command', 'query': text})
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['area']['code'], '110108')
        self.assertEqual(parse_command('/关闭实时预警 北京海淀')['operation'], 'disable')
        self.assertEqual(parse_command('/实时预警')['operation'], 'list')

    def test_ambiguous_or_unknown_does_not_subscribe(self):
        self.assertFalse(resolve('朝阳')['ok'])
        self.assertFalse(resolve('不存在县')['ok'])
        self.assertFalse(resolve('https://localhost')['ok'])
        self.assertFalse(parse_command('/开启实时预警')['ok'])

    def test_scope_and_province_matching(self):
        values=self.parse([warning(), warning('110105'), warning('110000')])['alerts']
        self.assertEqual({r['code'] for r in values}, {'110108', '110000'})
        local=next(r for r in values if r['code']=='110108')
        self.assertEqual(len(local['provinceContext']),1)
        self.assertEqual(next(r for r in values if r['code']=='110000')['matches'][0]['relation'],'省级')

    def test_city_children_but_province_own_issuers_only(self):
        city=areas()['440100'];province=areas()['440000']
        self.assertEqual(relation(city,'440106'),'辖区')
        self.assertEqual(relation(city,'440000'),'省级')
        self.assertIsNone(relation(city,'440300'))
        self.assertIsNone(relation(province,'440106'))

    def test_published_and_effective_times_distinct(self):
        a=self.parse([warning()])['alerts'][0]
        self.assertEqual(a['publishedAt'],'2026-11-08T00:30:00+08:00')
        self.assertEqual(a['effective'],'2026/11/08 02:00')

    def test_bulletin_issue_time_wins_over_ingestion_id(self):
        row=warning(stamp='20261108005437',body='余干县气象台2026年11月08日00时52分继续发布暴雨蓝色预警信号：预计未来12小时有暴雨。')
        self.assertEqual(self.parse([row])['alerts'][0]['publishedAt'],'2026-11-08T00:52:00+08:00')

    def test_upgrade_downgrade_and_unchanged(self):
        blue=self.parse([warning()])['alerts'][0]
        same=self.parse([warning()],previous=[blue])['alerts'][0]
        self.assertEqual(same['change'],'未变')
        orange=self.parse([warning(color='橙色',stamp='20261108004500')],previous=[blue])['alerts'][0]
        self.assertEqual(orange['change'],'升级');self.assertEqual(orange['previousColor'],'蓝色')
        lower=self.parse([warning(color='黄色',stamp='20261108005000')],previous=[orange])['alerts'][0]
        self.assertEqual(lower['change'],'降级')

    def test_same_id_changed_content_is_update(self):
        old=self.parse([warning()])['alerts'][0]
        new=self.parse([warning(body='新增受影响乡镇，请注意防范。')],previous=[old])['alerts'][0]
        self.assertEqual(new['change'],'更新');self.assertNotEqual(old['fingerprint'],new['fingerprint'])

    def test_latest_per_issuer_and_hazard(self):
        result=self.parse([warning(),warning(color='红色',stamp='20261108005000')])
        self.assertEqual(len(result['alerts']),1);self.assertEqual(result['alerts'][0]['color'],'红色')

    def test_absence_never_means_cancelled(self):
        old=self.parse([warning()])['alerts'][0]
        self.assertEqual(self.parse([],previous=[old])['alerts'],[])
        row=warning();row['headline']='海淀区气象台解除大风蓝色预警'
        self.assertEqual(self.parse([row])['alerts'][0]['change'],'解除')

    def test_malformed_feed_cannot_be_no_warning(self):
        for payload in [{'data':[]}, {'code':0,'data':{}}, {'code':0,'data':[{'id':'x'}]}]:
            with self.assertRaises(ValueError):parse_feed(payload,['110108'],now=NOW)

    def test_old_or_future_issue_time_excluded(self):
        self.assertEqual(self.parse([warning(stamp='20261101000000'),warning(stamp='20261109000000')])['alerts'],[])

    def test_tool_failure_does_not_claim_success(self):
        with patch('weather_alerts.fetch_feed',side_effect=TimeoutError()), patch('beijing_air_alerts.fetch_beijing',side_effect=TimeoutError()):
            self.assertEqual(weather_alerts.invoke({'action':'poll','codes':['110108']})['code'],'ALERT_SOURCE_UNAVAILABLE')
        self.assertFalse(weather_alerts.invoke({'action':'poll','codes':['999999']})['ok'])

    def test_alphanumeric_station_does_not_break_other_regions(self):
        row=warning('520500');row['id']='520500Y0100000_20261108003000'
        self.assertEqual(len(self.parse([row,warning()])['alerts']),1)
        self.assertEqual(self.parse([row],['520500'])['alerts'][0]['code'],'520500')
        row['id']='520500/0100000_20261108003000'
        with self.assertRaises(ValueError):self.parse([row])

    def test_independent_source_failure(self):
        with patch('weather_alerts.fetch_feed',return_value={'code':0,'data':[]}), patch('beijing_air_alerts.fetch_beijing',side_effect=TimeoutError()):
            result=weather_alerts.invoke({'action':'poll','codes':['110108']})
            self.assertTrue(result['ok']);self.assertEqual(result['sourceFailures'],['beijing_air'])
        with patch('weather_alerts.fetch_feed',side_effect=TimeoutError()), patch('beijing_air_alerts.fetch_beijing',return_value=[]):
            result=weather_alerts.invoke({'action':'poll','codes':['110108']})
            self.assertTrue(result['ok']);self.assertEqual(result['sourceFailures'],['cma'])

    def test_non_beijing_does_not_fetch_beijing(self):
        with patch('weather_alerts.fetch_feed',return_value={'code':0,'data':[]}), patch('beijing_air_alerts.fetch_beijing') as bj, patch('regional_air_alerts.fetch_tianjin',return_value=[]):
            self.assertTrue(weather_alerts.invoke({'action':'poll','codes':['120000']})['ok']);bj.assert_not_called()

    def test_extended_hazards_are_not_filtered(self):
        hazards=['台风','暴雨','暴雪','寒潮','大风','沙尘暴','高温','干旱','雷电','冰雹','霜冻','大雾','霾','道路结冰','强对流','雷暴大风','雷雨大风','海区大风','海雾','低温','寒冷','灰霾','森林火险','草原火险','地质灾害气象风险','山洪灾害气象风险','中小河流洪水气象风险','渍涝风险']
        for hazard in hazards:
            with self.subTest(hazard=hazard):
                row=warning();row['headline']=f'海淀区气象台发布{hazard}黄色预警';row['title']=row['headline']
                self.assertEqual(self.parse([row])['alerts'][0]['hazard'],hazard)
        row=warning();row['headline']='广州市气象台发布台风白色预警';row['title']=row['headline']
        a=self.parse([row])['alerts'][0];self.assertEqual(a['color'],'白色');self.assertEqual(a['hazard'],'台风')


if __name__ == '__main__':
    unittest.main()
