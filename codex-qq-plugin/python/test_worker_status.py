from copy import deepcopy
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from PIL import Image
from provider_status import SOURCES, prepare_report
import worker_artifacts
import worker_status as status


def png(size):
    buffer = BytesIO()
    Image.new("RGB", size).save(buffer, "PNG")
    return buffer.getvalue()


class WorkerStatusTests(unittest.TestCase):
    def setUp(self):
        tmp = self.enterContext(TemporaryDirectory())
        self.folder = Path(tmp) / "replies"
        self.enterContext(patch.object(worker_artifacts, "DIRECTORY", self.folder))
        self.checked = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.provider = self.enterContext(patch.object(status, "ai_service_status"))
        facts = {"overall": "operational", "incidents": [], "listLabel": "服务",
                 "rows": [{"label": "网页", "sourceName": "Website", "state": "operational"}]}
        self.value = {"service": "kimi", "source": SOURCES["kimi"], "checked_at": self.checked,
                      "text": "运行正常\n来源：" + SOURCES["kimi"],
                      "report": prepare_report("kimi", facts, self.checked)}
        self.provider.invoke.return_value = self.value

    def reply(self):
        return status.status_reply("ai_service_status", {"provider": "kimi"}, "fixture")

    def test_valid_snapshot_is_rendered_by_real_node_canvas(self):
        result = self.reply()
        self.assertEqual(result, {"text": self.value["text"], "richMedia": True, "media": "png"})
        with Image.open(self.folder / "fixture.png") as card:
            self.assertGreater(card.width, 1000)
            self.assertGreater(card.height, 500)
            card.verify()

    def test_invalid_sources_timestamps_schema_and_content_do_not_reach_canvas(self):
        cases = [
            ("service", "claude"), ("source", SOURCES["claude"]),
            ("checked_at", "2000-01-01T11:00:00Z"), ("checked_at", "2080-01-01T11:00:00Z"),
            ("text", "带有@标签\n来源：" + SOURCES["kimi"]), ("text", "没有指定来源"),
            ("report.provider", "openai"), ("report.source", SOURCES["openai"]),
            ("report.checkedAt", "2025-01-01T00:00:00Z"), ("report.mode", "historical"),
            ("report.summary", "过" * 151), ("report.incidentCount", 1), ("report.other", "unexpected"),
            ("report.rows", [{"label": "<tag>", "sourceName": "Website", "state": "operational"}]),
            ("report.rows", [{"label": "组件", "sourceName": "Website", "state": "partial_outage"}]),
        ]
        with patch.object(status, "render_canvas") as renderer:
            for path, invalid in cases:
                with self.subTest(path=path, invalid=invalid):
                    data = deepcopy(self.value)
                    target = data
                    parts = path.split(".")
                    for part in parts[:-1]:
                        target = target[part]
                    target[parts[-1]] = invalid
                    self.provider.invoke.return_value = data
                    reply = self.reply()
                    self.assertEqual(set(reply), {"text"})
                    self.assertTrue(reply["text"].endswith("来源：" + SOURCES["kimi"]))
                    self.assertNotIn("运行正常", reply["text"])
            renderer.assert_not_called()
        self.assertFalse(self.folder.exists())

    def test_oversize_and_corrupt_canvas_outputs_are_not_published(self):
        for data in (b"x" * (status.PNG_LIMIT + 1), b"not a PNG", png((100, 100))[:-30]):
            with patch.object(status, "render_canvas", return_value=data):
                self.assertNotIn("media", self.reply())
        self.assertFalse(self.folder.exists())

    def test_liang_validates_artifact_identity_dimensions_and_failure_caption(self):
        source = status.PUBLIC_SOURCES["liang"]
        identity = "a" * 32
        data = dict(service="liang", source=source, checked_at=self.checked, ok=True,
                    artifact_id=identity, text="已查询\n来源：" + source)
        with TemporaryDirectory() as tmp, patch.object(status, "OUTPUT", Path(tmp)), patch.object(status, "liang_status") as tool:
            tool.invoke.return_value = data
            path = Path(tmp) / (identity + ".png")
            for size in [(100, 300), (1080, 199), (1080, 200)]:
                with self.subTest(size=size):
                    path.write_bytes(png(size))
                    result = status.status_reply("liang_status", {}, "fixture")
                    self.assertEqual("media" in result, size == (1080, 200))
                    self.assertFalse(path.exists())
            data.update(ok=False, artifact_id=None)
            self.assertEqual(status.status_reply("liang_status", {}, "missing"), {"text": data["text"]})
            data["text"] = "来源：https://elsewhere.invalid/"
            self.assertTrue(status.status_reply("liang_status", {}, "bad")["text"].endswith(source))

    def test_provider_is_an_allowlisted_tool_argument(self):
        for tool, args in [("ai_service_status", {"provider": "unsupported"}),
                           ("ai_service_status", {"provider": "kimi", "extra": True}),
                           ("deepseek_service_status", {"provider": "kimi"}), ("other", {})]:
            with self.assertRaisesRegex(ValueError, "STATUS_TOOL_DENIED"):
                status.status_reply(tool, args, "unused")
        self.provider.invoke.assert_not_called()
