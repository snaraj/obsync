#!/usr/bin/env python3
"""Prepare an unpaired, synthetic iPhone bundle; never starts a listener."""
import argparse
import hashlib
import io
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import zipfile

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--source', type=Path, required=True)
p.add_argument('--run', type=Path, required=True)
a = p.parse_args()
source = a.source.resolve(strict=True)
run = a.run.resolve()
head = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
if subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain']):
    raise SystemExit('source must be clean')
if run.exists() or source == run or source in run.parents:
    raise SystemExit('run must be a new external directory')
os.umask(0o077)
files = {}
for name in ('main.js', 'manifest.json', 'styles.css'):
    path = source / 'plugin/dist' / name
    if path.is_symlink() or not path.is_file():
        raise SystemExit('required regular plugin artifact missing')
    files[name] = path.read_bytes()
manifest = json.loads(files['manifest.json'])
version = (source / 'VERSION').read_text().strip()
if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version) or manifest['id'] != 'obsync-private-sync' or manifest['version'] != version:
    raise SystemExit('unexpected candidate manifest')
vault = 'Obsync-Phone-Validation-' + version.replace('.', '-')
prefix = vault + '/.obsidian/plugins/obsync-private-sync/'
entries = {prefix + name: body for name, body in files.items()}
entries[vault + '/.obsidian/community-plugins.json'] = b'["obsync-private-sync"]\n'
entries[vault + '/Phone-sentinel.md'] = b'# Phone validation\n\nSynthetic phone note.\n'
archive = run / (vault + '.zip')
output = io.BytesIO()
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for name, body in sorted(entries.items()):
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.external_attr = 0o100600 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, body)
payload = output.getvalue()
with zipfile.ZipFile(io.BytesIO(payload)) as z:
    if len(z.namelist()) != len(entries) or set(z.namelist()) != set(entries):
        raise SystemExit('archive members mismatch')
    if any(z.read(name) != body for name, body in entries.items()):
        raise SystemExit('archive bytes mismatch')
binary = source / 'target/release/obsyncd'
if binary.is_symlink() or not binary.is_file():
    raise SystemExit('required regular server artifact missing')
receipt = {
    'sourceHead': head, 'sourceClean': True, 'candidateVersion': version, 'fixtureVault': vault,
    'pluginHashes': {name: hashlib.sha256(body).hexdigest() for name, body in files.items()},
    'zipSha256': hashlib.sha256(payload).hexdigest(),
    'zipMembers': sorted(entries), 'zipRoundTrip': 'PASS',
    'serverSha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
    'serverCopyVerified': False,
    'credentialsIncluded': False, 'endpointConfigured': False,
    'listenersStarted': False, 'phoneInstalled': False,
}
run.mkdir(parents=True, mode=0o700)
try:
    archive.write_bytes(payload)
    shutil.copy2(binary, run / 'obsyncd')
    receipt['serverCopyVerified'] = hashlib.sha256((run / 'obsyncd').read_bytes()).hexdigest() == receipt['serverSha256']
    if not receipt['serverCopyVerified']:
        raise ValueError('server changed while copying')
    (run / 'preflight.json').write_text(json.dumps(receipt, indent=2) + '\n')
except BaseException:
    if not run.is_symlink():
        shutil.rmtree(run)
    raise
print(json.dumps(receipt, indent=2))
