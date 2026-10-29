import unittest
from unittest.mock import patch
import model_transport as transport

class DummyClient:
    def __init__(self,**kwargs):self.kwargs=kwargs;self.is_closed=False
    def close(self):self.is_closed=True

class TransportTests(unittest.TestCase):
    def test_respects_existing_system_proxy_and_reuses_connection_client(self):
        with patch.object(transport,'_client',None),patch.object(transport,'_proxy_key',None),patch.object(transport,'getproxies',return_value={'https':'http://127.0.0.1:8888'}),patch.object(transport,'proxy_bypass',return_value=False),patch.object(transport.httpx,'Client',DummyClient):
            first=transport.get_model_http_client()
            self.assertEqual(first.kwargs['proxy'],'http://127.0.0.1:8888');self.assertFalse(first.kwargs['trust_env'])
            self.assertIs(first,transport.get_model_http_client())
            with patch.object(transport,'getproxies',return_value={'https':'http://127.0.0.1:9999'}):
                second=transport.get_model_http_client()
                self.assertTrue(first.is_closed);self.assertIsNot(first,second)

    def test_respects_explicit_proxy_bypass(self):
        with patch.object(transport,'_client',None),patch.object(transport,'_proxy_key',None),patch.object(transport,'getproxies',return_value={'https':'http://127.0.0.1:8888'}),patch.object(transport,'proxy_bypass',return_value=True),patch.object(transport.httpx,'Client',DummyClient):
            self.assertIsNone(transport.get_model_http_client().kwargs['proxy'])

if __name__=='__main__':unittest.main()
