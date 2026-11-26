"""Offline real LangChain graph behind the production NDJSON boundary."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'python'))
import agent_worker
import provider_status
import public_status
from PIL import Image
from test_agent_worker import ScriptedModel, call

current = {}
read_packet = agent_worker.read_packet

def track_request(stream):
    packet = read_packet(stream)
    if packet and packet.get('type') in ('request', 'fixed_request'):
        current.update(text=packet['text'])
    return packet

def factory(_):
    if 'openai' in current.get('text', '').lower():
        return ScriptedModel(responses=[call('openai_service_status', {})])
    for provider in ('gemini', 'claude', 'kimi'):
        if provider in current.get('text', '').lower():
            return ScriptedModel(responses=[call('ai_service_status', {'provider': provider})])
    name = 'liang_status' if '祖' in current.get('text', '') or '变阻' in current.get('text', '') else 'deepseek_service_status'
    return ScriptedModel(responses=[call(name, {})])

def facts(provider):
    return {'overall': 'operational', 'rows': [{'label': provider.upper() + ' API', 'sourceName': 'API', 'state': 'operational'}],
            'incidents': [], 'listLabel': '离线验证'}

agent_worker.read_packet = track_request
agent_worker.default_model_factory = factory
provider_status.fetch_provider = facts
public_status.fetch_liang_vote = lambda: dict(stage='梁圣', level='22.4794', up=100, down=10, frame=20)
public_status.liang_frame = lambda _: Image.new('RGB', (10, 10))
agent_worker.main()
