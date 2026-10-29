"""Dedicated private campus process: bounded protocol, no model, no QQ send."""
import contextlib
import io
import json
import logging
import sys
from pathlib import Path
from campus_classrooms import build_query_tool,envelope,CampusError

LIMIT=262144

def process(packet,*,collector=None):
    private=Path.cwd()/'.private'
    options={} if collector is None else {'collector':collector}
    if packet.get('type')=='campus' and packet.get('mode')=='recommend_render':
        from campus_compact import render_compact
        artifact=render_compact(packet['report'],private,packet.get('explanation',''))
        return {'kind':'campus','artifact_id':artifact}
    if packet.get('type')=='campus' and packet.get('mode')=='recommend':
        from campus_recommendations import build_recommendation_tool
        report=build_recommendation_tool(packet.get('snapshot'),packet['now'],packet.get('request_text')).invoke(packet['args'])
        return {'kind':'campus','recommendation':report,'artifact_id':None}
    if packet.get('type')!='campus' or packet.get('mode') not in {'query','report','login'} or not isinstance(packet.get('args'),dict):
        return {'kind':'campus','data':envelope(code='CAMPUS_QUERY_FAILED'),'artifact_id':None}
    data=build_query_tool(packet.get('credentials'),private,interactive=packet['mode']=='login',**options).invoke(packet['args'])
    artifact=None
    if data['ok'] and packet['mode']=='report':
        try:
            from campus_recommendations import recommend
            report=recommend(data,{},data['fetched_at'],packet.get('request_text'))
            if report['regions']==['三号楼']:
                from campus_report import render_report
                artifact=render_report(data,private)
            else:
                from campus_compact import render_compact
                artifact=render_compact(report,private)
        except Exception:return {'kind':'campus','data':data,'artifact_id':None,'render_error':True}
    return {'kind':'campus','data':data,'artifact_id':artifact}

def main():
    logging.disable(logging.CRITICAL)
    incoming,outgoing=sys.stdin.buffer,sys.stdout.buffer
    while True:
        raw=incoming.readline(LIMIT+1)
        if not raw:return
        packet={}
        try:
            if len(raw)>LIMIT:raise ValueError()
            packet=json.loads(raw)
            if not isinstance(packet,dict):packet={};raise ValueError()
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):result=process(packet)
        except Exception:result={'kind':'campus','data':envelope(code='CAMPUS_QUERY_FAILED'),'artifact_id':None}
        result.update(type='result',id=packet.get('id'))
        encoded=(json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n').encode()
        if len(encoded)>LIMIT:
            encoded=(json.dumps({'type':'result','id':packet.get('id'),'kind':'campus','data':envelope(code='CAMPUS_SCHEMA_CHANGED'),'artifact_id':None})+'\n').encode()
        outgoing.write(encoded);outgoing.flush()

if __name__=='__main__':main()
