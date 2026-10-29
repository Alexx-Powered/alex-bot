import pwd,subprocess
from pathlib import Path

name='alexbridge'
try:account=pwd.getpwnam(name)
except KeyError:
    subprocess.run(['useradd','--create-home','--shell','/usr/sbin/nologin',name],check=True);account=pwd.getpwnam(name)
key=Path('/tmp/alex-tunnel.pub').read_text().strip()
if not key.startswith('ssh-rsa ') or '\n' in key or len(key)>2000:raise ValueError('INVALID_PUBLIC_KEY')
folder=Path(account.pw_dir)/'.ssh';folder.mkdir(mode=0o700,exist_ok=True)
authorized=folder/'authorized_keys'
authorized.write_text('restrict,port-forwarding,permitopen="127.0.0.1:19327" '+key+'\n');authorized.chmod(0o600)
subprocess.run(['chown','-R',name+':'+name,str(folder)],check=True)
fragment=Path('/etc/ssh/sshd_config.d/70-alexbridge.conf')
fragment.write_text('''Match User alexbridge
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:19327
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
    ForceCommand /usr/sbin/nologin
Match all
''')
subprocess.run(['/usr/sbin/sshd','-t'],check=True)
subprocess.run(['systemctl','reload','ssh'],check=True)
print('RESTRICTED_SSH_FORWARDING_READY')
