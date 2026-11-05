import json
import unittest
from uuid import uuid4

from langchain_core.callbacks import CallbackManager
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, LLMResult

from performance_metrics import PerformanceRecorder, MAX_EVENTS


class Clock:
    def __init__(self): self.now = 10.0
    def __call__(self): return self.now
    def advance(self, ms): self.now += ms / 1000


class PerformanceTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.recorder = PerformanceRecorder(clock=self.clock)

    def test_span_offsets_rounding_and_defensive_snapshot(self):
        self.clock.advance(5)
        with self.recorder.span('router_setup'):
            self.clock.advance(2.12345)
        self.assertEqual(self.recorder.finish(), [{'name':'router_setup','ms':2.123,'offsetMs':5.0}])
        copy = self.recorder.finish(); copy[0]['ms'] = -1
        self.assertEqual(self.recorder.finish()[0]['ms'], 2.123)

    def test_operation_error_is_not_captured_or_replaced(self):
        with self.assertRaisesRegex(RuntimeError, 'private exception'):
            with self.recorder.span('memory'):
                self.clock.advance(3)
                raise RuntimeError('private exception password=SECRET')
        self.assertEqual(self.recorder.finish()[0]['ms'], 3)
        self.assertEqual(self.recorder.finish()[0]['status'], 'error')
        self.assertNotIn('SECRET', json.dumps(self.recorder.finish()))

    def test_provider_callback_reports_http_status_and_code_without_provider_body(self):
        error = RuntimeError('SECRET provider body')
        error.status_code = 429
        callback = self.recorder.callback('router_model')
        run_id = uuid4()
        callback.on_chat_model_start({}, [], run_id=run_id)
        callback.on_llm_error(error, run_id=run_id)
        event, = self.recorder.finish()
        self.assertEqual((event['errorCode'], event['httpStatus']), ('MODEL_PROVIDER_RATE_LIMITED', 429))
        self.assertNotIn('SECRET', json.dumps(event))

    def test_native_fallback_reports_wrapped_timeout_in_video_protocol(self):
        from video_trace import reporting, stage
        from weather_video_codec import VideoFailure
        events = []
        with self.assertRaises(VideoFailure), reporting(events.append), stage('video_fetch_ifs', (VideoFailure,)):
            try:
                raise TimeoutError('SECRET signed URL')
            except TimeoutError as cause:
                raise VideoFailure('VIDEO_NATIVE_UNAVAILABLE') from cause
        end = events[-1]
        self.assertEqual((end['phase'], end['errorCode'], end['causeCode']), ('fallback', 'VIDEO_NATIVE_UNAVAILABLE', 'NETWORK_TIMEOUT'))
        self.assertNotIn('SECRET', json.dumps(events))

    def test_explicit_record_projects_only_allowed_numeric_counts(self):
        self.clock.advance(20)
        self.assertTrue(self.recorder.record('router_model', 15, inputTokens=7, outputTokens=2, cachedInputTokens=0))
        self.assertEqual(self.recorder.finish(), [{'name':'router_model','ms':15.0,'offsetMs':5.0,'inputTokens':7,'outputTokens':2,'cachedInputTokens':0}])

    def test_invalid_stages_durations_extra_fields_and_tokens_are_rejected(self):
        for name in ['private text', '', 'prompt', None, []]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.recorder.record(name, 1)
        for value in [-1, float('nan'), float('inf'), -float('inf'), True, '5', None, 10**400]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.recorder.record('tool', value)
        for kwargs in [{'prompt':'private'}, {'error':'SECRET'}, {'inputTokens':-1}, {'outputTokens':True}, {'cachedInputTokens':float('nan')}, {'inputTokens':.5}, {'status':'private error'}, {'status':None}, {'inputTokens':10**400}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.recorder.record('tool', 1, **kwargs)
        self.assertEqual(self.recorder.finish(), [])

    def test_disabled_recorder_and_callback_never_inspect_payloads(self):
        class Exploding:
            def __getattribute__(self, name): raise AssertionError('payload accessed')
        recorder = PerformanceRecorder(False, clock=self.clock)
        callback = recorder.callback('chat_model'); run_id = uuid4()
        with recorder.span('not-a-stage'):
            recorder.record('bad', -1, prompt='SECRET')
        callback.on_chat_model_start(Exploding(), Exploding(), run_id=run_id)
        callback.on_llm_end(Exploding(), run_id=run_id)
        callback.on_llm_error(Exploding(), run_id=run_id)
        callback.on_tool_start(Exploding(), Exploding(), run_id=run_id)
        callback.on_tool_end(Exploding(), run_id=run_id)
        self.assertEqual(recorder.finish(), [])

    def test_disabled_recorder_never_calls_clock(self):
        def invalid_clock(): raise AssertionError('disabled clock accessed')
        recorder=PerformanceRecorder(False,clock=invalid_clock)
        with recorder.span('memory'): pass
        recorder.callback().on_llm_start({},[],run_id=uuid4())
        self.assertEqual(recorder.finish(),[])

    def test_real_langchain_chat_callback_and_usage_metadata(self):
        manager = CallbackManager([self.recorder.callback('router_model')])
        runs = manager.on_chat_model_start({'api_key':'SECRET'}, [[HumanMessage(content='private prompt')]])
        self.clock.advance(25)
        runs[0].on_llm_end(LLMResult(generations=[[ChatGeneration(message=AIMessage(content='private answer', usage_metadata={'input_tokens':13,'output_tokens':4,'total_tokens':17,'input_token_details':{'cache_read':9}}))]]))
        self.assertEqual(self.recorder.finish(), [{'name':'router_model','ms':25.0,'offsetMs':0.0,'inputTokens':13,'outputTokens':4,'cachedInputTokens':9}])
        self.assertNotIn('private', json.dumps(self.recorder.finish()))
        self.assertNotIn('SECRET', json.dumps(self.recorder.finish()))

    def test_llm_output_usage_fields_and_deepseek_cache_are_read_without_provider_text(self):
        callback = self.recorder.callback('chat_model'); run_id = uuid4()
        callback.on_llm_start({'key':'SECRET'}, ['private'], run_id=run_id)
        self.clock.advance(12)
        response = LLMResult(generations=[[ChatGeneration(message=AIMessage(content='hidden'))]], llm_output={'token_usage':{'prompt_tokens':20,'completion_tokens':3,'prompt_cache_hit_tokens':8,'secret':'SECRET'},'provider_error':'private'})
        callback.on_llm_end(response, run_id=run_id)
        self.assertEqual(self.recorder.finish()[0], {'name':'chat_model','ms':12.0,'offsetMs':0.0,'inputTokens':20,'outputTokens':3,'cachedInputTokens':8})

    def test_aggregate_usage_is_not_double_counted_with_message_usage(self):
        callback = self.recorder.callback(); run_id = uuid4()
        callback.on_llm_start({}, [], run_id=run_id)
        self.clock.advance(3)
        response = LLMResult(generations=[[ChatGeneration(message=AIMessage(content='', usage_metadata={'input_tokens':5,'output_tokens':2,'total_tokens':7}))]], llm_output={'token_usage':{'prompt_tokens':10,'completion_tokens':4}})
        callback.on_llm_end(response, run_id=run_id)
        self.assertEqual(self.recorder.finish()[0]['inputTokens'], 10)

    def test_invalid_provider_token_values_are_ignored(self):
        callback = self.recorder.callback(); run_id = uuid4()
        callback.on_llm_start({}, [], run_id=run_id); self.clock.advance(1)
        response = LLMResult(generations=[], llm_output={'token_usage':{'prompt_tokens':'SECRET','completion_tokens':-5,'prompt_cache_hit_tokens':float('nan')}})
        callback.on_llm_end(response, run_id=run_id)
        self.assertEqual(set(self.recorder.finish()[0]), {'name','ms','offsetMs'})

    def test_tool_time_is_separate_from_model_time_and_errors_never_escape(self):
        callback = self.recorder.callback(); model_id, tool_id = uuid4(), uuid4()
        callback.on_llm_start({'password':'SECRET'}, ['private'], run_id=model_id)
        self.clock.advance(7); callback.on_llm_end(LLMResult(generations=[]), run_id=model_id)
        callback.on_tool_start({'name':'sensitive_tool_name'}, 'private tool args', run_id=tool_id)
        self.clock.advance(40); callback.on_tool_error(RuntimeError('private secret error'), run_id=tool_id)
        self.assertEqual([event['ms'] for event in self.recorder.finish()], [7.0,40.0])
        self.assertEqual([event['name'] for event in self.recorder.finish()], ['router_model','tool'])
        self.assertEqual(self.recorder.finish()[1]['status'], 'error')
        self.assertNotIn('private', json.dumps(self.recorder.finish()))

    def test_failed_llm_time_is_recorded_without_exception(self):
        callback = self.recorder.callback('chat_model'); run_id = uuid4()
        callback.on_chat_model_start({}, [], run_id=run_id); self.clock.advance(8)
        callback.on_llm_error(RuntimeError('SECRET'), run_id=run_id)
        self.assertEqual(self.recorder.finish(), [{'name':'chat_model','ms':8.0,'offsetMs':0.0,'status':'error'}])

    def test_unknown_duplicate_ends_and_non_uuid_ids_are_safe(self):
        callback = self.recorder.callback(); run_id = uuid4()
        callback.on_llm_end(LLMResult(generations=[]), run_id=run_id)
        callback.on_llm_start({}, [], run_id='secret-user-id'); self.clock.advance(1)
        callback.on_llm_error(RuntimeError('SECRET'), run_id='secret-user-id')
        callback.on_llm_start({}, [], run_id=run_id); self.clock.advance(2)
        callback.on_llm_error(RuntimeError('SECRET'), run_id=run_id)
        callback.on_llm_end(LLMResult(generations=[]), run_id=run_id)
        self.assertEqual(len(self.recorder.finish()), 1)

    def test_bounded_events_and_pending_callback_timers(self):
        callback = self.recorder.callback()
        for _ in range(MAX_EVENTS + 20):
            self.recorder.record('memory', 1)
            callback.on_llm_start({}, [], run_id=uuid4())
        self.assertEqual(len(self.recorder.finish()), MAX_EVENTS)
        self.assertLessEqual(len(callback._llms), MAX_EVENTS)

    def test_callback_phase_is_restricted(self):
        with self.assertRaises(ValueError): self.recorder.callback('prompt')

    def test_only_fixed_status_values_can_be_emitted(self):
        self.recorder.record('chat_model', 3, status='fallback')
        self.assertEqual(self.recorder.finish()[0]['status'], 'fallback')
        self.recorder.record('router_setup', 1, status='ok')
        self.assertNotIn('status', self.recorder.finish()[1])


if __name__ == '__main__': unittest.main()
