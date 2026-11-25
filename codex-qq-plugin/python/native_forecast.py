"""Read a pinned ECMWF or CAMS run directly into the existing map viewport."""
import math
import hashlib
import os
import re
import sys
import tempfile
import time
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from threading import Lock

import httpx
from PIL import Image
from video_trace import sample
from weather_video_codec import VideoFailure

STORE = 'https://openmeteo.s3.amazonaws.com/data_run'
FIELDS = {'temperature': ('temperature_2m', '°C', -100, 70),
          'precipitation': ('precipitation', 'mm', 0, 1000),
          'cloud_cover': ('cloud_cover', '%', 0, 100),
          'pm25': ('pm2_5', 'μg/m³', 0, 5000)}
DOMAINS = {'ecmwf_ifs': 'ECMWF IFS', 'ncep_gfs013': 'NOAA GFS', 'cams_global': 'CAMS 全球', 'cams_europe': 'CAMS 欧洲'}
BLOCK = 32768
CACHE_TIMESTAMP_SIZE = 8


def valid_update_time(updated_at, run_at, now):
    if type(updated_at) is int and type(run_at) is int and 0 < run_at <= updated_at <= now + 60:
        return updated_at
    return None


def libraries():
    # Staged Linux releases may carry pinned wheels alongside the application.
    vendor = Path(__file__).with_name('.ifs-runtime')
    if vendor.is_dir() and str(vendor) not in sys.path:
        sys.path.insert(0, str(vendor))
    import numpy as np
    from omfiles import OmFileReader
    return np, OmFileReader


class RangeFile:
    """Seekable, bounded HTTP reader for one immutable object. Fetch each block once."""
    def __init__(self, client, url, deadline, *, block_size=BLOCK):
        self.client, self.url, self.deadline = client, url, deadline
        self.block_size = block_size
        self.lock, self.blocks, self.inflight = Lock(), OrderedDict(), {}
        self.failure = None
        self.budget = 24 * 1024 * 1024
        self.etag = None
        self.updated_at = None
        tail, start, self.length = self._request('bytes=-16384')
        if start != max(0, self.length - 16384):
            raise ValueError('invalid footer')
        self.tail = tail

    def _request(self, interval):
        try:
            return self._read_range(interval)
        except httpx.TransportError:
            # An idle connection can reset mid-fetch. Retry this same pinned range once.
            if self.deadline-time.monotonic() < 1:
                raise
            return self._read_range(interval)

    def _read_range(self, interval):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('native deadline')
        headers = {'Range': interval}
        if self.etag:
            headers['If-Match'] = self.etag
        with sample('video_download_slowest'), self.client.stream(
                'GET', self.url, headers=headers, timeout=min(6, remaining)) as response:
            if response.status_code != 206:
                raise ValueError('range unavailable')
            match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
            if not match:
                raise ValueError('invalid range')
            start, last, length = map(int, match.groups())
            size = last - start + 1
            tag = response.headers.get('ETag')
            if not (0 < size <= 2*1024*1024 and 0 <= start <= last < length and tag
                    and (self.etag is None or self.etag == tag)
                    and int(response.headers['Content-Length']) == size):
                raise ValueError('inconsistent range')
            if self.etag is None:
                modified = response.headers.get('Last-Modified')
                try:
                    stamp = parsedate_to_datetime(modified) if modified else None
                    if stamp is not None and stamp.tzinfo is not None:
                        self.updated_at = int(stamp.timestamp())
                except (ValueError, OverflowError, OSError):
                    pass
            self.etag = tag
            with self.lock:
                self.budget -= size
                if self.budget < 0:
                    raise ValueError('native transfer budget')
            data = response.read()
            if len(data) != size:
                raise ValueError('short range')
            return data, start, length

    def size(self, path):
        if path != self.url:
            raise ValueError('unexpected object')
        return self.length

    def _block(self, offset):
        with self.lock:
            if self.failure is not None:
                raise self.failure
            if offset in self.blocks:
                self.blocks.move_to_end(offset)
                return self.blocks[offset]
            pending = self.inflight.get(offset)
            if pending is None:
                pending = self.inflight[offset] = Future()
                owner = True
            else:
                owner = False
        if owner:
            try:
                end = min(self.length, offset + self.block_size)
                data, start, size = self._request(f'bytes={offset}-{end-1}')
                if start != offset or size != self.length or len(data) != end-offset:
                    raise ValueError('misplaced range')
                with self.lock:
                    self.blocks[offset] = data
                    if len(self.blocks) > 160:
                        self.blocks.popitem(last=False)
                pending.set_result(data)
            except BaseException as error:
                with self.lock:
                    self.failure = error
                pending.set_exception(error)
            finally:
                with self.lock:
                    self.inflight.pop(offset)
        return pending.result()

    def cat_file(self, path, start, end):
        if not (0 <= start <= end <= self.size(path) and end-start <= 2*1024*1024):
            raise ValueError('invalid read')
        tail_start = self.length-len(self.tail)
        if start >= tail_start:
            return self.tail[start-tail_start:end-tail_start]
        parts = []
        while start < end:
            offset = start//self.block_size*self.block_size
            block = self._block(offset)
            stop = min(end, offset+len(block))
            parts.append(block[start-offset:stop-offset])
            start = stop
        return b''.join(parts)


