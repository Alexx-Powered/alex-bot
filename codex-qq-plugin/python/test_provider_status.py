import json
import time
import unittest
from unittest.mock import patch
from pydantic import ValidationError
import provider_status as status


def statuspage(events=None, components=None, indicator='none'):
    return {'status': {'indicator': indicator}, 'incidents': events or [],
            'components': components or [{'name': 'Claude API (api.anthropic.com)', 'status': 'operational'}]}


class ProviderStatusTests(unittest.TestCase):
    def setUp(self):
        status._cache.clear()

    def test_fixed_langchain_schema_denies_unknown_provider_and_arbitrary_arguments(self):
        with patch.object(status, 'fetch_provider', side_effect=AssertionError('must not fetch')):
            for args in ({'provider': 'glm'}, {'provider': 'claude', 'url': 'http://localhost/'}, {'provider': 'kimi', 'key': 'secret'}):
                with self.assertRaises(ValidationError):
                    status.ai_service_status.invoke(args)
        with patch.object(status, 'build_opener', side_effect=AssertionError('must not open')):
            with self.assertRaises(ValueError):
                status.request('http://127.0.0.1/')

    def test_unresolved_event_is_retained_even_when_every_component_is_green(self):
        event = {'name': 'Intermittent API errors', 'status': 'monitoring', 'components': [{'name': 'Claude API (api.anthropic.com)'}],
                 'incident_updates': [{'status': 'monitoring', 'display_at': '2026-11-03T02:01:00Z',
                    'body': 'A fix has been implemented and we are monitoring the results.'}]}
        facts = status.parse_statuspage('claude', statuspage([event]))
        report = status.prepare_report('claude', facts, '2026-11-03T10:02:00+08:00')
        self.assertEqual(report['overall'], 'incident')
        self.assertEqual(report['statusTitle'], '修复后观察')
        self.assertEqual(report['incidents'][0]['affected'], 'Claude API')
        self.assertEqual(report['incidents'][0]['updatedAt'], '2026-11-03T10:01:00+08:00')
        self.assertIn('观察', report['incidents'][0]['progress'])

    def test_closed_history_is_not_current_and_an_unlisted_component_cannot_hide(self):
        components = [{'name': 'Responses', 'status': 'operational'}, {'name': 'New product', 'status': 'major_outage'}]
        facts = status.parse_statuspage('openai', statuspage([{'name': 'Old', 'status': 'resolved'}], components))
        self.assertEqual(facts['incidents'], [])
        self.assertEqual([r['label'] for r in facts['rows']], ['Responses API', 'New product'])
        report = status.prepare_report('openai', facts, '2026-11-03T10:00:00+08:00')
        self.assertEqual(report['overall'], 'incident')
        self.assertIn('New product', report['notice']['affected'])
        self.assertIsNone(report['notice']['updatedAt'])

    def test_unknown_upstream_component_state_is_not_normal(self):
        facts = status.parse_statuspage('kimi', statuspage(components=[{'name': 'Open API', 'status': 'new_unknown_state'}]))
        self.assertEqual(facts['overall'], 'unknown')
        self.assertEqual(facts['rows'][0]['state'], 'unknown')
        report = status.prepare_report('kimi', facts, '2026-11-03T10:00:00+08:00')
        self.assertIn('信息不完整', report['notice']['title'])
        with self.assertRaises(ValueError):
            status.parse_statuspage('openai', statuspage(), {})

    def test_latest_update_is_chosen_by_time_and_untrusted_markup_is_plain_text(self):
        event = {'name': '<script>Title</script>', 'status': 'identified', 'incident_updates': [
            {'body': 'Old', 'display_at': '2026-11-03T01:00:00Z'},
            {'body': 'New <b>notice</b> @all', 'display_at': '2026-11-03T02:00:00Z'}]}
        item = status.parse_statuspage('claude', statuspage([event]))['incidents'][0]
        self.assertEqual(item['progress'], 'New notice all')
        self.assertEqual(item['title'], 'Title')

    def test_active_maintenance_is_visible_but_future_and_completed_events_are_not_outages(self):
        data = statuspage()
        data['scheduled_maintenances'] = [{'name': phase, 'status': phase, 'incident_updates': []}
                                          for phase in ('scheduled', 'in_progress', 'completed')]
        result = status.parse_statuspage('claude', data)
        self.assertEqual(result['overall'], 'incident')
        self.assertEqual([e['phase'] for e in result['incidents']], ['in_progress'])

    def test_gemini_official_array_schema_keeps_mitigated_active_and_resolved_closed(self):
        active = ['event-a', 'API failures', 2, [[1, 'display', ['1793664000'], 'Errors'], [3, 'display', ['1793664600'], 'Mitigation applied']], 1, [1, 3]]
        closed = ['event-b', 'Old', 1, [[4, 'display', ['1793664000'], 'Resolved']], 2, [2]]
        result = status.parse_gemini([[[active, closed]]])
        self.assertEqual(result['overall'], 'incident')
        self.assertEqual(len(result['incidents']), 1)
        self.assertEqual(result['incidents'][0]['phase'], 'mitigated')
        self.assertEqual([r['state'] for r in result['rows']], ['major_outage', 'operational', 'major_outage'])
        self.assertIn('不含消费端', result['scopeNote'])
        for malformed in ({}, [], [[[['bad']]]]):
            with self.assertRaises(ValueError):
                status.parse_gemini(malformed)

    def test_gemini_fetch_only_uses_public_page_config_and_fixed_read_only_rpc(self):
        public_identifier = 'AIza' + 'a' * 35
        with patch.object(status, 'request', side_effect=['{"WIu0Nc":"'+public_identifier+'"}', '[[[]]]']) as fetch:
            facts = status.fetch_provider('gemini')
        self.assertEqual(facts['overall'], 'operational')
        self.assertEqual(fetch.call_args_list[0].args, (status.SOURCES['gemini'],))
        self.assertEqual(fetch.call_args_list[1].args, (status.GEMINI_RPC,))
        self.assertEqual(fetch.call_args_list[1].kwargs['data'], b'[]')
        self.assertNotIn(public_identifier, json.dumps(facts))

    def test_deepseek_retains_detailed_chinese_updates_and_affected_services(self):
        page = {'custom_domain': 'status.deepseek.com', 'name': 'DeepSeek',
                'components': [{'component_id': 'pro', 'name': 'DeepSeek V4 Pro API服务(API Service)'}]}
        change = {'title': 'API 部分中断', 'status': 'monitoring',
                  'affected_components': [{'component_id': 'pro', 'name': 'DeepSeek V4 Pro API服务(API Service)', 'status': 'degraded'}],
                  'updates': [{'status': 'investigating', 'at_seconds': 1793664000, 'description': '正在排查。'},
                              {'status': 'monitoring', 'at_seconds': 1793664600, 'description': '已实施修复，正在监控结果。\n\nA fix has been implemented.'}]}
        flight = 'a:{"initialData":' + json.dumps({'page': page, 'active_changes': [change]}) + ',"initialDataUpdatedAt":' + str(int(time.time()*1000)) + '}'
        html = '<script>self.__next_f.push(' + json.dumps([1, flight]) + ')</script>'
        result = status.parse_deepseek_report(html)
        self.assertEqual(result['rows'][0]['state'], 'degraded_performance')
        self.assertEqual(result['incidents'][0]['progress'], '已实施修复，正在监控结果。')
        self.assertEqual(result['incidents'][0]['affected'], 'V4 Pro API')

    def test_source_failure_never_looks_healthy_or_leaks_exception(self):
        with patch.object(status, 'fetch_provider', side_effect=RuntimeError('private-token=secret')):
            result = status.ai_service_status.invoke({'provider': 'kimi'})
        self.assertEqual(result['report']['overall'], 'unknown')
        self.assertIn('不能据此判断', result['report']['notice']['symptom'])
        self.assertNotIn('private-token', json.dumps(result))
        self.assertNotIn('secret', json.dumps(result))

    def test_short_cache_preserves_actual_checked_time_and_avoids_repeat_fetch(self):
        with patch.object(status, 'fetch_provider', return_value=status.parse_statuspage('claude', statuspage())) as fetch:
            first = status.ai_service_status.invoke({'provider': 'claude'})
            second = status.ai_service_status.invoke({'provider': 'claude'})
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(first['checked_at'], second['checked_at'])


if __name__ == '__main__':
    unittest.main()
