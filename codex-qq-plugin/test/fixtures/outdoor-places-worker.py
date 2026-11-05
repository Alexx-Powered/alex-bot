import sys,json
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'python'))
from outdoor_places import search_outdoor_places
packet=json.loads(sys.stdin.readline())
f={'properties':{'name':'措玉村','osm_type':'N','osm_id':8395119967,'osm_key':'place','osm_value':'hamlet','state':'西藏自治区','county':'洛扎县'},'geometry':{'type':'Point','coordinates':[90.7924176,28.2381573]}}
with patch('outdoor_places.fetch',return_value={'features':[f]}):print(json.dumps(search_outdoor_places.invoke(packet)))
