import unittest
from unittest.mock import patch
import agent_worker as worker
from test_agent_worker import ScriptedModel, packet, call

class TemporaryConnectionError(Exception):pass
class RequestTimeout(Exception):pass

class RecoveryTests(unittest.TestCase):
    def test_one_connection_failure_recovers_before_exactly_one_tool(self):
        calls=[]
        model=ScriptedModel(responses=[TemporaryConnectionError('SECRET'),call('radar_image',{'target':'北京'})])
        runner=worker.build_runner(model_factory=lambda cfg:model,rpc_callback=lambda *args:calls.append(args) or '图已生成')
        result=runner.run(packet(text='我在北京，想看看雷达图'))
        self.assertEqual(result['kind'],'tool');self.assertEqual(len(calls),1);self.assertEqual(len(model.seen),2)

    def test_exhausted_connection_and_timeout_have_safe_specific_codes(self):
        for errors,expected in [([TemporaryConnectionError('SECRET')]*2,'MODEL_CONNECTION_ERROR'),([RequestTimeout('SECRET')],'MODEL_TIMEOUT')]:
            model=ScriptedModel(responses=list(errors));runner=worker.build_runner(model_factory=lambda cfg:model)
            result=runner.run(packet(text='你好'))
            self.assertEqual(result['code'],expected);self.assertNotIn('SECRET',str(result));self.assertEqual(len(model.seen),len(errors))

    def test_balance_natural_tool_does_not_put_amount_in_conversation_memory(self):
        model=ScriptedModel(responses=[call('deepseek_account_balance',{})])
        runner=worker.build_runner(model_factory=lambda cfg:model)
        with patch.object(worker,'read_balance',return_value='DeepSeek余额：987.65 CNY'):
            result=runner.run(packet(text='我还有多少余额',context={'scope':'c2c'}))
        self.assertEqual(result['kind'],'balance');self.assertEqual(len(model.seen),1)
        self.assertNotIn('987.65',str(runner.sessions));self.assertIn('已私下查询',str(runner.sessions))

if __name__=='__main__':unittest.main()
