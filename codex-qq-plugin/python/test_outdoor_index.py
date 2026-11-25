import unittest
from outdoor_index import OutdoorHour, assess_period, outdoor_index


def sample(**changes):
    rows = [dict(time=f'2026-11-03T{hour:02}:00:00+08:00', cloud=0.0, pm25=0.0,
                 wind=1.0, gust=2.0, rain=0.0, code=0) for hour in range(6, 18)]
    for row in rows:
        row.update(changes)
    return {'date': '2026-11-03', 'hours': rows}


class OutdoorIndexTests(unittest.TestCase):
    def test_daily_220_requires_every_local_hour_strictly_above_and_lists_independent_warnings(self):
        template=sample(wind=4.0)['hours'][0]
        rows=[dict(template,time=f'2026-11-03T{h:02}:00:00+08:00',pm25=221.0) for h in range(24)]
        def score(hours,red=()):
            return outdoor_index.invoke({'date':'2026-11-03','hours':hours,'red_hazards':list(red)})
        dirty=score(rows)
        self.assertEqual(dirty['score'],0)
        self.assertEqual(dirty['dailyDanger']['reasons'],['全天PM2.5高于220 μg/m³'])
        for weaker in [rows[1:], [dict(rows[0],pm25=220.0),*rows[1:]], [dict(rows[0],pm25=None),*rows[1:]],
                       [dict(rows[0],time=rows[0]['time'].replace('11-03','11-04')),*rows[1:]]]:
            self.assertNotIn('dailyDanger',score(weaker))
        combined=score(rows,['重污染天气','空气重污染','大风','暴雨','冰雹'])
        self.assertCountEqual(combined['dailyDanger']['reasons'],['重污染天气红色预警','大风红色预警','暴雨红色预警','冰雹红色预警'])
        self.assertEqual(len(score(rows,['大风'])['dailyDanger']['reasons']),2)
        unknown_weather=score([],['道路结冰'])
        self.assertEqual(unknown_weather['recommendation']['suffix'],'应当避免外出')
        self.assertTrue(all(p['score']==0 and p['character']=='拉' for p in unknown_weather['periods']))

    def invoke(self, **changes):
        return outdoor_index.invoke(sample(**changes))

    def test_gold_and_cloud_only_floor(self):
        self.assertEqual(self.invoke()['grade'], 'gold')
        full_cloud = self.invoke(cloud=100.0)
        self.assertEqual(full_cloud['score'], 85)
        self.assertEqual(full_cloud['grade'], 'excellent')
        self.assertEqual(self.invoke(cloud=20.0)['score'], 94)

    def test_pm_boundaries(self):
        self.assertEqual(self.invoke(pm25=60.0)['score'], 95)
        self.assertEqual(self.invoke(pm25=100.0)['score'], 75)
        self.assertEqual(self.invoke(pm25=150.0)['score'], 35)

    def test_missing_pm_uses_hourly_sustained_wind_for_scoring(self):
        for wind, grade in [(3.39, 'unknown'), (3.4, 'excellent'), (10.8, 'fair'), (17.2, 'poor')]:
            with self.subTest(wind=wind):
                period = self.invoke(pm25=None, wind=wind, gust=12.0)['periods'][0]
                self.assertEqual(period['grade'], grade)
                if grade != 'unknown':
                    self.assertIsNone(period['conditions']['pm25Peak'])
        packet = sample(wind=3.4, pm25=None)
        packet['hours'][1].update(wind=3.3, pm25=100.0)
        packet['hours'][7].update(wind=3.3)
        morning, afternoon = outdoor_index.invoke(packet)['periods']
        self.assertAlmostEqual(morning['score'], 95.55555556)
        self.assertEqual(morning['conditions']['pm25Peak'], 100)
        self.assertEqual(afternoon['status'], 'unknown')

    def test_observed_clean_morning_and_forecast_rebound(self):
        data = sample(pm25=130.0)
        for row in data['hours'][:4]:
            row['observed'] = 18.0
        morning, afternoon = outdoor_index.invoke(data)['periods']
        self.assertGreaterEqual(morning['score'], 95)
        self.assertGreater(morning['score'], afternoon['score'])
        self.assertIn('09:00实测 18', morning['reason'])
        data['red_hazards'] = ['大风']
        self.assertEqual(outdoor_index.invoke(data)['score'], 0)
        for row in data['hours']:
            row.update(pm25=18.0, observed=None)
        data.pop('red_hazards')
        data['hours'][0]['observed'] = 18.0
        self.assertEqual(outdoor_index.invoke(data)['grade'], 'gold')

    def test_observation_correction_expires_at_eighteen_hours(self):
        base = sample(pm25=120.0)['hours'][0]
        def hour(h, obs=None):
            return OutdoorHour(**{**base,'time':f'2026-11-03T{h:02}:00:00+08:00','observed':obs})
        anchor = hour(0, 30.0)
        # A 90-unit bias decays by 5 per hour. Corrected values are 80, 115, 120.
        for h, expected in [(10, 15), (17, 37), (18, 41), (19, 41)]:
            row = assess_period('测试', h, h+1, [hour(h)], anchor)
            self.assertAlmostEqual(row['deductions']['pm25'],expected)

    def test_wind_thresholds_and_gusts(self):
        for wind, gust, score in [(10.7,13.8,100),(10.8,13.8,78),(1,13.9,78),
                                  (17.1,20.7,78),(17.2,2,30),(1,20.8,30),(24.5,2,0),(1,28.5,0)]:
            with self.subTest(wind=wind,gust=gust):
                self.assertEqual(self.invoke(wind=float(wind),gust=float(gust))['score'],score)

    def test_clean_air_blue_is_fair_and_a_yellow_gust_penalizes_only_its_period(self):
        data = sample(pm25=24.0, cloud=20.0, wind=11.0, gust=14.0)
        data['hours'][-1]['gust'] = 20.8
        result = outdoor_index.invoke(data)
        morning, afternoon = result['periods']
        self.assertEqual((morning['score'], morning['character'], morning['deductions']['wind']), (70, '可', 22))
        self.assertIn('扣22分', morning['reason'])
        self.assertEqual((afternoon['score'], afternoon['character'], afternoon['deductions']['wind']), (22, '拉', 70))
        self.assertIn('扣70分', afternoon['reason'])
        self.assertEqual(result['recommendation'], {'word': '上午', 'suffix': '户外条件尚可'})
        self.assertEqual(self.invoke(pm25=100.0, wind=11.0)['grade'], 'poor')

    def test_three_rain_deductions_and_hard_zero(self):
        brief = sample()
        for index in (0, 6):
            brief['hours'][index].update(rain=0.2, code=51)
        self.assertEqual(outdoor_index.invoke(brief)['score'], 80)
        self.assertEqual(self.invoke(rain=0.1,code=51)['score'],65)
        self.assertEqual(self.invoke(rain=0.4,code=61)['score'],50)
        self.assertEqual(self.invoke(rain=1.0,code=61)['score'],0)
        self.assertEqual(self.invoke(code=63)['score'],0)
        self.assertEqual(self.invoke(code=67)['score'],0)
        pulse = sample()
        for index in (0,6): pulse['hours'][index]['rain']=2.6
        self.assertEqual(outdoor_index.invoke(pulse)['score'],0)

    def test_best_half_day_and_all_day_wording(self):
        data = sample()
        for row in data['hours'][:6]: row['pm25']=150.0
        result = outdoor_index.invoke(data)
        self.assertEqual(result['bestPeriod'],'下午')
        self.assertEqual(result['recommendation'],{'word':'下午','suffix':'宜户外活动'})
        self.assertEqual(self.invoke()['recommendation']['word'],'全天')
        self.assertEqual(self.invoke(rain=0.1,code=51)['recommendation']['suffix'],'户外条件尚可')
        self.assertEqual(self.invoke(pm25=150.0)['recommendation'],{'word':'全天','suffix':'不宜户外活动'})

    def test_missing_or_unrated_weather_is_not_zero_or_good(self):
        for changes in [dict(pm25=None),dict(code=95),dict(code=71)]:
            self.assertEqual(self.invoke(**changes)['status'],'unknown')
        data=sample(); data['hours'].pop()
        self.assertEqual(outdoor_index.invoke(data)['status'],'unknown')

    def test_first_day_isolated_and_invalid_packet_rejected(self):
        data=sample()
        data['hours'] += [dict(row,time=row['time'].replace('11-03','11-04'),pm25=150.0) for row in data['hours']]
        self.assertEqual(outdoor_index.invoke(data)['score'],100)
        for mutate in [lambda d:d['hours'].append(d['hours'][0]),
                       lambda d:d['hours'][0].update(time='2026-11-03T06:00:00Z'),
                       lambda d:d['hours'][0].update(pm25=float('nan')),
                       lambda d:d['hours'][0].update(temperature=20),
                       lambda d:d.update(command='not allowed')]:
            bad=sample(); mutate(bad)
            with self.assertRaises(Exception): outdoor_index.invoke(bad)


if __name__ == '__main__':
    unittest.main()
