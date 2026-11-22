"""One request from the owner console's local systemd socket."""
import base64
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import sys
import time

YOGURT = "alex-yogurt-lab.service"
NONEBOT = "alex-nonebot-milky.service"
STATE_DIR = "/opt/alex-yogurt-state"
PNG_LIMIT = 96 * 1024


def command(*args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=3, check=True)
    return result.stdout.decode("utf-8", errors="replace")


def unit(name):
    output = command("/usr/bin/systemctl", "show", "-p", "ActiveState,InvocationID,ExecMainStartTimestampMonotonic", name)
    values = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    started = int(values.get("ExecMainStartTimestampMonotonic", "0"))
    wall_ms = (time.time_ns() - time.monotonic_ns() + started * 1000) // 1_000_000 if started else 0
    return values.get("ActiveState", "unknown"), values.get("InvocationID", ""), wall_ms


def qr_file(include_pixels):
    import pwd
    directory = os.open(STATE_DIR, os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fd = os.open("qrcode.png", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return {}
        with os.fdopen(fd, "rb") as file:
            info = os.fstat(file.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or
                    info.st_uid != pwd.getpwnam("alexyogurt").pw_uid or not 32 < info.st_size <= PNG_LIMIT):
                return {}
            stamp = {"qrVersion": f"{info.st_ino}-{info.st_mtime_ns}", "qrTime": info.st_mtime_ns // 1_000_000}
            if include_pixels:
                data = file.read(PNG_LIMIT + 1)
                if (len(data) != info.st_size or os.fstat(file.fileno()).st_mtime_ns != info.st_mtime_ns or
                        not data.startswith(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR") or
                        not data.endswith(b"\x00\x00\x00\x00IEND\xaeB\x60\x82")):
                    return {}
                width, height = struct.unpack(">II", data[16:24])
                if width != height or not 21 <= width <= 2048:
                    return {}
                stamp["png"] = base64.b64encode(data).decode("ascii")
            return stamp
    finally:
        os.close(directory)


def listener():
    address = f"0100007F:{19437:04X}"
    with Path("/proc/net/tcp").open() as rows:
        return any(fields[1] == address and fields[3] == "0A"
                   for fields in map(str.split, rows) if len(fields) > 3)


def login_event(invocation):
    if not re.fullmatch("[0-9a-f]{32}", invocation):
        return {}
    lines = command("/usr/bin/journalctl", "--quiet", "--no-pager", "-n", "30", "-o", "json",
                    "--output-fields=MESSAGE", "_SYSTEMD_INVOCATION_ID=" + invocation)
    for line in reversed(lines.splitlines()):
        entry = json.loads(line)
        message = entry.get("MESSAGE")
        if not isinstance(message, str):
            continue
        if re.search(r"身份验证失败|登录失败|登录态失效|二维码.{0,4}过期", message):
            return {"loginEvent": "expired" if "过期" in message else "failed",
                    "eventTime": int(entry["__REALTIME_TIMESTAMP"]) // 1000}
        if "已上线" in message or "登录成功" in message:
            break
    return {}


def handle(op):
    yogurt, invocation, started = unit(YOGURT)
    nonebot, _, channel_started = unit(NONEBOT)
    state = {"ok": True, "yogurt": yogurt, "nonebot": nonebot, "invocation": invocation,
             "listening": listener(), "started": max(started, channel_started)}
    if op == b"start\n":
        state.update(qr_file(False))
        command("/usr/bin/systemctl", "--no-block", "start", NONEBOT)
        command("/usr/bin/systemctl", "--no-block", "restart", YOGURT)
    else:
        state.update(login_event(invocation))
        if op == b"poll\n":
            state.update(qr_file(True))
    return state


if __name__ == "__main__":
    request = sys.stdin.buffer.readline(16)
    try:
        response = handle(request) if request in (b"status\n", b"poll\n", b"start\n") else {"ok": False}
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        response = {"ok": False}
    print(json.dumps(response, separators=(",", ":")), flush=True)
