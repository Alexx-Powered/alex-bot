import os
from pathlib import Path

def font_path(bold=False):
    configured=os.environ.get('QQ_FONT_BOLD' if bold else 'QQ_FONT_REGULAR')
    candidates=[configured] if configured else []
    candidates+=['C:/Windows/Fonts/msyhbd.ttc' if bold else 'C:/Windows/Fonts/msyh.ttc',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc' if bold else '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']
    for value in candidates:
        if value and Path(value).is_file():return value
    raise ValueError('CHINESE_FONT_MISSING')