def coordinate_axes(view, side):
    np, _ = libraries()
    positions = (np.arange(side)+.5)*view['size']/side
    lon = (view['left']+positions)/view['world']*360-180
    lat = np.degrees(np.arctan(np.sinh(math.pi*(1-2*(view['top']+positions)/view['world']))))
    return lat, lon


def domain_for(layer, view):
    if layer != 'pm25':
        return 'ecmwf_ifs'
    # Test the outer edges, including interpolation neighbours.
    x, y, span = (view[k]/view['world'] for k in ('left', 'top', 'size'))
    latitude = lambda v: math.degrees(math.atan(math.sinh(math.pi*(1-2*v))))
    if (x*360-180 >= -24.95 and (x+span)*360-180 <= 44.95
            and latitude(y) <= 71.95 and latitude(y+span) >= 30.05):
        return 'cams_europe'
    return 'cams_global'


def gaussian_row(y):
    distance = min(y, 2559-y)
    base = 2*y*y+18*y if y < 1280 else 6599680-(2*(2560-y)**2+18*(2560-y))
    return base, 20+4*distance


def verify_grid(domain, wkt):
    if domain == 'ecmwf_ifs':
        if 'Reduced Gaussian Grid O1280' not in wkt:
            raise ValueError('unexpected Gaussian grid')
        return
    match = re.search(r'BBOX\[([^\]]+)\]', wkt)
    expected = {'cams_global': (-90,-180,90,179.6), 'cams_europe': (71.95,-24.95,30.05,44.95),
                'ncep_gfs013': (-89.912125,-180,89.912125,179.88281)}[domain]
    box = [float(v) for v in match.group(1).split(',')] if match else []
    if len(box)!=4 or not all(math.isclose(a,b,abs_tol=.0001) for a,b in zip(box,expected)):
        raise ValueError('unexpected regular grid')


def raster_side(domain, view):
    step = {'ecmwf_ifs': 180/2560.5, 'ncep_gfs013': 360/3072, 'cams_global': .4, 'cams_europe': .1}[domain]
    return min(192, max(16, math.ceil(view['size']/view['world']*360/step)+2))


