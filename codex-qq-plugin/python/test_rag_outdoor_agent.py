"""Optional outdoor workflow through the real LangChain agent and its limits."""
import json
import os
import unittest
from unittest.mock import Mock,patch

import agent_worker as worker
from climate_history import ClimateLocation
from chat_memory import ChatMemoryStore
from group_features import FEATURE_KEYS
from rag_runtime import load_outdoor_config
from test_agent_worker import ScriptedModel,call,packet
import test_rag_integration as fixtures


class RagOutdoorAgentTests(unittest.TestCase):
    direct=fixtures.RagIntegrationTests.direct
    def setUp(self):
        fixtures.RagIntegrationTests.setUp(self)
        self.forecast=Mock()
        self.forecast.daily.return_value={'status':'ok','days':[
            {'date':'2026-11-07','temperature_min_c':-4,'temperature_max_c':8,'precipitation_mm':2,'wind_max_ms':5,'gust_max_ms':15},
            {'date':'2026-11-08','temperature_min_c':-2,'temperature_max_c':9,'precipitation_mm':0,'wind_max_ms':4,'gust_max_ms':12}],
            'source':{'documentation':'https://open-meteo.com/en/docs/ecmwf-api'}}
        self.climate=Mock()
        self.climate.normals.return_value={'status':'ok','period':{'start_year':1991,'end_year':2020,'complete':True},
            'months':[{'month':11,'temperature_mean_c':-5,'precipitation_mm':15}],
            'source':{'url':'https://open-meteo.com/en/docs/historical-weather-api'}}
        self.options={'locations':{'dangling':ClimateLocation('dangling',31.0733589,101.4052803)},
            'location_names':{'dangling':'党岭'},'climate_service':self.climate,'forecast_provider':self.forecast}
        self.store.put_document(namespace='shared',visibility='shared',domain='outdoor',title='徒步装备',
            text='衣物按排汗、保暖、防风防雨分层；鞋具防滑；带水和食物。此为一般准备，具体路线仍需核对。',
            source_ref='https://example.gov.cn/equipment')
        self.runner=worker.build_runner(model_factory=lambda _:self.model,rag_retriever=self.retriever,outdoor_config=self.options)
        self.trip={'destination_id':'dangling','start_date':'2026-11-07','end_date':'2026-11-08'}

    def test_real_agent_selects_one_composite_tool_and_skips_shortcut(self):
        self.model.responses.append(call('prepare_outdoor_trip',self.trip))
        with patch.object(worker,'quick_weather_route',return_value=('weather_image',{'city':'党岭'})) as quick:
            result=self.runner.run(packet(text='本周末去党岭徒步，季节合适吗，天气怎么样，需要什么装备？',
                sessionKey='a'*64,context={'scope':'c2c'},now='2026-11-06T01:00:00Z'))
        quick.assert_not_called()
        self.assertEqual(result['kind'],'rag')
        self.assertEqual(result['requiredFeature'],'weather')
        self.assertIn('最大阵风15m/s',result['text'])
        self.assertIn('1991–2020模式网格',result['text'])
        self.assertIn('保暖层与防雨层',result['text'])
        self.assertIn('https://example.gov.cn/equipment',result['text'])
        self.assertLessEqual(len(result['text']),1500)
        self.assertEqual(len(self.model.seen),1)
        self.forecast.daily.assert_called_once()
        self.assertNotIn('a'*64,result['text'])

    def test_no_optional_catalogue_or_weather_permission_no_tool(self):
        context={'scope':'group','access':'white','features':{key:True for key in FEATURE_KEYS}}
        context['features']['weather']=False
        tools,_,_=self.runner._tools(packet(sessionKey='a'*64,context=context),worker._normalize_policy(None),'2026-11-06')
        self.assertNotIn('prepare_outdoor_trip',[item.name for item in tools])
        without=worker.build_runner(rag_retriever=self.retriever)
        tools,_,_=without._tools(packet(sessionKey='a'*64,context={'scope':'c2c'}),worker._normalize_policy(None),'2026-11-06')
        self.assertNotIn('prepare_outdoor_trip',[item.name for item in tools])
        self.forecast.daily.assert_not_called()

    def test_single_weather_request_still_uses_fixed_route(self):
        rpc=Mock(return_value='已生成天气图')
        runner=worker.build_runner(model_factory=lambda _:self.model,rpc_callback=rpc,
            rag_retriever=self.retriever,outdoor_config=self.options)
        result=runner.run(packet(text='北京天气',sessionKey='a'*64,context={'scope':'c2c'}))
        self.assertEqual(result['kind'],'tool')
        self.assertEqual(rpc.call_args.args[2],'weather_image')
        self.assertEqual(self.model.seen,[])
        self.forecast.daily.assert_not_called()

    def test_short_trip_followup_receives_only_minimal_scoped_constraints(self):
        self.model.responses.append(call('prepare_outdoor_trip',self.trip))
        self.runner.run(packet(text='本周末去党岭徒步，天气和装备怎么样',sessionKey='a'*64,
            context={'scope':'c2c'},now='2026-11-06T01:00:00Z'))
        memory=self.runner.sessions['a'*64].turns[-1][1]
        self.assertIn('地点ID=dangling',memory)
        self.assertIn('2026-11-07~2026-11-08',memory)
        self.assertNotIn('1991',memory);self.assertNotIn('15m/s',memory)
        self.model.responses.append(call('prepare_outdoor_trip',{**self.trip,'route_variant':'葫芦海','overnight':False}))
        result=self.runner.run(packet(text='葫芦海、不露营',sessionKey='a'*64,context={'scope':'c2c'},now='2026-11-06T01:01:00Z'))
        self.assertEqual(result['kind'],'rag')
        self.assertTrue(any('地点ID=dangling' in str(message.content) for message in self.model.seen[-1]))
        self.assertIn('路线=葫芦海',self.runner.sessions['a'*64].turns[-1][1])
        self.assertNotIn('b'*64,self.runner.sessions)

    def test_outdoor_config_only_reads_operator_absolute_catalogue(self):
        path=self.root/'config.json'
        data={'enabled':True,'store_path':str(self.root/'store.sqlite3'),'outdoor':{
            'climate_path':str(self.root/'climate.sqlite3'),'locations':[{'id':'dangling','name':'党岭','latitude':31.07,'longitude':101.4}]}}
        path.write_text(json.dumps(data),encoding='utf-8')
        with patch.dict(os.environ,{'QQ_RAG_CONFIG':str(path)}):
            loaded=load_outdoor_config()
            self.assertEqual(loaded['locations']['dangling'].place_id,'dangling')
            data['outdoor']['climate_path']='relative.sqlite3'
            path.write_text(json.dumps(data),encoding='utf-8')
            self.assertIsNone(load_outdoor_config())

    def test_natural_clear_removes_canonical_notes_and_preserves_other_scope(self):
        memory=ChatMemoryStore(self.root/'chat-memory')
        runner=worker.build_runner(model_factory=lambda _:self.model,memory_store=memory,rag_retriever=self.retriever)
        self.direct('save_project_note',{'project_key':'天气助手','text':'采用 ECMWF 数据。'},text='保存项目 天气助手：采用 ECMWF 数据。')
        self.store.put_document(namespace='b'*64,domain='project',project_key='天气助手',title='他人记录',text='别人的记录。',source_ref='request:other')
        self.model.responses.append(call('chat_memory',{'action':'clear'}))
        result=runner.run(packet(text='忘掉我的所有记忆',sessionKey='a'*64,context={'scope':'c2c'},
            policy={'enabled':True,'topics':['daily'],'maxChars':600,'instructions':''}))
        self.assertIn('已经清空',result['text'])
        self.assertEqual(self.store.find_project_documents('天气助手',namespace='a'*64),[])
        self.assertEqual(len(self.store.find_project_documents('天气助手',namespace='b'*64)),1)

    def test_natural_clear_canonical_failure_does_not_claim_success(self):
        memory=ChatMemoryStore(self.root/'chat-memory')
        runner=worker.build_runner(model_factory=lambda _:self.model,memory_store=memory,rag_retriever=self.retriever)
        self.model.responses.append(call('chat_memory',{'action':'clear'}))
        with patch.object(self.store,'clear_project_notes',side_effect=RuntimeError('private path')):
            result=runner.run(packet(text='忘掉我的所有记忆',sessionKey='a'*64,context={'scope':'c2c'},
                policy={'enabled':True,'topics':['daily'],'maxChars':600,'instructions':''}))
        self.assertNotIn('已经清空',result['text'])
        self.assertIn('没能更新',result['text'])
        self.assertNotIn('private path',result['text'])
