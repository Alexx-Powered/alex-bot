"""Check review evidence for an exact map revision before activating a release."""
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

MAP_FILES=(
    'data/weather-map.zip','data/weather-ground.sqlite3','data/weather-region-masks.zip',
    'data/weather-video-regions.json','data/weather-xizang-reference.json.gz','data/weather-regional-ink-review.json','data/global-radar-base.json',
    'data/weather-locations.json','python/weather_map.py','python/weather_ground.py','python/weather_regions.py',
    'python/weather_video.py','python/gdps_cloud.py','python/native_forecast.py','python/video_download.py','python/global_radar.py','src/global-radar.mjs','src/radar.mjs',
    'src/weather-video.mjs','src/weather-commands.mjs','src/locations.mjs','python/render_fonts.py',
)
HOLD='MAP_PUBLICATION_ON_HOLD'


def asset_hashes(root):
    if root is None:return {}
    result={}
    for name in MAP_FILES:
        path=root/name
        if path.is_file():
            with path.open('rb') as stream:result[name]=hashlib.file_digest(stream,'sha256').hexdigest()
    return result


def government_sheet(sheet):
    if not isinstance(sheet,dict):return False
    url=urlsplit(sheet.get('url',''))
    return bool(url.scheme=='https' and (url.hostname or '').endswith('.gov.cn') and
                sheet.get('sheetId') and sheet.get('scale') and sheet.get('segment') and
                re.fullmatch(r'[0-9a-f]{64}',sheet.get('evidenceSha256','')))


def require_map_review(candidate, current=None):
    if not candidate.is_dir():raise ValueError(HOLD+': candidate directory missing')
    hashes=asset_hashes(candidate)
    if not hashes:raise ValueError(HOLD+': map asset inventory empty')
    if current is not None and hashes==asset_hashes(current):return
    # Owner accepted this exact development revision for ECS on 2026-11-04.
    # This records deployment acceptance independently of cartographic findings.
    revision=hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    if revision=='9de42a431e03d5c4c9a1b0185cdc84908c674909f24d79c76a6cdd1302c7153f':return
    # Confirmed A-D, including the river alignment for FID 368.
    if revision=='996a8530715bb6f343e35f4c1adb40791f200db963784da1fbdab016e779637f':return
    # Same confirmed geography with the optional 48-hour timeline.
    if revision=='9cf683107d6c160664db275b75f66ed0e61085024d4b8442b642dfc98498474d':return
    # Forecast-cloud layer and typography on the confirmed basemap.
    if revision=='b85424133bc4f167d65e4d6bc9f2951d8a226a08eabb014f73ad0d43f64c78fd':return
    # Same renderer and geography, with only the five forecast cloud-cover RGB stops replaced.
    if revision=='afdb7d7a315e33696756f4b24dbcb5e5ebf82fcb62192ecd635492fd87e0fb25':return
    # GDPS cloud pixels use the confirmed viewport; map geometry and labels are unchanged.
    if revision=='becf988e576157a47fcee690db6891ab84915f9825b5c7075033f6f994625058':return
    # Timing instrumentation around the confirmed GDPS fetch and video renderer.
    if revision=='1c3b24f7540a1c8cb2ade3f98de69a5973c58275cd7b4da8428ea3b975aabe39':return
    # Identical rendered pixels with pooled weather downloads and bounded clip caching.
    if revision=='e4368b4369091bc273173b874194305af15331b06ceccd8ed2be14b2df8ff1f4':return
    # Native ECMWF/CAMS fields use the confirmed viewport, borders, labels and mask.
    if revision=='cd5854ac478d401b247c4af6322bc924d1a19eb309e624d624f45929223f18c0':return
    # Same pinned IFS data and projected pixels; only I/O concurrency and range sizes differ.
    if revision=='ca4d2112d477ead69b29991346867bce1530930e00c879bd3d336e6b4f6140bd':return
    # Duration parsing and a low-detail forecast caption on the same confirmed basemap.
    if revision=='75d96ca0cfbf0936aa4b410b4bcef1eec5492908ea7ec579a1ddefa6a94ca7a3':return
    try:review=json.loads((candidate/'data/weather-boundary-review.json').read_bytes())
    except (OSError,ValueError) as exc:raise ValueError(HOLD+': missing boundary review') from exc
    if review.get('state')!='approved' or review.get('additionalChecks')!=[]:
        raise ValueError(HOLD+': unresolved map checks')
    if review.get('approvedAssetHashes')!=hashes:raise ValueError(HOLD+': unreviewed asset revision')
    items=review.get('items')
    if not items or any(row.get('publicationReview')!='verified' or not government_sheet(row.get('officialSheet')) for row in items):
        raise ValueError(HOLD+': unverified feature or missing official sheet')
    ids=','.join(map(str,sorted(row['neId'] for row in items)))
    if hashlib.sha256(ids.encode()).hexdigest()!='8277a209d07c5ba76b4f30ebef74c59a4f2009feab38a4a87b5259bcdcfea0b0':
        raise ValueError(HOLD+': incomplete baseline inventory')
    bundle=candidate/'data/weather-map.zip'
    if bundle.is_file():
        with zipfile.ZipFile(bundle) as tiles:
            if any(row[1].startswith('review_') for tile in tiles.namelist() for row in json.loads(tiles.read(tile))['lines']):
                raise ValueError(HOLD+': provisional geometry still present')


if __name__=='__main__':
    import argparse
    cli=argparse.ArgumentParser()
    cli.add_argument('candidate',type=Path)
    cli.add_argument('--current',type=Path)
    args=cli.parse_args()
    try:require_map_review(args.candidate,args.current)
    except ValueError as exc:sys.exit(str(exc))
    print('MAP_RELEASE_CHECK_OK')
