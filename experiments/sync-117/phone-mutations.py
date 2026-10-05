#!/usr/bin/env python3
"""Prove phone-fixture refusals fail their tests when removed. No native launch."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--source', type=Path, required=True)
p.add_argument('--preflight', type=Path, required=True)
p.add_argument('--receipt', type=Path, required=True)
a = p.parse_args()
env = {**os.environ, 'OBSYNC_LAB_SOURCE': str(a.source.resolve()),
       'OBSYNC_PHONE_PREFLIGHT': str(a.preflight.resolve())}
files = {name: (ROOT / name).read_text() for name in ('phone-session.py', 'phone-preflight.py')}
mutations = [
    ('manifest-version', 'phone-preflight.py', "if not re.fullmatch(r'[0-9]+\\.[0-9]+\\.[0-9]+', version) or manifest['id'] != 'obsync-private-sync' or manifest['version'] != version:", 'if False:', 'candidate_version_mismatch_leaves_no_preflight'),
    ('copy-integrity', 'phone-preflight.py', "if not receipt['serverCopyVerified']:", 'if False:', 'changed_server_copy_removes_prepared_fixture'),
    ('copy-cleanup', 'phone-preflight.py', 'shutil.rmtree(run)', 'pass', 'copy_failure_removes_prepared_fixture'),
    ('source-head', 'phone-session.py', "if facts['sourceHead'] != head or subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain']):", 'if False:', 'stale_source_refused_before_runtime'),
    ('artifact-hash', 'phone-session.py', "if binary.is_symlink() or archive.is_symlink() or sha(binary.read_bytes()) != facts['serverSha256'] or sha(archive.read_bytes()) != facts['zipSha256']:", 'if False:', 'corrupt_server_refused_before_runtime'),
    ('fixture-name', 'phone-session.py', "if not re.fullmatch(r'Obsync-Phone-Validation-[0-9]+-[0-9]+-[0-9]+', vault):", 'if False:', 'foreign_fixture_name_refused_before_runtime'),
    ('artifact-names', 'phone-session.py', "if set(facts['pluginHashes']) != {'main.js', 'manifest.json', 'styles.css'}:", 'if False:', 'foreign_plugin_name_refused_before_inputs'),
    ('plugin-hash', 'phone-session.py', 'if sha(body) != digest:', 'if False:', 'wrong_plugin_hash_removes_partial_inputs'),
    ('partial-cleanup', 'phone-session.py', 'shutil.rmtree(inputs)', 'pass', 'wrong_plugin_hash_removes_partial_inputs'),
    ('expiry', 'phone-session.py', 'if deadline is not None and time.monotonic() >= deadline:', 'if False:', 'expiry_terminates_owned_child_without_main_driver'),
    ('preparation-deadline', 'phone-session.py', 'deadline is not None and time.monotonic()', 'time.monotonic()', 'no_deadline_does_not_expire_preparation'),
]
results = []
try:
    for name, filename, old, new, test in mutations:
        original = files[filename]
        if old not in original:
            raise RuntimeError('mutation anchor missing: ' + name)
        changed = original.replace(old, new)
        # Crossing a deleted launch refusal must never start apps or listeners.
        if filename == 'phone-session.py':
            anchor = '        lab.up(SimpleNamespace('
            if changed.count(anchor) != 1:
                raise RuntimeError('native launch interception missing')
            changed = changed.replace(anchor, "        raise RuntimeError('mutation crossed validation')\n" + anchor)
        path = ROOT / filename
        path.write_text(changed)
        try:
            result = subprocess.run([sys.executable, '-B', '-m', 'unittest', '-q',
                'test_phone_preflight.PreflightTests.test_' + test], cwd=ROOT,
                env=env, capture_output=True, text=True, timeout=20)
            killed = result.returncode == 1 and ('FAIL:' in result.stderr or 'ERROR:' in result.stderr)
            results.append({'mutation': name, 'test': test, 'killed': killed})
        finally:
            path.write_text(original)
finally:
    for name, body in files.items():
        if (ROOT / name).read_text() != body:
            raise RuntimeError('source restoration failed: ' + name)
receipt = {'result': 'PASS' if all(r['killed'] for r in results) else 'FAIL',
           'nativeLaunchIntercepted': True, 'sourceRestored': True, 'mutations': results}
with a.receipt.open('x') as output:
    json.dump(receipt, output, indent=2)
    output.write('\n')
print(json.dumps(receipt))
sys.exit(0 if receipt['result'] == 'PASS' else 1)
