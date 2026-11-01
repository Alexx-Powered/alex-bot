import unittest
from urllib.error import URLError
from timeout_errors import is_timeout
from deepseek_balance import read_balance
from media_understanding import timeout_stage
from public_status import query_status
from unittest.mock import patch

class TimeoutTests(unittest.TestCase):
    def test_only_real_timeout_is_classified(self):
        self.assertTrue(is_timeout(URLError(TimeoutError('SECRET'))))
        self.assertFalse(is_timeout(ValueError('timeout in arbitrary text SECRET')))

    def test_balance_timeout_has_no_key_or_exception(self):
        def fetch(key):raise TimeoutError('SECRET raw request')
        result=read_balance('offline-test-key',fetch=fetch)
        self.assertIn('超时',result);self.assertIn('8秒',result);self.assertNotIn('SECRET',result)

    def test_media_timeout_has_fixed_phase(self):
        def fail():raise TimeoutError('SECRET')
        with self.assertRaises(TimeoutError) as caught:timeout_stage(fail,'download',10)
        self.assertEqual(caught.exception.stage,'download');self.assertNotIn('SECRET',str(caught.exception))

    def test_status_timeout_differs_from_other_source_failures(self):
        with patch('public_status.fetch_deepseek',side_effect=TimeoutError('SECRET')):
            result=query_status('deepseek')
        self.assertFalse(result['ok']);self.assertIn('超时',result['text']);self.assertNotIn('SECRET',result['text'])

if __name__=='__main__':unittest.main()
