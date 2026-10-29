import tempfile
import unittest
from pathlib import Path
from langchain_core.messages import AIMessage
from test_agent_worker import ScriptedModel,packet,call
import agent_worker as worker
from chat_memory import ChatMemoryStore

POLICY={'enabled':True,'topics':['群聊闲聊'],'maxChars':600,'instructions':'自然说话。'}

class ConversationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=ChatMemoryStore(Path(self.temp.name)/'memory')
        self.model=ScriptedModel()
        self.runner=self.new_runner()

    def new_runner(self):
        return worker.build_runner(model_factory=lambda _:self.model,memory_store=self.store,rpc_callback=lambda *_:self.fail('no external tools'))

    def run_chat(self,response,text='我叫测试小鱼',key='a'*64,context=None):
        self.model.responses.append(response)
        return self.runner.run(packet(text=text,sessionKey=key,policy=POLICY,context=context or {'scope':'c2c'}))

    def test_voice_precedes_tool_routing_and_direct_chat_needs_one_model_call(self):
        result=self.run_chat(AIMessage(content='被这堆代码折磨够呛吧。'),'写代码写得我好烦')
        self.assertEqual(result['kind'],'chat');self.assertEqual(len(self.model.seen),1)
        self.assertTrue(self.model.seen[-1][0].content.startswith('你是亚历克斯'))
        self.assertFalse(getattr(self.model.seen[-1][-1],'tool_calls',[]))

    def test_direct_chat_cannot_fake_live_business_results(self):
        result=self.run_chat(AIMessage(content='三号楼101现在空闲。'),'现在去哪个教室')
        self.assertNotEqual(result['kind'],'chat')

    def test_casual_line_breaks_and_playful_punctuation_survive_without_mentions_or_links(self):
        result=self.run_chat(call('reply_chat',{'topic':'群聊闲聊','text':'饭给你留着~\n慢慢说 🐟 <@!123> https://example.test'}),'我要投奔大肥鱼')
        self.assertIn('~\n',result['text']);self.assertIn('🐟',result['text'])
        self.assertNotIn('@',result['text']);self.assertNotIn('https',result['text'])

    def test_plain_chat_composer_has_no_tools_or_business_prompt_and_preserves_fallback(self):
        composer=ScriptedModel(responses=[AIMessage(content='来嘛~\n饭给你留着 🐟')])
        self.runner=worker.build_runner(model_factory=lambda _:self.model,chat_model_factory=lambda _:composer)
        result=self.run_chat(call('reply_chat',{'topic':'群聊闲聊','text':'我只能聊天，不能升级服务器。'}),'我要投奔大肥鱼')
        self.assertIn('来嘛~\n',result['text']);self.assertNotIn('权限',composer.seen[0][0].content)
        self.assertNotIn('deepseek_account_balance',str(composer.seen[0]));self.assertEqual(len(composer.seen),1)
        composer.responses.append(RuntimeError('provider private exception'))
        result=self.run_chat(call('reply_chat',{'topic':'群聊闲聊','text':'鱼先陪你缓缓~'}),'今天好累')
        self.assertEqual(result['text'],'鱼先陪你缓缓~')

    def test_memory_control_receipt_never_goes_to_chat_composer(self):
        self.runner.chat_model_factory=lambda _:self.fail('memory receipt cannot be rewritten')
        result=self.run_chat(call('chat_memory',{'action':'clear'}),'清空我的记忆')
        self.assertTrue(result['memory_reset'])

    def test_memory_survives_runner_restart_and_never_leaks_into_other_scope(self):
        result=self.run_chat(call('reply_chat',{'topic':'群聊闲聊','text':'好，就叫你小鱼。','memory_kind':'name','memory_text':'我叫测试小鱼'}))
        self.assertEqual(result['kind'],'chat');self.runner=self.new_runner()
        self.run_chat(call('reply_chat',{'topic':'群聊闲聊','text':'小鱼，来了。'}),'还记得我吗')
        self.assertIn('测试小鱼',str(self.model.seen[-1]))
        self.run_chat(call('reply_chat',{'topic':'群聊闲聊','text':'刚认识你呢。'}),'你认识我吗',key='b'*64)
        self.assertNotIn('测试小鱼',str(self.model.seen[-1]))

    def test_self_stated_name_is_remembered_even_if_model_omits_memory_arguments(self):
        self.run_chat(call('reply_chat',{'topic':'群聊闲聊','text':'行，就叫小河。'}),'我叫试运行小河，以后就叫我小河')
        self.runner=self.new_runner()
        result=self.run_chat(call('chat_memory',{'action':'recall'}),'还记得我的称呼吗')
        self.assertIn('叫我小河',result['text'])
        self.run_chat(call('reply_chat',{'topic':'群聊闲聊','text':'记得，小河。'}),'还记得该怎么称呼我吗？')
        result=self.run_chat(call('chat_memory',{'action':'recall'}),'你记得我什么')
        self.assertIn('叫我小河',result['text']);self.assertNotIn('称呼我吗',result['text'])

    def test_forget_clears_short_history_and_is_not_saved_as_a_turn(self):
        self.run_chat(call('reply_chat',{'topic':'群聊闲聊','text':'好的小鱼','memory_kind':'name','memory_text':'我叫测试小鱼'}))
        result=self.run_chat(call('chat_memory',{'action':'clear'}),'清空我的记忆')
        self.assertTrue(result['memory_reset']);self.assertNotIn('a'*64,self.runner.sessions)
        self.run_chat(call('chat_memory',{'action':'recall'}),'你记得我什么')
        self.assertNotIn('测试小鱼',str(self.model.seen[-1]))

    def test_gray_chat_can_remember_without_gaining_core_tools_or_other_member_facts(self):
        ctx={'scope':'group','access':'gray','currentSpeaker':'member-abcd','groupContext':[{'speaker':'member-ffff','role':'member','text':'我叫另一个人'}]}
        self.run_chat(call('reply_chat',{'topic':'群聊闲聊','text':'好的','memory_kind':'name','memory_text':'我叫另一个人'}),'你好',context=ctx)
        self.assertIn('chat_memory',self.model.bound[-1]);self.assertNotIn('deepseek_account_balance',self.model.bound[-1])
        self.runner=self.new_runner()
        result=self.run_chat(call('chat_memory',{'action':'recall'}),'你记得我什么',context=ctx)
        self.assertNotIn('另一个人',result['text'])

if __name__=='__main__':unittest.main()
