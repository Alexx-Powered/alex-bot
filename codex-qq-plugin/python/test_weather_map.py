import hashlib,json,unittest
import sqlite3
from contextlib import closing
from pathlib import Path
from weather_map import DATA,viewport_data,label_layout,project,overlay
from weather_video import area,forecast_map,SCALES,color,N
from weather_ground import DATABASE,Viewport,ground_layer,relief_image
from weather_regions import REGIONS,regional_area

class WeatherMapTests(unittest.TestCase):
    def test_registered_marks_keep_their_breaks_and_kashmir_symbols(self):
        import zipfile
        reference=json.loads(DATA.with_name('weather-regional-ink-review.json').read_bytes())
        self.assertEqual([r['id'] for r in reference['marine']],list(range(1,11)))
        self.assertTrue(all(len(r['ink'])==4 for r in reference['marine']))
        with zipfile.ZipFile(DATA) as tiles:
            lines={r[0]:r for tile in tiles.namelist() for r in json.loads(tiles.read(tile))['lines']}
        marine=[r[3] for r in lines.values() if r[1]=='review_maritime']
        frozen=lambda run:tuple(map(tuple,run))
        self.assertEqual({frozen(v) for v in marine},{frozen(p) for r in reference['marine'] for p in r['ink']})
        dots=[r[3] for r in lines.values() if r[1]=='review_ceasefire']
        self.assertEqual({tuple(p[0]) for p in dots},{tuple(p) for p in reference['kashmir']['ceasefireDots']})
        self.assertTrue(all(len(run)==2 and run[0]==run[1] for run in dots))
        self.assertEqual(sum(r[1]=='review_region' for r in lines.values()),len(reference['kashmir']['districtDashes']))

    def test_kashmir_and_offshore_anchors_match_reviewed_context(self):
        view=area(34.08,74.8);_,labels=viewport_data(view)
        self.assertFalse({'拉达克','查谟-克什米尔邦','阿扎德克什米尔','吉尔吉特－巴尔蒂斯坦'} & {r['name'] for r in labels})
        self.assertNotIn('review_caption',{r['kind'] for r in label_layout(labels,view)})
        self.assertIn('克什米尔',{r['name'] for r in label_layout(labels,view,show_boundary_captions=True)})
        east=area(24.11,122.76)
        self.assertNotIn('冲绳县',{r['name'] for r in label_layout(viewport_data(east)[1],east)})
        near_naha=area(26.3,127.9)
        self.assertIn('冲绳县',{r['name'] for r in viewport_data(near_naha)[1]})

    def test_lake_sea_and_prefecture_alignment(self):
        region=area(31.2989,120.5853); view=Viewport(region,640)
        with closing(sqlite3.connect(DATABASE.resolve().as_uri()+'?mode=ro',uri=True)) as db:
            names={name for name,_ in view.features(db,'citylabel')}
            self.assertTrue({'苏州市','无锡市','常州市'}.issubset(names))
            with relief_image(db,Viewport(area(30.2,101.5),256)) as hills:
                low,high=hills.getextrema();self.assertGreater(high-low,40)
        image,labels=ground_layer(region,640,'temperature')
        with image:
            for lon,lat in [(120.17,31.20),(122.7,31.4)]:
                self.assertEqual(image.getpixel(tuple(round(p) for p in view.point(lon,lat))),(30,107,151,53))
            self.assertNotEqual(image.getpixel(tuple(round(p) for p in view.point(120.5853,31.2989))),(30,107,151,53))
            self.assertNotIn((100,183,207,200), {color for _,color in image.getcolors(2048)})
        water={r['name'] for r in labels if r['kind']=='water'};self.assertIn('太湖',water);self.assertIn('东海',water)

    def test_cross_province_lines_follow_shared_city_vertices(self):
        # Independent common vertex pairs from the two original prefecture
        # polygons (Suzhou–Jiaxing, Suzhou–Shanghai and Suzhou–Wuxi).
        view=Viewport(area(31.2989,120.5853),640)
        with closing(sqlite3.connect(DATABASE.resolve().as_uri()+'?mode=ro',uri=True)) as db:
            edges={}
            for kind in ('province','district'):
                edges[kind]={frozenset((p,q)):owners for owners,rings in view.features(db,kind)
                             for ring in rings for p,q in zip(ring,ring[1:])}
            for kind,owners,points in (
                    ('province','320500|330400',((120.7017,30.9425),(120.6929,30.9522))),
                    ('province','310000|320500',((121.1288,31.3282),(121.1257,31.3461))),
                    ('district','320200|320500',((120.5920,31.6477),(120.5846,31.6394)))):
                self.assertEqual(edges[kind].get(frozenset(points)),owners)
            self.assertFalse(edges['province'].keys() & edges['district'].keys())
            delta=Viewport(area(22.35,113.90),640)
            sar_edges={owners for owners,_ in delta.features(db,'province')}
            self.assertTrue({'440300|810000','440400|820000'} <= sar_edges)
            # The same hierarchy is available on both sides of Tokyo Bay.
            tokyo=Viewport(area(35.68,139.75),640)
            for kind in ('province','district'):
                self.assertTrue(any(name=='JPN' for name,_ in tokyo.features(db,kind)))
    def test_offline_bundle_and_regional_boundaries(self):
        note=json.loads(DATA.with_name('weather-map-NOTICE.json').read_text(encoding='utf-8'))
        self.assertEqual(hashlib.sha256(DATA.read_bytes()).hexdigest(),note['bundleSha256'])
        a=area(23.1291,113.2644);lines,labels=viewport_data(a)
        self.assertTrue(all(r[1] in ('country','disputed') for r in lines))
        self.assertIn('深圳市',[r['name'] for r in labels]);self.assertIn('广东省',[r['name'] for r in labels])
        self.assertLess(len(lines),4000)
    def test_labels_avoid_each_other_and_reserved_ui(self):
        a=area(23.1291,113.2644);chosen=label_layout(viewport_data(a)[1],a)
        self.assertGreater(len(chosen),4);self.assertLessEqual(len(chosen),24)
        for i,row in enumerate(chosen):
            box=row['box'];self.assertGreaterEqual(box[1],90);self.assertLessEqual(box[3],490)
            for other in chosen[i+1:]:
                b=other['box'];self.assertFalse(box[0]<b[2] and box[2]>b[0] and box[1]<b[3] and box[3]>b[1])
    def test_dateline_projects_nearby_points_together(self):
        a=area(-16.0,179.9);x1,y1=project(179.9,-16,a);x2,y2=project(-179.9,-16,a)
        self.assertLess(abs(x2-x1),30);self.assertAlmostEqual(y1,y2)
        self.assertTrue(viewport_data(a)[1])
    def test_xizang_and_taiwan_use_administrative_centres_not_settlements(self):
        expected={'cn-54':{'拉萨市','日喀则市','山南市','林芝市','昌都市','那曲市','阿里地区'},
                  'cn-71':{'台北市','新北市','桃园市','台中市','台南市','高雄市'}}
        for key,names in expected.items():
            view=regional_area(REGIONS[key]);lines,labels=viewport_data(view)
            chosen=label_layout(labels,view)
            self.assertEqual({r['name'] for r in chosen if r['kind'] in ('capital','prefecture')},names)
            self.assertFalse(any(r['kind']=='city' for r in chosen))
            for i,r in enumerate(chosen):
                a=r['box']
                for other in chosen[i+1:]:
                    b=other['box']
                    self.assertFalse(a[0]<b[2] and a[2]>b[0] and a[1]<b[3] and a[3]>b[1])
            if key=='cn-71':
                self.assertEqual({r['name'] for r in chosen if r['kind']=='island'},{'钓鱼岛','赤尾屿'})
                self.assertEqual([r['name'] for r in chosen if r['kind']=='capital'],['台北市'])
                context,=[r for r in chosen if r['kind']=='coast_context']
                putian,=[r for r in labels if r.get('code')=='350300']
                self.assertEqual(context['text'],'福建省莆田市')
                self.assertEqual(context['anchor'],project(putian['lon'],putian['lat'],view))
            else:self.assertTrue(any(line[1]=='review_trace' for line in lines))

    def test_prefecture_labels_are_coded_and_never_demoted_by_population(self):
        view=regional_area(REGIONS['cn-65']);_,labels=viewport_data(view)
        q=label_layout(labels,view)
        self.assertEqual(len({r['code'] for r in q if r['kind'] in ('capital','prefecture')}),14)
        self.assertTrue(all(r.get('province')=='65' for r in q))
        with closing(sqlite3.connect(DATABASE.resolve().as_uri()+'?mode=ro',uri=True)) as db:
            tw=Viewport(regional_area(REGIONS['cn-71']),640)
            for kind in ('province','district'):
                self.assertTrue(all(name!='TWN' for name,_ in tw.features(db,kind)))
    def test_all_single_province_layouts_fit_their_administrative_centres(self):
        total=0
        for region in REGIONS.values():
            if len(region['members'])!=1:continue
            view=regional_area(region);rows=viewport_data(view)[1]
            names={r['name'] for r in rows if r['kind'] in ('prefecture','capital') and r.get('province') in view['members']}
            chosen=label_layout(rows,view)
            self.assertEqual({r['name'] for r in chosen if r['kind'] in ('prefecture','capital')},names,region['id'])
            self.assertFalse(any(r['kind']=='city' for r in chosen))
            total+=len(names)
        self.assertEqual(total,339)
    def test_interpolate_values_before_nonlinear_palette(self):
        grid=[j*40/(N-1) for i in range(N) for j in range(N)]
        with forecast_map('temperature',grid) as im:
            actual=im.getpixel((320,320));expected=color(20,SCALES['temperature'])
            self.assertLess(max(abs(a-b) for a,b in zip(actual,expected)),3)
        grid[N*N//2]=None
        with forecast_map('temperature',grid) as im:self.assertEqual(im.getpixel((320,320)),(155,161,163))
if __name__=='__main__':unittest.main()
