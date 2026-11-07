import calendar
from datetime import date,datetime,timedelta,timezone
import json
from pathlib import Path
import tempfile
import unittest

from pydantic import ValidationError
from climate_history import (ClimateHistory,ClimateLocation,ClimateError,aggregate_year,
    build_climate_normals_tool,FIELDS,SOURCE,TTL_SECONDS)
from climate_history import run_refresh_loop,latest_available_year


def fixture(location,year):
    count=366 if calendar.isleap(year) else 365
    return {'latitude':location.latitude,'longitude':location.longitude,'elevation':3300,
        'utc_offset_seconds':28800,'daily_units':dict(zip(FIELDS,('°C','mm','m/s'))),
        'daily':{'time':[(date(year,1,1)+timedelta(days=i)).isoformat() for i in range(count)],
            FIELDS[0]:[10+(year-1991)*.1]*count,FIELDS[1]:[2]*count,FIELDS[2]:[3]*count}}


class ClimateHistoryTests(unittest.TestCase):
    def setUp(self):
        parent=Path(__file__).resolve().parents[1]/'test-output/climate-tests';parent.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=parent);self.path=Path(self.temp.name)/'climate.sqlite3'
        self.now=datetime(2026,11,6,tzinfo=timezone.utc).timestamp()
        self.calls=[];self.location=ClimateLocation('synthetic-point',31,101)
        def fetch(location,year):
            self.calls.append(year);return fixture(location,year)
        self.service=ClimateHistory(self.path,clock=lambda:self.now,fetcher=fetch)

    def tearDown(self):self.temp.cleanup()

    def test_partial_backfill_never_claims_complete_baseline(self):
        result=self.service.refresh(self.location,max_years=2)
        self.assertEqual(result['refreshed_years'],[1991,1992])
        self.assertEqual(len(self.calls),2)
        report=self.service.normals(self.location,month=10)
        self.assertEqual(report['status'],'partial')
        self.assertFalse(report['period']['complete'])
        self.assertEqual(report['period']['baseline_kind'],'incomplete_sample')
        self.assertEqual(report['months'][0]['valid_years'],2)
        self.assertAlmostEqual(report['months'][0]['coverage'],2/30,places=4)
        self.assertFalse(report['source']['is_cma_station_observation'])
        self.assertIsNone(report['months'][0]['trend']['temperature_c'])

    def test_full_period_and_descriptive_trend(self):
        for _ in range(4):self.service.refresh(self.location,1991,2000,max_years=3)
        result=self.service.normals(self.location,month=2,start_year=1991,end_year=2000)
        self.assertTrue(result['period']['complete'])
        self.assertEqual(result['period']['kind'],'custom_history')
        self.assertEqual(result['period']['baseline_kind'],'custom_history_sample')
        month=result['months'][0]
        self.assertEqual(month['valid_years'],10)
        self.assertAlmostEqual(month['trend']['temperature_c']['per_decade'],1)
        self.assertFalse(month['trend']['temperature_c']['is_forecast'])
        self.assertFalse(month['trend']['temperature_c']['significance_tested'])
        self.assertEqual(self.service.refresh(self.location,1991,2000)['status'],'cached')

    def test_complete_year_window_and_reversed_period_rejected(self):
        for start,end in [(2026,2026),(2020,1991),(1939,1940),(1940,2020)]:
            with self.subTest(start=start,end=end),self.assertRaises(ClimateError):self.service.refresh(self.location,start,end)
        with self.assertRaises(ClimateError):self.service.refresh(self.location,max_years=30)
        self.assertEqual(self.calls,[])

    def test_no_data_query_does_not_fetch(self):
        result=self.service.normals(self.location,month=11)
        self.assertEqual(result['status'],'unavailable')
        self.assertIsNone(result['months'][0]['temperature_mean_c'])
        self.assertEqual(self.calls,[])

    def test_refresh_failure_preserves_old_data_marked_stale_and_backoff(self):
        self.service.refresh(self.location,1991,1991)
        old=self.service.normals(self.location,month=10,start_year=1991,end_year=1991)
        self.now+=TTL_SECONDS+1
        def fail(*args):raise OSError('secret upstream details must not leak')
        self.service.fetcher=fail
        self.assertEqual(self.service.refresh(self.location,1991,1991)['error_code'],'CLIMATE_SOURCE_UNAVAILABLE')
        result=self.service.normals(self.location,month=10,start_year=1991,end_year=1991)
        self.assertEqual(result['months'],old['months'])
        self.assertEqual(result['freshness']['state'],'stale')
        self.assertEqual(self.service.refresh(self.location,1991,1991)['status'],'backoff')
        self.assertNotIn('secret',json.dumps(result))

    def test_refresh_lease_blocks_concurrent_worker(self):
        nested=[]
        other=ClimateHistory(self.path,clock=lambda:self.now,fetcher=lambda *args:self.fail('duplicate fetch'))
        def fetch(location,year):
            nested.append(other.refresh(location,1991,1991)['status'])
            return fixture(location,year)
        self.service.fetcher=fetch
        self.assertEqual(self.service.refresh(self.location,1991,1991)['status'],'ok')
        self.assertEqual(nested,['busy'])

    def test_expired_lease_cannot_commit(self):
        def fetch(location,year):
            self.now+=100;return fixture(location,year)
        self.service.fetcher=fetch
        self.assertEqual(self.service.refresh(self.location,1991,1991)['error_code'],'CLIMATE_LEASE_LOST')
        self.assertEqual(self.service.normals(self.location,month=10,start_year=1991,end_year=1991)['status'],'unavailable')

    def test_missing_precip_days_not_extrapolated_or_marked_complete(self):
        def fetch(location,year):
            payload=fixture(location,year);payload['daily'][FIELDS[1]][0]=None;return payload
        self.service.fetcher=fetch;self.service.refresh(self.location,1991,1991)
        result=self.service.normals(self.location,month=1,start_year=1991,end_year=1991)
        self.assertIsNone(result['months'][0]['precipitation_mm'])
        self.assertFalse(result['period']['complete'])
        self.assertEqual(result['months'][0]['valid_years'],0)

    def test_lower_coverage_does_not_replace_cached_year(self):
        self.service.refresh(self.location,1991,1991);self.now+=TTL_SECONDS+1
        def fetch(location,year):
            payload=fixture(location,year);payload['daily'][FIELDS[1]][0]=None;return payload
        self.service.fetcher=fetch
        self.assertEqual(self.service.refresh(self.location,1991,1991)['error_code'],'CLIMATE_COVERAGE_REGRESSION')
        result=self.service.normals(self.location,month=1,start_year=1991,end_year=1991)
        self.assertEqual(result['months'][0]['precipitation_mm'],62)
        self.assertEqual(result['freshness']['state'],'stale')

    def test_date_units_and_location_checks(self):
        for mutate in [lambda p:p['daily']['time'].pop(),lambda p:p['daily_units'].update(precipitation_sum='inch'),
                       lambda p:p.update(latitude=10),lambda p:p['daily'][FIELDS[0]].__setitem__(0,float('nan'))]:
            payload=fixture(self.location,1991);mutate(payload)
            with self.assertRaises(ClimateError):aggregate_year(payload,self.location,1991)

    def test_place_identity_cannot_silently_change(self):
        self.service.normals(self.location)
        with self.assertRaisesRegex(ClimateError,'CLIMATE_PLACE_CHANGED'):
            self.service.normals(ClimateLocation(self.location.place_id,32,101))

    def test_model_grid_cannot_change_between_years(self):
        self.service.refresh(self.location,1991,1991)
        def shifted(location,year):
            payload=fixture(location,year);payload['latitude']+=.25;return payload
        self.service.fetcher=shifted
        result=self.service.refresh(self.location,1992,1992)
        self.assertEqual(result['error_code'],'CLIMATE_GRID_CHANGED')
        self.assertEqual(self.service.normals(self.location,start_year=1991,end_year=1992)['period']['available_years'],1)

    def test_langchain_tool_bound_catalog_and_strict_arguments(self):
        tool=build_climate_normals_tool(self.service,{self.location.place_id:self.location})
        result=tool.invoke({'place_id':self.location.place_id,'month':10})
        self.assertEqual(result['status'],'unavailable')
        self.assertEqual(tool.invoke({'place_id':'unknown'})['missing_fields'],['trusted_location'])
        for args in [{'place_id':self.location.place_id,'month':13},{'place_id':self.location.place_id,'month':'10'},
                     {'place_id':self.location.place_id,'latitude':0}]:
            with self.assertRaises(ValidationError):tool.invoke(args)
        self.assertEqual(self.calls,[])

    def test_source_lag_excludes_unavailable_new_year(self):
        self.now=datetime(2027,1,3,tzinfo=timezone.utc).timestamp()
        self.assertEqual(latest_available_year(self.now),2025)
        with self.assertRaises(ClimateError):self.service.refresh(self.location,2026,2026)
        self.now=datetime(2027,1,8,tzinfo=timezone.utc).timestamp()
        self.assertEqual(latest_available_year(self.now),2026)

    def test_watch_stops_and_caps_each_tick(self):
        class Stop:
            stopped=False
            def is_set(inner):return inner.stopped
            def wait(inner,seconds):
                self.assertEqual(seconds,60);inner.stopped=True;return True
        stop=Stop();results=[]
        runs=run_refresh_loop(self.service,self.location,max_years=1,interval_seconds=60,
            max_runs=0,stop_event=stop,on_result=results.append)
        self.assertEqual(runs,1)
        self.assertEqual(self.calls,[1991])
        self.assertEqual(len(results),1)

    def test_watch_latest_and_reference_recent_are_separate(self):
        runs=run_refresh_loop(self.service,self.location,start_year=2025,end_year='latest',max_years=1,max_runs=1)
        self.assertEqual(runs,1);self.assertEqual(self.calls,[2025])
        comparison=self.service.reference_and_recent(self.location,month=10)
        self.assertEqual(comparison['reference']['period']['start_year'],1991)
        self.assertEqual(comparison['reference']['period']['end_year'],2020)
        self.assertEqual(comparison['reference']['status'],'unavailable')
        self.assertEqual(comparison['recent']['period']['start_year'],2021)
        self.assertEqual(comparison['recent']['period']['end_year'],2025)
        self.assertFalse(comparison['recent']['period']['complete'])
        self.assertEqual(comparison['recent']['period']['kind'],'custom_history')

    def test_missing_year_retry_is_bounded_and_operator_can_resume(self):
        def fail(location,year):self.calls.append(year);raise OSError('unavailable')
        self.service.fetcher=fail
        self.assertEqual(self.service.refresh(self.location,1991,1991)['status'],'failed')
        self.assertEqual(self.service.refresh(self.location,1991,1991)['status'],'backoff')
        self.now+=3600
        self.assertEqual(self.service.refresh(self.location,1991,1991)['status'],'failed')
        self.now+=3600
        self.assertEqual(self.service.refresh(self.location,1991,1991)['status'],'backoff')
        self.assertEqual(len(self.calls),2)
        self.now+=3600
        self.assertEqual(self.service.refresh(self.location,1991,1991)['status'],'failed')
        self.now+=86400
        parked=self.service.refresh(self.location,1991,1991)
        self.assertEqual(parked['status'],'needs_attention')
        self.assertEqual(parked['blocked_years'],[1991])
        self.assertEqual(len(self.calls),3)
        self.assertIn('refresh_requires_operator_retry',self.service.normals(self.location,start_year=1991,end_year=1991)['missing_fields'])
        self.service.fetcher=fixture
        self.assertEqual(self.service.retry_failed(self.location,1991,1991),1)
        self.assertEqual(self.service.refresh(self.location,1991,1991)['status'],'ok')

    def test_failed_year_does_not_starve_other_missing_years(self):
        def fetch(location,year):
            self.calls.append(year)
            if year==1991:raise OSError('year unavailable')
            return fixture(location,year)
        self.service.fetcher=fetch
        self.service.refresh(self.location,1991,1992,max_years=1)
        self.now+=3600
        self.assertEqual(self.service.refresh(self.location,1991,1992,max_years=1)['refreshed_years'],[1992])
        self.assertEqual(self.calls,[1991,1992])

    def test_month_coverage_regression_not_hidden_by_other_month_improvement(self):
        def original(location,year):
            payload=fixture(location,year);payload['daily'][FIELDS[0]][40]=None;return payload
        self.service.fetcher=original;self.service.refresh(self.location,1991,1991)
        self.now+=TTL_SECONDS+1
        def changed(location,year):
            payload=fixture(location,year);payload['daily'][FIELDS[0]][0]=None;return payload
        self.service.fetcher=changed
        self.assertEqual(self.service.refresh(self.location,1991,1991)['error_code'],'CLIMATE_COVERAGE_REGRESSION')
        january=self.service.normals(self.location,month=1,start_year=1991,end_year=1991)
        self.assertEqual(january['months'][0]['sample_coverage'][FIELDS[0]],1)

    def test_watch_advances_to_new_available_year_and_reuses_fresh_cache(self):
        self.now=datetime(2026,12,31,tzinfo=timezone.utc).timestamp()
        class Advance:
            def is_set(inner):return False
            def wait(inner,seconds):
                self.now=datetime(2027,1,8,tzinfo=timezone.utc).timestamp();return False
        results=[]
        runs=run_refresh_loop(self.service,self.location,start_year=2025,end_year='latest',max_years=1,
            max_runs=2,interval_seconds=60,stop_event=Advance(),on_result=results.append)
        self.assertEqual(runs,2)
        self.assertEqual(self.calls,[2025,2026])
        self.assertEqual(self.service.refresh(self.location,2025,2026)['status'],'cached')

    def test_clock_rollback_does_not_leave_future_cache_permanently_fresh(self):
        self.service.refresh(self.location,1991,1991)
        self.now-=3600
        self.assertEqual(self.service.normals(self.location,start_year=1991,end_year=1991)['freshness']['state'],'stale')
        self.assertEqual(self.service.refresh(self.location,1991,1991)['refreshed_years'],[1991])


if __name__=='__main__':unittest.main()
