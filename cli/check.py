#!/usr/bin/env python3
"""Run the installed native package journey and remove its disposable files."""
import platform
from pathlib import Path
import shutil
import subprocess
import tempfile

target = {('Linux', 'x86_64'): 'linux-amd64', ('Linux', 'aarch64'): 'linux-arm64',
          ('Darwin', 'arm64'): 'darwin-arm64'}.get((platform.system(), platform.machine()))
if target is None:
    raise SystemExit('Use the ordinary-user Windows acceptance script on Windows.')
with tempfile.TemporaryDirectory(prefix='obsync-package-check-') as temporary:
    root = Path(temporary).resolve()
    binary = root / 'build-input'
    shutil.copyfile('target/release/obsync', binary)
    subprocess.run(['python3', 'cli/build.py', '--binary', str(binary),
                    '--platform', target, '--output', str(root / 'package')], check=True)
    subprocess.run(['python3', 'scripts/ci/cli-native.py', '--package', str(root / 'package'),
                    '--root', str(root), '--receipt', str(root / 'result.json')], check=True)
