"""Build the local place index from QWeather's complete published location CSV.

Usage: python scripts/build-weather-locations.py [--input downloaded.csv]
No weather API key is used. The fixed public download is performed once, without retry.
"""
import argparse
import csv
import datetime
import hashlib
import io
import json
from pathlib import Path
import re
import urllib.request
from collections import Counter

SOURCE = 'https://raw.githubusercontent.com/qwd/LocationList/master/China-City-List-latest.csv'
MAX_BYTES = 2 * 1024 * 1024


def short(value):
    value = re.sub(r'(壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|自治州|省|地区|盟|市|区|县|旗)$', '', value)
    return value


def unique(values):
    return list(dict.fromkeys(value for value in values if value))


def build(raw):
    rows = list(csv.reader(io.StringIO(raw.decode('utf-8-sig'))))
    if len(rows) < 3 or not rows[0][0].startswith('China-City-List v'):
        raise ValueError('UNEXPECTED_CATALOG_VERSION')
    version = rows[0][0]
    expected = ['Location_ID', 'Location_Name_EN', 'Location_Name_ZH', 'ISO_3166_1',
                'Country_Region_EN', 'Country_Region_ZH', 'Adm1_Name_EN', 'Adm1_Name_ZH',
                'Adm2_Name_EN', 'Adm2_Name_ZH', 'Timezone', 'Latitude', 'Longitude', 'AD_code']
    if rows[1] != expected:
        raise ValueError('UNEXPECTED_CATALOG_COLUMNS')
    places = []
    ids = set()
    for row in rows[2:]:
        if not row:
            continue
        if len(row) != len(expected) or not re.fullmatch('[A-Za-z0-9]+', row[0]):
            raise ValueError('INVALID_CATALOG_ROW')
        source_id, english, name, country_code, _, country, _, admin1, _, admin2, timezone, lat, lon, ad_code = row
        identifier = 'qweather-' + source_id
        if identifier in ids:
            raise ValueError('DUPLICATE_CATALOG_ID')
        ids.add(identifier)
        latitude, longitude = float(lat), float(lon)
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            raise ValueError('INVALID_CATALOG_COORDINATES')
        # Collapse a municipal root repeated at several administrative levels.
        parts = []
        for part in [admin1, admin2, name]:
            if part not in parts and not any(part == short(parent) for parent in parts):
                parts.append(part)
        qualified = '·'.join(parts)
        variants = unique([name, short(name)])
        prefixes = unique([admin1, short(admin1), admin2, short(admin2)])
        aliases = unique([name, short(name), english, qualified] +
                         [prefix + value for prefix in prefixes for value in variants] +
                         [a + b + value for a in unique([admin1, short(admin1)])
                          for b in unique([admin2, short(admin2)]) for value in variants])
        places.append({'id': identifier, 'name': qualified, 'latitude': latitude, 'longitude': longitude,
                       'admin1': admin1, 'admin2': admin2, 'country': country, 'countryCode': country_code,
                       'aliases': aliases, 'sourceLocationId': source_id, 'sourceName': name,
                       'sourceNameEn': english, 'timezone': timezone, 'administrativeCode': ad_code})
    places.sort(key=lambda item: item['id'])
    counts = dict(sorted(Counter(item['countryCode'] for item in places).items()))
    return {'metadata': {
        'status': 'READY', 'schemaVersion': 1,
        'source': 'QWeather official LocationList / China-City-List',
        'sourceUrl': SOURCE, 'repositoryUrl': 'https://github.com/qwd/LocationList',
        'documentationUrl': 'https://dev.qweather.com/docs/resource/location-list/',
        'sourceVersion': version, 'sourceDate': '2025-06-20' if version == 'China-City-List v202506200' else None,
        'retrievedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'sourceSha256': hashlib.sha256(raw).hexdigest(),
        'placeCount': len(places), 'countryCodeCounts': counts,
        'admin1Count': len(set(item['admin1'] for item in places)),
        'scope': 'Every data row in the official published China-City-List CSV; city/county/district weather locations, including listed HK/MO districts and TW townships. This is not a complete village list or a claim of current civil-administration completeness.',
        'coordinates': 'Unmodified coordinates from the source CSV. Legacy Beijing/Tianjin/Guangzhou aliases retain their pre-existing application coordinates separately.',
        'use': 'Official publicly downloadable location list retained for this local application with source attribution; no license is inferred for public redistribution.',
        'dynamicFallback': 'Open-Meteo official geocoding API (GeoNames data); ambiguous results require a selection.',
    }, 'places': places}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path)
    args = parser.parse_args()
    if args.input:
        raw = args.input.read_bytes()
    else:
        # Never follow a redirect to a different host when downloading this catalog.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                raise ValueError('CATALOG_REDIRECT_REJECTED')
        with urllib.request.build_opener(NoRedirect()).open(SOURCE, timeout=60) as response:
            raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('CATALOG_TOO_LARGE')
    document = build(raw)
    target = Path(__file__).resolve().parents[1] / 'data' / 'weather-locations.json'
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(document, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: document['metadata'][key] for key in ['status', 'sourceVersion', 'placeCount', 'countryCodeCounts', 'admin1Count', 'sourceSha256']}, ensure_ascii=True))


if __name__ == '__main__':
    main()
