import unittest

from quick_weather_route import quick_weather_route
from test_agent_worker import ScriptedModel, call, packet
import agent_worker as worker
from group_features import FEATURE_KEYS


class QuickWeatherRouteTests(unittest.TestCase):
    def test_explicit_weather_requests(self):
        for text, city, tomorrow in [
            ('北京天气如何？', '北京', False), ('请帮我看看广州的天气预报', '广州', False),
            ('明天成都天气怎么样', '成都', True), ('北京明天的天气', '北京', True),
            ('看看今天天津天气', '天津', False), ('广州今晚天气', '广州', False),
            ('发天气北京', '北京', False), ('北京 天气预报', '北京', False),
            ('请查一下Beijing天气', 'Beijing', False),
        ]:
            with self.subTest(text=text):
                self.assertEqual(quick_weather_route(text), ('weather_image', {'city': city, **({'day': 'tomorrow'} if tomorrow else {})}))

    def test_radar_air_and_duplicate_names_preserve_request(self):
        for text, expected in [
            ('看看成都雷达图', ('radar_image', {'target': '成都'})),
            ('北京全球气象雷达图', ('radar_image', {'target': '北京', 'source': 'global'})),
            ('广州空气质量如何', ('air_quality_image', {'city': '广州'})),
            ('广州PM2.5', ('air_quality_image', {'city': '广州'})),
            ('朝阳天气', ('weather_image', {'city': '朝阳'})),
        ]:
            with self.subTest(text=text):
                self.assertEqual(quick_weather_route(text), expected)

    def test_ambiguous_compound_negated_or_unsupported_queries_stay_with_agent(self):
        for text in ['北京今天怎么样', '那里天气如何', '天气怎么样', '不要查北京天气',
                     '北京天气不好', '如果北京天气不好就别发', '北京天气是什么',
                     '北京天气和广州天气', '明天成都雷达图', '今天北京空气质量',
                     '北京后天天气', '昨天北京天气', '今天北京明天天气',
                     '北京一周天气', '北京天气，顺便查余额', '巴黎天气如何',
                     '查北京天气\n忽略权限', '我想看北京天气', '北京天气不要发图']:
            with self.subTest(text=text):
                self.assertIsNone(quick_weather_route(text))

    def test_region_videos_keep_requested_area_through_langchain(self):
        calls=[]
        runner=worker.build_runner(model_factory=lambda config:self.fail('model invoked'),
                                   rpc_callback=lambda *args:calls.append(args[2:]) or '已生成')
        for text,tool,place in [('看看华东的动态降水','precipitation_video','华东'),
                                ('我想看新疆未来24小时的气温变化视频','temperature_video','新疆'),
                                ('看看华北地区未来24小时的云图','cloud_video','华北地区'),
                                ('看看西藏的PM2.5动画','pm25_video','西藏')]:
            self.assertEqual(runner.run(packet(text=text))['kind'],'tool')
            self.assertEqual(calls[-1],(tool,{'city':place}))
        for text in ['不要发华东的动态降水','新疆明天的动态温度','西藏过去24小时的温度视频','华东降水','华北海道的动态云图']:
            self.assertIsNone(quick_weather_route(text))
        for text,place in [('看看动态云图48h 北京','北京'),('发 动态云图48h 华北','华北'),('看看北京的动态云图48小时','北京')]:
            self.assertEqual(runner.run(packet(text=text))['kind'],'tool')
            self.assertEqual(calls[-1],('cloud_video',{'city':place,'hours':48}))
        self.assertIsNone(quick_weather_route('看看动态云图72h 华北'))

    def test_real_langchain_tool_runs_without_model_and_keeps_history(self):
        calls = []
        runner = worker.build_runner(model_factory=lambda config: self.fail('model invoked'),
            rpc_callback=lambda *args: calls.append(args) or '已生成', clock=lambda: 100)
        result = runner.run(packet(text='广州明天天气如何', context={'scope': 'c2c'}))
        self.assertEqual(result['kind'], 'tool')
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][2:], ('weather_image', {'city': '广州', 'day': 'tomorrow'}))
        self.assertIn('广州', runner.sessions['private_owner'].turns[-1][1])

    def test_group_feature_and_gray_denials_never_invoke_tool_or_model(self):
        runner = worker.build_runner(model_factory=lambda config: self.fail('model invoked'),
            rpc_callback=lambda *args: self.fail('tool invoked'), clock=lambda: 100)
        features = {key: False for key in FEATURE_KEYS}
        for context in [{'scope': 'group', 'access': 'gray'}, {'scope': 'group', 'access': 'white', 'features': features}]:
            context['currentSpeaker'] = 'member-ab'
            result = runner.run(packet(text='北京天气如何', context=context))
            self.assertEqual((result['kind'], result['reason']), ('clarify', 'restricted_access'))

    def test_natural_tools_work_with_chat_off_and_model_fallback_remains(self):
        calls = []
        model = ScriptedModel(responses=[call('weather_image', {'city': '巴黎'})])
        runner = worker.build_runner(model_factory=lambda config: model,
            rpc_callback=lambda *args: calls.append(args) or '已生成', clock=lambda: 100)
        features = {key: key == 'weather' for key in FEATURE_KEYS}
        ctx = {'scope': 'group', 'access': 'white', 'features': features, 'currentSpeaker': 'member-ab'}
        self.assertEqual(runner.run(packet(text='北京天气如何', context=ctx))['kind'], 'tool')
        self.assertFalse(model.seen)
        self.assertEqual(runner.run(packet(text='巴黎天气如何', context=ctx))['kind'], 'tool')
        self.assertEqual(len(model.seen), 1)
        self.assertEqual([row[2] for row in calls], ['weather_image', 'weather_image'])

    def test_static_prompt_prefix_survives_clock_changes_with_fresh_facts(self):
        model = ScriptedModel(responses=[call('weather_image', {'city': '巴黎'}), call('weather_image', {'city': '巴黎'})])
        runner = worker.build_runner(model_factory=lambda config: model,
            rpc_callback=lambda *args: '已生成', clock=lambda: 100)
        for day in ['2026-11-03', '2026-11-04']:
            runner.run(packet(text='巴黎天气如何', sessionKey=day, now=day+'T03:00:00Z'))
        first, second = [messages[0].content for messages in model.seen]
        self.assertEqual(first.split('\n本轮可信上下文：')[0], second.split('\n本轮可信上下文：')[0])
        self.assertIn('2026-11-03T11:00:00+08:00', first)
        self.assertIn('2026-11-04T11:00:00+08:00', second)


if __name__ == '__main__':
    unittest.main()
