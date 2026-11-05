import unittest
from weather_summary import weather_summary


class WeatherSummaryTests(unittest.TestCase):
    def test_all_artwork_families_and_severity_labels(self):
        for code, icon, label in [(0,"sunny","晴"),(2,"partly-cloudy","晴间多云"),(3,"overcast","阴"),
                                 (61,"light-rain","小雨"),(63,"light-rain","中雨"),(65,"heavy-rain","大雨"),
                                 (95,"thunderstorm","雷阵雨"),(97,"thunderstorm","强雷暴"),
                                 (71,"snow","小雪"),(75,"snow","大雪"),(45,"fog","雾"),(48,"fog","雾凇")]:
            with self.subTest(code=code):
                self.assertEqual(weather_summary.invoke({"date":"2026-11-04","code":code}),
                                 {"date":"2026-11-04","code":code,"icon":icon,"label":label})

    def test_missing_or_unsupported_code_never_becomes_sunny(self):
        for code in [None,-1,4,100]:
            result=weather_summary.invoke({"date":"2026-11-04","code":code})
            self.assertIsNone(result["icon"])
            self.assertIsNone(result["code"])

    def test_strict_public_data_only(self):
        for packet in [{"date":"2026-11-04","code":True},{"date":"2026-11-04","code":"0"},
                       {"date":"2026-02-30","code":0},{"date":"20261104","code":0},
                       {"date":"2026-11-04","code":0,"pm25":300},
                       {"date":"2026-11-04","code":0,"path":"/tmp/image"}]:
            with self.subTest(packet=packet),self.assertRaises(Exception):
                weather_summary.invoke(packet)


if __name__=="__main__":unittest.main()
