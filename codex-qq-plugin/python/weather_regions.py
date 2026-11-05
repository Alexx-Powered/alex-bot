"""Trusted regional extents shared by the weather video tool and its natural-language route."""
import json
import math
from pathlib import Path

_catalog = json.loads((Path(__file__).resolve().parents[1]/'data/weather-video-regions.json').read_bytes())['regions']
REGIONS = {row['id']:row for row in _catalog}
REGION_ALIASES = {alias:row['id'] for row in _catalog for alias in row['aliases']}


def regional_area(region):
    west,south,east,north=region['bounds']
    def mercator_y(lat):
        return (1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2
    left,right=(west+180)/360,(east+180)/360
    top,bottom=mercator_y(north),mercator_y(south)
    # Fit the entire region between the title and the color scale/timeline.
    # The minimum gives small territories some visible geographic context.
    span=max((right-left)/.90,(bottom-top)/.61,.6/360)
    return {'world':1,'size':span,'left':(left+right-span)/2,
            'top':(top+bottom)/2-.455*span,'members':region['members'],'region_id':region['id']}


def focus_mask(area, size):
    from io import BytesIO
    from zipfile import ZipFile
    from PIL import Image
    from weather_ground import Viewport

    region=REGIONS[area['region_id']]
    west,south,east,north=region['bounds']
    view=Viewport(area,size)
    left,top=map(round,view.point(west,north))
    right,bottom=map(round,view.point(east,south))
    result=Image.new('L',(size,size))
    archive=Path(__file__).resolve().parents[1]/'data/weather-region-masks.zip'
    with ZipFile(archive) as bundle,Image.open(BytesIO(bundle.read(region['id']+'.png'))) as source:
        if source.size!=(512,512) or source.mode!='L':raise ValueError('Invalid regional mask')
        with source.resize((max(1,right-left),max(1,bottom-top)),Image.Resampling.BILINEAR) as fitted:
            result.paste(fitted,(left,top))
    return result
