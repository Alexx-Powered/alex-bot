"""Stage a Git-built application and its verified private weather runtimes on the existing ECS."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import zipfile

from map_review import digest, require_map_review


ROOT = Path('/opt/alex-bot')
CURRENT = ROOT / 'current'
RUNTIMES = ('.ifs-runtime', '.pm25-runtime')


def stage(archive, expected_commit, *, link_runtime=False):
    releases = ROOT / 'releases'
    releases.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as package:
        manifest = json.loads(package.read('release-manifest.json'))
        release, commit = manifest['release'], manifest['commit']
        if not re.fullmatch(r'linux-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*', release):
            raise ValueError('INVALID_RELEASE')
        if not re.fullmatch(r'[a-f0-9]{40}', commit) or (expected_commit and commit != expected_commit):
            raise ValueError('COMMIT_MISMATCH')
        source = manifest['files']
        names = package.namelist()
        if len(names) != len(source) + 1 or set(names) != set(source) | {'release-manifest.json'}:
            raise ValueError('ARCHIVE_INVENTORY_MISMATCH')
        target = releases / release
        with tempfile.TemporaryDirectory(dir=releases) as scratch:
            root = Path(scratch) / release
            for name, checksum in source.items():
                path = PurePosixPath(name)
                if path.parts[:1] != ('codex-qq-plugin',) or '..' in path.parts or str(path) != name:
                    raise ValueError('INVALID_SOURCE_PATH')
                dest = root / path
                dest.parent.mkdir(parents=True, exist_ok=True)
                with package.open(name) as reader, dest.open('xb') as writer:
                    shutil.copyfileobj(reader, writer)
                if digest(dest) != checksum:
                    raise ValueError('SOURCE_HASH_MISMATCH')
                dest.chmod(0o644)
            carried = {}
            if CURRENT.is_dir():
                previous = json.loads((CURRENT / 'release-manifest.json').read_bytes())
                for runtime in RUNTIMES:
                    prefix = 'codex-qq-plugin/python/' + runtime + '/'
                    for name, checksum in previous['files'].items():
                        if not name.startswith(prefix):
                            continue
                        original = CURRENT / name
                        if '..' in PurePosixPath(name).parts or not original.resolve().is_relative_to(CURRENT.resolve()):
                            raise ValueError('INVALID_RUNTIME_PATH')
                        dest = root / name
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        if link_runtime:
                            # Both releases are root-owned. The service cannot modify a shared inode.
                            metadata = original.lstat()
                            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
                                    or metadata.st_mode & 0o7022):
                                raise ValueError('RUNTIME_NOT_SHAREABLE')
                            os.link(original, dest, follow_symlinks=False)
                        else:
                            with original.open('rb') as reader, dest.open('xb') as writer:
                                shutil.copyfileobj(reader, writer)
                            dest.chmod(original.stat().st_mode & 0o755)
                        if digest(dest) != checksum:
                            raise ValueError('RUNTIME_HASH_MISMATCH')
                        carried[name] = checksum
            manifest['files'] = {**source, **carried}
            manifest['runtimeFiles'] = len(carried)
            receipt = root / 'release-manifest.json'
            receipt.write_text(json.dumps(manifest, indent=2))
            receipt.chmod(0o644)
            root.chmod(0o755)
            for directory in root.rglob('*'):
                if directory.is_dir():
                    directory.chmod(0o755)
            modules = root / 'codex-qq-plugin/node_modules'
            modules.symlink_to('/opt/alex-bot-runtime/node/node_modules', target_is_directory=True)
            if target.exists():
                stored = json.loads((target / 'release-manifest.json').read_bytes())
                if stored != manifest or any(digest(target / k) != v for k, v in stored['files'].items()):
                    raise ValueError('EXISTING_RELEASE_MISMATCH')
            else:
                root.rename(target)
    return target, commit


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path, default=Path('/tmp/alex-release.zip'))
    parser.add_argument('--expected-commit')
    parser.add_argument('--stage-only', action='store_true')
    parser.add_argument('--link-runtime', action='store_true',
                        help='Hard-link verified root-owned runtime files on the same filesystem.')
    args = parser.parse_args()
    target, commit = stage(args.archive, args.expected_commit, link_runtime=args.link_runtime)
    if not args.stage_only:
        require_map_review(target / 'codex-qq-plugin', CURRENT / 'codex-qq-plugin')
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            link = Path(directory) / 'current'
            link.symlink_to(target, target_is_directory=True)
            os.replace(link, CURRENT)
    print(json.dumps({'release':target.name, 'commit':commit, 'source_verified':True,
                      'activated':not args.stage_only, 'started':False}))


if __name__ == '__main__':
    main()
