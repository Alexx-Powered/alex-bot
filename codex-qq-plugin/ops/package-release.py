"""Package the exact committed source, independently of local edits or untracked work."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import zipfile

root = Path(__file__).resolve().parents[2]
commit = subprocess.check_output(["git", "rev-parse", "--verify", "HEAD^{commit}"], cwd=root, text=True).strip()
paths = subprocess.check_output(["git", "ls-tree", "-rz", "--name-only", commit], cwd=root)
ignored = subprocess.run(["git", "check-ignore", "--no-index", "--stdin", "-z"], cwd=root,
                         input=paths, stdout=subprocess.PIPE)
if ignored.returncode == 0:
    raise ValueError("Local-only paths in release commit: " + ", ".join(
        name.decode() for name in ignored.stdout.split(b"\0") if name))
if ignored.returncode != 1:
    ignored.check_returncode()
source = subprocess.check_output(["git", "archive", commit, "--", "codex-qq-plugin"], cwd=root)
target = root / "codex-qq-plugin/test-output/migration"
target.mkdir(parents=True, exist_ok=True)
archive = target / "release.zip"
manifest = {}
with tarfile.open(fileobj=io.BytesIO(source)) as tree, zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as out:
    for entry in tree:
        name = entry.name
        if entry.isdir() or name.startswith("codex-qq-plugin/deploy/"):
            continue
        parts = PurePosixPath(name).parts
        if not entry.isfile() or any(p in {".private", ".venv", "node_modules", "test-output", "__pycache__", ".."} for p in parts):
            raise ValueError("INVALID_RELEASE_ENTRY")
        data = tree.extractfile(entry).read()
        manifest[name] = hashlib.sha256(data).hexdigest()
        out.writestr(name, data)
    release = "linux-" + commit[:12]
    out.writestr("release-manifest.json", json.dumps({"release": release, "commit": commit, "files": manifest}, indent=2))
receipt = {"release": release, "commit": commit, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "files": len(manifest)}
(target / "release.json").write_text(json.dumps(receipt), encoding="utf-8")
print(json.dumps(receipt))
