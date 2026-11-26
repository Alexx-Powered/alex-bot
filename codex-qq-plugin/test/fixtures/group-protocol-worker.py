"""Offline providers for the production LangGraph, worker businesses and stdio protocol."""
import json
import sys
import time
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import agent_worker
import worker_dynamic_weather
import worker_radar
from PIL import Image
from test_agent_worker import ScriptedModel, call
from weather_video_codec import finish_video


def record(source, parameters):
    with Path("fixture-sources.jsonl").open("a", encoding="utf-8") as file:
        file.write(json.dumps({"source": source, "parameters": parameters}) + "\n")


def radar_source(target):
    record("radar", {"target": target})
    image = BytesIO()
    Image.new("RGB", (1080, 1370), (32, 72, 101)).save(image, "PNG")
    return image.getvalue(), f"{target} · 全球雷达拼图\n来源：RainViewer"


def video_source(args, emit):
    record("forecast", args)
    started = args["start"]
    region = worker_dynamic_weather.REGIONS[args["region_id"]]
    metadata = {
        "ok": True, "format_version": 2, "width": 1080, "height": 1080, "fps": 12,
        "layer": args["layer"], "start": started, "end": started + 7200,
        "source_times": [started, started + 3600, started + 7200],
        "frames": 7, "generated_at": int(time.time()), "forecast_detail": "native",
        "region_id": region["id"], "view_bounds": region["bounds"],
    }
    output = Path(".private/weather-video")
    output.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory() as tmp:
        frames = Path(tmp)
        for i in range(metadata["frames"]):
            Image.new("RGB", (1080, 1080), (53 + i, 80, 102)).save(frames / f"frame-{i:03d}.png")
        return finish_video(frames, metadata, output, time.monotonic() + 20)


class ThinkingModel(ScriptedModel):
    extra_body: dict = {"thinking": {"type": "enabled"}}


model = ThinkingModel(responses=[
    call("radar_image", {"target": "东京", "source": "global"}),
    call("cloud_video", {"city": "华北", "day": "tomorrow", "hours": 37}),
    call("cloud_video", {"city": "华北", "day": "tomorrow", "hours": 48}),
    call("radar_image", {"target": "伦敦", "source": "global"}),
    call("radar_image", {"target": "纽约", "source": "global"}),
])
worker_radar.global_image = radar_source
worker_dynamic_weather.generate = video_source
original_build = agent_worker.build_runner
agent_worker.build_runner = lambda **kwargs: original_build(model_factory=lambda config: model, **kwargs)
agent_worker.main()
