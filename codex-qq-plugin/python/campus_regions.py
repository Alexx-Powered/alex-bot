"""Explicit classroom-region selection using campus room identifiers."""
import re
import unicodedata

REGIONS=['三号楼','主楼','主M','主北','主南']+[f'新主楼{letter}座' for letter in 'ABCDEFG']


def resolve_regions(snapshot,building='三号楼',regions=None,text=None):
    def normalize(value):
        return unicodedata.normalize('NFKC',value).upper().strip()
    def direct(value):
        value=normalize(value)
        if value in ('全部','所有','全部教学楼'):return REGIONS[:]
        if value=='新主楼':return REGIONS[5:]
        if value in ('老主楼','旧主楼'):return ['主楼']
        if value in ('3号楼','第三教学楼'):return ['三号楼']
        match=re.fullmatch(r'新主楼\s*([A-G])(?:座|区)?',value)
        return ['新主楼'+match[1]+'座'] if match else [value]
    if text is None:
        selected=[r for value in (regions or [building]) for r in direct(value)]
    else:
        text=normalize(text)
        if '沙河' in text:return ['沙河校区（当前仅支持学院路）'],'沙河校区'
        if any(word in text for word in ('全部教学楼','所有教学楼','学院路全部','学院路所有')):return REGIONS[:],'全部'
        selected=[]
        letters=[]
        # Both compact combinations (新主楼AC座) and repeated seats (A座和C座).
        for match in re.finditer(r'新主楼\s*([A-Z]+(?:\s*[,、，/和及与到至-]\s*[A-Z]+)*)',text):
            chunk=match[1]
            span=re.fullmatch(r'([A-G])\s*(?:到|至|-)\s*([A-G])',chunk)
            letters.extend(chr(x) for x in range(ord(span[1]),ord(span[2])+1)) if span else letters.extend(re.findall('[A-Z]',chunk))
        letters.extend(re.findall(r'(?<![A-Z])([A-Z])\s*座',text))
        for span in re.finditer(r'([A-G])座?\s*(?:到|至|-)\s*([A-G])座',text):
            letters.extend(chr(x) for x in range(ord(span[1]),ord(span[2])+1))
        if letters:selected.extend('新主楼'+letter+'座' for letter in letters)
        elif '新主楼' in text:selected.extend(REGIONS[5:])
        masked=text.replace('新主楼','')
        for pattern,region in [(r'主(?:楼)?\s*M(?:座|区)?','主M'),(r'主(?:楼)?北(?:座|区)?','主北'),(r'主(?:楼)?南(?:座|区)?','主南')]:
            if re.search(pattern,masked):selected.append(region);masked=re.sub(pattern,'',masked)
        if re.search('老主楼|旧主楼|主楼',masked):selected.append('主楼')
        if re.search('三号楼|3号楼|第三教学楼',text):selected.append('三号楼')
        if not selected and building!='三号楼' and normalize(building) in text:selected=direct(building)
        if not selected:
            unknown=re.search(r'[一二三四五六七八九十0-9]+号楼',text)
            selected=[unknown[0]] if unknown else ['三号楼']
    selected=list(dict.fromkeys(selected))
    label=selected[0] if len(selected)==1 else '新主楼' if selected==REGIONS[5:] else '全部' if selected==REGIONS else '组合区域'
    return selected,label


def room_region(building,room):
    source=unicodedata.normalize('NFKC',building).strip()
    name=unicodedata.normalize('NFKC',room).upper().strip()
    if source=='三号楼':return '三号楼'
    if source=='主楼':
        if re.match(r'主M\d',name):return '主M'
        if re.match(r'主北\d',name):return '主北'
        if re.match(r'主南\d',name):return '主南'
        if re.match(r'(?:主)?\d',name):return '主楼'
    if source=='新主楼':
        match=re.match(r'(?:新主楼)?([A-G])\d',name)
        return '新主楼'+match[1]+'座' if match else None
    return source if source in REGIONS else None
