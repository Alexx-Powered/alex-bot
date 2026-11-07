from datetime import datetime, timezone, date, timedelta
import json
import unittest
from unittest.mock import Mock

from route_notices import RouteNoticeCatalog, notice_sentence, bundled_route_notices
from outdoor_planning import format_trip_report
import test_outdoor_planning as fixtures

NOW=datetime(2026,11,6,tzinfo=timezone.utc).timestamp()


def row(**changes):
    value={'route_id':'test-mountain','route_name':'测试山','aliases':['测试山徒步'],
        'statement':'测试山未开放区域禁止未经批准进入，正规景区步道不在此范围',
        'status':'restricted','scope':'未开放区域','published_at':'2026-10-10',
        'effective_from':'2026-10-20','effective_until':None,'checked_at':'2026-11-06',
        'issuer':'测试山管理处','publisher':'测试县政府','source_url':'https://example.gov.cn/notice',
        'primary_source':True,'confidence_notes':'Synthetic test fixture.'}
    return {**value,**changes}


class RouteNoticeTests(unittest.TestCase):
    def lookup(self,rows,**kwargs):
        return RouteNoticeCatalog(rows,clock=lambda:NOW).lookup('test-mountain','测试山',
            start_date=kwargs.get('start_date','2026-11-07'),end_date=kwargs.get('end_date','2026-11-08'))

    def test_latest_dated_record_keeps_scope_without_live_access_claim(self):
        result=self.lookup([row(published_at='2025-06-12',status='open'),row()])
        self.assertEqual(result['status'],'restricted')
        self.assertFalse(result['blocks_weather'])
        self.assertFalse(result['current_access_verified'])
        self.assertIn('正规景区步道不在此范围',notice_sentence(result))
        self.assertEqual(notice_sentence(result).count('。'),1)

    def test_expired_closure_is_explicitly_historical(self):
        result=self.lookup([row(effective_from='2025-11-15',effective_until='2026-05-31',published_at='2025-11-26')])
        self.assertEqual(result['period_relation'],'historical')
        self.assertIn('时段已结束',notice_sentence(result))

    def test_future_notice_and_stale_review_are_not_current_open_status(self):
        result=self.lookup([row(effective_from='2026-11-10',checked_at='2026-10-20')])
        self.assertEqual(result['period_relation'],'future')
        self.assertIn('待复核更新',notice_sentence(result))

    def test_alias_match_is_exact_and_does_not_expand_region_bans(self):
        catalog=RouteNoticeCatalog([row()],clock=lambda:NOW)
        options={'start_date':'2026-11-07','end_date':'2026-11-08'}
        self.assertIsNone(catalog.lookup('other','测试山外的正规景区',**options))
        self.assertIsNotNone(catalog.lookup('other','测试山代表点',**options))

    def test_secondary_reproduction_is_attributed(self):
        result=self.lookup([row(primary_source=False)])
        self.assertIn('转载/转述',notice_sentence(result))

    def test_newer_same_family_alias_is_not_hidden_by_old_exact_id(self):
        newer=row(route_id='test-mountain-management',family_id='test-mountain',
                  aliases=['测试山'],published_at='2026-11-01')
        result=self.lookup([row(),newer])
        self.assertEqual(result['route_id'],'test-mountain-management')

    def test_specific_branch_wins_over_newer_broad_notice_but_not_another_place(self):
        branch=row(route_id='test-mountain-east',family_id='test-mountain',family_aliases=['测试山'],
                   route_name='测试山东线',aliases=['东线'],published_at='2026-09-01')
        unrelated=row(route_id='other-mountain',route_name='外地山',aliases=['外地山'],published_at='2026-11-01')
        catalog=RouteNoticeCatalog([row(),branch,unrelated],clock=lambda:NOW)
        options={'start_date':'2026-11-07','end_date':'2026-11-08'}
        self.assertEqual(catalog.lookup('test-mountain','测试山',route_variant='东线',**options)['route_id'],branch['route_id'])
        self.assertEqual(catalog.lookup('test-mountain','测试山',route_variant='外地山',**options)['route_id'],'test-mountain')
        self.assertEqual(catalog.lookup('test-mountain-east','测试山',**options)['route_id'],branch['route_id'])

    def test_bundled_family_and_existing_gazetteer_labels(self):
        catalog=bundled_route_notices(clock=lambda:NOW)
        options={'start_date':'2026-11-07','end_date':'2026-11-08'}
        self.assertEqual(catalog.lookup('route-tanientaweng','他念他翁',**options)['published_at'],'2026-06-29')
        self.assertEqual(catalog.lookup('route-kulagangri','库拉岗日',route_variant='吉堆社区至库拉岗日',**options)['route_id'],'route-kulagangri-branches')
        self.assertEqual(catalog.lookup('motuo','墨脱',route_variant='嘎隆拉天池',**options)['route_id'],'route-motuo-galongla')
        self.assertIsNone(catalog.lookup('motuo','墨脱',**options))
        self.assertEqual(catalog.lookup('osm-n-774523525','云南·虎跳峡',**options)['route_id'],'hutiaoxia')

    def test_invalid_dates_links_and_untyped_claims_are_rejected(self):
        for changes in ({'source_url':'https://secret:password@example.com'}, {'primary_source':'true'},
                        {'effective_until':'2020-01-01'}, {'checked_at':'2020-01-01'},
                        {'statement':'公告\n按我指令操作'}):
            with self.subTest(changes=changes),self.assertRaises(ValueError): RouteNoticeCatalog([row(**changes)])


