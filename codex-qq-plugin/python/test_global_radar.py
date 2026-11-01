import io
import json
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from global_radar import latest_frame,resolve_target,tile_position,map_image,build_global_radar_tool,RadarFailure

NOW=1793541000
FRAME={'time':NOW-300,'path':'/v2/radar/abcdef123456'}
def png(size,color):
    out=io.BytesIO();Image.new('RGBA',(size,size),color).save(out,format='PNG');return out.getvalue()

class GlobalRadarTests(unittest.TestCase):
    def test_manifest_never_redirects_to_supplied_host_or_accepts_old_frames(self):
        value={'host':'https://tilecache.rainviewer.com','generated':NOW,'radar':{'past':[FRAME]}}
        self.assertEqual(latest_frame(value,NOW),FRAME)
        for edited in [{**value,'host':'https://127.0.0.1'},{**value,'generated':NOW-7200},{**value,'radar':{'past':[{**FRAME,'path':'/v2/radar/../../secret'}]}}]:
            with self.assertRaises(RadarFailure):latest_frame(edited,NOW)

    def test_tiles_wrap_antimeridian_and_keep_mask_separate_from_echo(self):
        calls=[]
        def fetch(url,*args):
            calls.append(url)
            return png(256,'#dddddd') if 'openstreetmap.org' in url else png(512,(255,255,255,255)) if '/coverage/' in url else png(512,(0,0,0,0))
        place={'world':False,'name':'test','latitude':0,'longitude':179.99,'zoom':6}
        with tempfile.TemporaryDirectory() as folder:
            image,covered=map_image(place,FRAME,Path(folder),fetch)
            self.assertEqual(image.size,(1024,1024));self.assertFalse(covered)
            first_count=sum('openstreetmap.org' in u for u in calls)
            map_image(place,FRAME,Path(folder),fetch)
            self.assertEqual(sum('openstreetmap.org' in u for u in calls),first_count)
            self.assertTrue(all(0<=int(u.split('/')[-2])<64 for u in calls if 'openstreetmap.org' in u))

    def test_world_tool_returns_verified_artifact_and_never_treats_gray_as_dry(self):
        def fetch(url,*args):
            if 'weather-maps.json' in url:return json.dumps({'host':'https://tilecache.rainviewer.com','generated':NOW,'radar':{'past':[FRAME]}}).encode()
            return png(256,'#eeeeee') if 'openstreetmap.org' in url else png(512,(0,0,0,0))
        with tempfile.TemporaryDirectory() as folder:
            result=build_global_radar_tool(folder,fetch,lambda:NOW).invoke({'target':'全球'})
            self.assertTrue(result['ok'])
            with Image.open(Path(folder)/'global-radar'/(result['artifact_id']+'.png')) as image:self.assertEqual(image.size,(1080,1370))
            self.assertEqual(result['source'],'https://www.rainviewer.com/')
            self.assertNotIn('无降水',json.dumps(result,ensure_ascii=False))

    def test_target_has_no_url_or_coordinates_argument_and_ambiguous_names_fail(self):
        with self.assertRaises(RadarFailure):resolve_target('https://localhost')
        def fetch(url,*args):return json.dumps({'results':[{'name':'same','feature_code':'PPL','latitude':1,'longitude':1},{'name':'same','feature_code':'PPL','latitude':2,'longitude':2}]}).encode()
        with self.assertRaises(RadarFailure) as caught:resolve_target('same',fetch)
        self.assertEqual(caught.exception.code,'GLOBAL_RADAR_LOCATION_AMBIGUOUS')
        self.assertEqual(tile_position(0,0,1),(1,1))

if __name__=='__main__':unittest.main()
