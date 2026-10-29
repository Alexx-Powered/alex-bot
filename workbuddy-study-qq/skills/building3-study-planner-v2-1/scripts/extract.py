#!/usr/bin/env python3
"""Read the fixed classroom-query UI without an LLM: local OCR + grid geometry + pixels."""
import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
import time
from datetime import date
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import plan


def spans(mask):
    result = []
    for n in np.flatnonzero(mask):
        n = int(n)
        if result and n == result[-1][1]:
            result[-1][1] = n+1
        else:
            result.append([n, n+1])
    return result


def compact(text):
    return re.sub(r'\s+', '', text)


def label_candidates(im):
    pixels = np.asarray(im).astype('int16')
    r, g, b = pixels[:,:,0], pixels[:,:,1], pixels[:,:,2]
    # Include antialiased blue pixels in the narrow label column.
    blue = (b-r > 15) & (g-r > 5) & (b-g > 5) & (r < 235)
    blue[:,int(im.width*.25):] = False
    bands = spans(blue.sum(axis=1) > 3)
    merged = []
    for start, end in bands:
        if merged and start-merged[-1][1] < max(4, im.width*.006):
            merged[-1][1] = end
        else:
            merged.append([start, end])
    rows, tiles = [], []
    font = ImageFont.truetype(str(Path(os.environ.get('WINDIR', 'C:/Windows'))/'Fonts/arial.ttf'), 36)
    for y0, y1 in merged:
        xs = np.flatnonzero(blue[y0:y1].any(axis=0))
        x0, x1 = int(xs.min()), int(xs.max())+1
        if not im.width*.012 <= y1-y0 <= im.width*.075:
            continue
        if not 1.5 <= (x1-x0)/(y1-y0) <= 6 or x0 < im.width*.02:
            continue
        # Blue localizes the label; luminance preserves its dark glyphs even
        # after JPEG chroma subsampling has changed their hue.
        mask = pixels[y0:y1,x0:x1].mean(axis=2) < 200
        # Remove long underline strokes before and after cropping the prefix.
        for i in range(len(mask)):
            if any(b-a > mask.shape[1]*.6 for a,b in spans(mask[i])):
                mask[i] = False
        mask = mask[:,int(mask.shape[1]*.53):]
        for i in range(len(mask)):
            if any(b-a > mask.shape[1]*.65 for a,b in spans(mask[i])):
                mask[i] = False
        components = spans(mask.any(axis=0))
        if len(components) >= 3:
            mask = mask[:,components[-3][0]:components[-1][1]]
        glyphs = Image.fromarray(np.where(mask, 0, 255).astype('uint8'))
        glyphs = glyphs.resize((max(1, round(glyphs.width*40/glyphs.height)), 40), Image.Resampling.LANCZOS)
        tile = Image.new('RGB', (320, 70), 'white')
        # An OCR layout anchor, never a source of room numbers.
        ImageDraw.Draw(tile).text((12, 14), 'Room:', font=font, fill='black')
        tile.paste(glyphs, (135, 15))
        tiles.append(tile)
        rows.append({'label_box':[x0,y0,x1,y1]})
    canvas = Image.new('RGB', (320, max(70, len(tiles)*70)), 'white')
    for i,tile in enumerate(tiles):
        canvas.paste(tile,(0,70*i))
    return rows, canvas


def line_bounds(line):
    words = line['words']
    return [min(w['x'] for w in words), min(w['y'] for w in words),
            max(w['x']+w['width'] for w in words), max(w['y']+w['height'] for w in words)]


