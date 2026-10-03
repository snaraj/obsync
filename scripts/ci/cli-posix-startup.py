"""Measure actual installed processes; native CI supplies the trusted OS/runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

if sys.platform not in ('darwin', 'linux'):
    raise SystemExit('POSIX native runner required.')
parser = argparse.ArgumentParser()
parser.add_argument('--runtime', type=Path, required=True)
arguments = parser.parse_args()
source = Path(__file__).resolve().parents[2] / 'cli/dist'
digest = hashlib.sha256((source / 'package-manifest.json').read_bytes()).hexdigest()
receipt = dict(event='cli_installed_startup', platform=sys.platform,
               manifest_sha256=digest, load_at_start=os.getloadavg(), results={},
               method='35 fresh processes per command; first five separate; OS caches not purged',
               cleanup='pending')
with tempfile.TemporaryDirectory(prefix='obsync-cli-startup-') as temporary:
    root = Path(temporary).resolve()
    runtime, prefix = root / 'trusted-node', root / 'installed'
    shutil.copyfile(arguments.runtime.resolve(strict=True), runtime)
    runtime.chmod(0o700)
    receipt['runtime_sha256'] = hashlib.sha256(runtime.read_bytes()).hexdigest()
    environment = {'HOME': str(root), 'PATH': '/usr/bin:/bin'}

    def command(argv, timeout):
        result = subprocess.run([str(x) for x in argv], env=environment,
                                capture_output=True, text=True, timeout=timeout)
        if result.returncode != 0 or result.stderr:
            raise RuntimeError('Native installed command refused.')
        json.loads(result.stdout)

    def installation(mode):
        command([runtime, source / 'cli/install.mjs', mode, '--prefix', prefix,
                 '--manifest-sha256', digest], 30)

    try:
        installation('install')
        for name, arguments in [('help', ['help']), ('schema', ['schema', 'context.add']),
                                ('search', ['cli', 'search', 'context'])]:
            samples = []
            for _ in range(35):
                start = time.perf_counter()
                command([prefix / 'obsync', *arguments], 10)
                samples.append(round((time.perf_counter() - start) * 1000, 3))
            p95, cold = sorted(samples[5:])[28], max(samples[:5])
            receipt['results'][name] = dict(samples_ms=samples, warm_p95_ms=p95,
                                            initial_five_max_ms=cold,
                                            passed=p95 <= 250 and cold <= 1000)
    finally:
        try:
            installation('uninstall')
            if prefix.exists():
                raise RuntimeError('Public uninstall left the installation present.')
            receipt['cleanup'] = 'pass'
        finally:
            print(json.dumps(receipt))
if len(receipt['results']) != 3 or not all(r['passed'] for r in receipt['results'].values()):
    raise SystemExit('Installed CLI exceeded P01: warm p95 250 ms; initial launches 1000 ms.')
