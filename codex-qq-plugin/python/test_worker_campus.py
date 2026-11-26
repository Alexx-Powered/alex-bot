"""Offline campus migration coverage, using the real tools, caches and renderers."""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

from PIL import Image

from campus_cache import query_slot, remember, snapshots
from campus_classrooms import CampusError, TZ, normalize
from worker_campus import execute


SCHOOL = {'e': 0, 'd': {'list': {
    '三号楼': [{'name': '(三)105', 'kxsds': '1,2,3,4,5,6,7,8,9,10,11,12,13,14'}],
    '新主楼': [{'name': 'A102', 'kxsds': '11,12,13,14'}],
}}}
CREDS = {'enabled': True, 'username': 'fixture-student', 'password': 'fixture-password'}
SESSION = {'cookies': [{'name': 'session', 'value': 'fixture-secret'}], 'origins': []}


class CampusWorkerTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        original = Path.cwd()
        os.chdir(self.dir.name)
        self.addCleanup(os.chdir, original)
        self.private = Path('.private')
        self.clock = datetime.now(TZ)
        self.day = (self.clock.date() + timedelta(days=1)).isoformat()
        self.events = MagicMock()
        self.events.campus_allowed.return_value = True
        self.events.campus_progress.return_value = True
        self.events.campus_advice.return_value = '看看 A102。'
        self.grant = {'code': 'OK', 'credentials': CREDS, 'session_state': SESSION}

    def test_daily_report_and_compact_selection_are_driven_by_tool_arguments(self):
        def school(credentials, private, day, **options):
            self.assertEqual(credentials, CREDS)
            self.assertEqual(options['session_state'], SESSION)
            options['on_session'](SESSION)
            return SCHOOL

        for view, expected_width in [('full', 1800), ('compact', 1080)]:
            with self.subTest(view=view), patch('campus_worker.sys.platform', 'linux'), patch('campus_worker.browser_collect', side_effect=school):
                args = {'date': self.day, 'view': view, 'regions': ['新主楼A座', '主M'], 'session': 'evening'}
                reply = execute('buaa_classroom_query', args, {'id': view}, self.events, self.grant)
                self.assertEqual(reply, {'text': '', 'media': 'png'})
                self.events.campus_progress.assert_called_with('campus-fetch-current' if view=='compact' else 'campus-fetch')
                self.events.save_campus_session.assert_called_with(SESSION)
                with Image.open(self.private/'worker-replies'/(view+'.png')) as result:
                    self.assertEqual(result.width, expected_width)
        report = self.events.campus_advice.call_args.args[0]
        self.assertEqual(report['session'], '晚上')
        self.assertEqual(report['regions'], ['新主楼A座', '主M'])
        self.assertEqual(report['missing_regions'], ['主M'])
        self.assertEqual([row['room'] for row in report['candidates']], ['A102'])
        self.assertEqual(list((self.private/'campus-output').glob('*.png')), [])
        for value in [snapshots(self.private), report, self.events.campus_event.mock_calls]:
            self.assertNotIn('fixture-', str(value))

    def test_acknowledgement_and_denied_grant_prevent_collection(self):
        with patch('campus_worker.browser_collect', side_effect=AssertionError('unexpected browser')):
            self.events.campus_progress.return_value = False
            reply = execute('buaa_classroom_query', {}, {'id':'ack'}, self.events, self.grant)
            self.assertTrue(reply['cancelled'])
            self.events.campus_progress.reset_mock()
            reply = execute('buaa_classroom_query', {}, {'id':'denied'}, self.events, {'code':'CAMPUS_OWNER_ONLY'})
            self.assertTrue(reply['cancelled'])
            self.events.campus_progress.assert_not_called()
        self.assertFalse(self.private.exists())

    def test_expired_evidence_fetches_the_requested_date_and_source_failures_stay_unknown(self):
        with query_slot(self.private):
            remember(self.private, normalize(SCHOOL, self.day, self.clock - timedelta(hours=1)))
        args = {'date': self.day, 'rooms': ['主201']}
        packet = {'id': 'lookup', 'now': self.clock.isoformat()}
        updated = {'e': 0, 'd': {'list': {'主楼': [{'name': '主201', 'kxsds': '4,5'}]}}}
        with patch('campus_worker.browser_collect', return_value=updated) as collect:
            result = execute('buaa_classroom_data', args, packet, self.events, self.grant)
            collect.assert_not_called()
            facts = result['source_tool'].invoke(args)
            self.assertEqual(collect.call_args.args[2], self.day)
            self.assertEqual(facts['rows'], [{'building': '主楼', 'room': '主201', 'free_periods': [4, 5]}])
            self.assertIsNone(facts['current_period'])
            self.events.campus_progress.assert_not_called()
        with patch('campus_worker.browser_collect', side_effect=CampusError('CAMPUS_NETWORK_ERROR')):
            failed = execute('buaa_classroom_data', {'rooms': ['主201']}, packet, self.events, self.grant)
            self.assertIn('无法核实', failed['source_tool'].invoke({'rooms':['主201']})['error'])

    def test_revoked_query_does_not_open_browser_or_share_facts_with_advisor(self):
        args = {'date':self.day,'view':'compact','session':'evening'}
        self.events.campus_allowed.return_value=False
        with patch('campus_worker.browser_collect', side_effect=AssertionError('unexpected browser')):
            reply=execute('buaa_classroom_query',args,{'id':'stopped'},self.events,self.grant)
            self.assertTrue(reply['cancelled'])
        self.events.campus_allowed.side_effect=[True,False]
        with patch('campus_worker.browser_collect',return_value=SCHOOL):
            reply=execute('buaa_classroom_query',args,{'id':'revoked'},self.events,self.grant)
            self.assertTrue(reply['cancelled'])
        self.events.campus_advice.assert_not_called()

    def test_eight_days_survive_restart_and_legacy_cache_import(self):
        with query_slot(self.private):
            for remaining in range(-1,8):
                day = (self.clock.date()+timedelta(days=remaining)).isoformat()
                remember(self.private, normalize(SCHOOL, day, self.clock))
            with self.assertRaises(CampusError) as blocked:
                with query_slot(self.private, timeout=0):
                    self.fail('another browser owner acquired the account')
            self.assertEqual(blocked.exception.code, 'CAMPUS_BUSY')
        rows = snapshots(self.private)
        self.assertEqual(len(rows),8)
        self.assertEqual(next(iter(rows)),self.clock.date().isoformat())
        output = self.private/'campus-output'
        (output/'memory.json').unlink()
        self.assertEqual(list(snapshots(self.private)),[day])
        (output/'latest.json').write_text(json.dumps({**rows[day], 'credentials':CREDS}),encoding='utf8')
        self.assertEqual(snapshots(self.private), {})

    def test_read_only_recommendation_handles_expired_cache_and_advisor_failure(self):
        args = {'date':self.day,'session':'evening','regions':['新主楼A座']}
        with query_slot(self.private):
            remember(self.private, normalize(SCHOOL,self.day,self.clock-timedelta(hours=26)))
        self.events.campus_advice.side_effect=RuntimeError('fixture-advisor-failed')
        with patch('campus_worker.browser_collect', side_effect=AssertionError('unexpected browser')):
            stale = execute('buaa_classroom_recommend',args,{'id':'stale'},self.events,{'code':'OK'})
            self.assertIn('过期',stale['text'])
            self.events.campus_advice.assert_not_called()
            with query_slot(self.private):
                remember(self.private, normalize(SCHOOL,self.day,self.clock))
            reply = execute('buaa_classroom_recommend',args,{'id':'fallback'},self.events,{'code':'OK'})
            self.assertEqual(reply, {'text':'','media':'png'})
        self.events.campus_progress.assert_not_called()
        self.events.save_campus_session.assert_not_called()


if __name__ == '__main__':
    unittest.main()
