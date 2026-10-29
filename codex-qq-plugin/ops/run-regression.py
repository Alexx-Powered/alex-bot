import json,os,subprocess
from pathlib import Path

root=Path(__file__).resolve().parents[1]
out=Path('/var/lib/alexbot/.private/preflight');out.mkdir(parents=True,exist_ok=True)
results={}
for name,command in [('node',['/usr/local/bin/node','--test']),('python',['/opt/alex-bot-runtime/python/app-venv/bin/python','-B','-m','unittest','discover','-s','python','-p','test_*.py'])]:
    with (out/(name+'-tests.log')).open('w') as stream:
        result=subprocess.run(command,cwd=root,stdout=stream,stderr=subprocess.STDOUT,timeout=240)
    results[name]=result.returncode
    (out/'regression.json').write_text(json.dumps(results))
print(json.dumps(results))
raise SystemExit(int(any(results.values())))
