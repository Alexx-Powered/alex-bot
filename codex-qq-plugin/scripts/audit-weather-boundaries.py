"""Match each exceptional source geometry to the actual previous release's tiles.

Usage: python scripts/audit-weather-boundaries.py SOURCE.geojson OLD-weather-map.zip
Requires development Shapely only. This audit never confers publication approval.
"""
import gzip
import hashlib
import importlib.util
import json
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

APP=Path(__file__).resolve().parents[1]
BASE_SHA='e7f5fa39c6fc94b1176bcd070786d3428d19f9accff393b026bcfef1702b2de9'
SOURCE_SHA='2faac4f6b34386f3d21b6e018cf151f241f00e5c936d44dd17d7d9bfb147fa48'
SOURCES={
    'MNR':'https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html',
    'STD':'https://bzdt.tianditu.gov.cn/',
    'XZ':'https://zrzyt.xizang.gov.cn/fw/zyxz/202004/t20200430_139102.html',
    'IN':'https://www.mfa.gov.cn/web/fyrbt_673021/202403/t20240325_11270445.shtml',
    'UA':'https://www.mfa.gov.cn/web/fyrbt_673021/jzhsl_673025/202304/t20230424_11064751.shtml',
    'SO':'https://www.fmprc.gov.cn/wjbzhd/202601/t20260112_11811361.shtml',
    'CY':'https://www.mfa.gov.cn/ziliao_674904/1179_674909/202111/t20211130_10459117.shtml',
    'RS':'https://www.mfa.gov.cn/web/wjdt_674879/zcjd/202409/t20240916_11491613.shtml',
    'SY':'https://www.mfa.gov.cn/zwbd_673032/wjzs/202606/t20260624_11951325.shtml',
    'ISLANDS':'https://www.mfa.gov.cn/diaoyudao/chn/xwdt/201209/t20120915_8523866.htm',
    'CN':'https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/t20260722_11989560.shtml',
    'XJ':'https://xinjiang.tianditu.gov.cn/bzdt_code/bzdt.html',
    'QH':'https://qinghai.tianditu.gov.cn/qhbzmap/',
}
# Descriptive locators for finding sheets, not assertions of sovereignty.
PLACES={
    1746705343:'索马里北部',1746705331:'埃塞俄比亚与索马里交界',
    1746705323:'加沙地带周边',1746709121:'约旦河西岸周边',1746705327:'黎巴嫩南部边区',
    1746708629:'戈兰高地西缘一带',1746708491:'塞浦路斯岛内',1746705319:'阿克赛钦西缘一带',
    1746709141:'克什米尔东北部',1746705337:'中印边界东段、藏南内侧旧线',
    1746708623:'朝鲜半岛军事分界线一带',1746705351:'西撒哈拉境内沙墙一带',
    1746705329:'伊莱米三角地带',1746705371:'戈兰高地北侧一带',
    1746708661:'锡亚琴冰川北缘',1746706755:'科索沃与塞尔维亚其他地区之间',
    1746707747:'圭亚那与委内瑞拉交界',1746708757:'克什米尔西南部',
    1746708045:'摩洛哥与阿尔及利亚西南交界',1746705335:'马拉维湖东北部',
    1746705295:'珠海与澳门',1746708389:'深圳与香港',
    1746708827:'北海道东北部邻海',1746708403:'阿卜耶伊地区',
    1746705347:'圭亚那与苏里南南部交界',1746705345:'苏里南与法属圭亚那南部交界',
    1746708787:'克里米亚半岛北部',1746708603:'锡亚琴冰川西侧甲段',
    1746708607:'锡亚琴冰川西侧乙段',1746708449:'中印边界西部地段 B03',
    1746708457:'中印边界西部地段 B04',1746708463:'中印边界中部地段 B01',
    1746708469:'中印边界中部地段 B02',1746708751:'中不边境 B75 地段',
    1746708779:'中不边境 B76 地段',1746708837:'刻赤海峡一带',
    1746708915:'巴西与乌拉圭交界',1746708703:'南巴塔哥尼亚冰原',
    1746709133:'克什米尔西部',1746706305:'喀喇昆仑山西北段 B08',
}
TIBET={1746705337,1746708449,1746708457,1746708463,1746708469,1746708751,1746708779}
KASHMIR={1746709141,1746708757,1746709133,1746708661,1746708603,1746708607,1746706305}
def assessment(i):
    if i in TIBET:
        return ('旧线进入官方西藏省域，排除旧国界画法。替代几何和符号分别审核。',['XZ','MNR']+(['IN'] if i not in (1746708751,1746708779) else []))
    if i in (1746705295,1746708389):return '原国界层已跳过，特别行政区界沿内地共边绘制，仍需相应大比例尺标准行政区域图核线。',['MNR']
    if i==1746705319:return '已对照新疆自治区和和田图例。和田图例只列国界，自治区图例另列未定国界，均未给出此源要素与两省区接边的一一对应。',['XZ','XJ','CN','IN','MNR']
    if i in KASHMIR:return '全国竖图以灰色虚线表示地区界、黑色点线表示印巴停火线，图上另有实际控制区文字。未逐段确认此几何在局地视口的对应及端点。',['MNR','CN','XJ']
    if i in (1746708837,1746708787):return '外交部立场可查。该陈述并不提供逐段制图几何和图例；不能据第三方 CN 字段定线。',['UA','STD']
    if i in (1746705371,1746708629):return '已核对中方关于戈兰高地的表述，军事线与国界的具体走向仍需样图。',['SY','STD']
    if i in (1746705343,1746708491,1746706755):
        return '官方立场不足以支持把此岛内或境内分隔线画成国际边界。其他图例和范围仍需样图。', [{1746705343:'SO',1746708491:'CY',1746706755:'RS'}[i],'STD']
    if i==1746708623:return '全国横图朝鲜半岛段与图例均为黑色点线，类别为军事分界线。原包统一的争议虚线不适用；局地放大后的线形和端点仍待对位。',['MNR','CN']
    return '已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。',['MNR','STD']


