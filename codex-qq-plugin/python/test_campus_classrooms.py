import copy
import io
import json
import tempfile
import unittest
from datetime import datetime,timezone,timedelta
from pathlib import Path
from unittest.mock import patch
from pydantic import ValidationError
from campus_classrooms import build_query_tool,normalize,CampusError,query_day,SCHEMA,login_failure
from campus_report import observations,render_report
from campus_worker import process

CLOCK=datetime(2026,10,29,15,0,tzinfo=timezone(timedelta(hours=8)))
CREDS={'enabled':True,'username':'offline-student','password':'offline-password'}
PAYLOAD={'e':0,'d':{'list':{'三号楼':[{'name':'(三)105','kxsds':'1,6,7,8,9,10,11,12,13,14'},
    {'name':'(三)204','kxsds':'1,2,3,4,5,6,7,8,9,10,11,12,13,14'}],
    '主楼':[{'name':'主M101','kxsds':''}],'新主楼':[{'name':'B102','kxsds':'1,14'}]}}}

class CampusTests(unittest.TestCase):
    def tool(self,collector=None,credentials=CREDS):
        return build_query_tool(credentials,Path('unused-private'),clock=lambda:CLOCK,
            collector=collector or (lambda *_a,**_k:copy.deepcopy(PAYLOAD)))

    def test_real_langchain_tool_always_projects_fixed_json_without_credentials(self):
        result=self.tool().invoke({'date':'2026-10-29'})
        self.assertTrue(result['ok']);self.assertEqual(result['schema_version'],SCHEMA)
        self.assertEqual(result['buildings'],['三号楼','主楼','新主楼'])
        self.assertEqual(result['rooms'][0]['free_periods'],[1,6,7,8,9,10,11,12,13,14])
        self.assertEqual(result['rooms'][0]['busy_periods'],[2,3,4,5])
        self.assertEqual(result['rooms'][2]['busy_periods'],list(range(1,15)))
        self.assertNotIn('offline-student',json.dumps(result))
        self.assertNotIn('offline-password',json.dumps(result))
        self.assertEqual(set(result),{'schema_version','ok','code','campus','date','fetched_at','source','semantics','buildings','rooms'})

    def test_interface_free_marks_are_preserved_even_for_earlier_periods(self):
        result=normalize(PAYLOAD,'2026-10-29',CLOCK)
        data=observations(result)
        self.assertEqual(data['rows'][0]['slots'],'FBBBBFFFFFFFFF')
        self.assertEqual(len(data['rows']),2)
        self.assertNotIn('?',data['rows'][0]['slots'])

    def test_invalid_dates_and_unconfigured_disabled_accounts_never_access_network(self):
        def forbidden(*_a,**_k):raise AssertionError('must not reach network')
        self.assertEqual(self.tool(forbidden).invoke({'date':'2026-10-28'})['code'],'CAMPUS_INVALID_DATE')
        self.assertEqual(self.tool(forbidden).invoke({'date':'2026-11-06'})['code'],'CAMPUS_INVALID_DATE')
        self.assertEqual(self.tool(forbidden,{}).invoke({})['code'],'CAMPUS_NOT_CONFIGURED')
        self.assertEqual(self.tool(forbidden,{**CREDS,'enabled':False}).invoke({})['code'],'CAMPUS_DISABLED')
        self.assertEqual(query_day('',CLOCK),'2026-10-29')

    def test_tool_schema_does_not_accept_credentials_urls_or_paths(self):
        for args in [{'username':'not-allowed'},{'password':'not-allowed'},{'url':'https://example.invalid'},{'path':'C:/'}]:
            with self.subTest(args=list(args)):
                with self.assertRaises(ValidationError):self.tool().invoke(args)

    def test_api_errors_bad_periods_duplicate_rooms_and_wrong_shapes_fail_closed(self):
        cases=[{'e':1}, {'e':0,'d':{}}, {'e':0,'d':{'list':{'三号楼':[{'name':'105','kxsds':'15'}]}}},
            {'e':0,'d':{'list':{'三号楼':[{'name':'105','kxsds':''},{'name':'105','kxsds':'1'}]}}},
            {'e':0,'d':{'list':{'三号楼':[{'name':'105','kxsds':None}]}}}]
        for payload in cases:
            with self.subTest(payload=payload):
                result=self.tool(lambda *_a,**_k:payload).invoke({})
                self.assertFalse(result['ok']);self.assertEqual(result['rooms'],[])

    def test_auth_network_and_exception_details_are_never_exposed(self):
        for error in [CampusError('CAMPUS_AUTH_FAILED'),RuntimeError('offline-password and account data')]:
            def failed(*_a,**_k):raise error
            result=self.tool(failed).invoke({})
            self.assertFalse(result['ok'])
            self.assertNotIn('offline-password',json.dumps(result))
            self.assertEqual(result['rooms'],[])

    def test_login_redirect_detached_frame_is_not_a_network_or_auth_failure(self):
        from unittest.mock import MagicMock
        from playwright.sync_api import Error as BrowserError
        frame=MagicMock()
        frame.locator.return_value.inner_text.side_effect=BrowserError('Frame was detached during navigation')
        self.assertIsNone(login_failure(frame))
        frame.locator.return_value.inner_text.side_effect=None
        frame.locator.return_value.inner_text.return_value='用户名或密码错误'
        self.assertEqual(login_failure(frame),'CAMPUS_AUTH_FAILED')
        frame.locator.return_value.inner_text.return_value=''
        frame.locator.return_value.is_visible.return_value=True
        self.assertEqual(login_failure(frame),'CAMPUS_INTERACTION_REQUIRED')

    def test_renderer_reuses_six_tier_rules_and_excludes_204_without_skill_execution(self):
        from PIL import Image
        data=normalize(PAYLOAD,'2026-10-29',CLOCK)
        with tempfile.TemporaryDirectory() as temp:
            with patch('subprocess.run',side_effect=AssertionError('no skill or subprocess')):
                artifact=render_report(data,temp,demo=True)
            file=Path(temp)/'campus-output'/(artifact+'.png')
            with Image.open(file) as image:
                self.assertEqual(image.width,1800);self.assertLessEqual(image.height,16000)
            import plan
            result=plan.analyze(observations(data))
            self.assertNotIn('204',result['rooms'])
            top=result['sessions']['下午']['recommendations'][0]
            self.assertEqual(top['room'],'105');self.assertEqual(plan.recommendation_tier(top,result['rooms']),1)
            self.assertTrue(file.stat().st_size<1_500_000)
            self.assertEqual(json.loads((file.parent/'latest.json').read_text(encoding='utf-8'))['rooms'],data['rooms'])

    def test_dedicated_worker_returns_only_json_and_no_credential_echo(self):
        result=process({'type':'campus','mode':'query','args':{},'credentials':{}},collector=lambda *_a,**_k:PAYLOAD)
        self.assertEqual(result['kind'],'campus');self.assertIsNone(result['artifact_id'])
        self.assertEqual(result['data']['code'],'CAMPUS_NOT_CONFIGURED')

    def test_no_free_rooms_does_not_invent_recommendations(self):
        data=normalize({'e':0,'d':{'list':{'三号楼':[{'name':'105','kxsds':''}]}}},'2026-10-29',CLOCK)
        import sys
        from campus_report import SCRIPTS
        if str(SCRIPTS) not in sys.path:sys.path.insert(0,str(SCRIPTS))
        import plan
        result=plan.analyze(observations(data))
        self.assertEqual(data['rooms'][0]['free_periods'],[])
        self.assertTrue(all(not s['recommendations'] for s in result['sessions'].values()))

