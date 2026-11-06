"""Export the public README and its explicit asset allowlist; never copy source history."""
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit
import argparse
import hashlib
import json
import re

PRIVATE_START = '<!-- public-readme:private:start -->'
PRIVATE_END = '<!-- public-readme:private:end -->'
ASSETS = (
    'codex-qq-plugin/public/logo.png',
    'docs/images/weather.webp',
    'docs/images/weather-summary.webp',
    'docs/images/forecast-video.webp',
    'docs/images/providers.webp',
    'docs/images/console.webp',
    'docs/images/help.webp',
    'docs/public-assets.md',
)
MANIFEST = '.public-readme-sync.json'


def public_text(source):
    lines = []
    private = False
    sections = 0
    for line in source.splitlines():
        if line.strip() == PRIVATE_START:
            if private:
                raise ValueError('nested private section')
            private = True
            sections += 1
        elif line.strip() == PRIVATE_END:
            if not private:
                raise ValueError('unmatched private section end')
            private = False
        elif 'public-readme:private:' in line:
            raise ValueError('private markers must occupy a complete line')
        elif not private:
            lines.append(line)
    if private or sections < 3:
        raise ValueError('missing or unclosed private sections')
    return re.sub(r'\n{3,}', '\n\n', '\n'.join(lines)).strip() + '\n'


def validate_text(text, name, allowed):
    forbidden = [r'-----BEGIN .*PRIVATE KEY-----', r'\b(?:sk-|lsv2_pt_)[A-Za-z0-9_-]{24,}',
                 r'\bAKIA[A-Z0-9]{16}\b', r'(?i)(?:access_token|api_key|token)=[A-Za-z0-9_-]{20,}',
                 r'(?i)[A-Z]:[\\/](?:Users|Projects)\b', r'/var/lib/alexbot', r'/opt/alex-bot',
                 r'HANDOVER\.md', r'生活费', r'living_cost_budget',
                 r'https://github\.com/Alexx-Powered/alex-bot(?:/|#|\s|\)|$)']
    if any(re.search(pattern, text) for pattern in forbidden):
        raise ValueError('private material in ' + name)
    links = re.findall(r'\]\(([^\s)]+)(?:\s+"[^"]*")?\)|(?:src|href)="([^"]+)"', text)
    for markdown, html in links:
        href = markdown or html
        parts = urlsplit(href)
        if parts.scheme:
            if parts.scheme != 'https' or parts.username or parts.password:
                raise ValueError('unsupported external link in ' + name)
            continue
        if not parts.path:
            continue
        target = PurePosixPath(name).parent / unquote(parts.path)
        if parts.netloc or target.is_absolute() or '..' in target.parts or str(target) not in allowed:
            raise ValueError('unexported relative link in ' + name + ': ' + href)


def build_files(root):
    root = Path(root).resolve()
    def read(name):
        path = root / name
        if path.is_symlink() or not path.resolve().is_relative_to(root) or not path.is_file():
            raise ValueError('invalid export input: ' + name)
        return path.read_bytes()
    files = {'README.md': public_text(read('README.md').decode('utf-8-sig')).encode('utf-8')}
    files.update((name, read(name)) for name in ASSETS)
    allowed = set(files)
    for name, data in files.items():
        if name.endswith('.md'):
            validate_text(data.decode('utf-8-sig'), name, allowed)
    files[MANIFEST] = (json.dumps({'version': 1, 'files': {
        name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())
    }}, indent=2) + '\n').encode()
    return files


def export(root, destination):
    root, destination = Path(root).resolve(), Path(destination).resolve()
    if destination == root or root.is_relative_to(destination):
        raise ValueError('destination would overwrite the source repository')
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('export requires an empty destination')
    files = build_files(root)
    for name, data in files.items():
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return files


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    files = export(args.root, args.output)
    print(json.dumps({'files': len(files), 'bytes': sum(map(len, files.values()))}))
