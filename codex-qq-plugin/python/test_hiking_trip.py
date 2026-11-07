import copy,json,tempfile,unittest
from datetime import datetime,timedelta
from pathlib import Path
from unittest.mock import patch
from hiking_trip import *
from hiking_catalog import validate_profile,HikingStore,extract_profiles,ingest_profile,ingest_candidates
from research_queue import ResearchQueue
from rag_store import RagStore

class HikingTests(unittest.TestCase):
    def tempdir(self):
        root=Path(__file__).resolve().parents[1]/'test-output/hiking-tests';root.mkdir(parents=True,exist_ok=True)
        return tempfile.TemporaryDirectory(dir=root)
    def profile(self):
        return validate_profile({'topic':'测试山','variant':'两日穿越','sources':[{'url':'https://www.2bulu.com/a','title':'测试行程','date':'2026-11-07'}],
          'days':[{'route':['山村','湖畔'],'sleep':{'name':'湖畔','kind':'tent'}},{'route':['湖畔','山村'],'sleep':None}]})
    def weather(self):
        start=datetime(2026,11,7)
        return {name:{(start+timedelta(hours=i)).isoformat(timespec='minutes'):{'temperature_2m':temp,'cloud_cover':40,'precipitation':1 if i%24 else 3,'rain':.5,'showers':.2,'snowfall':.1,'wind_gusts_10m':2} for i in range(72)} for name,temp in [('山村',10),('湖畔',-2)]}
    def test_route_movement_precip_interval_and_complete_night(self):
        value=plan_weather(self.profile(),date(2026,11,7),self.weather())
        self.assertEqual(value['days'][0]['series'][0][0],10)
        self.assertEqual(value['days'][0]['series'][16][0],-2)
        self.assertEqual(value['days'][0]['stats']['precip'],26)
        self.assertEqual(value['days'][0]['stats']['rain'],16.8)
        self.assertEqual(value['nights'][0]['low'],-2)
        self.assertEqual(value['nights'][0]['comfort'],-7)
    def test_missing_camp_never_uses_village(self):
        weather=self.weather();del weather['湖畔']['2026-11-08T08:00']
        self.assertIsNone(plan_weather(self.profile(),date(2026,11,7),weather)['nights'][0]['comfort'])
        del weather['湖畔']
        card=plan_weather(self.profile(),date(2026,11,7),weather)
        self.assertEqual(card['days'][0]['stats']['min'],10)
        self.assertEqual(card['days'][0]['coverage']['min'],13)
        self.assertIsNone(card['days'][0]['series'][16][0])
        self.assertIsNone(card['nights'][0]['low'])
    def test_partial_day_reports_known_hours_instead_of_erasing_every_stat(self):
        series=[[hour-5,hour*2,1,.5,.1,hour,0] for hour in range(24)]
        for hour in [8,12,16]:series[hour]=[None]*6+[1]
        stats,coverage=day_statistics(series)
        self.assertEqual(stats,{'min':-5,'max':18,'cloud':22.86,'precip':21,'rain':10.5,'snow':2.1,'gust':23})
        self.assertEqual(set(coverage.values()),{21})
        self.assertEqual(series[12],[None]*6+[1])
    def test_daily_missing_fields_are_independent_and_no_data_is_not_zero(self):
        series=[[10,None,0,0,0,2,0] for _ in range(24)];series[0][0]=None
        stats,coverage=day_statistics(series)
        self.assertEqual(stats['min'],10);self.assertEqual(coverage['min'],23)
        self.assertIsNone(stats['cloud']);self.assertEqual(coverage['cloud'],0)
        self.assertEqual(stats['precip'],0);self.assertEqual(coverage['precip'],24)
        empty,counts=day_statistics([[None]*6+[0] for _ in range(24)])
        self.assertTrue(all(v is None for v in empty.values()));self.assertEqual(set(counts.values()),{0})
    def test_partial_hours_keep_partial_status_even_with_every_place_located(self):
        weather=self.weather();weather['山村']['2026-11-07T01:00']['temperature_2m']=None
        points={name:{'lat':30,'lon':100,'source':'https://www.openstreetmap.org/node/1'} for name in weather}
        with patch('hiking_trip.catalog',return_value=[self.profile()]),patch('hiking_trip.resolve_points',return_value=points),patch('hiking_trip.forecasts',return_value=(weather,'2026-11-07T08:00:00+08:00',None)):
            card=make_trip('测试山',source='发 徒步 测试山',now=datetime(2026,11,7,tzinfo=TZ))
        self.assertEqual(card['status'],'partial');self.assertEqual(card['missing'],[])
        self.assertEqual(card['days'][0]['stats']['min'],-2)
        self.assertEqual(card['days'][0]['coverage']['min'],23)
        self.assertEqual(card['days'][0]['coverage']['cloud'],24)
        self.assertIsNone(card['days'][0]['series'][1][0])
    def test_ambiguous_geocoder_is_rejected(self):
        def fake(*args,**kwargs):return {'features':[{'properties':{'name':'龙山村','osm_type':'N','osm_id':i,'osm_key':'place','osm_value':'village'},'geometry':{'coordinates':coord}} for i,coord in [(1,[114,27]),(2,[115,27])]]}
        self.assertIsNone(locate('龙山村',fetcher=fake))
        self.assertEqual(locate('龙山村',{'lat':27,'lon':113},fetcher=fake)['lon'],114)
    def test_horizon_no_fetch_and_no_fake_cache(self):
        def fail(*a,**k):raise AssertionError('must not fetch')
        result=forecasts({'湖':{'lat':30,'lon':100}},date(2027,1,1),date(2027,1,3),fetcher=fail,now=datetime(2026,11,7,tzinfo=TZ))
        self.assertEqual(result[2],'FORECAST_OUTSIDE_HORIZON')
    def test_payload_partial_and_independent_alternative(self):
        profile=self.profile();inn=copy.deepcopy(profile);inn['variant']='住店往返';inn['days'][0]['route']=['山村'];inn['days'][0]['sleep']={'name':'山村','kind':'inn'}
        point={'山村':{'lat':30,'lon':100,'source':'https://www.openstreetmap.org/node/1'},'湖畔':{'lat':30.1,'lon':100.1,'source':'https://www.openstreetmap.org/node/2'}}
        with patch('hiking_trip.catalog',return_value=[profile,inn]),patch('hiking_trip.resolve_points',return_value=point),patch('hiking_trip.forecasts',return_value=(self.weather(),'2026-11-07T08:00:00+08:00',None)):
            card=make_trip('测试山',source='发 徒步 测试山',now=datetime(2026,11,7,tzinfo=TZ))
        self.assertEqual(card['days'][0]['stats']['min'],-2)
        self.assertEqual(card['alternate']['days'][0]['stats']['min'],10)
        self.assertEqual(card['alternate']['nights'][0]['comfort'],None)
    def test_catalogue_types_and_bounded_route_storage(self):
        profiles=seed_profiles();self.assertGreaterEqual(len({p['topic'] for p in profiles}),3)
        with self.tempdir() as temp:
            q=ResearchQueue(Path(temp)/'queue.sqlite3');s=HikingStore(q);p=self.profile();s.put(p)
            self.assertEqual(s.get('测试山')[0]['variant'],p['variant'])
            canonical=RagStore(Path(temp)/'rag.sqlite3');ingest_profile(canonical,p)
            q.clock=lambda:time.time()+8*86400
            self.assertEqual(s.get('测试山'),[])
    def test_extraction_grounding_rejects_invented_camp_and_coordinates(self):
        p=self.profile();p.pop('points');p.pop('reviewed');p.pop('checked_at');p.pop('notice');p.pop('season')
        evidence=['第1天测试山山村至湖畔，湖畔露营，第二天继续徒步。','第2天湖畔回到山村，行程结束，离山返程。']
        for d,e in zip(p['days'],evidence):d['evidence']=e;d.pop('distance_km')
        pages=[{'url':p['sources'][0]['url'],'title':'测试山行程','text':'\n'.join(evidence)}]
        value=extract_profiles('测试山',pages,'unused',requester=lambda:json.dumps({'profiles':[p]}))
        self.assertEqual(len(value),1);self.assertFalse(value[0]['reviewed']);self.assertEqual(value[0]['points'],{})
        p['days'][0]['sleep']['name']='虚构营地'
        self.assertEqual(extract_profiles('测试山',pages,'unused',requester=lambda:json.dumps({'profiles':[p]})),[])
    def test_private_topic_not_sent_to_search(self):
        with self.assertRaises(ValueError):make_trip('我家后山',source='去我家后山徒步')
    def test_chinese_day_labels_and_camp_do_not_invent_tents_or_inns(self):
        p={'topic':'测试山','variant':'三日穿越','days':[
          {'route':['起点村','湖畔营地'],'sleep':{'name':'湖畔营地','kind':'tent'},'source':0,'evidence':'第一天：测试山从起点村徒步到湖畔营地，结束当天行程。'},
          {'route':['湖畔营地','山脊营地'],'sleep':{'name':'山脊营地','kind':'camp'},'source':0,'evidence':'第二天：湖畔营地到山脊营地，沿途经过草甸。'},
          {'route':['山脊营地','终点村'],'sleep':None,'source':0,'evidence':'第三天：山脊营地翻过垭口，徒步至终点村结束。'}]}
        pages=[{'url':'https://www.8264.com/a','title':'测试山三日行程','text':'\n'.join(d['evidence'] for d in p['days'])}]
        result=extract_profiles('测试山',pages,'unused',requester=lambda:json.dumps({'profiles':[p]}))
        self.assertEqual(len(result),1);self.assertEqual(result[0]['days'][0]['sleep']['kind'],'camp')
        self.assertFalse(inn_plan(result[0]))
        missing=copy.deepcopy(result[0]);missing['days'][0]['sleep']=None;missing['days'][1]['sleep']=None
        self.assertFalse(inn_plan(missing))
        for d in p['days']:d['source']=1
        pages.insert(0,{'url':'https://example.gov.cn/notice','title':'测试山公告','text':'测试山公告没有路线行程。'})
        result=extract_profiles('测试山',pages,'unused',requester=lambda:json.dumps({'profiles':[p]}))
        self.assertEqual(result[0]['sources'][0]['url'],'https://www.8264.com/a')
        self.assertEqual(len(result[0]['sources']),1)
    def test_unmapped_route_uses_unique_source_named_start_with_bounded_lookup(self):
        p=self.profile();calls=[]
        def locator(name,anchor=None):
            calls.append(name)
            return {'lat':30,'lon':100,'source':'https://www.openstreetmap.org/node/1'} if name=='山村' else None
        points=resolve_points('测试山',[p],locator=locator)
        self.assertIn('山村',points);self.assertNotIn('湖畔',points);self.assertLessEqual(len(calls),7)
    def test_approved_regional_climate_name_keeps_complete_historical_context(self):
        from types import SimpleNamespace
        profile=self.profile();card={**plan_weather(profile,date(2026,11,7),self.weather()),'topic':'测试山','start':'2026-11-07','status':'ok','timings':{}}
        service=SimpleNamespace(normals=lambda location,month:{'months':[{'complete':True,'month':month,'temperature_mean_c':2,'precipitation_mm':20}]})
        config={'locations':{'test':'fixed-location'},'location_names':{'test':'某省测试山代表点'},'climate_service':service}
        with patch('hiking_trip.make_trip',return_value=card):
            result=build_hiking_tool(source='发 徒步 测试山',outdoor_config=config).invoke({'destination':'测试山'})
        self.assertIn('ERA5 1991—2020',result['hikingCard']['climate'])
    def test_background_promotes_only_after_committed_job(self):
        from bounded_research import run_next
        from hashlib import sha256
        with self.tempdir() as temp:
            q=ResearchQueue(Path(temp)/'queue.sqlite3');q.enqueue('测试山');p=self.profile();p['checked_at']=time.time()
            body='测试山第1天山村至湖畔，湖畔露营；第2天返回山村。此为历史行程，当前开放情况需核对。'
            candidate={'url':p['sources'][0]['url'],'title':'测试山两日行程','text':body,'published_at':'2026-11-07','fetched_at':datetime.now(TZ).isoformat(),'content_hash':sha256(body.encode()).hexdigest()}
            result={'status':'completed','candidates':[candidate],'metrics':{},'hiking_profiles':[p]}
            store=RagStore(Path(temp)/'rag.sqlite3')
            with patch('bounded_research.run_child',return_value=result):out=run_next(q,store=store)
            self.assertEqual(out['metrics']['hiking_profiles'],1);self.assertEqual(out['metrics']['rag_updates'],1)
            self.assertEqual(HikingStore(q).get('测试山')[0]['variant'],'两日穿越')
    def test_auto_reference_never_overwrites_same_named_reviewed_route(self):
        with self.tempdir() as temp:
            store=RagStore(Path(temp)/'rag.sqlite3');p=self.profile();p['reviewed']=True
            manual=ingest_profile(store,p);p['reviewed']=False
            automatic=ingest_profile(store,p)
            self.assertNotEqual(manual['doc_id'],automatic['doc_id'])
            self.assertFalse(ingest_profile(store,{**p,'reviewed':True})['changed'])

if __name__=='__main__':unittest.main()
