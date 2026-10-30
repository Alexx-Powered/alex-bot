"""Offline real LangChain graph behind the production NDJSON boundary."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'python'))
from agent_worker import build_runner, read_packet, write_packet
from test_agent_worker import ScriptedModel, call

current = {}
def factory(_):
    name = 'liang_status' if '祖' in current.get('text', '') or '变阻' in current.get('text', '') else 'deepseek_service_status'
    return ScriptedModel(responses=[call(name, {})])
def rpc(request_id, call_id, name, args):
    write_packet(sys.stdout.buffer, {'type': 'tool', 'id': request_id, 'callId': call_id, 'name': name, 'args': args})
    response = read_packet(sys.stdin.buffer)
    if not response or response.get('callId') != call_id:
        raise ValueError('INVALID_RPC')
    return response['content']
runner = build_runner(model_factory=factory, rpc_callback=rpc)
while True:
    current = read_packet(sys.stdin.buffer)
    if current is None:
        break
    write_packet(sys.stdout.buffer, runner.run(current))
