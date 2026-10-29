"""Real LangChain routing with scripted models, no QQ or provider requests."""
import unittest
from unittest.mock import patch

import agent_worker as worker
from test_agent_worker import ScriptedModel, call, packet

BALANCE = 'DeepSeek API 账户余额：\n可用 4.09 CNY（赠金 0.00，充值余额 4.09）\n可供 API 调用：是\n查询时间：10-29 21:51（北京时间）'


class ToolFollowupTests(unittest.TestCase):
    def setUp(self):
        self.model = ScriptedModel()
        self.clock = 100.0
        self.runner = worker.build_runner(model_factory=lambda _: self.model, clock=lambda: self.clock)
        self.context = {'scope': 'c2c'}
        self.session = 'owner-session'

    def request(self, text, tool_name, args, **changes):
        self.model.responses = [call(tool_name, args)]
        return self.runner.run(packet(text=text, sessionKey=self.session, context=self.context, **changes))

    def fixed(self, name, args=None, **changes):
        value = {'type': 'execute', 'id': 'fixed-1', 'name': name, 'args': args or {},
                 'sessionKey': self.session, 'context': self.context}
        if name == 'deepseek_account_balance':
            value['config'] = packet()['config']
        value.update(changes)
        return self.runner.run(value)

    def test_natural_balance_then_omitted_conversion_and_reverse(self):
        with patch.object(worker, 'read_balance', return_value=BALANCE) as fetch:
            result = self.request('我余额还有多少？', 'deepseek_account_balance', {})
            self.assertEqual(result['kind'], 'balance')
            converted = self.request('换算成古月币是多少？', 'convert_previous_result', {'to_unit': 'HU$'})
            self.assertIn('4.09 元 ≈ 0.035057 HU$', converted['text'])
            self.assertEqual((converted['kind'], converted['source'], converted['sensitive']), ('reasoned', 'conversion', True))
            reverse = self.request('再换回人民币呢', 'convert_previous_result', {'to_unit': 'CNY'})
            self.assertIn('4.09 元 = 4.09 元', reverse['text'])
            fetch.assert_called_once()
        self.assertEqual(len(self.model.seen), 1, 'Explicit followups invoke the fixed tool without another model call')
        self.assertNotIn('4.09', str(self.model.seen))
        self.assertNotIn('offline-test-key', str(self.model.seen))
        self.assertNotIn('4.09', str(self.runner.sessions[self.session].turns))

    def test_fixed_balance_survives_first_model_signature_initialization(self):
        with patch.object(worker, 'read_balance', return_value=BALANCE):
            self.assertEqual(self.fixed('deepseek_account_balance')['kind'], 'balance')
        result = self.request('那折合多少HU$呀', 'convert_previous_result', {'to_unit': 'HU$'})
        self.assertIn('0.035057 HU$', result['text'])

    def test_complex_followup_can_still_select_the_context_tool_with_real_langchain(self):
        with patch.object(worker, 'read_balance', return_value=BALANCE):
            self.fixed('deepseek_account_balance')
        result = self.request('可以把刚刚查到的钱用古月币表示给我看一下吗', 'convert_previous_result', {'to_unit': 'HU$'})
        self.assertIn('0.035057 HU$', result['text'])
        self.assertEqual(len(self.model.seen), 1)
        self.assertNotIn('4.09', str(self.model.seen))

    def test_fixed_quantity_followup_is_exact_without_balance_or_model_amount(self):
        self.assertEqual(self.fixed('convert_units', {'amount': '1', 'from_unit': '马里', 'to_unit': 'km'})['text'], '1 马里 = 3.08 km')
        result = self.request('那换成米呢', 'convert_previous_result', {'to_unit': 'm'})
        self.assertIn('1 马里 = 3080 m', result['text'])
        self.assertNotIn('sensitive', result)

    def test_missing_context_expiry_and_failed_query_never_guess(self):
        result = self.request('换成古月币是多少', 'convert_previous_result', {'to_unit': 'HU$'})
        self.assertNotIn('4.09', result['text'])
        self.assertIn('具体数值', result['text'])
        with patch.object(worker, 'read_balance', return_value=BALANCE):
            self.fixed('deepseek_account_balance')
        self.clock += 601
        self.assertIn('具体数值', self.request('换成HU$', 'convert_previous_result', {'to_unit': 'HU$'})['text'])
        with patch.object(worker, 'read_balance', return_value=BALANCE):
            self.fixed('deepseek_account_balance')
        with patch.object(worker, 'read_balance', return_value='暂时无法核实 DeepSeek 余额，请稍后再试。'):
            self.fixed('deepseek_account_balance')
        self.assertIn('具体数值', self.request('换成HU$', 'convert_previous_result', {'to_unit': 'HU$'})['text'])

    def test_group_members_and_gray_access_cannot_inherit_core_facts(self):
        self.context = {'scope': 'group', 'access': 'white', 'groupContext': [], 'currentSpeaker': 'member-abcdef'}
        with patch.object(worker, 'read_balance', return_value=BALANCE):
            self.fixed('deepseek_account_balance')
        original = self.session
        self.session = 'other-member'
        self.assertIn('具体数值', self.request('换成HU$', 'convert_previous_result', {'to_unit': 'HU$'})['text'])
        self.session = original
        self.context['access'] = 'gray'
        self.context['groupContext'] = [{'role': 'assistant', 'speaker': 'fish', 'text': '可用4.09元'}]
        result = self.request('换成HU$', 'convert_previous_result', {'to_unit': 'HU$'})
        self.assertIn('具体数值', result['text'])
        self.assertNotIn('sensitive', result)

    def test_changed_api_key_invalidates_old_balance(self):
        with patch.object(worker, 'read_balance', return_value=BALANCE):
            self.fixed('deepseek_account_balance')
        config = packet()['config'] | {'apiKey': 'different-fake-api-key'}
        result = self.request('换成古月币呢', 'convert_previous_result', {'to_unit': 'HU$'}, config=config)
        self.assertIn('具体数值', result['text'])

    def test_key_rotation_then_new_fixed_query_keeps_the_new_account_fact(self):
        self.request('换成HU$', 'convert_previous_result', {'to_unit': 'HU$'})
        config = packet()['config'] | {'apiKey': 'rotated-fake-api-key'}
        with patch.object(worker, 'read_balance', return_value=BALANCE):
            self.fixed('deepseek_account_balance', config=config)
        result = self.request('换成古月币是多少', 'convert_previous_result', {'to_unit': 'HU$'}, config=config)
        self.assertIn('0.035057 HU$', result['text'])

    def test_unrelated_tool_invalidates_old_quantity(self):
        self.fixed('convert_units', {'amount': '1', 'from_unit': '马里', 'to_unit': 'km'})
        self.runner.rpc_callback = lambda *_: '天气图已生成'
        self.fixed('weather_image', {'city': '北京'})
        self.assertIn('具体数值', self.request('换成米呢', 'convert_previous_result', {'to_unit': 'm'})['text'])

    def test_a_new_quantity_in_chat_cannot_silently_reuse_an_older_account_balance(self):
        for text in ['我刚刚花了70元', '我刚刚花了七十块']:
            with self.subTest(text=text):
                with patch.object(worker, 'read_balance', return_value=BALANCE):
                    self.fixed('deepseek_account_balance')
                result=self.request(text,'reply_chat',{'topic':'日常','text':'鱼帮你看好余下的白饭~'},policy={'enabled':True,'topics':['日常'],'maxChars':600,'instructions':''})
                self.assertEqual(result['kind'],'chat')
                self.assertFalse(self.runner.tool_results.summary(self.session,self.context)['available'])


if __name__ == '__main__':
    unittest.main()
