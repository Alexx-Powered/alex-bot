import {GlobalFonts} from '@napi-rs/canvas';
import {existsSync} from 'node:fs';
const file=process.env.QQ_FONT_REGULAR||(['C:/Windows/Fonts/msyh.ttc','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'].find(existsSync));
if(file)GlobalFonts.registerFromPath(file,'Alex CJK');
export const CHINESE_FONT='Alex CJK, sans-serif';
