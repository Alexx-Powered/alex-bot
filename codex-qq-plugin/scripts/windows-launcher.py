"""Run a fixed Alex Bot entry point without allocating a Windows console."""

import os
from pathlib import Path
import subprocess
import sys


scripts = Path(__file__).resolve().parent
entry = {"tunnel": "run-cloud-tunnel.ps1", "console": "open-console.ps1"}[sys.argv[1]]
powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
sys.exit(subprocess.call(
    [str(powershell), "-NoProfile", "-NonInteractive", "-File", str(scripts / entry)],
    cwd=scripts.parent,
    creationflags=subprocess.CREATE_NO_WINDOW,
    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
))