def audit(source,old_zip):
    from shapely.geometry import shape
    digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
    assert digest(source)==SOURCE_SHA and digest(old_zip)==BASE_SHA
    spec=importlib.util.spec_from_file_location('builder',APP/'scripts/build-weather-map.py')
    builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
    with zipfile.ZipFile(old_zip) as z:
        chunks={r[0]:r for name in z.namelist() for r in json.loads(z.read(name))['lines']}
    def line_key(points):return tuple((p[0],p[1]) for p in points)
    locations=defaultdict(list)
    for idx,kind,_,pts in chunks.values():locations[line_key(pts)].append((idx,kind))
    original=json.loads(source.read_bytes())['features'];tibet=json.loads(gzip.decompress((APP/'data/weather-xizang-reference.json.gz').read_bytes()))
    coverage=shape(tibet['province']);items=[];dashed=set()
    for row in original:
        p=row['properties'];fid=p['NE_ID'];kind=p['FEATURECLA']
        if kind=='International boundary (verify)' and not p.get('FCLASS_CN'):continue
        geometry=row['geometry'];g=shape(geometry);matches=[]
        for line in (geometry['coordinates'] if geometry['type']=='MultiLineString' else [geometry['coordinates']]):
            pieces=[[]]
            for point in line:
                if pieces[-1] and abs(point[0]-pieces[-1][-1][0])>180:pieces.append([])
                pieces[-1].append(point[:2])
            for piece in pieces:
                slim=builder.simplify(piece)
                for j in range(0,len(slim)-1,48):
                    found=locations[line_key(slim[j:j+49])]
                    if fid in (1746705295,1746708389):
                        assert not found
                    else:
                        assert len(found)==1,(fid,j)
                        matches.extend(found)
        types={style for _,style in matches}
        assert len(types)<=1
        output='跳过' if not matches else '虚线' if types=={'disputed'} else '实线'
        if output=='虚线':dashed.update(i for i,_ in matches)
        finding,basis=assessment(fid)
        items.append({'neId':fid,'location':PLACES[fid],'rawClass':kind,'cnField':p.get('FCLASS_CN'),'oldSymbol':output,
                      'oldTileIds':[i for i,_ in matches],'bounds':[round(v,5) for v in g.bounds],
                      'fractionInsideOfficialTibet':round(g.intersection(coverage).length/g.length,5),
                      'finding':finding,'references':basis,'publicationReview':'pending','officialSheet':None})
    assert {r['neId'] for r in items}==set(PLACES)
    assert dashed=={i for i,r in chunks.items() if r[1]=='disputed'}
    report={'state':'hold','reviewedRelease':'linux-wxregion-bb1118dc0769','sourceSha256':SOURCE_SHA,
            'baseBundleSha256':BASE_SHA,'sourceFeatures':len(original),'uniqueTileChunks':len(chunks),
            'dashedTileChunks':len(dashed),'symbols':dict(Counter(r['oldSymbol'] for r in items)),
            'sources':SOURCES,'items':items,'regionalTechnicalEvidence':'docs/map-regional-registration-20261104.json',
            'additionalChecks':['全球适用比例尺参考样图及各例外地段','西藏五条记录已与两张全国原图叠合，察隅河段已区分河线和黑墨迹，仍须按各地段核实最终线型',
                                '藏新省界已按三个完整官方要素及第四个要素的西端核对，未覆盖的其他陆地边段仍需核准',
                                '海上十段已按官方竖图逐段提取并与横图比对，点查视口的部分端点差异可见，成图比例尺适用范围有待确认',
                                '台湾省图、附属岛屿及港澳界线的视口和图例','区域遮罩、国外 ADM1/ADM2 及全球雷达所有实际出图路径'],
            'approvedAssetHashes':{}}
    (APP/'data/weather-boundary-review.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print('source features',len(original),'exceptional',len(items),'symbols',report['symbols'],'dashed chunks',len(dashed))


if __name__=='__main__':audit(Path(sys.argv[1]),Path(sys.argv[2]))
