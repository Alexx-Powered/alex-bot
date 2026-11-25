import io
import json
import math
import time
import unittest
from urllib.parse import urlsplit, parse_qs
from unittest.mock import patch

from PIL import Image
from gdps_cloud import LAYER, WORLD, cloud_forecast, coverage, iso
from weather_video import VideoFailure, area, prepare_video


def tiff(bounds, side, value=75, crs=3857):
    west,south,east,north=bounds
    tags={33550:((east-west)/side,(north-south)/side,0.),33922:(0.,0.,0.,west,north,0.),
          34735:(1,1,0,2,1025,0,1,1,3072,0,1,crs)}
    out=io.BytesIO()
    with Image.new('F',(side,side),value) as image:image.save(out,'TIFF',tiffinfo=tags)
    return out.getvalue()


class CloudTests(unittest.TestCase):
    def test_native_view_and_each_valid_hour_are_pinned_to_one_run(self):
        start=1793743200;times=[start+i*3600 for i in range(48)]
        stamps=[iso(t) for t in times];run=iso(start-3600)
        view=area(32.06,118.797);calls=[]
        west=(view['left']/view['world']-.5)*WORLD;north=(.5-view['top']/view['world'])*WORLD
        span=view['size']/view['world']*WORLD
        def fetch(url,limit):
            q=parse_qs(urlsplit(url).query)
            if q['SERVICE']==['WMS']:
                return (f'<Layer xmlns="http://www.opengis.net/wms"><Name>{LAYER}</Name>'
                        f'<Dimension name="time">{",".join(stamps)}</Dimension>'
                        f'<Dimension name="reference_time" default="{run}"/></Layer>').encode()
            side=38
            self.assertEqual(q['SIZE'],[f'x({side})',f'y({side})'])
            self.assertEqual(q['SUBSET'],[f'x({west:.4f},{west+span:.4f})',f'y({north-span:.4f},{north:.4f})'])
            self.assertEqual(q['DIM_REFERENCE_TIME'],[run]);self.assertEqual(q['OUTPUTCRS'],['EPSG:3857'])
            stamp=q['TIME'][0];calls.append(stamp)
            return tiff((west,north-span,west+span,north),side,stamps.index(stamp))
        frames=cloud_forecast(view,times,fetch,time.monotonic()+5)
        try:
            self.assertCountEqual(calls,stamps)
            self.assertEqual([frame.getpixel((0,0)) for frame in frames],list(range(48)))
        finally:
            for frame in frames:frame.close()

    def test_shifted_extent_wrong_crs_and_missing_data_are_rejected(self):
        bounds=(500.,500.,2000.,2000.)
        for raw in [tiff(bounds,4,-9999),tiff(bounds,4,math.nan),tiff(bounds,4,crs=4326),
                    tiff((515.,500.,2015.,2000.),4),b'not a coverage']:
            with self.subTest(raw=raw[:4]),self.assertRaises(VideoFailure):coverage(raw,bounds,4)

    def test_fallback_preserves_the_complete_48_hour_window_and_credits(self):
        view=area(32.,118.);times=[1793743200+i*3600 for i in range(48)];grids=[[]]*48
        available=times[0]-60
        with patch('weather_video.native_forecast',side_effect=[
                VideoFailure('VIDEO_NATIVE_UNAVAILABLE'), (grids,'NOAA GFS · Open-Meteo',available)]) as native, \
             patch('weather_video.render_sequence',return_value=142) as render:
            result=prepare_video(dict(layer='cloud_cover',name='南京',latitude=32.,longitude=118.,hours=48),None,times[0])
        self.assertNotIn('domain', native.call_args_list[0].kwargs)
        self.assertEqual(native.call_args.kwargs['domain'],'ncep_gfs013')
        self.assertEqual(render.call_args.args[3]['forecast_source'],'NOAA GFS · Open-Meteo')
        self.assertEqual(render.call_args.args[3]['forecast_updated_at'],available)
        self.assertEqual(result['forecast_detail'],'native')
        self.assertIs(render.call_args.args[5],grids)
        self.assertEqual(result['source_times'],times)
