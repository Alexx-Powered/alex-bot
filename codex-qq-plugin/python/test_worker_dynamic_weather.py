"""Business-layer regressions for worker-owned dynamic weather replies."""
import os
from datetime import datetime, timedelta
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from performance_metrics import PerformanceRecorder
import worker_dynamic_weather as weather


class WorkerVideoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(os.chdir, os.getcwd())
        os.chdir(self.tmp.name)
        self.directory = Path(".private/weather-video")
        self.directory.mkdir(parents=True)
        weather._cache.clear()
        self.clock = datetime(2026, 11, 26, 12, 30, tzinfo=weather.TZ)
        self.clock_patch = patch.object(weather.time, "time", return_value=self.clock.timestamp())
        self.clock_patch.start()
        self.addCleanup(self.clock_patch.stop)
        self.start = int(self.clock.replace(minute=0).timestamp()+3600)
        self.mp4 = (24).to_bytes(4,"big")+b"ftyp"+bytes(64)
        self.calls = []
        self.generated = self.clock.timestamp()
        self.packet = {"id":"request1","now":self.clock.isoformat()}
        self.trace = PerformanceRecorder()
        self.events = []
        self.trace.video_event = self.events.append
        self.video_patch = patch.object(weather, "generate", self.fake_generate)
        self.video_patch.start()
        self.addCleanup(self.video_patch.stop)

    def fake_generate(self, args, emit):
        self.calls.append(args)
        emit({"stage":"video_encode_h264","phase":"start"})
        (self.directory/("a"*32+".mp4")).write_bytes(self.mp4)
        start = args.get("start",self.start)
        times = [start+i*3600 for i in range(3)]
        result = dict(ok=True, artifact_id="a"*32, bytes=len(self.mp4), layer=args["layer"],
                      format_version=2,width=1080,height=1080,fps=12,start=start,end=times[-1],
                      generated_at=int(self.generated),source_times=times,
                      frames=7 if args.get("hours")==48 else 13, forecast_detail="native")
        if "region_id" in args:
            region = weather.REGIONS[args["region_id"]]
            result.update(region_id=region["id"],view_bounds=region["bounds"])
        return result

    def run_video(self,name="cloud_video",**args):
        return weather.execute(name, dict(city="华北")|args, self.packet,self.trace,{})

    def test_region_dated_cache_contains_completed_file_and_timings(self):
        args = {"city":"华北", "day":"2026-11-27","hours":48}
        self.assertEqual(self.run_video(**args), {"media":"mp4","text":""})
        self.assertEqual(self.events,[{"stage":"video_encode_h264","phase":"start"}])
        self.assertEqual(self.calls, [dict(layer="cloud_cover",name="华北",region_id=weather.REGION_ALIASES["华北"],
                                          start=int(datetime(2026,11,27,tzinfo=weather.TZ).timestamp()),hours=48)])
        self.assertFalse(any(self.directory.iterdir()))
        self.assertEqual(Path(".private/worker-replies/request1.mp4").read_bytes(),self.mp4)
        self.packet["id"]="request2"
        self.assertEqual(self.run_video(**args)["media"],"mp4")
        self.assertEqual(len(self.calls),1)
        self.assertIn("video_cache_hit",[e["name"] for e in self.trace.finish()])

    def test_point_target_cache_and_coarse_and_stale_rules(self):
        def sampled(args,emit):
            return dict(self.fake_generate(args,emit),forecast_detail="sampled")
        with patch.object(weather,"generate",sampled):
            for i in range(2):
                self.packet["id"] = "sample"+str(i)
                self.assertIn("media",self.run_video("temperature_video", city="蔚县"))
        self.assertEqual(len(self.calls),2)
        self.assertEqual(self.calls[0]["name"],"河北省·张家口市·蔚县")
        self.assertEqual(self.calls[0]["layer"],"temperature")
        self.assertIn("latitude",self.calls[0])
        self.assertNotIn("hours",self.calls[0])
        self.generated-=600
        self.packet["id"]="stale"
        self.assertNotIn("media",self.run_video())

    def test_error_is_user_text_and_has_no_attachment(self):
        for name,code,reply in [
            ("precipitation_video","VIDEO_BOTH_OUTSIDE_WINDOW","ECMWF IFS、NOAA GFS 数据源无当日预报"),
            ("pm25_video","VIDEO_OUTSIDE_WINDOW","CAMS数据源无当日预报"),
            ("satellite_video","VIDEO_NO_COVERAGE",weather.ERRORS["VIDEO_NO_COVERAGE"]),
            ("cloud_video","VIDEO_GFS_OUTSIDE_WINDOW",weather.ERRORS["VIDEO_GFS_OUTSIDE_WINDOW"])]:
            with patch.object(weather,"generate",return_value={"ok":False,"code":code}):
                self.assertEqual(self.run_video(name),{"text":reply})
        self.assertNotIn("media",self.run_video("satellite_video",hours=48))
        self.assertNotIn("media",self.run_video(day="2026-11-23"))

    def test_observation_gaps_and_single_forecast_lead(self):
        t=(self.start//600)*600
        data=dict(format_version=2,width=1080,height=1080,fps=12,start=t-2400,end=t,generated_at=t+1200,
                  source_times=[t-2400,t-1800,t],frames=6)
        self.assertTrue(weather.timeline_ok(data,"cloud",24,None))
        self.assertFalse(weather.timeline_ok(dict(data,frames=9),"cloud",24,None))
        self.assertFalse(weather.timeline_ok(dict(data,generated_at=t+5401),"cloud",24,None))
        data.update(start=t,end=t,generated_at=t-100,source_times=[t],frames=1,forecast_detail="native")
        self.assertTrue(weather.timeline_ok(data,"cloud_cover",48,t))
        self.assertFalse(weather.timeline_ok(data,"cloud_cover",48,t-3600))


class WorkerAirTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026,11,26,12,30,tzinfo=weather.TZ)
        self.start = self.now.replace(minute=0)
        self.place={"id":"beijing","name":"北京","latitude":39.9,"longitude":116.4}
        self.rows = [(self.start+h*weather.HOUR).strftime("%Y-%m-%dT%H:00") for h in range(48)]
        self.values=[15.0]*48
        self.urls=[]
        self.meta=dict(last_run_initialisation_time=int(self.start.timestamp()-4*3600),
                       last_run_availability_time=int(self.start.timestamp()),data_end_time=int(self.start.timestamp()+48*3600))

    def fetch(self,url,params=None,**kwargs):
        self.urls.append((url,params))
        if params is None:
            return self.meta
        return {"timezone":weather.ZONENAME,"utc_offset_seconds":28800,"hourly":{"time":self.rows,"pm2_5":self.values},
                "hourly_units":{"pm2_5":"µg/m³"}}

    def test_rolling_window_and_missing_values(self):
        self.values[3]=None
        with patch.object(weather,"get_json",self.fetch):
            report=weather.rolling_air(self.place,self.now)
            self.assertEqual(report["hourly"][0]["time"],self.start.isoformat())
            self.assertEqual(report["hourly"][-1]["time"],(self.start+47*weather.HOUR).isoformat())
            self.assertIsNone(report["hourly"][3]["pm25"])
            self.assertTrue(any(q and q["forecast_hours"]==48 and q["domains"]=="cams_global" for _,q in self.urls))
            self.values[:25]=[None]*25
            with self.assertRaisesRegex(ValueError,"FORECAST_DATA_MISSING"):
                weather.rolling_air(self.place,self.now)
            self.meta["last_run_initialisation_time"]-=48*3600
            with self.assertRaisesRegex(ValueError,"FORECAST_MODEL_STALE"):
                weather.rolling_air(self.place,self.now)

    def test_ambiguous_alias_does_not_fetch_or_render(self):
        with patch.object(weather,"get_json",side_effect=AssertionError("unexpected network")):
            result=weather.execute("air_quality_image",{"city":"朝阳"},{"id":"air-1","now":self.now.isoformat()},PerformanceRecorder(),{})
        self.assertIn("地名有重名",result["text"])
        self.assertNotIn("media",result)