def page_metadata(ocr):
    dates, headings, header_bands, clocks = set(), [], [], []
    hidden_past = False
    for line in ocr['lines']:
        text = compact(line['text'])
        if not line['words']:
            continue
        box = line_bounds(line)
        for match in re.finditer(r'(20\d{2})[-一—./](\d{1,2})[-一—./](\d{1,2})', text):
            try:
                dates.add(date(*(int(x) for x in match.groups())).isoformat())
            except ValueError:
                pass
        if '三号楼' in text:
            headings.append(('三号楼',box[1],box[3]))
        elif text == '主楼' or re.fullmatch('[一二四五六七八九十]+号楼',text):
            headings.append((text,box[1],box[3]))
        if text in ['教室','节数']:
            header_bands.append([box[1],box[3]])
        if '以前' in text and '不显示' in text:
            hidden_past = True
        if box[1] < ocr['height']*.07:
            match = re.search(r'(?<!\d)([01]?\d|2[0-3])[:：]([0-5]\d)(?!\d)',text)
            if match:
                clocks.append(f'{int(match[1]):02}:{match[2]}')
    return {'dates':sorted(dates), 'headings':sorted(headings,key=lambda x:x[1]),
            'header_bands':header_bands, 'hidden_past_notice':hidden_past, 'clock_text':clocks}


def in_building(y, metadata, assume_building):
    preceding = [x for x in metadata['headings'] if x[1] <= y]
    if preceding:
        return preceding[-1][0] == '三号楼'
    return not metadata['headings'] and assume_building


def grid_edges(im, rows):
    if len(rows) < 2:
        raise ValueError('至少需要两行可定位标签来验证网格；请补充完整截图。')
    pixels = np.asarray(im).astype('int16')
    # Resizing blends gray borders with neighboring green cells. Allow that
    # tint, then require narrow, repeated, equally spaced vertical lines.
    gray = (pixels.max(axis=2)-pixels.min(axis=2) <= 60) & (pixels[:,:,0] >= 150) & (pixels[:,:,0] <= 253)
    top = min(r['label_box'][1] for r in rows)
    bottom = max(r['label_box'][3] for r in rows)
    score = gray[top:bottom].mean(axis=0)
    columns = [(a+b-1)/2 for a,b in spans(score > .55) if b-a < im.width*.015]
    label_right = float(np.median([r['label_box'][2] for r in rows]))
    choices = []
    for i in range(len(columns)-7):
        edges = columns[i:i+8]
        step = float(np.median(np.diff(edges)))
        error = float(max(abs(np.diff(edges)-step)))
        if edges[0] <= label_right or edges[-1]-edges[0] < im.width*.55:
            continue
        if error <= max(2,step*.04):
            choices.append((error/step, edges))
    if not choices:
        raise ValueError('未找到覆盖7个双节列的规则网格；不能套用旧截图坐标。')
    paired = min(choices)[1]
    edges = []
    for a,b in zip(paired, paired[1:]):
        edges.extend([a,(a+b)/2])
    return edges+[paired[-1]]


