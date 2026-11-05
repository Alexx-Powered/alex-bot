import struct
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from PIL import Image
from native_forecast import (RangeFile, cached_frames, coordinate_axes, domain_for,
                             gaussian_row, libraries, projected_frames, store_frames)
from weather_video import area


class NativeForecastTests(unittest.TestCase):
    def test_gaussian_row_continuity_and_both_poles(self):
        next_point = 0
        for y in range(2560):
            start, width = gaussian_row(y)
            self.assertEqual(start,next_point)
            self.assertEqual(width,gaussian_row(2559-y)[1])
            next_point += width
        self.assertEqual(next_point,6599680)

    def test_global_grid_projection_at_dateline_and_europe_extent(self):
        np, _ = libraries()
        class Grid:
            shape = (451,900,1)
            def __getitem__(self, index):
                y,x,_ = index
                lon = -180+np.arange(x.start,x.stop)*.4
                # Periodic at the date line, with a north-south gradient.
                return ((-90+y*.4)+np.cos(np.radians(lon))*10).astype('float32')[:,None]
        view=area(-37,179.8)
        frames=projected_frames(Grid(),'cams_global',view,slice(0,1),(-100,100))
        with frames[0] as frame:
            lat,lon=coordinate_axes(view,frame.width)
            expected=lat[:,None]+np.cos(np.radians(lon))*10
            np.testing.assert_allclose(np.asarray(frame),expected,atol=.0002)
        self.assertEqual(domain_for('pm25',area(48.86,2.35)),'cams_europe')
        self.assertEqual(domain_for('pm25',area(48,44.5)),'cams_global')
        self.assertEqual(domain_for('pm25',area(39.9,116.4)),'cams_global')

    def test_cache_serves_shorter_window_and_ignores_truncated_data(self):
        with tempfile.TemporaryDirectory() as directory:
            prefix=Path(directory)/'native-test'
            frames=[Image.new('F',(4,4),float(i)) for i in range(48)]
            store_frames(prefix,frames)
            hit=cached_frames(prefix,4,24,(0,100))
            self.assertEqual([f.getpixel((2,2)) for f in hit],list(range(24)))
            for frame in [*frames,*hit]:frame.close()
            prefix.with_suffix('.48.grid').write_bytes(struct.pack('<f',1))
            self.assertIsNone(cached_frames(prefix,4,24,(0,100)))

    def test_range_reads_validate_pin_and_reuse_blocks(self):
        data=bytes(range(256))*1024
        calls=[]
        def response(req):
            spec=req.headers['Range'].removeprefix('bytes=')
            if spec.startswith('-'):
                first,last=len(data)-int(spec[1:]),len(data)-1
            else:
                self.assertEqual(req.headers['If-Match'],'"fixed"')
                first,last=map(int,spec.split('-'))
            calls.append((first,last))
            return httpx.Response(206,content=data[first:last+1],headers={
                'ETag':'"fixed"','Content-Range':f'bytes {first}-{last}/{len(data)}'})
        with httpx.Client(transport=httpx.MockTransport(response)) as client:
            url='https://example.invalid/fixed'
            for block_size in (8192,16384,32768):
                with self.subTest(block_size=block_size):
                    calls.clear()
                    file=RangeFile(client,url,time.monotonic()+2,block_size=block_size)
                    intervals=[(200,260),(245,255),(block_size-8,block_size+7),(len(data)-22,len(data))]*4
                    with ThreadPoolExecutor(max_workers=12) as pool:
                        result=list(pool.map(lambda pair:file.cat_file(url,*pair),intervals))
                    self.assertEqual(result,[data[a:b] for a,b in intervals])
                    self.assertCountEqual(calls,[(0,block_size-1),(block_size,2*block_size-1),
                                                 (len(data)-16384,len(data)-1)])
