"""Root operator accepts the dedicated account on stdin. Only the expected account gets a WS server."""
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import subprocess
import sys

OPS = Path(__file__).resolve().parent
HOME = Path("/var/lib/alexqqgw")
CONF = Path("/etc/alex-qq-gateway")
UNIT = Path("/etc/systemd/system/alex-qq-gateway.service")


def write_config(path, content, gid):
    temp = path.with_name("." + path.name + "." + secrets.token_hex(6))
    temp.write_text(json.dumps(content) + "\n")
    os.chown(temp, 0, gid)
    temp.chmod(0o640 if gid else 0o600)
    temp.replace(path)


def prepare():
    group = pwd.getpwnam("alexqqgw").pw_gid
    CONF.mkdir(mode=0o700, exist_ok=True)
    for folder in ["config", "plugins"]:
        p = HOME / folder
        p.mkdir(exist_ok=True)
        if p.is_symlink() or any(p.iterdir()) and folder == "plugins":
            raise ValueError("UNEXPECTED_GATEWAY_DIRECTORY")
        os.chown(p, 0, group)
        p.chmod(0o750)
    ops = Path("/opt/alex-qq-gateway/ops")
    ops.mkdir(exist_ok=True)
    shutil.copyfile(OPS / "run-onebot-gateway.py", ops / "run-onebot-gateway.py")
    (ops / "run-onebot-gateway.py").chmod(0o644)
    shutil.copyfile(OPS / UNIT.name, UNIT)
    UNIT.chmod(0o644)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    return group


def configure(group, number):
    if not re.fullmatch(r"[1-9]\d{4,11}", number, re.ASCII):
        raise ValueError("INVALID_ACCOUNT_NUMBER")
    profile_path = CONF / "onebot.json"
    if profile_path.exists():
        saved = json.loads(profile_path.read_text())
        if saved["selfId"] != number or saved["mode"] != "receive-only":
            raise ValueError("EXISTING_ACCOUNT_OR_MODE_DIFFERS")
        token = saved["token"]
    else:
        token = secrets.token_hex(32)
    net = {name: [] for name in ["httpServers", "httpSseServers", "httpClients", "websocketServers", "websocketClients", "plugins"]}
    config = {"network": net, "enableLocalFile2Url": False, "parseMultMsg": False}
    write_config(HOME / "config/onebot11.json", config, group)
    net["websocketServers"] = [{"name": "alex-bridge", "enable": True, "host": "127.0.0.1", "port": 19328,
                                "token": token, "reportSelfMessage": False, "messagePostFormat": "array",
                                "heartInterval": 30000, "enableForcePushEvent": False, "debug": False}]
    write_config(HOME / "config" / ("onebot11_" + number + ".json"), config, group)
    write_config(HOME / "config/webui.json", {"host": "127.0.0.1", "port": 0, "token": secrets.token_hex(32)}, group)
    write_config(HOME / "config/napcat.json", {"fileLog": False, "consoleLog": False}, group)
    challenge = CONF / "probe.challenge"
    if not challenge.exists():
        with challenge.open("x") as output:
            output.write(secrets.token_hex(8))
    write_config(profile_path, {"selfId": number, "mode": "receive-only", "token": token}, 0)


if __name__ == "__main__":
    os.umask(0o077)
    if subprocess.run(["systemctl", "is-active", "--quiet", "alex-qq-gateway"]).returncode == 0:
        raise SystemExit("STOP_GATEWAY_BEFORE_CONFIGURING")
    if sys.argv[1:] not in (["prepare"], ["account"]):
        raise SystemExit("Use prepare or account")
    gid = prepare()
    if sys.argv[1] == "account":
        configure(gid, sys.stdin.readline(32).strip())
    print(json.dumps({"prepared": True, "accountConfigured": (CONF / "onebot.json").is_file(), "started": False}))
