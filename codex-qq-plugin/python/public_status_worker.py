"""Private NDJSON worker for fixed LangChain status tools; no provider keys."""
import sys
from agent_worker import read_packet, write_packet
from public_status import deepseek_service_status, liang_status
from provider_status import ai_service_status, SOURCES

TOOLS = {t.name: t for t in (deepseek_service_status, liang_status, ai_service_status)}
while True:
    packet = read_packet(sys.stdin.buffer)
    if packet is None:
        break
    result = {"type": "result", "id": packet.get("id"), "kind": "error", "code": "STATUS_REQUEST_INVALID"}
    try:
        args = packet.get('args')
        valid_args = (isinstance(args, dict) and set(args) == {'provider'} and args['provider'] in SOURCES) if packet.get('name') == 'ai_service_status' else args == {}
        if packet.get("type") != "public_status" or packet.get("name") not in TOOLS or not valid_args or set(packet) - {"type", "id", "name", "args", "_sentAtMs"}:
            raise ValueError("STATUS_REQUEST_INVALID")
        result.update(kind="analysis", data=TOOLS[packet["name"]].invoke(args))
        result.pop("code", None)
    except Exception:
        pass
    write_packet(sys.stdout.buffer, result)