def projected_frames(root, domain, view, time_slice, limits, *, workers=8):
    np, _ = libraries()
    gaussian = domain == 'ecmwf_ifs'
    rows, cols, lat0, dy, lon0 = {
        'ecmwf_ifs': (2560, 0, 1279.5*180/2560.5, -180/2560.5, 0),
        'ncep_gfs013': (1536, 3072, -0.11714935*1535/2, 0.11714935, -180.),
        'cams_global': (451, 900, -90., .4, -180.),
        'cams_europe': (420, 700, 71.95, -.1, -24.95),
    }[domain]
    if tuple(root.shape[:2]) != ((1, 6599680) if gaussian else (rows, cols)):
        raise ValueError('unexpected model grid')
    # Cell-centred pixels cover exactly the approved Web Mercator viewport.
    # Match native detail for local views; bound source rows and RAM for wide areas.
    pixels = raster_side(domain, view)
    lat, lon = coordinate_axes(view, pixels)
    ys = np.clip((lat-lat0)/dy, 0, rows-1)
    lo, hi = math.floor(ys.min()), math.ceil(ys.max())
    selected = np.unique(np.rint(np.linspace(lo, hi, min(hi-lo+1, 160))).astype(int))

    def band(y):
        if gaussian:
            offset, width = gaussian_row(int(y))
        else:
            offset, width = 0, cols
        dx = .1 if domain == 'cams_europe' else 360/width
        xs = (lon-lon0)/dx
        x0 = np.floor(xs).astype(int)
        first, last = int(x0[0]), int(x0[-1])+1
        count = last-first+1
        def read(x, n):
            return root[0, offset+x:offset+x+n, time_slice] if gaussian else root[int(y), x:x+n, time_slice]
        if domain == 'cams_europe':
            if first < 0 or last >= cols:
                raise ValueError('outside Europe grid')
            values = read(first, count)
        else:
            start = first % width
            n = min(count, width-start)
            values = read(start, n)
            if n < count:
                values = np.concatenate((values, read(0, count-n)))
        with sample('video_decode_slowest'):
            if not np.isfinite(values).all() or values.min() < limits[0] or values.max() > limits[1]:
                raise ValueError('invalid model values')
            weight = (xs-x0).astype('float32')[:,None]
            i = x0-first
            return values[i]*(1-weight)+values[i+1]*weight

    with ThreadPoolExecutor(max_workers=workers) as pool:
        bands = np.stack(list(pool.map(band, selected)))
    lower = np.maximum(0, np.searchsorted(selected, ys, side='right')-1)
    upper = np.minimum(lower+1, len(selected)-1)
    weight = ((ys-selected[lower])/np.maximum(1, selected[upper]-selected[lower])).astype('float32')[:,None]
    return [Image.fromarray(bands[lower,:,t]*(1-weight)+bands[upper,:,t]*weight) for t in range(bands.shape[2])]


def cached_frames(prefix, side, count, bounds):
    np, _ = libraries()
    for available in (48,24) if count==24 else (48,):
        path = prefix.with_suffix(f'.{available}.grid')
        try:
            if path.is_symlink() or path.stat().st_size != CACHE_TIMESTAMP_SIZE+available*side*side*4:
                continue
            with path.open('rb') as stream:
                updated_at = int.from_bytes(stream.read(CACHE_TIMESTAMP_SIZE), 'little') or None
                data = np.fromfile(stream, dtype='<f4', count=count*side*side).reshape(count,side,side)
            if not np.isfinite(data).all() or data.min() < bounds[0]-.001 or data.max() > bounds[1]+.001:
                continue
            return [Image.fromarray(frame) for frame in data], updated_at
        except (OSError, ValueError):
            continue
    return None


def store_frames(prefix, frames, updated_at):
    # Storage is private and disposable. A full disk or competing job cannot break a forecast.
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(dir=prefix.parent, prefix='native-', suffix='.tmp', delete=False) as f:
            tmp = Path(f.name)
            # Keep the timestamp and frame data in the same atomic cache entry.
            f.write((updated_at or 0).to_bytes(CACHE_TIMESTAMP_SIZE, 'little'))
            for frame in frames:
                f.write(frame.tobytes('raw','F;32F'))
        os.replace(tmp,prefix.with_suffix(f'.{len(frames)}.grid'))
        files = sorted(prefix.parent.glob('native-*.grid'), key=lambda p:p.stat().st_mtime, reverse=True)
        for stale in files[4:]:
            stale.unlink(missing_ok=True)
    except OSError:
        pass
    finally:
        if tmp is not None:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass


