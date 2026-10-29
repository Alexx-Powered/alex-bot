import unittest
from unittest.mock import patch
from deepseek_balance import read_balance
import agent_worker as worker

class BalanceTests(unittest.TestCase):
    def test_readonly_network_error_retries_once_without_retrying_auth(self):
        from urllib.error import HTTPError, URLError
        good={'is_available':True,'balance_infos':[{'currency':'CNY','total_balance':'110.00','granted_balance':'10.00','topped_up_balance':'100.00'}]}
        fetch=__import__('unittest.mock',fromlist=['Mock']).Mock(side_effect=[URLError('private-connect-error'),good])
        self.assertIn('可用 110.00 CNY',read_balance('fake-key-123',fetch));self.assertEqual(fetch.call_count,2)
        fetch=__import__('unittest.mock',fromlist=['Mock']).Mock(side_effect=HTTPError('https://api.deepseek.com/user/balance',401,'private-auth-error',{},None))
        self.assertIn('鉴权失败',read_balance('fake-key-123',fetch));self.assertEqual(fetch.call_count,1)

    def test_projects_numeric_fields_only(self):
        text=read_balance('fake-key-123',lambda key:{'is_available':True,'balance_infos':[{'currency':'CNY','total_balance':'110.00','granted_balance':'10.00','topped_up_balance':'100.00'}],'secret':'never-show'})
        self.assertIn('可用 110.00 CNY',text);self.assertNotIn('never-show',text)

    def test_failure_is_sanitized_and_never_invented(self):
        def broken(key):raise OSError('credential-secret')
        for fetch in [broken,lambda key:{'is_available':True,'balance_infos':[{'currency':'CNY','total_balance':'@all'}]}]:
            text=read_balance('fake-key-123',fetch);self.assertIn('无法核实',text);self.assertNotIn('credential-secret',text)

    def test_execute_has_no_model_call_or_group_access(self):
        runner=worker.build_runner(model_factory=lambda config:self.fail('Balance must not use model'))
        base={'type':'execute','id':'balance-test','name':'deepseek_account_balance','args':{},'config':{'apiKey':'fake-key-123'}}
        with patch.object(worker,'read_balance',return_value='余额测试') as fetch:
            result=runner.run(base|{'context':{'scope':'c2c'}})
            self.assertEqual((result['kind'],result['text']),('balance','余额测试'));fetch.assert_called_once()
            fetch.reset_mock();self.assertEqual(runner.run(base|{'context':{'scope':'group'}})['kind'],'error');fetch.assert_not_called()
        self.assertFalse(runner.sessions)

if __name__=='__main__':unittest.main()
