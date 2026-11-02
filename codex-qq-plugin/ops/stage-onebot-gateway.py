"""Stage a pinned NapCat AppImage on Ubuntu. Never logs a QQ account in."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import struct
import subprocess
import sys

VERSION = "v4.18.42"
EXPECTED = "7fdab02ed69650ff525e6708648656ca5d891fc05b1d7353998cddd91286b5d6"
SIZE = 314270912
ASSET = "QQ-53644_NapCat-v4.18.42-amd64.AppImage"
URL = "https://github.com/NapNeko/NapCatAppImageBuild/releases/download/" + VERSION + "/" + ASSET
DOWNLOAD = Path("/var/cache/alex-qq-fetch/NapCat.AppImage.part")
ROOT = Path("/opt/alex-qq-gateway")
RELEASE = ROOT / "releases" / VERSION


def digest(file):
    with file.open("rb") as stream:
        h = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def stage():
    if not DOWNLOAD.is_file() or DOWNLOAD.stat().st_size != SIZE or digest(DOWNLOAD) != EXPECTED:
        raise ValueError("GATEWAY_DOWNLOAD_INCOMPLETE_OR_INVALID")
    if RELEASE.exists():
        if (RELEASE / ".upstream-sha256").read_text().strip() != EXPECTED:
            raise ValueError("EXISTING_RELEASE_MISMATCH")
        return
    packages = ROOT / "packages"
    packages.mkdir(parents=True, exist_ok=True)
    (ROOT / "releases").mkdir(exist_ok=True)
    image = packages / ASSET
    shutil.copyfile(DOWNLOAD, image)
    image.chmod(0o644)
    if digest(image) != EXPECTED:
        raise ValueError("GATEWAY_COPY_INVALID")
    # Find the SquashFS 4.0 superblock without running the downloaded ELF as root.
    with image.open("rb") as stream:
        header = stream.read(4 * 1024 * 1024)
    offset = header.find(b"hsqs")
    while offset >= 0 and struct.unpack_from("<HH", header, offset+28) != (4, 0):
        offset = header.find(b"hsqs", offset+1)
    if offset < 0:
        raise ValueError("SQUASHFS_HEADER_MISSING")
    build = Path("/var/cache/alex-qq-build") / VERSION
    if build.exists():
        raise ValueError("INSPECT_PREVIOUS_PARTIAL_EXTRACTION")
    subprocess.run(["systemd-run", "--quiet", "--wait", "--pipe", "--collect", "-p", "DynamicUser=yes",
                    "-p", "CacheDirectory=alex-qq-build", "-p", "ProtectSystem=strict", "-p", "ProtectHome=yes",
                    "-p", "NoNewPrivileges=yes", "-p", "PrivateNetwork=yes", "-p", "MemoryMax=192M", "-p", "Nice=10",
                    "/usr/bin/unsquashfs", "-no-progress", "-no-xattrs", "-processors", "1", "-data-queue", "16",
                    "-frag-queue", "8", "-offset", str(offset), "-d", str(build), str(image)], check=True)
    if not all((build / n).is_file() for n in ["qq", "AppRun", "napcat/napcat.mjs", "resources/app/loadNapCat.js"]):
        raise ValueError("UNEXPECTED_GATEWAY_LAYOUT")
    candidate = RELEASE.with_name(VERSION + ".stage")
    if candidate.exists():
        raise ValueError("INSPECT_PREVIOUS_STAGING_DIRECTORY")
    shutil.copytree(build, candidate, symlinks=True)
    for f in candidate.rglob("*"):
        if not f.is_symlink():
            f.chmod(0o755 if f.is_dir() or f.stat().st_mode & 0o111 else 0o644)
    (candidate / ".upstream-sha256").write_text(EXPECTED + "\n")
    candidate.rename(RELEASE)


def prepare_account():
    try:
        user = pwd.getpwnam("alexqqgw")
    except KeyError:
        subprocess.run(["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/var/lib/alexqqgw",
                        "--shell", "/usr/sbin/nologin", "alexqqgw"], check=True)
        user = pwd.getpwnam("alexqqgw")
    if user.pw_dir != "/var/lib/alexqqgw" or user.pw_shell != "/usr/sbin/nologin":
        raise ValueError("GATEWAY_ACCOUNT_COLLISION")
    work = Path(user.pw_dir)
    work.mkdir(mode=0o700, exist_ok=True)
    os.chown(work, user.pw_uid, user.pw_gid)
    work.chmod(0o700)


if __name__ == "__main__":
    if sys.argv[1:] == ["fetch"]:
        subprocess.run(["systemd-run", "--quiet", "--collect", "-p", "DynamicUser=yes", "-p", "CacheDirectory=alex-qq-fetch",
                        "-p", "ProtectSystem=strict", "-p", "ProtectHome=yes", "-p", "NoNewPrivileges=yes",
                        "-p", "MemoryMax=64M", "-p", "UMask=0077", "/usr/bin/curl", "--fail", "--silent", "--show-error",
                        "--location", "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "15", "--max-time",
                        "3600", "--continue-at", "-", "-o", str(DOWNLOAD), URL], check=True)
    elif sys.argv[1:] == ["stage"]:
        os.umask(0o022)
        stage()
        prepare_account()
        print(json.dumps({"release": VERSION, "sha256": EXPECTED, "staged": True, "started": False}))
    else:
        raise SystemExit("Use fetch or stage")
