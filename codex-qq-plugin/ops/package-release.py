"""Package only Git-visible project source. Private state has a separate encrypted transfer."""
import hashlib,json,subprocess,zipfile
from pathlib import Path

root=Path(__file__).resolve().parents[2]
names=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','--','codex-qq-plugin','workbuddy-study-qq'],cwd=root).decode().splitlines()
names=sorted(set(n for n in names if not n.startswith('codex-qq-plugin/deploy/')))
for name in names:
    if any(part in ['.private','.venv','node_modules','test-output','__pycache__'] for part in Path(name).parts):raise ValueError('PRIVATE_FILE_IN_PACKAGE')
manifest={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in names if (root/name).is_file()}
version='linux-'+hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()[:12]
target=root/'codex-qq-plugin/test-output/migration';target.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(target/'release.zip','w',zipfile.ZIP_DEFLATED) as archive:
    for name in manifest:archive.write(root/name,name)
    archive.writestr('release-manifest.json',json.dumps({'release':version,'files':manifest},indent=2))
(target/'release.json').write_text(json.dumps({'release':version,'sha256':hashlib.sha256((target/'release.zip').read_bytes()).hexdigest(),'files':len(manifest)}),encoding='utf-8')
print((target/'release.json').read_text())
