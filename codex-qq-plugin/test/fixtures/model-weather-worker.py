"""A scripted provider for cross-process graph and telemetry tests."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'python'))
import agent_worker
from test_agent_worker import ScriptedModel, call

model = ScriptedModel(responses=[
    call('weather_image', {'city':'北京'}),
    call('weather_image', {'city':'广州','day':'tomorrow'}),
    call('clarify_or_ignore', {'reason':'restricted_access'}),
    call('pm25_video', {'city':'北京','hours':48}),
    call('cloud_video', {'city':'华北','hours':48}),
])
build = agent_worker.build_runner
agent_worker.build_runner = lambda **kwargs: build(model_factory=lambda _: model, **kwargs)
agent_worker.main()
