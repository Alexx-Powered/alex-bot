"""Read hourly GDPS total cloud cover in the exact weather-video viewport."""
import io
import math
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urlencode
from xml.etree import ElementTree

from PIL import Image
from weather_video_codec import VideoFailure
from video_trace import sample

BASE = 'https://geo.weather.gc.ca/geomet?'
LAYER = 'GDPS_15km_TotalCloudCover'
WORLD = 2 * math.pi * 6378137
WMS = '{http://www.opengis.net/wms}'
DOWNLOAD_WORKERS = 8


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def reference_run(raw, times):
    try:
        root = ElementTree.fromstring(raw)
        layer = next(node for node in root.iter(WMS+'Layer') if node.findtext(WMS+'Name') == LAYER)
        dimensions = {d.attrib['name']: d for d in layer.findall(WMS+'Dimension')}
        run = dimensions['reference_time'].attrib['default']
        issued = datetime.strptime(run, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc).timestamp()
        available = set((dimensions['time'].text or '').split(','))
        if not 0 <= times[0]-issued <= 24*3600 or not all(iso(t) in available for t in times):
            raise VideoFailure('VIDEO_DATA_MISSING')
        return run
    except (KeyError, ValueError, StopIteration, ElementTree.ParseError) as error:
        raise VideoFailure('VIDEO_SOURCE_INVALID') from error


def coverage(raw, bounds, side):
    west, south, east, north = bounds
    try:
        with Image.open(io.BytesIO(raw), formats=['TIFF']) as frame:
            if frame.mode != 'F' or frame.size != (side, side) or frame.n_frames != 1:
                raise VideoFailure('VIDEO_SOURCE_INVALID')
            scale = frame.tag_v2.get(33550, ())
            tie = frame.tag_v2.get(33922, ())
            keys = frame.tag_v2.get(34735, ())
            entries = list(zip(*[iter(keys[4:])]*4))
            if (3072,0,1,3857) not in entries or (1025,0,1,1) not in entries or len(scale)!=3 or len(tie)!=6:
                raise VideoFailure('VIDEO_SOURCE_INVALID')
            if tie[:3] != (0,0,0) or not all(math.isclose(a,b,abs_tol=.1) for a,b in zip(
                (tie[3], tie[4], scale[0]*side, scale[1]*side), (west,north,east-west,north-south))):
                raise VideoFailure('VIDEO_SOURCE_INVALID')
            # Validate before conversion so missing pixels cannot turn into clear sky.
            for value in memoryview(frame.tobytes()).cast('f'):
                if not 0 <= value <= 100:
                    raise VideoFailure('VIDEO_DATA_MISSING')
            return frame.convert('L')
    except (OSError, ValueError, SyntaxError) as error:
        raise VideoFailure('VIDEO_SOURCE_INVALID') from error


def cloud_forecast(area, times, fetch, deadline):
    span = area['size']/area['world']
    west = (area['left']/area['world']-.5)*WORLD
    north = (.5-area['top']/area['world'])*WORLD
    east, south = west + span*WORLD, north - span*WORLD
    if min(west,south) < -WORLD/2 or max(east,north) > WORLD/2:
        raise VideoFailure('VIDEO_NO_COVERAGE')
    # Size to the angular spacing of the native 0.15-degree product. Cap
    # regional views so all 48 scalar rasters fit in the small ECS worker.
    side = min(320, max(2, math.ceil(span*360/.15)))
    raw = fetch(BASE+urlencode(dict(SERVICE='WMS',VERSION='1.3.0',REQUEST='GetCapabilities',layer=LAYER)), 200000)
    run = reference_run(raw, times)
    parameters = [('SERVICE','WCS'),('VERSION','2.0.1'),('REQUEST','GetCoverage'),('COVERAGEID',LAYER),
                  ('FORMAT','image/tiff'),('SUBSETTINGCRS','EPSG:3857'),('OUTPUTCRS','EPSG:3857'),
                  ('SUBSET',f'x({west:.4f},{east:.4f})'),('SUBSET',f'y({south:.4f},{north:.4f})'),
                  ('SIZE',f'x({side})'),('SIZE',f'y({side})'),('INTERPOLATION','BILINEAR'),('DIM_REFERENCE_TIME',run)]
    def read(stamp):
        if time.monotonic() >= deadline:
            raise VideoFailure('VIDEO_TIMEOUT')
        raw = fetch(BASE+urlencode(parameters+[('TIME',iso(stamp))]), side*side*4+65536)
        with sample('video_decode_slowest'):
            return coverage(raw,(west,south,east,north),side)
    frames = []
    with ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as pool:
        futures = [pool.submit(read,t) for t in times]
        try:
            for future in futures:
                frames.append(future.result())
        except BaseException:
            for future in futures:
                future.cancel()
            for image in frames:
                image.close()
            raise
    return frames
