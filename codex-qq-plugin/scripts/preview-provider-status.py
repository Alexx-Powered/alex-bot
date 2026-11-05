"""Read current public status through the real restricted LangChain tool."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))
from provider_status import ai_service_status, SOURCES

OUT = ROOT / 'test-output/status-providers'
OUT.mkdir(parents=True, exist_ok=True)


def capture(provider):
    result = ai_service_status.invoke({'provider': provider})
    (OUT / (provider + '-source.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'provider': provider, 'overall': result['report']['overall'], 'checkedAt': result['checked_at'],
            'rows': len(result['report']['rows']), 'incidents': result['report']['incidentCount']}


if __name__ == '__main__':
    with ThreadPoolExecutor(max_workers=2) as pool:
        for result in pool.map(capture, SOURCES):
            print(json.dumps(result, ensure_ascii=False), flush=True)
