#!/usr/bin/env python3
"""Build tooling only: package an already-built native binary without fetching."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts/ci'))
from cli_package_contract import CLI_MAX_BYTES, CLI_PLATFORMS, cli_files, member_mode


def build(binary, platform, output, release_source=None):
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if release_source:
        dirty = subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT)
        if head != release_source or dirty:
            raise ValueError('Release packaging requires the exact clean source commit.')
    if len(head) != 40 or any(c not in '0123456789abcdef' for c in head):
        raise ValueError('Exact source commit required.')
    if output.exists() or output.is_symlink():
        raise ValueError('Use a new, absent build directory.')
    sources = {'LICENSE': ROOT / 'LICENSE', 'README.md': ROOT / 'cli/README.md',
               'VERSION': ROOT / 'VERSION', 'obsync.exe' if platform == 'windows-amd64' else 'obsync': binary}
    content = {}
    for name in cli_files(platform):
        source = sources[name]
        info = source.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= CLI_MAX_BYTES:
            raise ValueError('Package input must be a bounded single-link regular file.')
        content[name] = source.read_bytes()
    if sum(map(len, content.values())) > CLI_MAX_BYTES:
        raise ValueError('Package byte budget exceeded.')
    manifest = {'schema_version': 2, 'version': content['VERSION'].decode().strip(), 'platform': platform,
                'source_sha': head, 'candidate': release_source is None,
                'files': [{'name': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                          for name, data in sorted(content.items())]}
    raw = (json.dumps(manifest, separators=(',', ':')) + '\n').encode()
    content['package-manifest.json'] = raw
    output.mkdir(mode=0o700)
    try:
        for name, data in content.items():
            target = output / name
            with target.open('xb') as stream:
                stream.write(data)
            target.chmod(member_mode(name))
        return {'event': 'cli_package_built', 'platform': platform, 'candidate': manifest['candidate'],
                'source_sha': head, 'manifest_sha256': hashlib.sha256(raw).hexdigest(),
                'binary_sha256': next(f['sha256'] for f in manifest['files'] if f['name'] in ('obsync', 'obsync.exe'))}
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--platform', choices=CLI_PLATFORMS, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--release-source')
    args = parser.parse_args()
    print(json.dumps(build(args.binary, args.platform, args.output, args.release_source)))
