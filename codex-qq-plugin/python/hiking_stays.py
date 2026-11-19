"""Accommodation evidence: a place named 木屋 is not itself a room booking."""
import re
TENT=r'露营|扎营|帐篷'
INN=r'客栈|酒店|民宿|旅馆|床位|通铺|多人间|客房|住店|睡在木屋(?:里|内)|木屋(?:里|内)住宿'
NEG=r'(?:禁止|不可|不能|不允许|不准|严禁|勿|无法|没有|不提供|不支持|无)[^，,。；;]{0,16}'

def named_parts(name,text):
    for part in re.split(r'[。；;\n]',text):
        if name not in part:continue
        at=part.index(name)
        # A restriction on another area before this clause does not apply to
        # the explicitly named campsite (e.g. designated tent platforms).
        start=max(part.rfind('，',0,at),part.rfind(',',0,at))+1
        yield part[start:]

def blocked(name,text,pattern):
    return any(re.search(NEG+'(?:'+pattern+')',part) for part in named_parts(name,text))

def stay_modes(name,text):
    # Evidence is a short, source-verbatim passage for this named overnight
    # place. Never classify from another day's campsite or from 木屋 alone.
    parts=list(named_parts(name,text))
    joined='。'.join(parts)
    return [kind for kind,pattern in [('tent',TENT),('inn',INN)] if any(re.search(pattern,p) for p in parts) and not blocked(name,joined,pattern)]
