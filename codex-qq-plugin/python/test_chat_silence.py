import unittest
import agent_worker
from test_agent_worker import ScriptedModel,packet,call


class ChatSilenceTests(unittest.TestCase):
    def run_chat(self,response,text):
        model=ScriptedModel(responses=[response])
        runner=agent_worker.build_runner(model_factory=lambda _:model,rpc_callback=lambda *_:self.fail('chat must not call external tools'))
        result=runner.run(packet(text=text,policy={'enabled':True,'topics':['群聊闲聊'],'maxChars':600,'instructions':''},context={'scope':'group','access':'gray','currentSpeaker':'member-abcd','groupContext':[]}))
        return result,model

    def test_server_upgrade_joke_is_allowed_chat_without_external_tools(self):
        result,model=self.run_chat(call('reply_chat',{'topic':'群聊闲聊','text':'大肥鱼先收留你，白饭管够。'}),'你能不能让Tibo升级一下服务器啊，好慢啊，不然我要投入大肥鱼的怀抱了')
        self.assertEqual(result['kind'],'chat');self.assertIn('白饭管够',result['text'])
        self.assertEqual(set(model.bound[0]),{'reply_chat','convert_units','convert_previous_result','clarify_or_ignore'})

    def test_unsupported_action_returns_explanation_reason_instead_of_silent_ignore(self):
        result,_=self.run_chat(call('clarify_or_ignore',{'reason':'unsupported_action'}),'帮我联系管理员升级服务器')
        self.assertEqual(result['kind'],'clarify');self.assertEqual(result['reason'],'unsupported_action')


if __name__=='__main__':unittest.main()