class CampusRoutingTests(unittest.TestCase):
    def test_owner_agent_routes_to_campus_without_campus_secrets_or_json_in_model(self):
        import agent_worker
        from test_agent_worker import ScriptedModel,call,packet
        model=ScriptedModel(responses=[call('buaa_classroom_query',{'date':'2026-10-29'})])
        calls=[]
        runner=agent_worker.build_runner(model_factory=lambda _c:model,rpc_callback=lambda *args:calls.append(args) or '本机图片已生成。')
        result=runner.run(packet(text='学院路现在有什么空教室，给我三号楼简报',context={'scope':'c2c'}))
        self.assertEqual(result['kind'],'tool');self.assertEqual(calls[0][2],'buaa_classroom_query')
        self.assertIn('buaa_classroom_query',model.bound[0]);self.assertEqual(len(model.seen),1)
        self.assertNotIn('offline-student',str(model.seen));self.assertNotIn('offline-password',str(model.seen))

    def test_group_agent_has_no_campus_tool(self):
        import agent_worker
        from test_agent_worker import ScriptedModel,call,packet
        model=ScriptedModel(responses=[call('clarify_or_ignore',{'reason':'ignore'})])
        runner=agent_worker.build_runner(model_factory=lambda _c:model,rpc_callback=lambda *_a:self.fail('no RPC'))
        result=runner.run(packet(text='查学院路空教室',context={'scope':'group','currentSpeaker':'member-123abc','groupContext':[]}))
        self.assertEqual(result['kind'],'ignore');self.assertNotIn('buaa_classroom_query',model.bound[0])

if __name__=='__main__':unittest.main()
