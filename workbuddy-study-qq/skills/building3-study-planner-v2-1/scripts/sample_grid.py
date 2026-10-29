#!/usr/bin/env python3
"""Sample green/white cells after the agent verifies table bounds and room labels. Requires Pillow."""
import argparse
import json
from pathlib import Path


def classify(image, box):
    x0, y0, x1, y1 = box
    if not (0 <= x0 < x1 <= image.width and 0 <= y0 < y1 <= image.height):
        raise ValueError(f'采样区域越界：{box}')
    green = white = count = 0
    # Read a center patch, not the lines or just one potentially corrupted pixel.
    for iy in range(3, 8):
        for ix in range(3, 8):
            x = min(image.width-1, int(x0 + (x1-x0)*ix/10))
            y = min(image.height-1, int(y0 + (y1-y0)*iy/10))
            r, g, b = image.getpixel((x, y))
            green += g > 125 and g-r > 20 and g-b > 15
            white += min(r, g, b) >= 225 and max(r, g, b)-min(r, g, b) <= 20
            count += 1
    if green / count >= .88:
        return 'F'
    if white / count >= .92:
        return 'B'
    return '?'


def extract(manifest, base):
    from PIL import Image
    if manifest.get('building') != '三号楼':
        raise ValueError('仅支持已定位的三号楼表格。')
    output = {k: manifest[k] for k in ('building', 'date', 'date_note', 'notes') if k in manifest}
    output['rows'] = []
    for spec in manifest['images']:
        path = Path(spec['path'])
        if not path.is_absolute():
            path = base / path
        im = Image.open(path).convert('RGB')
        edges = spec.get('x_edges')
        if edges is None:
            x0, x1 = spec['x0'], spec['x1']
            edges = [x0 + (x1-x0)*i/14 for i in range(15)]
        if len(edges) != 15 or any(a >= b for a, b in zip(edges, edges[1:])):
            raise ValueError('x_edges 必须是从左到右递增的15条单节边界。')
        for row in spec['rows']:
            values = [classify(im, (edges[i], row['y0'], edges[i+1], row['y1'])) for i in range(14)]
            for p in row.get('unknown_periods', []):
                if type(p) is not int or not 1 <= p <= 14:
                    raise ValueError('unknown_periods 中的节数必须为1—14。')
                values[p-1] = '?'
            output['rows'].append({'room': row['room'], 'slots': ''.join(values), 'source': path.name})
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        data = extract(json.loads(args.manifest.read_text(encoding='utf-8-sig')), args.manifest.parent)
    except ImportError:
        parser.error('需要 Pillow；可使用宿主已有图像运行环境，或直接目视逐格记录，规划脚本本身不依赖 Pillow。')
    except (KeyError, TypeError, ValueError) as exc:
        parser.error(str(exc))
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'已采样{len(data["rows"])}行。请目视复核房间号、列对齐和半格，再交给plan.py。')


if __name__ == '__main__':
    main()