def native_forecast(layer, view, times, now, deadline, cache_dir=None, *, domain=None):
    name, unit, low, high = FIELDS[layer]
    domain = domain or domain_for(layer, view)
    # IFS row slices touch many disjoint ranges. Keep one origin and overlap the
    # smaller reads; the CAMS rectangular grids need fewer connections.
    workers, block_size = (32, 16*1024) if domain=='ecmwf_ifs' else (8, BLOCK)
    try:
        np, reader_type = libraries()
        with httpx.Client(headers={'Accept-Encoding':'identity'}, limits=httpx.Limits(
                max_connections=workers, max_keepalive_connections=workers), timeout=6) as client:
            base = f'{STORE}/{domain}'
            with sample('video_download_slowest'):
                response = client.get(base+'/latest.json')
                response.raise_for_status()
                manifest = response.json()
            run = datetime.strptime(manifest['reference_time'], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
            run_at = int(run.timestamp())
            source = DOMAINS[domain]+' · Open-Meteo'
            max_age = {'ecmwf_ifs':24, 'ncep_gfs013':24, 'cams_global':36, 'cams_europe':48}[domain]*3600
            if not (0 <= now-run_at <= max_age) or name not in manifest['variables']:
                raise ValueError('run not available')
            verify_grid(domain, manifest['crs_wkt'])
            url = f"{base}/{run.strftime('%Y/%m/%d/%H%MZ')}/{name}.om"
            prefix = None
            if cache_dir:
                # Include the pinned run, start hour and exact viewport in the cache identity.
                identity = (url, times[0], *(view[k] for k in ('world','size','left','top')), 'mercator-v1')
                prefix = cache_dir/('native-'+hashlib.sha256(repr(identity).encode()).hexdigest())
                hit = cached_frames(prefix,raster_side(domain,view),len(times),(low,high))
                if hit is not None:
                    frames, updated_at = hit
                    return frames, source, valid_update_time(updated_at, run_at, now)
            store = RangeFile(client, url, deadline, block_size=block_size)
            updated_at = valid_update_time(store.updated_at, run_at, now)
            with reader_type.from_fsspec(store, url) as root:
                with root.get_child_by_name('crs_wkt') as crs:
                    verify_grid(domain,crs.read_scalar())
                with root.get_child_by_name('unit') as units, root.get_child_by_name('forecast_reference_time') as ref:
                    if units.read_scalar() != unit or ref.read_scalar() != run_at:
                        raise ValueError('inconsistent metadata')
                with root.get_child_by_name('time') as axis:
                    if axis.shape != (root.shape[-1],) or not (1 <= axis.shape[0] <= 400):
                        raise ValueError('invalid time dimension')
                    stamps = axis[:]
                k = int(np.searchsorted(stamps, times[0]))
                if np.any(np.diff(stamps)<=0):
                    raise ValueError('invalid forecast time axis')
                if times[0]>stamps[-1]:
                    raise VideoFailure('VIDEO_OUTSIDE_WINDOW')
                times=[t for t in times if t<=stamps[-1]]
                if not np.array_equal(stamps[k:k+len(times)], times):
                    raise ValueError('incomplete hourly forecast')
                # Each compressed chunk already contains the time series. Reuse it for a 48h follow-up.
                count = len(times)
                if prefix and count==24 and np.array_equal(stamps[k:k+48], times[0]+np.arange(48)*3600):
                    count = 48
                frames = projected_frames(root, domain, view, slice(k,k+count), (low, high), workers=workers)
                if prefix and len(frames) in (24,48):
                    store_frames(prefix,frames,updated_at)
                for frame in frames[len(times):]:
                    frame.close()
                frames = frames[:len(times)]
        return frames, source, updated_at
    except (ImportError, OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError, httpx.HTTPError) as err:
        raise VideoFailure('VIDEO_NATIVE_UNAVAILABLE') from err