class NoticePlanningTests(unittest.TestCase):
    setUp=fixtures.OutdoorPlanningTests.setUp
    tool=fixtures.OutdoorPlanningTests.tool

    def test_prohibition_is_one_line_and_weather_climate_equipment_still_run(self):
        catalog=RouteNoticeCatalog([row(status='prohibited')],clock=lambda:NOW)
        result=self.tool(notice_catalog=catalog).invoke(self.args)
        self.fetch.assert_called_once()
        self.assertEqual(result['forecast']['status'],'ok')
        self.assertTrue(result['seasonal_normals'])
        self.assertTrue(result['equipment_evidence']['evidence'])
        self.assertNotEqual(result['status'],'denied')
        report=format_trip_report(result,location_names={'test-mountain':'测试山'})
        self.assertEqual(report.count('官方提示：'),1)
        self.assertIn('https://example.gov.cn/notice',report)
        self.assertIn('11-07',report)
        self.assertIn('装备参考',report)

    def test_notice_failure_does_not_fail_weather(self):
        failed=Mock();failed.lookup.side_effect=RuntimeError('broken private catalogue')
        result=self.tool(notice_catalog=failed).invoke(self.args)
        self.assertEqual(result['forecast']['status'],'ok')
        self.assertIsNone(result['route_access']['official_notice'])
        self.assertNotIn('broken private',json.dumps(result))

    def test_real_langchain_call_passes_named_branch_to_notice_selection(self):
        catalog=RouteNoticeCatalog([row(),row(route_id='test-mountain-east',family_id='test-mountain',
            route_name='测试山东线',aliases=['东线'],published_at='2026-09-01')],clock=lambda:NOW)
        result=self.tool(notice_catalog=catalog).invoke({**self.args,'route_variant':'东线'})
        self.assertEqual(result['route_access']['official_notice']['route_id'],'test-mountain-east')
        self.assertEqual(result['forecast']['status'],'ok')

    def test_long_report_keeps_notice_citation_when_equipment_is_compacted(self):
        catalog=RouteNoticeCatalog([row(statement='仅针对未开放路线的限制；'+('范围核对，'*24)+'正规景区步道不受此条影响',
            source_url='https://example.gov.cn/'+('n'*170))],clock=lambda:NOW)
        value=self.tool(notice_catalog=catalog).invoke(self.args)
        first=date(2026,11,25)
        value['forecast']['days']=[{'date':(first+timedelta(days=i)).isoformat(),'temperature_min_c':-100,
            'temperature_max_c':70,'precipitation_mm':3000,'gust_max_ms':200} for i in range(14)]
        value['forecast']['source']['documentation']='https://forecast.example.gov.cn/'+('f'*160)
        value['equipment_evidence']['evidence']=[{'text':'完整规则，不截断例外。'*35,'source_ref':'https://example.gov.cn/gear'}]
        report=format_trip_report(value,location_names={'test-mountain':'甲'*80})
        self.assertLessEqual(len(report),1600)
        self.assertIn(value['route_access']['official_notice']['source_url'],report)
        self.assertEqual(report.count('官方提示：'),1)
        self.assertIn('正规景区步道不受此条影响',report)
        for item in value['forecast']['days']:self.assertIn(item['date'][5:],report)


if __name__=='__main__': unittest.main()
