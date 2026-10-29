"""Root operator: drain QQ, install the staged release, preserve pause choice, verify PID."""
import json,os,subprocess,time
from pathlib import Path
from urllib.request import Request,build_opener,ProxyHandler

state=Path('/var/lib/alexbot');current=Path('/opt/alex-bot/current');previous=current.resolve()
policy=state/'config/chat-policy.md';old_policy=policy.read_bytes()
token=(state/'.private/admin-token').read_text().strip()
opener=build_opener(ProxyHandler({}))
def call(route,body=None):
    request=Request('http://127.0.0.1:19327/api/'+route,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with opener.open(request,timeout=180) as response:value=json.load(response)
    if not value.get('ok'):raise RuntimeError('API_FAILED')
    return value
def run(*args):subprocess.run(args,check=True,capture_output=True)
def ready():
    for _ in range(70):
        try:
            value=call('status')
            if value.get('transport',{}).get('state')=='connected':return value
        except Exception:pass
        time.sleep(.5)
    raise RuntimeError('CONNECT_TIMEOUT')
before=call('status');paused=before['core']['paused']
if before['core']['uncertainDeliveries']:raise RuntimeError('PENDING_DELIVERY')
backup=state/'.private/chat-update-before.json'
backup.write_text(json.dumps({'previousRelease':str(previous),'previousPaused':paused,'at':time.time(),'policy':old_policy.decode('utf-8')}));backup.chmod(0o600)
try:
    run('systemctl','stop','alexbot-morning')
    call('disconnect',{})
    run('systemctl','stop','alexbot')
    run('python3',str(previous/'codex-qq-plugin/ops/install-release.py'))
    deployed=current.resolve()
    new_policy=(deployed/'codex-qq-plugin/config/chat-policy.md').read_bytes()
    prior_default=(previous/'codex-qq-plugin/config/chat-policy.md').read_bytes()
    if old_policy.replace(b'\r\n',b'\n').strip()==prior_default.replace(b'\r\n',b'\n').strip():
        policy.write_bytes(new_policy);policy_mode='updated-default'
    else:
        # Keep user-owned rules/frontmatter while adding the new voice guidance.
        text=old_policy.decode('utf-8-sig');front,body=text.split('---',2)[1:]
        guidance=new_policy.decode('utf-8-sig').split('---',2)[2].split('换算和生活费',1)[0]
        policy.write_text('---'+front+'---\n'+guidance+'\n'+body);policy_mode='preserved-custom-rules'
    os.chown(policy,998,998);policy.chmod(0o600)
    run('systemctl','start','alexbot');after=ready()
    if not paused:
        if after['core'].get('pauseReason')!='LOCAL_PAUSE':raise RuntimeError('UNEXPECTED_PAUSE')
        call('pause',{'paused':False})
    run('systemctl','start','alexbot-morning');after=call('status')
    pid=int(subprocess.check_output(['systemctl','show','alexbot','-p','MainPID','--value'],text=True))
    listener=subprocess.check_output(['ss','-ltnp','sport = :19327'],text=True)
    if f'pid={pid},' not in listener or after['core']['dailyAttempts']<before['core']['dailyAttempts'] or after['core']['uncertainDeliveries']:raise RuntimeError('VERIFICATION_FAILED')
    print(json.dumps({'ok':True,'release':deployed.name,'pid':pid,'started':subprocess.check_output(['systemctl','show','alexbot','-p','ExecMainStartTimestamp','--value'],text=True).strip(),'policy':policy_mode,'connected':True,'paused':after['core']['paused'],'paired':after['core']['paired'],'dailyBefore':before['core']['dailyAttempts'],'dailyAfter':after['core']['dailyAttempts'],'uncertainDeliveries':after['core']['uncertainDeliveries']}))
except Exception:
    subprocess.run(['systemctl','stop','alexbot'],capture_output=True)
    temporary=Path('/opt/alex-bot/current.rollback');temporary.unlink(missing_ok=True);temporary.symlink_to(previous,target_is_directory=True);temporary.replace(current)
    policy.write_bytes(old_policy);os.chown(policy,998,998);policy.chmod(0o600)
    try:
        run('systemctl','start','alexbot');restored=ready()
        if not paused and restored['core'].get('pauseReason')=='LOCAL_PAUSE':call('pause',{'paused':False})
        run('systemctl','start','alexbot-morning')
        print(json.dumps({'ok':False,'code':'UPDATE_ROLLED_BACK','previousRelease':previous.name}))
    except Exception:print(json.dumps({'ok':False,'code':'ROLLBACK_NEEDS_ATTENTION'}))
    raise SystemExit(1)
