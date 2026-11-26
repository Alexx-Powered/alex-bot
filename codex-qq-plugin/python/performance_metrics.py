"""Content-free, bounded timing for one worker request.

Retain numeric timings, tokens and classified error codes. Omit prompts,
tool payloads, identities and raw exceptions.
"""
from __future__ import annotations

from contextlib import contextmanager
import math
from threading import RLock
import time
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler
from trace_errors import error_fields

STAGES = frozenset({"router_setup", "router_model", "chat_setup", "chat_model", "fuzzy_qa", "memory", "tool", "resolve_location", "weather_fetch", "air_fetch",
                    "morning_air_gefs", "warning_fetch", "weather_render", "hiking_render", "radar_query", "weather_video",
                    "video_cache_hit", "video_read_mp4", "heavy_queue"})
MODEL_PHASES = frozenset({"router_model", "chat_model", "fuzzy_qa"})
TOKEN_FIELDS = frozenset({"inputTokens", "outputTokens", "cachedInputTokens"})
STATUSES = frozenset({"ok", "error", "fallback"})
MAX_EVENTS = 32
MAX_TOKEN_COUNT = 1_000_000_000_000


def _duration(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("PERFORMANCE_METRIC_INVALID")
    try:
        numeric = float(value)
    except (OverflowError, ValueError):
        raise ValueError("PERFORMANCE_METRIC_INVALID") from None
    if not math.isfinite(numeric) or numeric < 0:
        raise ValueError("PERFORMANCE_METRIC_INVALID")
    return numeric


def _count(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or value > MAX_TOKEN_COUNT or not math.isfinite(value) or int(value) != value:
        raise ValueError("PERFORMANCE_METRIC_INVALID")
    return int(value)


def _tokens(raw):
    """Project known numeric fields only, ignoring arbitrary provider metadata."""
    if not isinstance(raw, dict):
        return {}
    result = {}
    paths = {
        "inputTokens": (("input_tokens",), ("prompt_tokens",)),
        "outputTokens": (("output_tokens",), ("completion_tokens",)),
        "cachedInputTokens": (("input_token_details", "cache_read"), ("prompt_tokens_details", "cached_tokens"),
                              ("prompt_cache_hit_tokens",), ("cache_read_input_tokens",), ("cached_input_tokens",)),
    }
    for field, candidates in paths.items():
        for candidate in candidates:
            value = raw
            for key in candidate:
                value = value.get(key) if isinstance(value, dict) else None
            try:
                result[field] = _count(value)
                break
            except ValueError:
                continue
    return result


def _usage(response):
    # llm_output is batch-level when present; a message fills only missing fields.
    output = getattr(response, "llm_output", None)
    result = _tokens(output.get("token_usage")) if isinstance(output, dict) else {}
    generations = getattr(response, "generations", None)
    if isinstance(generations, list):
        for batch in generations[:1]:
            if not isinstance(batch, list):
                continue
            for generation in batch[:1]:
                message = getattr(generation, "message", None)
                for name, value in _tokens(getattr(message, "usage_metadata", None)).items():
                    result.setdefault(name, value)
    return result


class PerformanceRecorder:
    def __init__(self, enabled=True, *, clock=None):
        if not isinstance(enabled, bool) or (clock is not None and not callable(clock)):
            raise ValueError("PERFORMANCE_METRIC_INVALID")
        self.enabled = enabled
        self._clock = clock or time.perf_counter
        self._started = self._clock() if enabled else 0.0
        self._events = []
        self._lock = RLock()

    def _append(self, name, ms, started, metrics, status="ok", error=None):
        if not self.enabled:
            return False
        if not isinstance(name, str) or name not in STAGES or set(metrics) - TOKEN_FIELDS or not isinstance(status, str) or status not in STATUSES:
            raise ValueError("PERFORMANCE_METRIC_INVALID")
        elapsed = _duration(ms)
        raw_offset = (started - self._started) * 1000
        if not math.isfinite(raw_offset):
            raise ValueError("PERFORMANCE_METRIC_INVALID")
        offset = _duration(max(0, raw_offset))
        event = {"name": name, "ms": round(elapsed, 3), "offsetMs": round(offset, 3)}
        if status != 'ok':
            event['status'] = status
            if error is not None:
                event.update(error_fields(error, model=name in MODEL_PHASES))
        event.update({key: _count(value) for key, value in metrics.items()})
        with self._lock:
            if len(self._events) >= MAX_EVENTS:
                return False
            self._events.append(event)
        return True

    def record(self, name, ms, *, status="ok", **metrics):
        if not self.enabled:
            return False
        elapsed = _duration(ms)
        return self._append(name, elapsed, self._clock() - elapsed / 1000, metrics, status)

    @contextmanager
    def span(self, name):
        if not self.enabled:
            yield
            return
        if not isinstance(name, str) or name not in STAGES:
            raise ValueError("PERFORMANCE_METRIC_INVALID")
        started = self._clock()
        status = 'ok'
        failure = None
        try:
            yield
        except BaseException as error:
            status = 'error'
            failure = error
            raise
        finally:
            # A telemetry clock failure must not hide the original operation error.
            try:
                self._append(name, (self._clock() - started) * 1000, started, {}, status, failure)
            except (ValueError, TypeError, OverflowError):
                pass

    def callback(self, phase="router_model"):
        if not isinstance(phase, str) or phase not in MODEL_PHASES:
            raise ValueError("PERFORMANCE_METRIC_INVALID")
        return _PerformanceCallback(self, phase)

    def finish(self):
        with self._lock:
            return [dict(event) for event in self._events[:MAX_EVENTS]]


class _PerformanceCallback(BaseCallbackHandler):
    run_inline = True
    raise_error = False

    def __init__(self, recorder, phase):
        self._recorder, self._phase = recorder, phase
        self._llms, self._tools = {}, {}
        self._lock = RLock()

    @staticmethod
    def _key(run_id):
        # UUID keys are transient correlation only; never emitted by finish().
        if isinstance(run_id, UUID):
            return run_id
        if isinstance(run_id, str):
            try:
                return UUID(run_id)
            except ValueError:
                return None
        return None

    def _start(self, table, run_id):
        if not self._recorder.enabled:
            return
        key = self._key(run_id)
        if key is None:
            return
        with self._lock:
            if len(table) < MAX_EVENTS and key not in table:
                table[key] = self._recorder._clock()

    def _end(self, table, run_id, name, metrics=None, status='ok', error=None):
        if not self._recorder.enabled:
            return
        key = self._key(run_id)
        with self._lock:
            started = table.pop(key, None)
        if started is None:
            return
        try:
            self._recorder._append(name, (self._recorder._clock() - started) * 1000, started, metrics or {}, status, error)
        except (ValueError, TypeError, OverflowError):
            pass

    def on_llm_start(self, serialized, prompts, *, run_id, **kwargs):
        self._start(self._llms, run_id)

    def on_chat_model_start(self, serialized, messages, *, run_id, **kwargs):
        self._start(self._llms, run_id)

    def on_llm_end(self, response, *, run_id, **kwargs):
        if not self._recorder.enabled:
            return
        try:
            usage = _usage(response)
        except Exception:
            usage = {}
        self._end(self._llms, run_id, self._phase, usage)

    def on_llm_error(self, error, *, run_id, **kwargs):
        self._end(self._llms, run_id, self._phase, status='error', error=error)

    def on_tool_start(self, serialized, input_str, *, run_id, **kwargs):
        self._start(self._tools, run_id)

    def on_tool_end(self, output, *, run_id, **kwargs):
        self._end(self._tools, run_id, "tool")

    def on_tool_error(self, error, *, run_id, **kwargs):
        self._end(self._tools, run_id, "tool", status='error', error=error)
