import json
import random
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import httpx
from PIL import Image
from video_download import pooled_downloads
from weather_video import N, area, forecast_frames, latlon
from weather_video_codec import DISK_RESERVE, MAX_SPOOL, OUTPUT_SIZE, FrameFiles, VideoFailure, finish_video, frame_folder


class DownloadTests(unittest.TestCase):
    def test_three_forecast_batches_complete_in_reverse_order_without_moving_cells(self):
        view=area(32.06,118.797)
        points=[latlon(view['left']+x*view['size']/(N-1),view['top']+y*view['size']/(N-1),view['world'])
                for y in range(N) for x in range(N)]
        indices={(f'{lat:.5f}',f'{lon:.5f}'):i for i,(lat,lon) in enumerate(points)}
        barrier=threading.Barrier(3,timeout=5);done=[threading.Event() for _ in range(3)]
        times=[1793718000+i*3600 for i in range(24)]
        def fetch(url):
            query=parse_qs(urlsplit(url).query)
            coords=list(zip(query['latitude'][0].split(','),query['longitude'][0].split(',')))
            batch=indices[coords[0]]//75
            barrier.wait()
            if batch<2:self.assertTrue(done[batch+1].wait(5))
            rows=[{'latitude':float(lat),'longitude':float(lon),'utc_offset_seconds':0,
                   'hourly_units':{'temperature_2m':'°C'},
                   'hourly':{'time':times,'temperature_2m':[indices[(lat,lon)]%50]*24}} for lat,lon in coords]
            done[batch].set()
            return json.dumps(rows).encode()
        _,actual,grids=forecast_frames('temperature',32.06,118.797,times[0],fetch)
        self.assertEqual(times,actual)
        self.assertTrue(all(g==[i%50 for i in range(N*N)] for g in grids))

    def test_response_bounds_redirects_and_throttle_survive_pooling(self):
        calls=[]
        def serve(request):
            path=request.url.path;calls.append(path)
            if path=='/limit':return httpx.Response(429)
            if path=='/redirect':return httpx.Response(302,headers={'Location':'https://example.invalid/x'})
            return httpx.Response(200,stream=httpx.ByteStream(b'data'))
        client=httpx.Client(transport=httpx.MockTransport(serve))
        with patch('video_download.httpx.Client',return_value=client),pooled_downloads() as fetch:
            with self.assertRaisesRegex(VideoFailure,'VIDEO_SOURCE_INVALID'):fetch('https://example.invalid/x')
            for path,limit in [('/redirect',10),('/too-large',3)]:
                with self.assertRaisesRegex(VideoFailure,'VIDEO_SOURCE_INVALID'):fetch('https://geo.weather.gc.ca'+path,limit)
            for _ in range(2):
                with self.assertRaises(VideoFailure) as error:fetch('https://geo.weather.gc.ca/limit')
                self.assertFalse(error.exception.transient)
            self.assertEqual(fetch('https://api.open-meteo.com/fallback',4),b'data')
        self.assertTrue(client.is_closed)
        self.assertEqual(calls,['/redirect','/too-large','/limit','/fallback'])

    def test_both_lossless_frame_formats_preserve_pixels_order_and_cleanup(self):
        with TemporaryDirectory() as tmp,Image.new('RGB',(OUTPUT_SIZE,OUTPUT_SIZE),'#826b49') as image:
            image.paste((12,42,126),(0,1,32,45))
            for extension,free in [('tga',DISK_RESERVE+MAX_SPOOL),('png',DISK_RESERVE+MAX_SPOOL-1)]:
                with frame_folder(Path(tmp)) as folder:
                    spool=FrameFiles(folder)
                    with patch('weather_video_codec.shutil.disk_usage',return_value=SimpleNamespace(free=free)):
                        spool.append(image)
                    with Image.open(folder/('frame-000.'+extension)) as decoded:
                        self.assertEqual(decoded.convert('RGB').tobytes(),image.tobytes())
                self.assertFalse(folder.exists())

    def test_tga_and_png_use_the_same_h264_colour_conversion(self):
        width,height=64,48
        outputs=[]
        with TemporaryDirectory() as tmp:
            for extension in ('png','tga'):
                with frame_folder(Path(tmp)) as folder:
                    for index in range(3):
                        pixels=random.Random(index).randbytes(width*height*3)
                        with Image.frombytes('RGB',(width,height),pixels) as image:
                            image.save(folder/f'frame-{index:03d}.{extension}')
                    result=finish_video(folder,{'frames':3},Path(tmp),time.monotonic()+15)
                    outputs.append((Path(tmp)/(result['artifact_id']+'.mp4')).read_bytes())
        self.assertEqual(outputs[0],outputs[1])
