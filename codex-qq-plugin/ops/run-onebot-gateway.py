"""Unprivileged supervisor for the single-account, memory-limited ECS gateway."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time

RELEASE = Path("/opt/alex-qq-gateway/releases/v4.18.42")
RUNTIME = Path("/run/alex-qq-gateway")
STATE = Path("/var/lib/alexqqgw")


def counters(file):
    return {row[0].rstrip(":"): int(row[1]) for line in Path(file).read_text().splitlines()
            if len(row := line.split()) > 1 and row[1].isdigit()}


def listener():
    port = f"{19328:04X}"
    sockets = [s for name in ("tcp", "tcp6") for line in Path("/proc/net", name).read_text().splitlines()[1:]
               if (s := line.split())[3] == "0A" and s[1].endswith(":" + port)]
    if any(s[1] != "0100007F:" + port for s in sockets):
        raise RuntimeError("NON_LOOPBACK_LISTENER")
    return bool(sockets)


def sample(state, available, minimum, started):
    temp = RUNTIME / "health.tmp"
    temp.write_text(json.dumps({"state": state, "availableMiB": available, "minimumMiB": minimum,
                                "uptimeSeconds": int(time.monotonic()-started)}))
    temp.replace(RUNTIME / "health.json")


def main():
    start = time.monotonic()
    minimum = counters("/proc/meminfo")["MemAvailable"] // 1024
    if minimum < 600 or listener():
        sample("PREFLIGHT_FAILED", minimum, minimum, start)
        return 75
    vm = counters("/proc/vmstat")
    process = subprocess.Popen(["/usr/bin/xvfb-run", "-a", "-s", "-screen 0 640x480x24 -nolisten tcp",
                                str(RELEASE / "qq"), "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
                               cwd=STATE, env={**os.environ, "LD_LIBRARY_PATH": str(RELEASE / "usr/lib"),
                                               "XDG_DATA_DIRS": str(RELEASE / "usr/share")+":/usr/local/share:/usr/share"},
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    available = minimum
    low = swapping = 0
    had_listener = False
    try:
        while process.poll() is None:
            available = counters("/proc/meminfo")["MemAvailable"] // 1024
            minimum = min(minimum, available)
            current = counters("/proc/vmstat")
            low = low + 1 if available < 300 else 0
            swapping = swapping + 1 if current["pswpout"] - vm["pswpout"] >= 256 else 0
            online = listener()
            if available < 192 or low >= 3 or swapping >= 3 or current["oom_kill"] > vm["oom_kill"]:
                state = "MEMORY_GUARD_STOP"
            elif not online and (had_listener or time.monotonic() - start > 150):
                state = "LOGIN_OR_CONNECTION_STOP"
            else:
                state = "LOOPBACK_LISTENING" if online else "AWAITING_LOGIN"
            sample(state, available, minimum, start)
            if state.endswith("STOP"):
                return 75
            had_listener |= online
            vm = current
            time.sleep(3)
        sample("PROCESS_EXITED", available, minimum, start)
        return 1
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)


if __name__ == "__main__":
    raise SystemExit(main())
