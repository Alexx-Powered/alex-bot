"""Real production NDJSON/LangChain boundary with network replaced offline."""
import runpy
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'python'))
import provider_status


def facts(provider):
    return {'overall': 'operational', 'rows': [{'label': provider.upper() + ' API', 'sourceName': 'API', 'state': 'operational'}],
            'incidents': [], 'listLabel': '离线验证'}


with patch.object(provider_status, 'fetch_provider', side_effect=facts):
    runpy.run_path(str(ROOT / 'python/public_status_worker.py'), run_name='__main__')
