import io
import hashlib
import json
import tempfile
from urllib.error import HTTPError
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import agent_worker
import public_status as status
from test_agent_worker import ScriptedModel, call, packet

NOW = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)


def html(changes=None, **overrides):
    data = {"page": {"name": "DeepSeek", "custom_domain": "status.deepseek.com", "components": [
        {"component_id": "pro", "name": "DeepSeek Pro API"}, {"component_id": "chat", "name": "对话服务"}]},
        "active_changes": changes or []}
    data.update(overrides)
    flight = '1:["$","client",null,{"initialData":' + json.dumps(data) + ',"initialDataUpdatedAt":' + str(int(NOW.timestamp() * 1000)) + "}]"
    return "<script>self.__next_f.push(" + json.dumps([1, flight]) + ")</script>"


class PublicStatusTests(unittest.TestCase):
    def test_current_healthy_and_component_outage_from_official_initial_data(self):
        self.assertEqual(status.parse_deepseek(html(), NOW)["overall"], "operational")
        value = status.parse_deepseek(html([{"title": "API延迟", "status": "investigating", "affected_components": [{"component_id": "pro", "status": "degraded"}]}]), NOW)
        self.assertEqual(value["overall"], "degraded")
        self.assertEqual([r["status"] for r in value["components"]], ["degraded", "operational"])
        self.assertEqual(value["incidents"][0]["title"], "API延迟")

    def test_resolved_and_future_events_are_not_reported_as_current_outage(self):
        for state in ["resolved", "completed", "cancelled", "scheduled"]:
            value = status.parse_deepseek(html([{"status": state, "affected_components": [{"component_id": "pro", "status": "full_outage"}]}]), NOW)
            self.assertEqual(value["overall"], "operational")
            self.assertFalse(value["incidents"])

    def test_unknown_new_schema_never_claims_healthy(self):
        value = status.parse_deepseek(html([{"status": "investigating", "affected_components": []}]), NOW)
        self.assertEqual(value["overall"], "unknown")
        for source in ["<h1>Everything is fine</h1>", html(page={}), html(active_changes={})]:
            with self.assertRaises((ValueError, KeyError)):
                status.parse_deepseek(source, NOW)
        with self.assertRaises(ValueError):
            status.parse_deepseek(html(), datetime(2026, 10, 30, 12, 6, tzinfo=timezone.utc))

    def test_fragmented_metadata_does_not_need_history_and_matches_score_to_portrait(self):
        value={'up':8115,'down':2180,'weightedUp':256.25,'weightedDown':123.11,'level':22.3541}
        prefix=json.dumps(value)[:-1]+',"events":['
        self.assertIsNone(status.parse_liang_prefix(prefix[:30]))
        result=status.parse_liang_prefix(prefix)
        self.assertEqual((result['level'],result['stage'],result['frame']),('22.3541','梁圣',22))
        for override in [{'level':float('nan')},{'up':True},{'level':61},{'down':-1},{'up':'8115'}]:
            with self.assertRaises(ValueError):
                status.parse_liang_prefix(json.dumps({**value,**override})[:-1]+',"events":[')

    def test_status_query_reads_only_live_prefix_not_large_history_and_is_get_only(self):
        value={'up':9,'down':1,'weightedUp':8.2,'weightedDown':.9,'level':23.5}
        payload=(json.dumps(value)[:-1]+',"events":['+'0,'*100000).encode()
        class Response(io.BytesIO):
            consumed=0
            def read1(self,size):
                chunk=super().read(size);self.consumed+=len(chunk);return chunk
        response=Response(payload)
        with patch.object(status.sys,'platform','linux'),patch.object(status.socket,'getaddrinfo',return_value=[(2,1,6,'',('104.21.1.194',443))]),patch.object(status.subprocess,'Popen') as spawn:
            spawn.return_value.stdout=response
            spawn.return_value.poll.return_value=None
            facts=status.fetch_liang_vote()
            args=spawn.call_args.args[0]
            self.assertFalse(spawn.call_args.kwargs['shell'])
            self.assertIn('--fail',args)
            self.assertTrue(args[-1].startswith(status.SOURCES['liang']+'api/vote?status_query='))
            self.assertNotIn('POST',args)
            self.assertIn('liang.itsuyo.top:443:104.21.1.194',args)
            self.assertEqual(facts['stage'],'梁神')
            self.assertLess(response.consumed,5000)

    def test_verified_pinned_author_frame_cache_is_used_and_corruption_is_rejected(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as folder:
            directory=Path(folder);buffer=io.BytesIO();Image.new('RGB',(1254,1254),'orange').save(buffer,format='WEBP')
            raw=buffer.getvalue();target=directory/'frame-22.webp';target.write_bytes(raw)
            (directory/'manifest.json').write_text(json.dumps({'revision':status.FRAME_REVISION,'frames':{'22':{'sha256':hashlib.sha256(raw).hexdigest()}}}))
            with patch.object(status,'FRAME_CACHE',directory),patch.object(status,'build_opener',side_effect=RuntimeError('offline')):
                with status.liang_frame(22) as image:self.assertEqual(image.size,(1254,1254))
                target.write_bytes(b'corrupt')
                with self.assertRaises(RuntimeError):status.liang_frame(22)
                with self.assertRaises(ValueError):status.liang_frame('../secret')

    def test_zero_arg_langchain_tools_cannot_change_sources_accounts_or_actions(self):
        for tool in (status.deepseek_service_status, status.liang_status):
            with patch.object(status, "query_status", return_value={"ok": True}) as query:
                # LangChain ignores extra keys on an empty schema. Neither the
                # implementation nor the Node/worker boundary can use them.
                for args in [{}, {"url": "https://example.invalid/", "direction": "up", "key": "not-a-key"}]:
                    self.assertTrue(tool.invoke(args)["ok"])
                self.assertEqual(query.call_args_list, [unittest.mock.call("deepseek" if tool.name.startswith("deepseek") else "liang")] * 2)

    def test_failure_never_exposes_raw_error_or_creates_fake_picture(self):
        with patch.object(status, "fetch_deepseek", side_effect=RuntimeError("private-token=sk-secret")):
            value = status.deepseek_service_status.invoke({})
        self.assertFalse(value["ok"])
        self.assertIsNone(value["artifact_id"])
        self.assertNotIn("private-token", json.dumps(value))
        self.assertIn(status.SOURCES["deepseek"], value["text"])

    def test_success_returns_bounded_artifact_and_same_snapshot_caption(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(status, "OUTPUT", Path(folder)), patch.object(status, "fetch_deepseek", return_value=html()), patch.object(status, "parse_deepseek", return_value={"overall": "degraded", "components": [{"name": "Pro", "status": "degraded"}], "incidents": []}):
                value = status.deepseek_service_status.invoke({})
                self.assertTrue(value["ok"])
                self.assertIn("性能下降", value["text"])
                self.assertTrue(value["text"].endswith("来源：https://status.deepseek.com/"))
                from PIL import Image
                with Image.open(Path(folder) / (value["artifact_id"] + ".png")) as image:
                    self.assertEqual(image.width, 1080)

    def test_real_main_agent_tools_route_once_without_second_model_and_gray_has_none(self):
        for name in ("deepseek_service_status", "liang_status"):
            calls = []
            model = ScriptedModel(responses=[call(name, {})])
            runner = agent_worker.build_runner(model_factory=lambda _: model, rpc_callback=lambda *args: calls.append(args) or "已生成图片")
            result = runner.run(packet(text="查一下服务现在状态", context={"scope": "c2c"}))
            self.assertEqual(result["kind"], "tool")
            self.assertEqual(calls[0][2:], (name, {}))
            self.assertEqual(len(model.seen), 1)
            gray = ScriptedModel(responses=[call("clarify_or_ignore", {"reason": "restricted_access"})])
            restricted = agent_worker.build_runner(model_factory=lambda _: gray, rpc_callback=lambda *args: self.fail("gray must not query"))
            self.assertEqual(restricted.run(packet(context={"scope": "group", "access": "gray", "groupContext": [], "currentSpeaker": "member-abc"}))["kind"], "clarify")
            self.assertNotIn(name, gray.bound[0])


if __name__ == "__main__":
    unittest.main()
