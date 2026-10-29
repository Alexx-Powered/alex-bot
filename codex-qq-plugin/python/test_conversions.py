import unittest
from datetime import date

from pydantic import ValidationError
from conversions import ConversionArgs, convert_quantity, is_conversion_request, living_budget


class ConversionTests(unittest.TestCase):
    def test_marathon_and_half_marathon_are_fixed_distances(self):
        self.assertEqual(convert_quantity('1','marathon','马里'),'1 全马 ≈ 13.699675 马里')
        self.assertEqual(convert_quantity('1','half_marathon','km'),'1 半马 = 21.0975 km')

    def test_living_budget_dates_exact_funds_and_daily_cost(self):
        value=living_budget('0.6','HU$',date(2026,10,29))
        self.assertEqual((value['balance_cny'],value['next_payday'],value['required_cny']),('70','2026-11-10','600'))
        self.assertEqual(value['days_including_today_excluding_payday'],12)
        self.assertFalse(value['enough']);self.assertEqual(value['surplus_or_shortfall_cny'],'530')
        self.assertEqual(living_budget('600','CNY',date(2026,10,29))['enough'],True)

    def test_payday_and_year_rollover_are_explicit(self):
        self.assertEqual(living_budget('50','CNY',date(2026,10,9))['required_cny'],'50')
        self.assertEqual(living_budget('50','CNY',date(2026,10,10))['next_payday'],'2026-11-10')
        self.assertEqual(living_budget('50','CNY',date(2026,12,31))['next_payday'],'2027-01-10')
        self.assertIn('本月工资已发',living_budget('1','HU$',date(2026,10,10))['assumptions'])

    def test_exact_rates_and_both_directions(self):
        cases = [("0.6", "HU$", "CNY", "0.6 HU$ = 70 元"),
                 ("70", "CNY", "HU$", "70 元 = 0.6 HU$"),
                 ("1.2", "HU$", "CNY", "1.2 HU$ = 140 元"),
                 ("3", "HU$", "CNY", "3 HU$ = 350 元"),
                 ("1", "马里", "km", "1 马里 = 3.08 km"),
                 ("3.08", "km", "马里", "3.08 km = 1 马里"),
                 ("1", "马时", "h", "1 马时 = 1.5 小时"),
                 ("1.5", "h", "马时", "1.5 小时 = 1 马时"),
                 ("3080", "m", "马里", "3080 m = 1 马里"),
                 ("90", "min", "马时", "90 分钟 = 1 马时")]
        for amount, source, target, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(convert_quantity(amount, source, target), expected)

    def test_repeating_results_use_approximation_without_floating_point_drift(self):
        self.assertEqual(convert_quantity("1", "HU$", "CNY"), "1 HU$ ≈ 116.666667 元")
        self.assertEqual(convert_quantity("1", "km", "马里"), "1 km ≈ 0.324675 马里")
        self.assertEqual(convert_quantity("1", "h", "马时"), "1 小时 ≈ 0.666667 马时")
        self.assertEqual(convert_quantity("0.00000001", "CNY", "HU$"), "0.00000001 元 ≈ 0 HU$")

    def test_zero_identity_leading_zeros_and_upper_bound(self):
        self.assertEqual(convert_quantity("0", "HU$", "CNY"), "0 HU$ = 0 元")
        self.assertEqual(convert_quantity("000.6000", "HU$", "CNY"), "0.6 HU$ = 70 元")
        self.assertEqual(convert_quantity("1", "马时", "马时"), "1 马时 = 1 马时")
        self.assertLessEqual(len(convert_quantity("999999999999.99999999", "马里", "m")), 80)

    def test_rejects_cross_dimension_or_unknown_units(self):
        for source, target in [("HU$", "马里"), ("马时", "km"), ("km", "CNY"), ("USD", "HU$")]:
            with self.subTest(pair=(source, target)), self.assertRaises(ValueError):
                convert_quantity("1", source, target)

    def test_no_eval_nonfinite_extreme_or_numeric_coercion(self):
        for amount in ["-1", "+1", "NaN", "Infinity", "1e3", "1/3", "1+2", "1;print(1)", "1000000000000", "1.123456789", "", 1, 0.6, True, None]:
            with self.subTest(amount=amount), self.assertRaises(ValidationError):
                convert_quantity(amount, "HU$", "CNY")
        with self.assertRaises(ValidationError):
            ConversionArgs.model_validate({"amount": "1", "from_unit": "HU$", "to_unit": "CNY", "rate": "1"})

    def test_questions_cannot_be_confused_with_mali_country_or_casual_mentions(self):
        for text in ["0.6古月币能换多少元", "古月币汇率", "1马里相当于多少公里", "一马时多久", "convert 1 HU$ to CNY"]:
            self.assertTrue(is_conversion_request(text), text)
        for text in ["马里首都是什么", "发天气马里", "你喜欢古月币吗", "白饭很好吃"]:
            self.assertFalse(is_conversion_request(text), text)


if __name__ == "__main__":
    unittest.main()
