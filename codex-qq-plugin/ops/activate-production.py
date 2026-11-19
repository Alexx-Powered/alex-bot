"""Activate one verified Git-built release on the managed official QQ instance."""
import argparse
from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.request import ProxyHandler, Request, build_opener
from urllib.error import URLError
from zoneinfo import ZoneInfo

from map_review import digest, require_map_review

ROOT = Path('/opt/alex-bot')
CURRENT = ROOT / 'current'
HOME = Path('/var/lib/alexbot')
BOT = 'alexbot.service'
NODE = '/usr/local/bin/node'
TIMERS = ('daily-reboot', 'morning-gefs', 'morning-ecmwf', 'group-morning-prepare',
          'group-morning', 'rag-backup', 'research', 'climate-refresh')
RETIRED = ('alex-qq-gateway.service', 'alex-qq-control.service', 'alexbot-onebot.service',
           'alex-qq-pilot.service', 'alexbot-onebot-morning.service', 'alexbot-onebot-morning.timer',
           'alexbot-morning.service')
PERMISSIONS = ('ownerId', 'allowedGroups', 'grayGroups', 'groupHelpNotes', 'wakeWords', 'wakeWordRevision',
               'removedOfficialGroups', 'paused', 'pauseReason')


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*args, timeout=100):
    return subprocess.check_output(args, text=True, timeout=timeout).strip()


def prop(unit, field):
    return run('systemctl', 'show', unit, '-p', field, '--value')


def verify_process(release):
    pid = prop(BOT, 'MainPID')
    proc = Path('/proc') / pid
    check(CURRENT.resolve() == release, 'RELEASE_CHANGED')
    check('pid=' + pid + ',' in run('ss','-ltnp','sport = :19327'), 'LISTENER_MISMATCH')
    argv = (proc / 'cmdline').read_bytes().split(b'\0')[:3]
    check(argv == [NODE.encode(), str(CURRENT / 'codex-qq-plugin/src/server.mjs').encode(), b'--connect'], 'ENTRY_MISMATCH')
    check((proc / 'cwd').resolve() == HOME and
          b'QQ_TRANSPORT=official' in (proc / 'environ').read_bytes().split(b'\0'), 'TRANSPORT_MISMATCH')
    return {'pid':int(pid), 'started':prop(BOT,'ExecMainStartTimestamp'), 'entry':str(release/'codex-qq-plugin/src/server.mjs')}


def ready():
    token = (HOME / '.private/admin-token').read_text().strip()
    opener = build_opener(ProxyHandler({}))
    query = Request('http://127.0.0.1:19327/api/status', headers={'Authorization':'Bearer '+token})
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            with opener.open(query, timeout=3) as response:
                result = json.load(response)
            if result.get('ok') and result['transport']['state'] == 'connected':
                return result
        except (OSError, URLError):
            pass
        time.sleep(.5)
    raise RuntimeError('OFFICIAL_CONNECTION_TIMEOUT')


def switch(target):
    with tempfile.TemporaryDirectory(dir=ROOT) as folder:
        link = Path(folder) / 'current'
        link.symlink_to(target, target_is_directory=True)
        os.replace(link, CURRENT)


def snapshot():
    state = json.loads((HOME / '.private/state.json').read_bytes())
    return {key:state.get(key) for key in PERMISSIONS}


def check_schedule():
    check(all(prop(u,'UnitFileState') == 'masked' for u in RETIRED), 'RETIRED_UNIT_CHANGED')
    for name in TIMERS:
        unit = 'alexbot-' + name + '.timer'
        next_run = prop(unit,'NextElapseUSecRealtime') or prop(unit,'NextElapseUSecMonotonic')
        check(prop(unit,'UnitFileState') == 'enabled' and prop(unit,'ActiveState') == 'active'
              and next_run not in ('','n/a','0'), 'TIMER_CHANGED: '+unit)
    when = datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%H:%M')
    check(not ('07:25' <= when < '07:40'), 'MORNING_BUSY')
    for role in ('group-morning','group-morning-prepare'):
        check(prop('alexbot-'+role+'.service','ActiveState') in ('inactive','failed'), 'MORNING_BUSY')


def backup(target):
    available = next(int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()
                     if line.startswith('MemAvailable:'))
    check(available >= 600*1024, 'INSUFFICIENT_MEMORY_FOR_BACKUP')
    output = run('systemd-run','--quiet','--wait','--collect','--pipe','--uid=alexbot',
                 '-p','MemoryMax=128M','-p','MemorySwapMax=0','-p','CPUQuota=50%',
                 '-p','WorkingDirectory='+str(HOME),'-p','LoadCredential=backup.public:/etc/alexbot/backup-public.pem',
                 NODE,str(target/'codex-qq-plugin/ops/backup.mjs'),'create')
    receipt = json.loads(output.splitlines()[-1])
    check(receipt.get('ok') and Path(receipt['file']).is_file(), 'BACKUP_FAILED')
    return {'file':receipt['file'],'sha256':digest(Path(receipt['file']))}


def activate(commit, base_name):
    check(re.fullmatch('[a-f0-9]{40}',commit), 'INVALID_COMMIT')
    old = CURRENT.resolve()
    target = ROOT/'releases'/('linux-'+commit[:12])
    check(old.name == base_name and old.parent == target.parent and old != target, 'BASE_CHANGED')
    manifest = json.loads((target/'release-manifest.json').read_bytes())
    check(manifest['commit'] == commit and manifest['release'] == target.name, 'CANDIDATE_CHANGED')
    check(all(digest(target/name) == value for name,value in manifest['files'].items()), 'HASH_MISMATCH')
    require_map_review(target/'codex-qq-plugin', old/'codex-qq-plugin')
    check_schedule()
    before = ready()
    check(before['core']['uncertainDeliveries'] == 0, 'UNSETTLED_BEFORE_SWITCH')
    original = verify_process(old)
    saved = backup(target)
    check(ready()['core']['uncertainDeliveries'] == 0, 'UNSETTLED_BEFORE_SWITCH')
    check_schedule()
    try:
        run('systemctl','stop',BOT)
        frozen = snapshot()
        switch(target)
        run('systemctl','start',BOT)
        after = ready()
        actual = verify_process(target)
        check(actual['pid'] != original['pid'] and actual['started'] != original['started'], 'STALE_PROCESS')
        check(snapshot() == frozen and after['core']['uncertainDeliveries'] == 0, 'PROTECTED_STATE_CHANGED')
        check_schedule()
    except BaseException:
        run('systemctl','stop',BOT)
        switch(old)
        run('systemctl','start',BOT)
        ready()
        verify_process(old)
        raise
    print(json.dumps({'commit':commit,'base':old.name,'release':target.name,**actual,'connected':True,
                      'files':len(manifest['files']),'uncertain':after['core']['uncertainDeliveries'],
                      'paused':after['core']['paused'],'backup':saved,'timers':len(TIMERS)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('commit')
    parser.add_argument('base')
    args = parser.parse_args()
    with open('/run/lock/alexbot-source-switch.lock','a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        activate(args.commit, args.base)
