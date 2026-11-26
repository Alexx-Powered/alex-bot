import json
import unittest
from datetime import datetime
from unittest.mock import patch

import httpx

import agent_worker
from campus_classrooms import TZ, normalize
from campus_evidence import classroom_evidence
from group_reply_graph import build_reply_graph
from test_agent_worker import packet


NOW = datetime(2026, 11, 26, 10, 5, tzinfo=TZ)
ROWS = normalize({'e': 0, 'd': {'list': {
    '主楼': [{'name': '主201', 'kxsds': '3,4'}, {'name': '主M201', 'kxsds': '1'}],
    '三号楼': [{'name': '(三)201', 'kxsds': ''}],
}}}, NOW.date().isoformat(), NOW)


class FuzzyQATests(unittest.TestCase):
    def test_evidence_keeps_exact_room_matches_ambiguity_and_breaks(self):
        def read(rooms, now=NOW, **kwargs):
            return classroom_evidence(ROWS, {'rooms': rooms, **kwargs}, now)

        data = read(['主楼２０１', '主M201', '主999'])
        self.assertEqual(data['current_period'], 3)
        self.assertEqual([r['free_periods'] for r in data['rows']], [[3, 4], [1]])
        self.assertEqual([item['count'] for item in data['matches'].values()], [1, 1, 0])
        self.assertEqual(read(['201'])['matches']['201']['count'], 3)
        self.assertEqual(read(['201'], building='三号楼')['rows'][0]['free_periods'], [])
        self.assertIsNone(read([], NOW.replace(hour=10, minute=35))['current_period'])
        self.assertIsNone(read([], NOW.replace(day=25))['current_period'])
        self.assertEqual(read([])['total_rows'], 3)

    def test_actual_graph_has_conditional_node(self):
        graph = build_reply_graph(lambda _: {'evidence': None}, lambda _: self.fail('unexpected delegation'))
        self.assertIn('fuzzy_qa', graph.get_graph().nodes)
        self.assertNotIn('reply', graph.invoke({}))

    def test_forward_study_windows_at_period_boundaries_and_meal_breaks(self):
        snapshot = normalize({'e': 0, 'd': {'list': {
            '主楼': [{'name': '主201', 'kxsds': '1,2,6,7,14'}]}}}, NOW.date().isoformat(), NOW)
        cases = [
            # time, phase, current, following, minutes to next, nearest block, first conflict
            ('07:55', 'before_first', None, 1, 5, ('08:00', '09:35', 95), 3),
            ('08:30', 'in_class', 1, 2, 20, ('08:00', '09:35', 65), 3),
            ('08:45', 'break', None, 2, 5, ('08:50', '09:35', 45), 3),
            ('09:35', 'break', None, 3, 15, ('14:00', '15:35', 95), 3),
            ('12:30', 'break', None, 6, 90, ('14:00', '15:35', 95), 8),
            ('15:20', 'in_class', 7, 8, 30, ('14:50', '15:35', 15), 8),
            ('18:55', 'break', None, 11, 5, ('21:30', '22:15', 45), 11),
            ('19:00', 'in_class', 11, 12, 50, ('21:30', '22:15', 45), 11),
            ('21:40', 'in_class', 14, None, None, ('21:30', '22:15', 35), None),
            ('22:15', 'after_last', None, None, None, None, None),
        ]
        for hhmm, phase, current, following, minutes, expected, booking in cases:
            with self.subTest(hhmm=hhmm):
                hour, minute = map(int, hhmm.split(':'))
                evidence = classroom_evidence(snapshot, {'rooms': ['主201']}, NOW.replace(hour=hour, minute=minute))
                pos, room = evidence['schedule_position'], evidence['rows'][0]
                self.assertEqual((pos['phase'], pos['current_period'], pos['next_period'], pos.get('minutes_to_next_start')),
                                 (phase, current, following, minutes))
                block = room.get('nearest_free_block')
                self.assertEqual(block and (block['start'], block['end'], block['remaining_minutes']), expected)
                self.assertEqual((room.get('first_booking') or {}).get('period'), booking)
        at_break = classroom_evidence(snapshot, {}, NOW.replace(hour=18, minute=55))['rows'][0]
        self.assertEqual(at_break['first_booking'], {'period': 11, 'start': '19:00', 'minutes_before_conflict': 5})
        near_bell = classroom_evidence(snapshot, {}, NOW.replace(hour=9, minute=32, second=30))['rows'][0]
        self.assertEqual(near_bell['nearest_free_block']['remaining_minutes'], 2)
        self.assertEqual(near_bell['first_booking'], {'period': 3, 'start': '09:50', 'minutes_before_conflict': 17})

    def test_split_meal_breaks_no_free_periods_and_other_dates(self):
        snapshot = normalize({'e': 0, 'd': {'list': {'主楼': [
            {'name': '主201', 'kxsds': '5,6,7,10,11'}, {'name': '主202', 'kxsds': ''}]}}}, NOW.date().isoformat(), NOW)
        for hour, minute, end in [(11, 40, '12:15'), (17, 45, '18:15')]:
            partly_free, fully_booked = classroom_evidence(snapshot, {}, NOW.replace(hour=hour, minute=minute))['rows']
            self.assertEqual(partly_free['nearest_free_block']['end'], end)
            self.assertIsNone(fully_booked['nearest_free_block'])
        other = classroom_evidence(snapshot, {}, NOW.replace(day=25))
        self.assertEqual(other['schedule_position']['phase'], 'other_date')
        self.assertNotIn('nearest_free_block', other['rows'][0])

    def test_authorized_json_reaches_only_high_effort_subagent(self):
        for revoked in (False, True):
            with self.subTest(revoked=revoked):
                self.check_protocol(revoked)

    def check_protocol(self, revoked):
        calls = []
        question = '主201空闲吗'
        answer = '按学院路课表，主201现在第3节空闲。'

        def respond(request):
            body = json.loads(request.content)
            calls.append(body)
            if len(calls) == 1:
                message = {'role': 'assistant', 'content': '', 'reasoning_content': 'route',
                           'tool_calls': [{'type': 'function', 'id': 'lookup', 'function': {
                               'name': 'buaa_classroom_data', 'arguments': '{"rooms":["主201"]}'}}]}
            else:
                message = {'role': 'assistant', 'content': answer}
            return httpx.Response(200, json={'id': 'test', 'model': 'deepseek-flash', 'created': 0,
                'choices': [{'index': 0, 'finish_reason': 'tool_calls' if len(calls) == 1 else 'stop', 'message': message}]})

        grants = []

        def gateway(_id, operation, **kwargs):
            if operation == 'authorize':
                self.assertEqual(kwargs['tool'], 'buaa_classroom_data')
                return {'allowed': True, 'grant': {'code': 'OK', 'credentials': {'password': 'fixture-private'}}}
            self.assertEqual(operation, 'campus_continue')
            grants.append(True)
            return {'allowed': len(grants) == 1 or not revoked}

        runner = agent_worker.build_runner(profiling=True)
        runner.gateway = gateway
        with (httpx.Client(transport=httpx.MockTransport(respond)) as client,
              patch.object(agent_worker, 'get_model_http_client', return_value=client),
              patch('worker_campus.snapshots', return_value={ROWS['date']: ROWS})):
            result = runner.run(packet(text=question, now=NOW.isoformat(), replyFormat='attachment-v1',
                                       context={'scope': 'group', 'access': 'white', 'currentSpeaker':'member-a', 'groupContext': []}))
        self.assertEqual(result['kind'], 'attachment', result)
        self.assertEqual(result['tool'], 'buaa_classroom_data')
        self.assertEqual(calls[0]['reasoning_effort'], 'low')
        if revoked:
            self.assertTrue(result['cancelled'])
            self.assertEqual(len(calls), 1)
            return
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1]['reasoning_effort'], 'high')
        self.assertEqual(calls[1]['thinking'], {'type': 'enabled'})
        self.assertFalse(calls[1].get('tools'))
        material = json.loads(calls[1]['messages'][-1]['content'])
        self.assertEqual(material['question'], question)
        self.assertEqual(len(material['source_data']['rows']), 1)
        row = material['source_data']['rows'][0]
        self.assertEqual((row['building'], row['room'], row['free_periods']), ('主楼', '主201', [3, 4]))
        self.assertEqual(row['nearest_free_block']['end'], '11:25')
        self.assertNotIn('fixture-private', str(calls))
        self.assertIn('fuzzy_qa', [t['name'] for t in result['timings']])
        self.assertEqual(result['text'], answer)
