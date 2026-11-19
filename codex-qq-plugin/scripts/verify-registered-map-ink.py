"""Replay the government-sheet pixel registration for the unpublished weather overlay.

Pass --originals DIRECTORY to verify the two original JPEGs as well.
"""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
EVIDENCE = APP / 'docs/map-registration-source-pixels-20261104.json.gz'


def grid_value(line, pixel):
    lo, hi = line['domain']
    t = (2 * pixel - lo - hi) / (hi - lo)
    first, second = 1, t
    result = line['coeff'][0] + line['coeff'][1] * t
    for coefficient in line['coeff'][2:]:
        first, second = second, 2 * t * second - first
        result += coefficient * second
    return result


def coordinate(lines, along, observed):
    nodes = [(grid_value(line, along), float(degree)) for degree, line in lines.items()
             if line['support'][0] - 90 <= along <= line['support'][1] + 90]
    nearby = sorted(nodes, key=lambda pair: abs(pair[0] - observed))[:4]
    if len(nearby) < 3:
        raise ValueError('Insufficient printed graticule')
    return sum(value * math.prod((observed - other) / (position - other)
                                 for other, _ in nearby if other != position)
               for position, value in nearby)


def verify(originals=None, source=EVIDENCE):
    if not source.is_file():
        raise SystemExit('Supply the local registration record with --evidence PATH.')
    receipt = json.loads(gzip.decompress(source.read_bytes()))
    data = json.loads((APP / 'data/weather-regional-ink-review.json').read_bytes())
    if data['state'] != 'internal-review':
        raise ValueError('Unexpected review state')
    for name, sheet in receipt['sheets'].items():
        if sheet['sha256'] != data['sheets'][name]['sha256']:
            raise ValueError('Inconsistent original sheet')
        if originals:
            with (originals / sheet['localName']).open('rb') as stream:
                if hashlib.file_digest(stream,'sha256').hexdigest() != sheet['sha256']:
                    raise ValueError('Original sheet checksum mismatch')

    count = 0
    maximum = 0
    def compare(sheet_name, pixels, geographic):
        nonlocal count, maximum
        sheet = receipt['sheets'][sheet_name]
        for (x,y), (lon,lat) in zip(pixels,geographic,strict=True):
            projected_lon = coordinate(sheet['meridians'],y,x)
            projected_lat = coordinate(sheet['parallels'],x,y)
            error = max(abs(projected_lon-lon),abs(projected_lat-lat))
            maximum = max(maximum,error)
            if error > .0000052:
                raise ValueError(f'Coordinate differs from registered source at {(x,y)}')
            count += 1

    for source_mark, mark in zip(receipt['marine'],data['marine'],strict=True):
        if source_mark['id'] != mark['id'] or len(mark['ink']) != 4:
            raise ValueError('Original mark identity or interrupted pattern lost')
        for pixels, run in zip(source_mark['runs'],mark['ink'],strict=True):
            compare('portrait',pixels,run)
    for pixels, run in zip(receipt['districtDashes'],data['kashmir']['districtDashes'],strict=True):
        compare('landscape',pixels,run)
    compare('landscape',receipt['ceasefireDots'],data['kashmir']['ceasefireDots'])
    print(f'{count} vertices replayed, maximum coordinate rounding {maximum:.8f} degrees')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--originals', type=Path)
    parser.add_argument('--evidence', type=Path, default=EVIDENCE)
    args = parser.parse_args()
    verify(args.originals, args.evidence)
