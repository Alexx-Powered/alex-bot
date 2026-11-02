"""Workbench operator entry. Keep QQ identity out of command lines and QR material out of logs."""
import base64
import json
import os
from pathlib import Path
import pwd
import stat
import subprocess
import sys
import time

KEY_DIR = Path("/run/alex-qq-bootstrap")
KEY = KEY_DIR / "operator.pem"
HOME = Path("/var/lib/alexqqgw")
OPS = Path(__file__).resolve().parent
UNIT = "alex-qq-gateway.service"


def active():
    return subprocess.run(["systemctl", "is-active", "--quiet", UNIT]).returncode == 0


def public_modulus():
    if active():
        raise ValueError("GATEWAY_ALREADY_RUNNING")
    KEY_DIR.mkdir(mode=0o700, exist_ok=True)
    if not KEY.exists() or time.time() - KEY.stat().st_mtime > 600:
        temp = KEY.with_suffix(".new")
        subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048",
                        "-out", str(temp)], check=True, stderr=subprocess.DEVNULL)
        temp.replace(KEY)
    result = subprocess.check_output(["openssl", "rsa", "-in", str(KEY), "-noout", "-modulus"], text=True)
    return base64.b64encode(bytes.fromhex(result.strip().split("=", 1)[1])).decode()


def start(ciphertext):
    if active() or time.time() - KEY.stat().st_mtime > 600:
        raise ValueError("STALE_LOGIN_REQUEST")
    sealed = base64.b64decode(ciphertext.strip(), validate=True)
    if len(sealed) != 256:
        raise ValueError("INVALID_ENVELOPE")
    clear = subprocess.check_output(["openssl", "pkeyutl", "-decrypt", "-inkey", str(KEY), "-pkeyopt",
                                    "rsa_padding_mode:oaep", "-pkeyopt", "rsa_oaep_md:sha256",
                                    "-pkeyopt", "rsa_mgf1_md:sha256"], input=sealed, stderr=subprocess.DEVNULL)
    KEY.unlink()
    subprocess.run(["python3", str(OPS / "configure-onebot-gateway.py"), "account"], input=clear,
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    del clear
    if active():
        raise ValueError("GATEWAY_ALREADY_RUNNING")
    subprocess.run(["systemctl", "start", UNIT], check=True, stdout=subprocess.DEVNULL)
    return {"started": active()}


def current_qr():
    # Both image and parent are in the gateway user's directory. Root must never
    # follow a symlink supplied by the QQ process.
    if not active():
        return {}
    since = int(subprocess.check_output(["systemctl", "show", UNIT, "-p", "ActiveEnterTimestampMonotonic",
                                        "--value"], text=True)) / 1_000_000
    start_time = time.time() - (time.monotonic() - since)
    directory = os.open(HOME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        cache = os.open("cache", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            fd = os.open("qrcode.png", os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=cache)
            with os.fdopen(fd, "rb") as image:
                info = os.fstat(image.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != pwd.getpwnam("alexqqgw").pw_uid or
                        info.st_nlink != 1 or not 50 < info.st_size < 262144 or
                        info.st_mtime < start_time - 1 or time.time() - info.st_mtime >= 90):
                    return {}
                raw = image.read(262144)
                if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
                    return {}
                return {"png": base64.b64encode(raw).decode()}
        finally:
            os.close(cache)
    except FileNotFoundError:
        return {}
    finally:
        os.close(directory)


if __name__ == "__main__":
    os.umask(0o077)
    try:
        mode, = sys.argv[1:]
        if mode == "key":
            result = {"modulus": public_modulus()}
        elif mode == "start":
            result = start(sys.stdin.readline(400))
        elif mode == "qr":
            result = current_qr()
        else:
            raise ValueError("INVALID_MODE")
        print(json.dumps(result))
    except Exception:
        raise SystemExit("GATEWAY_OPERATOR_REQUEST_FAILED")
