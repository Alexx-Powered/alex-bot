"""Root operator installs verified source without starting or connecting the Bot."""
import hashlib,json,os,subprocess,zipfile,sys
from pathlib import Path

archive=Path('/tmp/alex-release.zip')
with zipfile.ZipFile(archive) as zipped:
    manifest=json.loads(zipped.read('release-manifest.json'));release=manifest['release']
    if not release.startswith('linux-') or not release[6:].isalnum():raise ValueError('INVALID_RELEASE')
    target=Path('/opt/alex-bot/releases')/release
    if not target.exists():
        for name in zipped.namelist():
            if Path(name).is_absolute() or '..' in Path(name).parts:raise ValueError('INVALID_PATH')
        zipped.extractall(target)
    for name,digest in manifest['files'].items():
        if hashlib.sha256((target/name).read_bytes()).hexdigest()!=digest:raise ValueError('HASH_MISMATCH')
for p in target.rglob('*'):
    if not p.is_symlink():p.chmod(0o755 if p.is_dir() else 0o644)
modules=target/'codex-qq-plugin/node_modules'
if not modules.exists():modules.symlink_to('/opt/alex-bot-runtime/node/node_modules',target_is_directory=True)
if '--stage-only' not in sys.argv:
    current=Path('/opt/alex-bot/current')
    from map_review import require_map_review
    require_map_review(target/'codex-qq-plugin',current/'codex-qq-plugin')
    temporary=Path('/opt/alex-bot/current.next')
    if temporary.is_symlink():temporary.unlink()
    temporary.symlink_to(target,target_is_directory=True);temporary.replace(current)
Path('/var/lib/alexbot').chmod(0o700)
subprocess.run(['chown','alexbot:alexbot','/var/lib/alexbot'],check=True)
print(json.dumps({'release':release,'source_verified':True,'activated':'--stage-only' not in sys.argv,'started':False}))
