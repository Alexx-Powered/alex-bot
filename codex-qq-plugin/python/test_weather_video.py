import unittest,json,time
from unittest.mock import patch
from pydantic import ValidationError
from pathlib import Path
from weather_video import cloud_times,forecast_frames,build_tool,VideoFailure,N
class VideoTests(unittest.TestCase):
 def test_snow_marks_only_wet_snowy_pixels(self):
  from PIL import Image,ImageChops
  from weather_video import mark_snow
  with Image.new('RGB',(64,64),'#445566') as image, image.copy() as before, Image.new('F',image.size,1.0) as total, Image.new('F',image.size,0.0) as snow:
   snow.paste(0.5,(32,0,64,64))
   total.paste(0.0,(0,32,64,64))
   mark_snow(image,total,snow)
   with ImageChops.difference(image,before) as diff:
    box=diff.getbbox()
    self.assertIsNotNone(box)
    self.assertGreaterEqual(box[0],32)
    self.assertLessEqual(box[3],32)

 def test_missing_snow_keeps_total_without_cross_model_substitution(self):
  from PIL import Image
  from weather_video import prepare_video
  calls=[]
  def native(layer,region,times,now,deadline,cache_dir,*,domain=None,manifests):
   calls.append((layer,domain,manifests))
   if layer=='snow_water':raise VideoFailure('VIDEO_NATIVE_UNAVAILABLE')
   return [Image.new('F',(2,2),1)],'ECMWF IFS',None
  with patch('weather_video.native_forecast',side_effect=native),patch('weather_video.render_sequence',return_value=1) as render:
   result=prepare_video(dict(name='测试',layer='precipitation',latitude=41,longitude=115),None)
  self.assertTrue(result['ok'])
  self.assertFalse(render.call_args.args[3]['snow_available'])
  self.assertEqual(calls[1][:2],('snow_water','ecmwf_ifs'))
  self.assertIs(calls[0][2],calls[1][2])

 def test_all_regions_fit_between_title_and_timeline_in_both_sources(self):
  from weather_regions import REGIONS,REGION_ALIASES,regional_area
  from weather_video import cloud_window,xy
  self.assertEqual(len(REGIONS),41)
  self.assertEqual(REGIONS['cn-north']['members'],['11','12','13','14'])
  self.assertEqual(REGION_ALIASES['新疆维吾尔自治区'],'cn-65')
  self.assertNotIn('新疆乌鲁木齐',REGION_ALIASES)
  for region in REGIONS.values():
   a=regional_area(region);w,s,e,n=region['bounds']
   z,left,top,side,cols,rows=cloud_window(a)
   self.assertLessEqual(len(cols)*len(rows),6);self.assertLessEqual(side,384)
   for lat,lon in [(s,w),(s,e),(n,w),(n,e)]:
    x,y=xy(lat,lon,1)
    fx=(x-a['left'])/a['size'];fy=(y-a['top'])/a['size']
    self.assertTrue(.049<=fx<=.951 and .149<=fy<=.761,region['name'])
    self.assertAlmostEqual((x*(256<<z)-left)/side,fx)
    self.assertAlmostEqual((y*(256<<z)-top)/side,fy)

 def test_regional_grid_and_cloud_cover_the_named_area(self):
  import io
  from urllib.parse import urlsplit,parse_qs
  from PIL import Image
  from weather_regions import REGIONS,regional_area
  from weather_video import cloud_frame,cloud_window
  a=regional_area(REGIONS['cn-65']);requested=[];tiles=set()
  def grid_fetch(url):
   q=parse_qs(urlsplit(url).query);pts=list(zip(map(float,q['latitude'][0].split(',')),map(float,q['longitude'][0].split(','))))
   requested.extend(pts);times=[1793718000+i*3600 for i in range(24)]
   return json.dumps([{'latitude':lat,'longitude':lon,'utc_offset_seconds':0,'hourly_units':{'temperature_2m':'°C'},
                       'hourly':{'time':times,'temperature_2m':[lon/4]*24}} for lat,lon in pts]).encode()
  _,_,grids=forecast_frames('temperature',None,None,1793717999,grid_fetch,viewport=a)
  self.assertEqual(len(set(requested)),225);self.assertNotEqual(grids[0][0],grids[0][-1])
  latitudes,longitudes=zip(*requested)
  self.assertLess(min(longitudes),73.5);self.assertGreater(max(longitudes),96.38)
  self.assertGreater(max(latitudes),49.18);self.assertLess(min(latitudes),34.34)
  z,_,_,side,cols,rows=cloud_window(a)
  def tile_fetch(url,limit):
   parts=urlsplit(url).path.split('/');self.assertEqual(int(parts[-3]),z)
   x,y=int(parts[-2]),int(parts[-1].split('.')[0]);tiles.add((x,y))
   data=io.BytesIO()
   with Image.new('L',(256,256),10+x*3+y) as im:im.save(data,'JPEG')
   return data.getvalue()
  with cloud_frame(a,{'basetime':'20261104000000','validtime':'20261104000000'},tile_fetch) as frame:
   self.assertEqual(frame.size,(round(side),round(side)));self.assertGreater(frame.getextrema()[1],frame.getextrema()[0])
  self.assertEqual(tiles,{(x,y) for x in cols for y in rows})

 def test_framed_region_mask_follows_the_provinces(self):
  from weather_regions import REGIONS,regional_area,focus_mask
  from weather_ground import Viewport
  for key,inside,outside in [('cn-65',(87.62,43.82),(76.89,43.24)),
                            ('cn-east',(121.47,31.23),(114.30,30.59)),
                            ('cn-north',(116.40,39.90),(117.12,36.65))]:
   a=regional_area(REGIONS[key]);view=Viewport(a,640)
   with focus_mask(a,640) as mask:
    self.assertGreater(mask.getpixel(tuple(map(round,view.point(*inside)))),200)
    self.assertLess(mask.getpixel(tuple(map(round,view.point(*outside)))),30)

 def test_video_tool_target_schema_preserves_points_and_rejects_arbitrary_regions(self):
  from weather_video import Args
  base={'name':'新疆','layer':'temperature'}
  self.assertEqual(Args(**base,region_id='cn-65').region_id,'cn-65')
  self.assertIsNone(Args(**base,latitude=43.,longitude=88.).region_id)
  for options in ({},{'region_id':'cn-random'},{'region_id':'cn-65','latitude':43.},{'bounds':[70,30,100,50]}):
   with self.assertRaises(ValidationError):Args(**base,**options)

 def test_detailed_frames_fit_and_low_disk_preserves_reserve(self):
  from tempfile import TemporaryDirectory
  from types import SimpleNamespace
  from PIL import Image
  from weather_video_codec import DISK_RESERVE,MAX_SPOOL,FrameFiles,OUTPUT_SIZE
  self.assertGreater(MAX_SPOOL,145*(3*OUTPUT_SIZE*OUTPUT_SIZE+65536))
  with TemporaryDirectory() as directory,Image.new('RGB',(OUTPUT_SIZE,OUTPUT_SIZE)) as source:
   spool=FrameFiles(directory)
   spool.bytes=160*1024*1024
   spool.append(source)
   with patch('weather_video_codec.shutil.disk_usage',return_value=SimpleNamespace(free=DISK_RESERVE)):
    with self.assertRaises(VideoFailure):spool.append(source)
   self.assertEqual(spool.count,1)
   self.assertFalse(list(Path(directory).glob('frame-001.*')))
 def test_cloud_uses_observed_times_not_download_time(self):
  now=1793718000;rows=[{'basetime':time.strftime('%Y%m%d%H%M%S',time.gmtime(now-i*600)),'validtime':time.strftime('%Y%m%d%H%M%S',time.gmtime(now-i*600))} for i in range(40)]
  result=cloud_times(rows,now);self.assertEqual(len(result),37);self.assertEqual(result[-1][0]-result[0][0],21600)
  partial=cloud_times(rows[:12]+rows[13:]+[rows[0]],now);self.assertEqual(len(partial),36)
  from weather_video import transition_steps
  self.assertEqual(sum(transition_steps('cloud',a[0],b[0]) for a,b in zip(partial,partial[1:]))+1,138)
  with self.assertRaises(VideoFailure):cloud_times(rows,now+7200)
  self.assertEqual(len(cloud_times(rows[:5],now)),5)
  with self.assertRaises(VideoFailure):cloud_times(rows[:1],now)
 def test_forecast_exact_grid_time_units_and_null_handling(self):
  from urllib.parse import urlsplit,parse_qs
  def fetch(url):
   q=parse_qs(urlsplit(url).query);self.assertEqual(q['models'],['ecmwf_ifs']);times=[1793718000+i*3600 for i in range(24)]
   return json.dumps([{'latitude':float(a),'longitude':float(b),'utc_offset_seconds':0,'hourly_units':{'temperature_2m':'°C'},'hourly':{'time':times,'temperature_2m':[20]*24}} for a,b in zip(q['latitude'][0].split(','),q['longitude'][0].split(','))]).encode()
  a,t,g=forecast_frames('temperature',23.1291,113.2644,1793717999,fetch);self.assertEqual(len(g),24);self.assertEqual(len(g[0]),N*N)
  def corrupt(url):
   r=json.loads(fetch(url))
   for row in r:
    if abs(row['latitude']-23.1291)<.001 and abs(row['longitude']-113.2644)<.001:row['hourly']['temperature_2m'][0]=None
   return json.dumps(r).encode()
  with self.assertRaises(VideoFailure):forecast_frames('temperature',23.1291,113.2644,1793717999,corrupt)
 def test_dated_grid_stops_at_last_source_hour(self):
  from urllib.parse import urlsplit,parse_qs
  start=1795708800
  def fetch(url):
   q=parse_qs(urlsplit(url).query)
   self.assertEqual(q['start_hour'],['2026-11-26T16:00'])
   times=[start+i*3600 for i in range(48)]
   return json.dumps([{'latitude':float(a),'longitude':float(b),'utc_offset_seconds':0,
       'hourly_units':{'pm2_5':'μg/m³'},'hourly':{'time':times,'pm2_5':[0]*7+[None]*41}}
       for a,b in zip(q['latitude'][0].split(','),q['longitude'][0].split(','))]).encode()
  _,times,grids=forecast_frames('pm25',41.245,115.420,start-4*86400,fetch,start=start,hours=48)
  self.assertEqual(times,[start+i*3600 for i in range(7)])
  self.assertEqual(len(grids),7)

 def test_no_key_no_arbitrary_url_or_path(self):
  tool=build_tool(Path('.'))
  with self.assertRaises(ValidationError):tool.invoke({'layer':'cloud','name':'北京','latitude':39.9,'longitude':116.4,'url':'http://localhost'})
  with patch('weather_video.request',side_effect=AssertionError('must not fetch')):
   self.assertEqual(tool.invoke({'layer':'cloud','name':'伦敦','latitude':51.5,'longitude':0.0})['code'],'VIDEO_NO_COVERAGE')
 def test_natural_language_tools_are_real_langchain_and_features_filter(self):
  from test_agent_worker import ScriptedModel,packet,call
  from agent_worker import build_runner
  from group_features import FEATURE_KEYS
  for name in ['cloud_video','pm25_video','precipitation_video','temperature_video']:
   model=ScriptedModel();model.responses.append(call(name,{'city':'广州'}));calls=[]
   runner=build_runner(model_factory=lambda _:model,rpc_callback=lambda _r,_c,n,a:calls.append((n,a)) or '本机视频已生成')
   r=runner.run(packet(text='看广州的天气变化视频'));self.assertEqual(r['kind'],'tool');self.assertEqual(calls,[(name,{'city':'广州'})])
  model=ScriptedModel();model.responses.append(call('cloud_video',{'city':'广州'}));runner=build_runner(model_factory=lambda _:model,rpc_callback=lambda *a:'video')
  r=runner.run(packet(context={'scope':'group','access':'white','currentSpeaker':'member-abcdef123456','groupContext':[],'features':{k:k=='weather' for k in FEATURE_KEYS}}));self.assertNotIn('pm25_video',model.bound[0]);self.assertIn('cloud_video',model.bound[0])
 def test_video_duration_contract(self):
  from agent_worker import ForecastVideoArgs
  from pydantic import ValidationError
  for hours in (6,12,72):
   with self.assertRaises(ValidationError):ForecastVideoArgs(city='广州',hours=hours)
  for hours in (24,48):self.assertEqual(ForecastVideoArgs(city='广州',hours=hours).hours,hours)
if __name__=='__main__':unittest.main()
