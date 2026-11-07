"""Real LangChain + canonical-store boundary tests; no QQ or model API calls."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import agent_worker as worker
from group_features import FEATURE_KEYS
from rag_retriever import RagRetriever
from rag_store import RagStore
from rag_runtime import format_observation, load_rag_retriever
from test_agent_worker import ScriptedModel, call, packet


class RagIntegrationTests(unittest.TestCase):
    def setUp(self):
        parent=Path(__file__).resolve().parents[1]/'test-output/rag-integration'
        parent.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.store=RagStore(self.root/'store.sqlite3')
        self.retriever=RagRetriever(self.store)
        self.model=ScriptedModel()
        self.runner=worker.build_runner(model_factory=lambda _:self.model,rag_retriever=self.retriever)
        self.store.put_document(namespace='shared',visibility='shared',domain='campus',title='测试资料',
            source_ref='https://example.edu/building',text='测试楼开放规则：工作日 08:00—22:00 开放，节假日另行通知。')

    def direct(self,name,args,text='查询测试楼开放规则',**changes):
        request={'id':'test-rag','type':'rag','name':name,'args':args,'text':text,
                 'sessionKey':'a'*64,'context':{'scope':'c2c'}}
        request.update(changes)
        return self.runner.run(request)

    def test_real_langchain_search_returns_complete_sourced_rule(self):
        self.model.responses.append(call('search_domain_knowledge',{'query':'测试楼开放规则','domain':'campus'}))
        result=self.runner.run(packet(text='测试楼的开放规则是什么',sessionKey='a'*64,context={'scope':'c2c'}))
        self.assertEqual(result['kind'],'rag')
        self.assertEqual(result['requiredFeature'],'campus')
        self.assertIn('节假日另行通知。',result['text'])
        self.assertIn('https://example.edu/building',result['text'])
        self.assertIn('search_domain_knowledge',self.model.bound[0])
        self.assertNotIn('a'*64,result['text'])

    def test_default_off_and_bad_operator_config_do_not_create_store(self):
        with patch.dict(os.environ,{},clear=True):
            self.assertIsNone(load_rag_retriever())
        config=self.root/'config.json'
        config.write_text(json.dumps({'enabled':True,'store_path':'relative.sqlite3'}))
        with patch.dict(os.environ,{'QQ_RAG_CONFIG':str(config)}):
            self.assertIsNone(load_rag_retriever())
        absent=worker.build_runner()
        result=absent.run({'id':'off','type':'rag','name':'recall_project_notes','args':{'query':'项目'},
                          'text':'回忆项目','sessionKey':'a'*64,'context':{'scope':'c2c'}})
        self.assertEqual(result['status'],'unavailable')

    def test_permissions_and_model_supplied_identity_fail_closed(self):
        context={'scope':'group','access':'white','currentSpeaker':'member-123',
                 'groupContext':[],'features':{key:True for key in FEATURE_KEYS}}
        context['features']['campus']=False
        result=self.direct('search_domain_knowledge',{'query':'开放规则'},context=context)
        self.assertNotIn('节假日另行通知',result['text'])
        result=self.direct('search_domain_knowledge',{'query':'开放规则','namespace':'b'*64})
        self.assertEqual(result['kind'],'error')
        result=self.direct('search_domain_knowledge',{'query':'开放规则'},context={'scope':'group','access':'gray'})
        self.assertEqual(result['kind'],'error')

    def test_write_grounding_scope_update_delete(self):
        args={'project_key':'天气助手','text':'已确认采用 ECMWF 数据。'}
        refused=self.direct('save_project_note',args,text='天气助手怎么样了')
        self.assertIn('未修改记录',refused['text'])
        saved=self.direct('save_project_note',args,text='保存项目 天气助手：已确认采用 ECMWF 数据。')
        self.assertIn('已保存',saved['text'])
        other=self.direct('recall_project_notes',{'query':'ECMWF','project_key':'天气助手'},sessionKey='b'*64)
        self.assertNotIn('已确认采用',other['text'])
        recalled=self.direct('recall_project_notes',{'query':'ECMWF','project_key':'天气助手'})
        self.assertIn('已确认采用 ECMWF 数据。',recalled['text'])
        deleted=self.direct('delete_project_note',{'project_key':'天气助手'},text='删除项目 天气助手')
        self.assertIn('已删除',deleted['text'])
        after=self.direct('recall_project_notes',{'query':'ECMWF','project_key':'天气助手'})
        self.assertNotIn('已确认采用',after['text'])

    def test_memory_disabled_blocks_write_and_recall(self):
        context={'scope':'group','access':'white','currentSpeaker':'member-123','groupContext':[],
                 'features':{key:True for key in FEATURE_KEYS}}
        context['features']['memory']=False
        result=self.direct('save_project_note',{'project_key':'测试','text':'目标已确认。'},
                           text='保存项目 测试：目标已确认。',context=context)
        self.assertEqual(result['status'],'unavailable')
        self.assertEqual(self.store.find_project_documents('测试',namespace='a'*64),[])

    def test_outdoor_knowledge_uses_weather_permission(self):
        self.store.put_document(namespace='shared',visibility='shared',domain='outdoor',title='徒步资料',
            source_ref='https://example.gov.cn/hiking',text='山地徒步路线开放须查询当期管理公告。')
        context={'scope':'group','access':'white','currentSpeaker':'member-123','groupContext':[],
                 'features':{key:True for key in FEATURE_KEYS}}
        context['features']['weather']=False
        result=self.direct('search_domain_knowledge',{'query':'山地徒步路线','domain':'outdoor'},context=context)
        self.assertNotIn('当期管理公告',result['text'])
        context['features']['weather']=True
        result=self.direct('search_domain_knowledge',{'query':'山地徒步路线','domain':'outdoor'},context=context)
        self.assertEqual(result['requiredFeature'],'weather')
        self.assertIn('当期管理公告',result['text'])

    def test_explicit_project_save_bypasses_model_and_old_memory(self):
        result=self.runner.run(packet(text='保存项目 天气助手：采用 ECMWF 数据。',
            sessionKey='a'*64,context={'scope':'c2c'}))
        self.assertEqual(result['kind'],'rag')
        self.assertIn('已保存',result['text'])
        self.assertEqual(self.model.seen,[])

    def test_legacy_clear_and_off_delete_project_notes_before_reopen(self):
        from social_memory import SocialMemory
        from social_worker import process
        config=self.root/'rag.json'
        config.write_text(json.dumps({'enabled':True,'store_path':str(self.root/'store.sqlite3')}))
        legacy=SocialMemory(self.root/'legacy')
        self.store.put_document(namespace='b'*64,domain='project',title='其他人',text='其他人的结论。',
            source_ref='request:other',project_key='他人项目')
        for action in ('clear','off'):
            self.direct('save_project_note',{'project_key':'天气助手','text':'采用 ECMWF 数据。'},
                        text='保存项目 天气助手：采用 ECMWF 数据。')
            with patch.dict(os.environ,{'QQ_RAG_CONFIG':str(config)}):
                result=process({'type':'social','args':{'action':action,'namespace':'a'*64,'scope':'c'*64}},legacy)
                self.assertTrue(result['ok'])
                reopened=process({'type':'social','args':{'action':'on','namespace':'a'*64,'scope':'c'*64}},legacy)
                self.assertTrue(reopened['ok'])
            self.assertEqual(self.store.find_project_documents('天气助手',namespace='a'*64),[])
            result=self.direct('recall_project_notes',{'query':'ECMWF','project_key':'天气助手'})
            self.assertNotIn('采用 ECMWF 数据。',result['text'])
            self.assertEqual(len(self.store.find_project_documents('他人项目',namespace='b'*64)),1)

    def test_legacy_scope_mismatch_does_not_delete_project_notes(self):
        from social_memory import SocialMemory
        from social_worker import process
        config=self.root/'rag.json'
        config.write_text(json.dumps({'enabled':True,'store_path':str(self.root/'store.sqlite3')}))
        legacy=SocialMemory(self.root/'legacy')
        legacy.control('a'*64,'c'*64,'on')
        self.direct('save_project_note',{'project_key':'天气助手','text':'采用 ECMWF 数据。'},text='保存项目 天气助手：采用 ECMWF 数据。')
        with patch.dict(os.environ,{'QQ_RAG_CONFIG':str(config)}):
            result=process({'type':'social','args':{'action':'clear','namespace':'a'*64,'scope':'d'*64}},legacy)
        self.assertFalse(result['ok'])
        self.assertEqual(len(self.store.find_project_documents('天气助手',namespace='a'*64)),1)

    def test_rag_diagnostics_are_bounded_and_do_not_contain_evidence(self):
        result=self.direct('recall_project_notes',{'query':'没有的项目'})
        self.assertEqual(result['status'],'unavailable')
        self.assertEqual(result['errorCode'],'RAG_VECTOR_NOT_CONFIGURED')
        self.assertIn('lexical_ms',result['ragTimings'])
        self.assertTrue(all(type(v) in (int,float) for v in result['ragTimings'].values()))

    def test_formatter_keeps_whole_chunks_and_exceptions(self):
        text='规则说明。'*95+'但考试期间不开放。'
        evidence=[{'title':'开放规则','text':text,'revision':1,'source_ref':'https://example.edu/rules','doc_id':str(i)} for i in range(4)]
        result=format_observation({'status':'ok','evidence':evidence})
        self.assertLessEqual(len(result),1400)
        self.assertEqual(result.count('规则说明。'),95*result.count('但考试期间不开放。'))
        self.assertGreater(result.count('但考试期间不开放。'),0)


if __name__=='__main__':
    unittest.main()