def read_numbers(ocr, count):
    texts = [[] for _ in range(count)]
    for line in ocr['lines']:
        for word in line['words']:
            n = int((word['y']+word['height']/2)//70)
            if 0 <= n < count:
                texts[n].append((word['x'],word['text']))
    values = []
    for row in texts:
        text = compact(''.join(t for _,t in sorted(row)))
        matches = set(re.findall(r'(?<!\d)\d{3}(?!\d)',text))
        values.append({'candidates':sorted(matches), 'text':text})
    return values


def cell_state(im, box):
    x0,y0,x1,y1 = box
    # The label center lies in the cell body; avoid vertical grid lines and
    # inspect a patch rather than a single pixel. Uncertain colors remain '?'.
    patch = im.crop((round(x0+(x1-x0)*.22),round(y0),round(x1-(x1-x0)*.22),round(y1)))
    pixels = np.asarray(patch).astype('int16')
    if not pixels.size:
        return '?',0.0,0.0
    r,g,b = pixels[:,:,0],pixels[:,:,1],pixels[:,:,2]
    green = float(((g > 125)&(g-r > 20)&(g-b > 15)).mean())
    white = float(((pixels.min(axis=2)>=225)&(pixels.max(axis=2)-pixels.min(axis=2)<=20)).mean())
    value = 'F' if green >= .88 else 'W' if white >= .92 else '?'
    return value,round(green,4),round(white,4)


def resolve_query_date(ocr_dates, explicit_date=None):
    # Every image in this request belongs to one day, as guaranteed by the user.
    # Different OCR date strings are recognition issues, not separate batches.
    if explicit_date:
        date.fromisoformat(explicit_date)
        return explicit_date, []
    dates = set(ocr_dates)
    if len(dates) == 1:
        return next(iter(dates)), []
    if len(dates) > 1:
        return None, ['本批截图按同一天合并；日期OCR结果不一致，待核对查询日期后再自动改名。']
    return None, ['查询日期未识别到，先完成同日数据分析，确认日期后再自动改名。']


def extract_images(paths, out_dir, query_date=None, assume_building=False):
    start_time = time.perf_counter()
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True,exist_ok=True)
    diagnostic = out_dir/'diagnostics'
    diagnostic.mkdir(exist_ok=True)
    prepared, requests = [], []
    for index,path in enumerate(paths):
        path = Path(path).resolve()
        with Image.open(path) as source:
            im = source.convert('RGB')
        if max(im.size) > 10000:
            raise ValueError('图片超过本机Windows OCR支持的10000像素边长，请先分为有重叠的截图。')
        rows,canvas = label_candidates(im)
        if canvas.height > 10000:
            raise ValueError('行数过多，请分批截图。')
        label_path = diagnostic/f'{index+1:02}-labels.png'
        canvas.save(label_path)
        prepared.append({'path':path,'rows':rows, 'size':im.size})
        requests.extend([{'path':str(path)}, {'path':str(label_path),'language':'en'}, {'path':str(label_path),'language':'zh'}])
    request_path, response_path = diagnostic/'ocr-request.json', diagnostic/'ocr-result.json'
    request_path.write_text(json.dumps({'images':requests},ensure_ascii=False),encoding='utf-8')
    powershell = Path(os.environ.get('WINDIR','C:/Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
    proc = subprocess.run([str(powershell),'-NoProfile','-ExecutionPolicy','Bypass','-File',str(Path(__file__).with_name('windows_ocr.ps1')),
                           '-InputJson',str(request_path),'-OutputJson',str(response_path)],capture_output=True,timeout=120)
    if proc.returncode:
        raise RuntimeError('本地OCR失败：'+proc.stderr.decode(errors='replace')[-1600:])
    responses = json.loads(response_path.read_text(encoding='utf-8-sig'))['images']
    dates, metadata = set(), []
    for i in range(len(prepared)):
        meta = page_metadata(responses[i*3]);metadata.append(meta);dates.update(meta['dates'])
    query_date, date_notes = resolve_query_date(dates, query_date)
    output_rows, evidence, review, image_info = [], [], [], []
    for index,item in enumerate(prepared):
        path,all_rows,meta = item['path'],item['rows'],metadata[index]
        numbers = [read_numbers(responses[index*3+j],len(all_rows)) for j in [1,2]]
        scoped = []
        for n,row in enumerate(all_rows):
            x0,y0,x1,y1 = row['label_box'];center=(y0+y1)/2
            if not in_building(center,meta,assume_building):
                continue
            if any(max(y0,a)<min(y1,b) for a,b in meta['header_bands']):
                continue
            row = {**row,'index':n}
            scoped.append(row)
        with Image.open(path) as source:
            im = source.convert('RGB')
        if not scoped:
            review.append({'source':path.name,'reason':'未确认三号楼范围或未找到教室行；无表头的已确认三号楼截图可使用--assume-building。'})
            continue
        try:
            edges = grid_edges(im,scoped)
        except ValueError as exc:
            review.append({'source':path.name,'reason':str(exc)})
            continue
        image_info.append({'source':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                           'size':item['size'],'period_edges':edges,'metadata':meta,
                           'scope_basis':'visible_heading' if meta['headings'] else 'explicit_assumption'})
        for row in scoped:
            n = row['index']
            observed = set(numbers[0][n]['candidates']) | set(numbers[1][n]['candidates'])
            room = next(iter(observed)) if len(observed)==1 else None
            if not room or room not in plan.KNOWN:
                review.append({'source':path.name,'label_box':row['label_box'], 'reason':'教室号不明确、双语OCR冲突或不在布局名单内',
                               'ocr':[numbers[0][n],numbers[1][n]]})
                continue
            _,y0,_,y1 = row['label_box']
            raw,slots,cells = [],[],[]
            for j in range(14):
                box = [edges[j],y0,edges[j+1],y1]
                state,green,white = cell_state(im,box)
                value = 'B' if state=='W' else state
                raw.append(state);slots.append(value)
                cells.append({'period':j+1,'color':state,'state':value,'box':box,'green_ratio':green,'white_ratio':white})
            observation = {'room':room,'slots':''.join(slots),'source':path.name}
            output_rows.append(observation)
            evidence.append({**observation,'raw_colors':''.join(raw),'label_box':row['label_box'],
                             'ocr':[numbers[0][n],numbers[1][n]],'cells':cells})
            if '?' in raw:
                review.append({'source':path.name,'room':room,'reason':'部分色块不明确','periods':[i+1 for i,v in enumerate(raw) if v=='?']})
    if not output_rows:
        raise ValueError('未提取到可用行：'+json.dumps(review,ensure_ascii=False))
    notes = list(date_notes)
    if review:
        notes.append(f'有{len(review)}项需核对，详见review.json；可识别的其他行已继续处理。')
    title = plan.task_title(query_date)
    data = {'building':'三号楼','date':query_date,'date_note':'用户已确认本次所有截图均为同一天；绿色为空闲，白色为有课。',
            'rows':output_rows,'notes':notes,'suggested_title':title,
            'rename_action':{'tool':'Skill','arguments':{'skill':'/rename','args':title}} if title else None}
    audit = {'schema_version':'2.1','elapsed_seconds':round(time.perf_counter()-start_time,3),
             'color_semantics':{'F':'空闲','W':'有课','?':'图像无法判读'},'same_day_batch':True,
             'images':image_info,'observations':evidence,'review':review,'suggested_title':title}
    for name,value in [('input.json',data),('evidence.json',audit),('review.json',review)]:
        (out_dir/name).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
    with (out_dir/'cells.csv').open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.writer(f);writer.writerow(['source','room']+[f'第{i}节' for i in range(1,15)])
        writer.writerows([r['source'],r['room'],*r['slots']] for r in output_rows)
    result = plan.analyze(data)
    (out_dir/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    (out_dir/'report.txt').write_text(plan.render_markdown(result),encoding='utf-8')
    print(json.dumps({'date':query_date,'suggested_title':title,'observations':len(output_rows),'rooms':len(result['rooms']),
                      'review_count':len(review),'elapsed_seconds':audit['elapsed_seconds'],
                      'recommendations':{k:len(v['recommendations']) for k,v in result['sessions'].items()},
                      'output':str(out_dir)},ensure_ascii=False))
    return data,audit,result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('images',nargs='+',type=Path)
    parser.add_argument('--out-dir',required=True,type=Path)
    parser.add_argument('--date')
    parser.add_argument('--assume-building',action='store_true',help='User confirms unheaded crops belong to Building 3; visible other-building headings still excluded.')
    args=parser.parse_args()
    try:
        extract_images(args.images,args.out_dir,args.date,args.assume_building)
    except (ValueError,RuntimeError,OSError,subprocess.TimeoutExpired) as exc:
        parser.error(str(exc))


if __name__=='__main__':
    main()
