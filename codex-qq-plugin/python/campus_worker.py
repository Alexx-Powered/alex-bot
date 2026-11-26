"""Dedicated private campus process: bounded protocol, no model, no QQ send."""
import contextlib
import io
import json
import logging
import sys
from pathlib import Path
from campus_classrooms import build_query_tool,envelope,campus_stage,browser_collect,CampusError

LIMIT=262144

def process(packet,*,collector=None,on_stage=None,authorized=None):
    private=Path.cwd()/'.private'
    if packet.get('cache_snapshot') is True and packet.get('mode') in {'query','report','login'}:
        from campus_cache import query_slot,remember
        try:
            with query_slot(private):
                if authorized and not authorized():
                    return {'cancelled':True}
                result=_process(packet,private,collector,on_stage)
                if result['data']['ok']:
                    remember(private,result['data'])
                return result
        except CampusError as exc:
            return {'kind':'campus','data':envelope(code=exc.code),'artifact_id':None}
    return _process(packet,private,collector,on_stage)

def _process(packet,private,collector,on_stage):
    session={}
    profile=packet.get('timeout_profile','normal')
    if profile not in {'normal','morning'} or (profile=='morning' and (packet.get('type')!='campus' or packet.get('mode')!='report')):
        return {'kind':'campus','data':envelope(code='CAMPUS_QUERY_FAILED'),'artifact_id':None}
    if collector is None:
        def collector(credentials,private_root,day,*,interactive=False):
            options={'timeout_profile':profile} if profile!='normal' else {}
            if on_stage:options['on_stage']=on_stage
            if sys.platform!='win32':
                options.update(session_state=packet.get('session_state'),on_session=lambda state:session.update(state=state))
            return browser_collect(credentials,private_root,day,interactive=interactive,**options)
    if packet.get('type')=='campus' and packet.get('mode')=='recognize':
        from campus_intent import recover_classroom_request
        return {'kind':'campus',**recover_classroom_request.invoke({**packet['args'],'now':packet['now']})}
    if packet.get('type')=='campus' and packet.get('mode')=='intent':
        from campus_intent import classroom_report_intent
        return {'kind':'campus','intent':classroom_report_intent.invoke(packet['args'])}
    if packet.get('type')=='campus' and packet.get('mode')=='recommend_render':
        from campus_compact import render_compact
        artifact=render_compact(packet['report'],private,packet.get('explanation',''))
        return {'kind':'campus','artifact_id':artifact}
    if packet.get('type')=='campus' and packet.get('mode')=='recommend':
        from campus_recommendations import build_recommendation_tool,timestamp
        if 'snapshot' in packet:
            snapshot=packet['snapshot']
        else:
            from campus_cache import snapshots
            date=packet['args'].get('date') or timestamp(packet['now']).date().isoformat()
            snapshot=snapshots(private).get(date)
        report=build_recommendation_tool(snapshot,packet['now'],packet.get('request_text')).invoke(packet['args'])
        return {'kind':'campus','recommendation':report,'artifact_id':None}
    if packet.get('type')!='campus' or packet.get('mode') not in {'query','report','login'} or not isinstance(packet.get('args'),dict):
        return {'kind':'campus','data':envelope(code='CAMPUS_QUERY_FAILED'),'artifact_id':None}
    # Only the local Windows console can present an interactive login window.
    # ECS has no display; its login check uses the same bounded headless flow.
    data=build_query_tool(packet.get('credentials'),private,interactive=packet['mode']=='login' and sys.platform=='win32',collector=collector).invoke(packet['args'])
    artifact=None
    if data['ok'] and packet['mode']=='report':
        try:
            with campus_stage(on_stage,'campus_render',error_code='CAMPUS_RENDER_FAILED'):
                from campus_regions import resolve_regions
                from campus_report import render_report,render_region_day
                selected,_=resolve_regions(data,packet.get('building') or '三号楼',packet.get('regions'),packet.get('request_text'))
                artifact=render_report(data,private,save_latest=not packet.get('cache_snapshot')) if selected==['三号楼'] else render_region_day(data,private,selected)
        except Exception:return {'kind':'campus','data':data,'artifact_id':None,'render_error':True}
    return {'kind':'campus','data':data,'artifact_id':artifact,**({'session_state':session['state']} if 'state' in session else {})}

def main():
    logging.disable(logging.CRITICAL)
    incoming,outgoing=sys.stdin.buffer,sys.stdout.buffer
    def write(payload):
        outgoing.write((json.dumps(payload,ensure_ascii=False,separators=(',',':'))+'\n').encode());outgoing.flush()
    while True:
        raw=incoming.readline(LIMIT+1)
        if not raw:return
        packet={}
        try:
            if len(raw)>LIMIT:raise ValueError()
            packet=json.loads(raw)
            if not isinstance(packet,dict):packet={};raise ValueError()
            def emit(stage,phase,**fields):
                write({'type':'campus_stage','id':packet.get('id'),'stage':stage,'phase':phase,**fields})
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                result=process(packet,on_stage=emit if packet.get('_traceCampus') is True else None)
        except Exception:result={'kind':'campus','data':envelope(code='CAMPUS_QUERY_FAILED'),'artifact_id':None}
        result.update(type='result',id=packet.get('id'))
        encoded=(json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n').encode()
        if len(encoded)>LIMIT:
            encoded=(json.dumps({'type':'result','id':packet.get('id'),'kind':'campus','data':envelope(code='CAMPUS_SCHEMA_CHANGED'),'artifact_id':None})+'\n').encode()
        outgoing.write(encoded);outgoing.flush()

if __name__=='__main__':main()
