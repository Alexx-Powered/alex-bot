import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from openai_status import read_status
import agent_worker as worker
from test_agent_worker import ScriptedModel, packet, call
from langchain_core.messages import AIMessage

class StatusTests(unittest.TestCase):
    def test_general_question_has_no_unsolicited_history_and_arbitrary_names_work(self):
        events=[{'name':name+' degraded','status':'resolved','resolved_at':'2026-10-27T12:00:00Z'} for name in ['Example Model X','Unrelated Service']]
        fetch=self.feeds(events);now=datetime(2026,10,29,tzinfo=timezone.utc)
        self.assertEqual(read_status('codex','',fetch,now)['recent_resolved_incidents'],[])
        related=read_status('all','Example-Model-X',fetch,now)['recent_resolved_incidents']
        self.assertEqual(len(related),1);self.assertIn('Example Model X',related[0]['name'])
        self.assertEqual(read_status('all','Unknown Model',fetch,now)['recent_resolved_incidents'],[])
        self.assertEqual(len(read_status('all','',fetch,now,include_recent=True)['recent_resolved_incidents']),2)

    def feeds(self, incidents):
        return lambda path: {'components':[{'name':'Codex in ChatGPT Desktop','status':'operational'}],'status':{'indicator':'none','description':'All Systems Operational'}} if 'summary' in path else {'incidents':incidents}

    def test_resolved_is_not_active_and_components_are_explicit(self):
        result=read_status('codex','6.1sol',self.feeds([{'name':'6.1 Sol Degraded','status':'resolved','resolved_at':'2026-10-27T12:00:00Z','incident_updates':[{'body':'Recovered','status':'resolved'}]}]),datetime(2026,10,29,tzinfo=timezone.utc))
        self.assertEqual(result['active_incidents'],[])
        self.assertEqual(len(result['recent_resolved_incidents']),1)
        self.assertTrue(result['scope_component_found'])
        self.assertIn('+08:00',result['checked_at'])

    def test_active_incident_retained_even_when_summary_none(self):
        result=read_status(fetch=self.feeds([{'name':'Errors','status':'investigating','incident_updates':[{'body':'Error rate elevated'}]}]))
        self.assertEqual(result['active_incidents'][0]['updates'][0]['body'],'Error rate elevated')

    def test_network_and_malformed_responses_fail_closed(self):
        def failed(path):raise OSError('private error must not appear')
        for fetch in [failed,lambda path:{}]:
            result=read_status(fetch=fetch)
            self.assertFalse(result['available']);self.assertNotIn('private',str(result))

    def test_langchain_status_then_explanation_has_official_source(self):
        model=ScriptedModel(responses=[call('openai_service_status',{'scope':'codex','query':'6.1sol'}),AIMessage(content='官方未报告当前故障，个人连接仍需排查。')])
        runner=worker.build_runner(model_factory=lambda config:model)
        with patch.object(worker,'read_status',return_value={'available':True,'checked_at':'2026-10-29T10:00:00+08:00','global_status':{'description':'Operational'},'active_incidents':[]}):
            result=runner.run(packet(text='6.1sol不能用了是遇到什么问题了吗'))
        self.assertEqual(result['kind'],'reasoned');self.assertEqual(result['source'],'openai-status')
        self.assertEqual(len(model.seen),2)

if __name__=='__main__':unittest.main()
