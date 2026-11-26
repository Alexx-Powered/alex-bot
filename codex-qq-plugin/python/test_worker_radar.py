"""Fixture NMC pages and local PNGs, no QQ sends or live network."""
import base64
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx

import worker_artifacts
import worker_radar as radar

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNq0AAAAASUVORK5CYII=")
NOW = datetime(2026,10,28,10,30,tzinfo=timezone.utc).timestamp()
URL = "https://image.nmc.cn/product/2026/10/28/RDCP/SEVP_AOC_RDCP_SLDAS3_ECREF_AZ9010_L88_PI_20261028101800000.PNG"
BJ = radar.FIXED["北京"].url
GX = radar.NMC + "/publish/radar/guang-xi/nan-ning.htm"


def menu(level, links):
    return f'<div class="p-nav nav{level}"><ul>'+"".join(
        f'<li><a href="{url}">{name}</a></li>' for name,url in links)+"</ul></div>"


def frame(url=URL, label="10/28 18:18"):
    return f'<div class="time actived" data-img="{url}" data-time="{label}"></div>'


def fixture():
    menus = menu(2,[("北京",BJ),("广西",GX)])
    region = "https://www.nmc.cn/publish/radar/huabei.html"
    pages = {
        BJ: menus+menu(3,[("大兴",BJ)])+frame(),
        GX: '<title>单站雷达_广西_南宁</title>'+menus+menu(3,[("南宁",GX)])+frame(URL.replace("AZ9010","AZ9999")),
        region: '<title>雷达拼图_华北</title>'+frame(URL.replace("AZ9010","ANCN")),
        radar.REGIONS_URL: menu(2,[("华北",region)]),
    }
    calls = []
    def fetch(url, kind):
        calls.append((url,kind))
        if kind == "image":
            return PNG, "image/png"
        return pages[url].encode(), "text/html"
    now = [NOW]
    return radar.DomesticRadar(fetch,lambda:now[0]),pages,calls,now


class Performance:
    def span(self, name):
        assert name == "radar_query"
        return nullcontext()


