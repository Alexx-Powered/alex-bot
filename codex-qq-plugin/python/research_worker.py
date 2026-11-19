"""One bounded network job; only a trusted supervisor supplies this stdin packet."""
import json
import sys
import time
from bounded_research import research_once
from research_queue import normalize_topic
from research_transport import PublicBingRSSProvider,BraveApiProvider,DeepSeekSearchProvider,SearchHit


def main():
    started=time.monotonic()
    raw=sys.stdin.buffer.read(4097)
    if len(raw)>4096:raise ValueError('RESEARCH_INPUT_TOO_LARGE')
    packet=json.loads(raw);topic=normalize_topic(packet['topic'])
    initial_hits=None
    if packet['provider']=='bing_rss':provider=PublicBingRSSProvider()
    elif packet['provider']=='brave':provider=BraveApiProvider(api_key=packet.get('api_key',''))
    elif packet['provider']=='deepseek':provider=DeepSeekSearchProvider(api_key=packet.get('api_key',''))
    elif packet['provider']=='operator_sources':
        provider=PublicBingRSSProvider()
        rows=packet['sources']
        if not isinstance(rows,list) or not 1<=len(rows)<=3:raise ValueError('RESEARCH_SOURCES_INVALID')
        initial_hits=[SearchHit(row['url'],row['title']) for row in rows]
    else:raise ValueError('RESEARCH_PROVIDER_UNSUPPORTED')
    pages=[]
    result=research_once(topic,provider,initial_hits=initial_hits,profile_pages=pages,budget_seconds=12)
    remaining=19-time.monotonic()+started
    # Complete pages survive an extraction timeout or a lingering HTTP thread.
    sys.stdout.buffer.write(json.dumps(result,ensure_ascii=False).encode()+b'\n');sys.stdout.buffer.flush()
    if result['status']=='completed' and pages and packet.get('api_key') and remaining>=2:
        from hiking_catalog import extract_profiles
        photos=[]
        if remaining>=6:
            from hiking_images import collect_photos
            photos=collect_photos(pages,budget=min(2,remaining-4),diagnostics=result['metrics'])
        remaining=19-time.monotonic()+started
        result['metrics']['llm_calls']=1
        tick=time.monotonic()
        result['hiking_profiles']=extract_profiles(topic,pages,packet['api_key'],timeout=max(.1,min(8,remaining)),diagnostics=result['metrics'],photos=photos)
        result['metrics']['extraction_ms']=round((time.monotonic()-tick)*1000,3)
    result['metrics']['total_ms']=round((time.monotonic()-started)*1000,3)
    sys.stdout.buffer.write(json.dumps(result,ensure_ascii=False).encode()+b'\n');sys.stdout.buffer.flush()


if __name__=='__main__':
    try:main()
    except Exception:
        sys.stdout.buffer.write(b'{"status":"failed","error_code":"RESEARCH_WORKER_FAILED","candidates":[],"metrics":{}}')
