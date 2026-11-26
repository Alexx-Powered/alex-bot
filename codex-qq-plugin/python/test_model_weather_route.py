import unittest
import agent_worker as worker
from group_features import FEATURE_KEYS
from test_agent_worker import ScriptedModel,call,packet


class ModelWeatherRoutingTests(unittest.TestCase):
    def test_weather_with_chat_disabled_reaches_model_and_preserves_args(self):
        calls = []
        model = ScriptedModel(responses=[call('cloud_video', {'city':'桦皮岭','hours':48,'day':'2026-11-27'})])
        runner = worker.build_runner(model_factory=lambda _:model,
            rpc_callback=lambda *args:calls.append(args[2:]) or '已生成')
        ctx = {'scope':'group', 'access':'white', 'currentSpeaker':'member-ab',
               'features':{k:k=='weather' for k in FEATURE_KEYS}}
        runner.run(packet(text='小瘦鱼 周五桦皮岭48小时动态云图',context=ctx,now='2026-11-26T01:00:00Z'))
        self.assertEqual(len(model.seen),1)
        self.assertNotIn('pm25_video',model.bound[0])
        self.assertEqual(calls,[('cloud_video',{'city':'桦皮岭','hours':48,'day':'2026-11-27'})])

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