class WorkerRadarTests(unittest.TestCase):
    def test_verified_nmc_image_ends_as_the_request_scoped_artifact(self):
        service,pages,calls,now = fixture()
        packet={"id":"fixture-bj"}
        with tempfile.TemporaryDirectory() as tmp, patch.object(worker_artifacts, "DIRECTORY",Path(tmp)), patch.object(radar,"domestic",service):
            reply=radar.execute("radar_image",{"target":"北京市"},packet,Performance(),None)
            self.assertEqual(reply,{"text":"","media":"png"})
            self.assertEqual((Path(tmp)/"fixture-bj.png").read_bytes(),PNG)
        self.assertEqual(calls,[(BJ,"page"),(URL,"image")])
        self.assertEqual(service.image("北京"),("png",PNG))
        self.assertEqual(len(calls),2)
        now[0] += 300
        self.assertEqual(service.image("北京"),("png",PNG))
        self.assertEqual(len(calls),4)

    def test_page_and_product_identity_and_observation_age(self):
        service,pages,calls,now=fixture()
        for bad in (frame(URL.replace("AZ9010","AZ9220")),frame(label="10/28 18:17"),
                    frame(URL.replace("202610281018","202602301018")),frame(URL.replace("image.nmc.cn","foreign.example")),
                    '<img src="https://image.nmc.cn/assets/img/default.jpg">'):
            pages[BJ] = bad
            with self.assertRaises(radar.RadarError):
                service.image("北京")
        self.assertNotIn("image",[kind for _,kind in calls])
        pages[BJ]=frame(label="10/28 10:18")
        now[0]=NOW+47*60
        self.assertEqual(service.image("北京")[1],PNG)
        now[0]+=2*60
        with self.assertRaises(radar.RadarError) as caught:
            service.image("北京")
        self.assertEqual(caught.exception.code,"RADAR_STALE")

    def test_catalog_is_complete_before_use_and_cached_and_matches_qualifier(self):
        service,pages,calls,_=fixture()
        self.assertIn("2站/2省级地区",service.listing(""))
        self.assertIn("广西·南宁",service.listing("广西"))
        self.assertEqual(sum(k=="page" for _,k in calls),3)
        self.assertEqual(service.image("广西南宁"),("png",PNG))
        self.assertEqual(service.image("华北"),("png",PNG))
        service,pages,calls,_=fixture()
        pages[GX]=menu(3,[("南宁","https://other.invalid/bad.htm")])
        for _ in range(2):
            with self.assertRaises(radar.RadarError) as caught:
                service.listing("")
            self.assertEqual(caught.exception.code,"RADAR_CATALOG_UNAVAILABLE")
        self.assertEqual(len(calls),3)
        self.assertFalse(any("other.invalid" in url for url,_ in calls))

    def test_query_routing_only_falls_back_for_recoverable_failures(self):
        with patch.object(radar.domestic,"image") as local, patch.object(radar,"global_image",return_value=(PNG,"全球雷达来源")) as glob:
            with tempfile.TemporaryDirectory() as tmp, patch.object(worker_artifacts,"DIRECTORY",Path(tmp)):
                for code in ("AMBIGUOUS_TARGET","RADAR_CATALOG_UNAVAILABLE","RADAR_TIME_INVALID","RADAR_SOURCE_REJECTED"):
                    local.side_effect=radar.RadarError(code,"失败提示")
                    self.assertEqual(radar.execute("radar_image",{"target":"同名站"},{"id":"denied"},Performance(),None),{"text":"失败提示"})
                    glob.assert_not_called()
                local.side_effect=radar.RadarError("RADAR_STALE")
                reply = radar.execute("radar_image",{"target":"北京"},{"id":"fallback"},Performance(),None)
                self.assertEqual(reply,{"text":"全球雷达来源","richMedia":True,"media":"png"})
                glob.assert_called_once_with("北京")
                local.reset_mock()
                radar.execute("radar_image",{"target":"东京","source":"global"},{"id":"direct"},Performance(),None)
                local.assert_not_called()

    def test_paginated_catalog_and_duplicate_station_rejection(self):
        service, pages, _, _ = fixture()
        stations = [(f"站{n}", f"{radar.NMC}/publish/radar/guang-xi/{n}.htm") for n in range(13)]
        pages[GX] = menu(3, stations)
        self.assertIn("下一页：雷达目录 广西 2", service.listing("广西"))
        self.assertIn("第2/2页）\n广西·站12", service.listing("广西 2"))
        with self.assertRaisesRegex(radar.RadarError, "共2页"):
            service.listing("广西 3")
        service, pages, _, _ = fixture()
        pages[GX] = menu(3, [("大兴", BJ)])
        with self.assertRaises(radar.RadarError) as caught:
            service.listing("")
        self.assertEqual(caught.exception.code, "RADAR_CATALOG_UNAVAILABLE")

    def test_redirects_sizes_and_mime_are_checked_before_publication(self):
        def mocked(response):
            return httpx.MockTransport(lambda request:response)
        for target in ("http://image.nmc.cn/x", URL+"/different", "https://other.invalid/"):
            with self.assertRaises(radar.RadarError) as caught:
                radar.download(URL,"image",transport=mocked(httpx.Response(302,headers={"Location":target})))
            self.assertEqual(caught.exception.code,"RADAR_SOURCE_REJECTED")
        for mime,length in (("text/html","10"),("image/png","66666666")):
            with self.assertRaises(radar.RadarError):
                radar.download(URL,"image",transport=mocked(httpx.Response(200,content=PNG,headers={"content-type":mime,"content-length":length})))
        for raw,mime in ((PNG[:20],"image/png"),(PNG,"image/jpeg"),(b"bad bytes","image/png")):
            with self.assertRaises(radar.RadarError):
                radar.image_type(raw,mime)

    def test_global_caption_keeps_coverage_source_and_removes_temporary_image(self):
        import io
        from PIL import Image
        from unittest.mock import Mock
        identifier="0"*32
        out=io.BytesIO()
        Image.new("RGB",(1080,1370)).save(out,"PNG")
        blob=out.getvalue()
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path,"cwd",return_value=Path(tmp)):
            directory=Path(tmp)/".private/global-radar";directory.mkdir(parents=True)
            file=directory/(identifier+".png")
            data=dict(ok=True,artifact_id=identifier,name="东京",covered=False,source=radar.RAINVIEWER,issued_at=datetime.now(timezone.utc).isoformat())
            tool=Mock()
            tool.invoke.return_value=data
            with patch("global_radar.build_global_radar_tool",return_value=tool):
                file.write_bytes(blob)
                raw,caption=radar.global_image("东京")
                self.assertEqual(raw,blob)
                self.assertIn("灰纹为缺测",caption)
                self.assertIn(radar.RAINVIEWER,caption)
                self.assertFalse(file.exists())
                file.write_bytes(blob)
                data["issued_at"]="2000-01-01T00:00:00+00:00"
                with self.assertRaises(radar.RadarError) as caught:
                    radar.global_image("东京")
                self.assertEqual(caught.exception.code,"GLOBAL_RADAR_STALE")
                self.assertFalse(file.exists())
