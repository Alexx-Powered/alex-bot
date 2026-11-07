"""Real LangChain invokes with canonical RAG and bounded HTTP fixtures."""
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

from pydantic import ValidationError
from langchain_core.callbacks import BaseCallbackHandler
from climate_history import ClimateLocation, ClimateHistory
from outdoor_planning import DAY_FIELDS, ECMWFDailyForecast, build_outdoor_planning_tool,format_trip_report
from rag_retriever import RagRetriever
from rag_store import RagStore


NOW=datetime(2026,11,6,tzinfo=timezone.utc).timestamp()
PLACE=ClimateLocation('fixture-point',30.0,102.0)


def response(days=('2026-11-07','2026-11-08')):
    values={
        'temperature_2m_min':-3.0,'temperature_2m_max':8.0,'precipitation_sum':2.0,
        'snowfall_sum':1.0,'wind_speed_10m_max':5.0,'wind_gusts_10m_max':10.0,'weather_code':71}
    return {'latitude':30.01,'longitude':102.01,'elevation':3000,'utc_offset_seconds':28800,
            'daily':{'time':list(days),**{k:[v]*len(days) for k,v in values.items()}},
            'daily_units':{k:v[1] for k,v in DAY_FIELDS.items()}}


class OutdoorPlanningTests(unittest.TestCase):
    def setUp(self):
        parent=Path(__file__).resolve().parents[1]/'test-output/outdoor-planning'
        parent.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.store=RagStore(self.root/'rag.sqlite3')
        self.retriever=RagRetriever(self.store)
        self.store.put_document(namespace='shared',visibility='shared',domain='outdoor',title='测试山｜历史管制记录',
            text='测试山路线曾因降雪封闭。该历史通知不能证明当前允许通行。',
            source_ref='https://example.gov.cn/historic-notice')
        self.store.put_document(namespace='shared',visibility='shared',domain='outdoor',title='测试山｜装备资料',
            text='测试山徒步装备资料：保暖和防雨层需要分开准备。此为一般建议，不是完整个人装备清单。',
            source_ref='https://example.gov.cn/equipment')
        self.store.put_document(namespace='other-user',domain='outdoor',title='其他人私人行程',
            text='测试山徒步路线装备：他人的私人电话不得出现在结果中。',source_ref='private-note')
        self.fetch=Mock(return_value=json.dumps(response()).encode())
        self.forecast=ECMWFDailyForecast(fetcher=self.fetch,clock=lambda:NOW)
        self.climate_fetch=Mock(side_effect=AssertionError('Query must never fetch history'))
        self.climate=ClimateHistory(self.root/'climate.sqlite3',clock=lambda:NOW,fetcher=self.climate_fetch)
        self.args={'destination_id':'test-mountain','start_date':'2026-11-07','end_date':'2026-11-08'}

    def tool(self,**kwargs):
        options={'locations':{'test-mountain':PLACE},'location_names':{'test-mountain':'测试山'},
            'retriever':self.retriever,'namespace':'reader-user','climate_service':self.climate,
            'forecast_provider':self.forecast,'allow_shared':True,'allow_weather':True,'clock':lambda:NOW}
        options.update(kwargs)
        return build_outdoor_planning_tool(**options)

    def test_real_tool_separates_forecast_climate_route_and_gear(self):
        result=self.tool().invoke(self.args)
        self.assertEqual(result['forecast']['status'],'ok')
        self.assertEqual(result['forecast']['days'][0]['temperature_min_c'],-3)
        self.assertEqual(result['seasonal_normals'][0]['status'],'unavailable')
        self.assertEqual(result['route_access']['current_open_status'],'unknown')
        self.assertTrue(result['route_access']['evidence'])
        self.assertTrue(result['equipment_evidence']['evidence'])
        self.assertEqual(result['answer_status'],'needs_verification')
        self.assertIn('route_variant',result['missing_fields'])
        self.assertIn('safe_to_go',result['unsupported_conclusions'])
        self.assertNotIn('私人电话',json.dumps(result,ensure_ascii=False))
        self.climate_fetch.assert_not_called()
        url=self.fetch.call_args.args[0]
        self.assertEqual(urlsplit(url).netloc,'api.open-meteo.com')
        query=parse_qs(urlsplit(url).query)
        self.assertEqual(query['models'],['ecmwf_ifs'])
        self.assertEqual(query['start_date'],['2026-11-07'])
        self.assertEqual(query['end_date'],['2026-11-08'])

    def test_climate_values_never_replace_missing_forecast(self):
        climate=Mock()
        climate.normals.return_value={'schema_version':'climate.normals.v1','status':'ok',
            'source':{'kind':'reanalysis','model':'ERA5'},'period':{'start_year':1991,'end_year':2020},
            'months':[{'month':1,'temperature_mean_c':5,'precipitation_mm':10}]}
        result=self.tool(climate_service=climate).invoke({**self.args,'start_date':'2027-01-07','end_date':'2027-01-08'})
        self.assertEqual(result['forecast']['days'],[])
        self.assertEqual(result['forecast']['error_code'],'FORECAST_DATES_OUTSIDE_HORIZON')
        self.assertEqual(result['seasonal_normals'][0]['months'][0]['precipitation_mm'],10)
        self.assertIn('complete_actual_forecast',result['missing_fields'])
        self.fetch.assert_not_called()
        climate.normals.assert_called_once_with(PLACE,month=1,start_year=1991,end_year=2020)

    def test_actual_coverage_does_not_fill_missing_dates(self):
        self.fetch.return_value=json.dumps(response(('2026-11-07',))).encode()
        result=self.tool().invoke(self.args)
        self.assertEqual(result['forecast']['status'],'partial')
        self.assertEqual(result['forecast']['missing_dates'],['2026-11-08'])
        self.assertEqual(len(result['forecast']['days']),1)

    def test_partial_horizon_only_fetches_overlap(self):
        self.fetch.return_value=json.dumps(response(('2026-11-19',))).encode()
        result=self.forecast.daily(PLACE,'2026-11-19','2026-11-21')
        self.assertEqual(result['missing_dates'],['2026-11-20','2026-11-21'])
        self.assertEqual(parse_qs(urlsplit(self.fetch.call_args.args[0]).query)['end_date'],['2026-11-19'])

    def test_wrong_units_are_missing_not_relabelled(self):
        data=response();data['daily_units']['wind_speed_10m_max']='km/h'
        self.fetch.return_value=json.dumps(data).encode()
        result=self.tool().invoke(self.args)['forecast']
        self.assertEqual(result['status'],'partial')
        self.assertIsNone(result['days'][0]['wind_max_ms'])
        self.assertIn('2026-11-07.wind_max_ms',result['missing_fields'])

    def test_wrong_location_invalid_date_and_http_failure_are_contained(self):
        data=response();data['latitude']=35
        self.fetch.return_value=json.dumps(data).encode()
        self.assertEqual(self.tool().invoke(self.args)['forecast']['status'],'unavailable')
        data=response();data['daily']['time'][1]='2026-11-09'
        self.fetch.return_value=json.dumps(data).encode()
        self.assertEqual(self.tool().invoke(self.args)['forecast']['status'],'unavailable')
        self.fetch.side_effect=RuntimeError('secret/path/token')
        result=self.tool().invoke(self.args)
        self.assertEqual(result['forecast']['error_code'],'FORECAST_SOURCE_UNAVAILABLE')
        self.assertNotIn('secret/path/token',json.dumps(result))

    def test_permission_and_unknown_destination_prevent_all_io(self):
        self.assertEqual(self.tool(allow_weather=False).invoke(self.args)['status'],'denied')
        self.assertEqual(self.tool().invoke({**self.args,'destination_id':'unknown'})['error_code'],'DESTINATION_NOT_BOUND')
        self.fetch.assert_not_called()
        self.climate_fetch.assert_not_called()

    def test_tool_schema_rejects_authority_and_unbounded_inputs(self):
        for args in ({**self.args,'namespace':'other-user'}, {**self.args,'url':'http://127.0.0.1'},
                     {**self.args,'end_date':'2026-11-30'}, {**self.args,'start_date':'2026-02-30'},
                     {**self.args,'experience':'expert-guaranteed-safe'}):
            with self.assertRaises(ValidationError): self.tool().invoke(args)
        self.fetch.assert_not_called()

    def test_route_constraints_retained_and_deleted_evidence_disappears(self):
        args={**self.args,'route_variant':'只到观景台','overnight':False,'experience':'regular','max_altitude_m':3500}
        for row in self.store.active_chunks(namespace='reader-user',domain='outdoor',include_shared=True):
            self.store.delete_document(row['doc_id'],namespace='shared')
        result=self.tool().invoke(args)
        self.assertEqual(result['requirements']['route_variant'],'只到观景台')
        self.assertNotIn('experience',result['missing_fields'])
        self.assertNotIn('overnight',result['missing_fields'])
        self.assertEqual(result['route_access']['evidence'],[])
        self.assertIn('equipment_source_evidence',result['missing_fields'])

    def test_private_evidence_is_not_exported_to_tool_callbacks(self):
        class Capture(BaseCallbackHandler):
            def __init__(self): self.events=[]
            def on_tool_start(self,*args,**kwargs): self.events.append('input')
            def on_tool_end(self,*args,**kwargs): self.events.append('output')
        capture=Capture()
        result=self.tool().invoke(self.args,config={'callbacks':[capture]})
        self.assertTrue(result['route_access']['evidence'])
        self.assertEqual(capture.events,[])

    def test_all_null_days_are_not_reported_as_available_forecast(self):
        data=response()
        for key in DAY_FIELDS: data['daily'][key]=[None,None]
        self.fetch.return_value=json.dumps(data).encode()
        result=self.tool().invoke(self.args)['forecast']
        self.assertEqual(result['status'],'unavailable')
        self.assertEqual(result['error_code'],'FORECAST_DATA_MISSING')
        self.assertEqual(result['days'],[])
        self.assertEqual(result['missing_dates'],['2026-11-07','2026-11-08'])
        data['daily']['temperature_2m_min'][0]=-3
        self.fetch.return_value=json.dumps(data).encode()
        result=self.tool().invoke(self.args)['forecast']
        self.assertEqual(result['status'],'partial')
        self.assertEqual([row['date'] for row in result['days']],['2026-11-07'])
        self.assertEqual(result['missing_dates'],['2026-11-08'])

    def test_cross_year_months_follow_trip_order_and_isolate_one_failure(self):
        self.forecast.clock=lambda:datetime(2026,12,30,tzinfo=timezone.utc).timestamp()
        self.fetch.return_value=json.dumps(response(('2026-12-31','2027-01-01'))).encode()
        climate=Mock()
        climate.normals.side_effect=[{'status':'partial','period':{'start_year':1991,'end_year':2020},
            'months':[{'month':12,'temperature_mean_c':-2,'valid_years':2,'coverage':.0667}]},
            RuntimeError('provider-error-with-secret')]
        result=self.tool(climate_service=climate).invoke({**self.args,'start_date':'2026-12-31','end_date':'2027-01-01'})
        self.assertEqual(result['forecast']['status'],'ok')
        self.assertEqual([value['requested_month'] for value in result['seasonal_normals']],[12,1])
        self.assertEqual([value['trip_dates'] for value in result['seasonal_normals']],[['2026-12-31'],['2027-01-01']])
        self.assertEqual(result['seasonal_normals'][0]['months'][0]['valid_years'],2)
        self.assertEqual(result['seasonal_normals'][1]['status'],'unavailable')
        self.assertIn('climate_normal_month_12',result['missing_fields'])
        self.assertIn('climate_normal_month_1',result['missing_fields'])
        self.assertTrue(result['route_access']['evidence'])
        self.assertNotIn('provider-error-with-secret',json.dumps(result))

    def test_malformed_provider_results_cannot_abort_other_sources(self):
        forecast=Mock();forecast.daily.return_value=None
        result=self.tool(forecast_provider=forecast).invoke(self.args)
        self.assertEqual(result['forecast']['status'],'unavailable')
        self.assertTrue(result['equipment_evidence']['evidence'])
        climate=Mock();climate.normals.return_value=None
        result=self.tool(climate_service=climate).invoke(self.args)
        self.assertEqual(result['forecast']['status'],'ok')
        self.assertEqual(result['seasonal_normals'][0]['status'],'unavailable')
        climate.normals.return_value={'status':'ok','period':{'start_year':1991,'end_year':2020},
                                    'months':[{'month':1,'precipitation_mm':9}]}
        result=self.tool(climate_service=climate).invoke(self.args)
        self.assertEqual(result['seasonal_normals'][0]['status'],'unavailable')
        self.assertEqual(result['seasonal_normals'][0]['months'],[])

    def test_forecast_horizon_uses_china_local_calendar(self):
        self.forecast.clock=lambda:datetime(2026,11,5,17,tzinfo=timezone.utc).timestamp()
        self.fetch.return_value=json.dumps(response(('2026-11-06',))).encode()
        result=self.forecast.daily(PLACE,'2026-11-05','2026-11-06')
        self.assertEqual(result['timezone'],'Asia/Shanghai')
        self.assertEqual(result['missing_dates'],['2026-11-05'])
        query=parse_qs(urlsplit(self.fetch.call_args.args[0]).query)
        self.assertEqual(query['start_date'],['2026-11-06'])

    def test_ambiguous_operator_permission_and_mixed_timezones_fail_closed(self):
        self.assertEqual(self.tool(allow_weather='false').invoke(self.args)['status'],'denied')
        with self.assertRaisesRegex(ValueError,'OUTDOOR_TIMEZONE_UNSUPPORTED'):
            self.tool(locations={'test-mountain':ClimateLocation('fixture-point',30,102,'UTC')})
        self.fetch.assert_not_called()

    def test_fourteen_day_cross_month_report_preserves_dates_and_fits_protocol(self):
        from datetime import date,timedelta
        first=date(2026,11,25)
        days=[{'date':(first+timedelta(days=i)).isoformat(),'temperature_min_c':-100,'temperature_max_c':70,
            'precipitation_mm':3000,'gust_max_ms':200} for i in range(14)]
        long_url='https://example.gov.cn/'+('a'*170)
        value={'requirements':{'destination_id':'beijing','start_date':'2026-11-25','end_date':'2026-12-08'},
            'forecast':{'status':'ok','days':days,'source':{'documentation':long_url}},
            'seasonal_normals':[{'requested_month':month,'status':'ok','period':{'complete':True},
                'source':{'url':'https://climate.example.gov.cn/'+('b'*160)},
                'months':[{'month':month,'temperature_mean_c':-5.401,'precipitation_mm':3000}]} for month in (11,12)],
            'equipment_evidence':{'evidence':[{'text':'需要核对。'*85,'source_ref':'https://equipment.example.gov.cn/'+('c'*150)}]},
            'missing_fields':['route_variant','overnight','experience']}
        text=format_trip_report(value,location_names={'beijing':'甲'*80})
        self.assertLessEqual(len(text),1600)
        for row in days:self.assertIn(row['date'][5:],text)
        self.assertIn('具体线路',text)
        self.assertIn('1991–2020',text)
        self.assertIn('-5.4',text);self.assertNotIn('-5.401',text)
        self.assertIn(long_url,text)

    def test_report_rejects_unsafe_source_links(self):
        value=self.tool().invoke(self.args)
        for url in ('https://user:secret@example.com/a','https:///missing-host','https://example.com/a\nsecret'):
            value['forecast']['source']['documentation']=url
            text=format_trip_report(value)
            self.assertNotIn(url,text)
            self.assertNotIn('secret',text)


if __name__=='__main__':
    unittest.main()
