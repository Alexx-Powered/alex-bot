"""Convert this host's existing /swapfile to random-key encrypted swap, with rollback."""
import json,subprocess
from pathlib import Path

def run(*args):
    return subprocess.run(args,check=True,capture_output=True,text=True).stdout

backing=Path('/swapfile')
if not backing.is_file() or backing.is_symlink() or backing.stat().st_size!=2*1024**3:
    raise RuntimeError('UNEXPECTED_SWAPFILE')
active=Path('/proc/swaps').read_text().splitlines()[1:]
if any(line.split()[0]=='/dev/dm-0' for line in active) and Path('/dev/mapper/alexbot-swap').exists():
    print('ENCRYPTED_SWAP_ALREADY_ACTIVE');raise SystemExit(0)
if len(active)!=1 or active[0].split()[0]!='/swapfile' or int(active[0].split()[3])!=0:
    raise RuntimeError('SWAP_NOT_IDLE')
fstab=Path('/etc/fstab');crypttab=Path('/etc/crypttab')
old_fstab=fstab.read_text();old_crypttab=crypttab.read_text() if crypttab.exists() else ''
if 'alexbot-swap' in old_fstab+old_crypttab:raise RuntimeError('PARTIAL_SETUP_REQUIRES_REVIEW')
backup=Path('/etc/alexbot/migration-swap-backup.json')
with backup.open('x') as f:json.dump({'fstab':old_fstab,'crypttab':old_crypttab},f)
backup.chmod(0o600)
new_fstab='\n'.join(line for line in old_fstab.splitlines() if not (line.strip() and not line.lstrip().startswith('#') and line.split()[0]=='/swapfile'))+'\n/dev/mapper/alexbot-swap none swap sw 0 0\n'
new_crypttab=old_crypttab.rstrip()+'\nalexbot-swap /swapfile /dev/urandom swap,cipher=aes-xts-plain64,size=256\n'
run('swapoff','/swapfile')
try:
    run('cryptsetup','open','--type','plain','--cipher','aes-xts-plain64','--key-size','256','--key-file','/dev/urandom','/swapfile','alexbot-swap')
    run('mkswap','/dev/mapper/alexbot-swap');run('swapon','/dev/mapper/alexbot-swap')
    fstab.write_text(new_fstab);crypttab.write_text(new_crypttab)
    run('systemctl','daemon-reload')
except Exception:
    subprocess.run(['swapoff','/dev/mapper/alexbot-swap'],capture_output=True)
    subprocess.run(['cryptsetup','close','alexbot-swap'],capture_output=True)
    fstab.write_text(old_fstab);crypttab.write_text(old_crypttab)
    run('mkswap','/swapfile');run('swapon','/swapfile');run('systemctl','daemon-reload')
    raise
print(json.dumps({'encrypted_swap':True,'backing_bytes':backing.stat().st_size,'ephemeral_key':True}))
