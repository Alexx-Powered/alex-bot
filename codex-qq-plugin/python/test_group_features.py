import unittest
from group_features import FEATURE_KEYS
from test_agent_worker import ScriptedModel, packet, call
from agent_worker import build_runner


class GroupFeatureTests(unittest.TestCase):
    def test_langchain_exposes_only_explicitly_enabled_group_tools(self):
        model=ScriptedModel()
        calls=[]
        runner=build_runner(model_factory=lambda _:model,rpc_callback=lambda *_:calls.append(True) or 'image')
        features={key:key=='weather' for key in FEATURE_KEYS}
        context={'scope':'group','access':'white','features':features,'currentSpeaker':'member-abcdef123456','groupContext':[]}
        model.responses.append(call('weather_image',{'city':'北京'}))
        self.assertEqual(runner.run(packet(context=context))['kind'],'tool')
        self.assertEqual(len(calls),1)
        self.assertIn('weather_image',model.bound[0])
        for name in ['radar_image','deepseek_account_balance','convert_units','buaa_classroom_query','openai_service_status']:
            self.assertNotIn(name,model.bound[0])

    def test_invalid_or_partial_feature_context_fails_before_model_or_rpc(self):
        model=ScriptedModel()
        runner=build_runner(model_factory=lambda _:model,rpc_callback=lambda *_:self.fail('RPC must not run'))
        for features in [{'weather':True},{key:1 for key in FEATURE_KEYS}]:
            result=runner.run(packet(context={'scope':'group','access':'white','features':features}))
            self.assertEqual(result['kind'],'error')
        self.assertFalse(model.seen)


if __name__=='__main__':
    unittest.main()
