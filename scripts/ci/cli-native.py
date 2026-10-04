#!/usr/bin/env python3
"""Public packaged CLI journey with independent state and inventory readback."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import tempfile
import time


def startup_result(samples):
    assert len(samples) == 35
    assert max(samples[:5]) < 1000, ('cold launch', samples[:5])
    warm = sorted(samples[5:])
    assert warm[28] < 250, ('warm p95', warm[28])
    return {'first_five_ms': samples[:5], 'warm_p95_ms': warm[28], 'warm_median_ms': statistics.median(warm)}


def journey(package, root, trust=()):
    binary = 'obsync.exe' if os.name == 'nt' else 'obsync'
    package = package.resolve()
    config, installed, second = root / 'config', root / 'installed', root / 'second'
    digest = hashlib.sha256((package / 'package-manifest.json').read_bytes()).hexdigest()
    result = {'commands': 0, 'platform': json.loads((package / 'package-manifest.json').read_text())['platform'],
              'manifest_sha256': digest, 'binary_sha256': hashlib.sha256((package / binary).read_bytes()).hexdigest()}

    def run(args, code=0, exe=None, human=False):
        started = time.monotonic_ns()
        proc = subprocess.run([str(exe or installed / binary), *args, *trust,
                               *([] if human else ['-o', 'json'])], env={}, capture_output=True, timeout=8)
        elapsed = (time.monotonic_ns() - started) / 1e6
        assert proc.returncode == code, (args[0], proc.returncode, proc.stdout.decode(errors='replace'),
                                         proc.stderr.decode(errors='replace'))
        assert not proc.stderr and len(proc.stdout) <= 65536
        result['commands'] += 1
        return (proc.stdout.decode() if human else json.loads(proc.stdout)), elapsed

    def context(args, code=0):
        return run([*args, '--config-dir', str(config)], code)[0]

    def plan(args):
        p = context(args)['data']['plan']
        path = root / 'plan.json'
        path.write_text(json.dumps(p))
        return p, ['apply', '-f', str(path), '--expect-digest', p['digest']]

    def stored():
        return {p.name:p.read_bytes() for p in config.iterdir()}

    def disk():
        states = []
        for slot in (0, 1):
            p = config / f'contexts.{slot}'
            if not p.exists():
                continue
            b = p.read_bytes()
            if not b:
                continue
            start = len(b'OBSYNC-CONTEXT-1\n')
            assert b.startswith(b'OBSYNC-CONTEXT-1\n')
            n = int.from_bytes(b[start:start+4], 'big')
            end = start + 4 + n
            assert len(b) == end + 32 and hashlib.sha256(b[:end]).digest() == b[end:]
            state = json.loads(b[start+4:end])
            assert state['revision'] % 2 == slot
            states.append(state)
        return max(states, key=lambda s:s['revision'])

    binding = ['--from', str(package), '--prefix', str(installed), '--manifest-sha256', digest]
    if os.name == 'nt':
        original_trust = trust
        receipt = Path(trust[1])
        original_receipt = receipt.read_bytes()
        wrong = root / 'powershell.json'
        assert not wrong.exists() and not wrong.is_symlink()
        try:
            trust = [*original_trust[:-1], '0' * 64]
            refused, _ = run(['get', 'contexts', '--config-dir', str(config)], 4, exe=package / binary)
            assert refused['error']['code'] == 'windows_trust_digest' and not config.exists()
            forged = json.loads(original_receipt)
            forged['directory'] = str(root)
            forged['powershell']['sha256'] = '0' * 64
            raw = json.dumps(forged, separators=(',', ':')).encode()
            wrong.write_bytes(raw)
            trust = ['--windows-trust', str(wrong), '--windows-trust-sha256', hashlib.sha256(raw).hexdigest()]
            refused, _ = run(['get', 'contexts', '--config-dir', str(config)], 4, exe=package / binary)
            assert refused['error']['code'] == 'windows_trust_executable' and not config.exists()
            assert wrong.read_bytes() == raw and receipt.read_bytes() == original_receipt
        finally:
            trust = original_trust
            if wrong.exists():
                wrong.unlink()
        companion = root / 'installed.pending.obsync-create'
        companion.mkdir()
        sentinel = companion / 'sentinel'
        sentinel.write_bytes(b'synthetic interrupted creation')
        refused, _ = run(['install', *binding], 4, exe=package / binary)
        assert refused['error']['code'] == 'stage_not_empty' and not installed.exists()
        assert set(p.name for p in companion.iterdir()) == {'sentinel'}
        assert sentinel.read_bytes() == b'synthetic interrupted creation'
        sentinel.unlink()
        # The following public install must recover this exact empty companion.
    message, _ = run(['install', *binding], exe=package / binary, human=True)
    assert message.startswith('obsync ') and 'installed and verified.' in message and not message.startswith('{')
    expected = set(p.name for p in package.iterdir())
    assert {p.name for p in installed.iterdir()} == expected
    for p in package.iterdir():
        assert p.read_bytes() == (installed / p.name).read_bytes()
    assert run(['version'])[0]['data']['platform'] == result['platform']
    help_text, _ = run(['config', 'set-context', '--help'], human=True)
    assert 'Usage:' in help_text and '--server' in help_text
    context(['get', 'contexts'])
    p, apply = plan(['config', 'set-context', 'lab', '--server', 'https://example.invalid'])
    assert not config.exists()
    context(apply)
    previous = disk()
    assert previous['revision'] == 1 and len(previous['contexts']) == 1 and len(previous['receipts']) == 1
    before = stored()
    assert context(apply)['data']['replayed'] is True
    assert before == stored()
    p, apply = plan(['config', 'use-context', 'lab'])
    # Race the initialized configuration under the same contract as the POSIX suite.
    children, codes = [], []
    deadline = time.monotonic() + 8
    try:
        for _ in range(2):
            children.append(subprocess.Popen([str(installed / binary), *apply, '--config-dir', str(config),
                                              *trust, '-o', 'json'], env={}, stdout=subprocess.PIPE,
                                             stderr=subprocess.PIPE))
        for child in children:
            out, err = child.communicate(timeout=max(0.001, deadline - time.monotonic()))
            assert child.returncode in (0, 5), ('concurrent apply', child.returncode, out, err)
            assert not err and len(out) <= 65536 and json.loads(out)['schema_version'] == 1
            codes.append(child.returncode)
            result['commands'] += 1
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=2)
    assert 0 in codes
    assert context(apply)['data']['replayed'] is True
    current, _ = run(['config', 'current-context', '--config-dir', str(config)], human=True)
    assert current == 'lab\n' or current == 'lab\r\n'
    state = disk()
    assert state['revision'] == 2 and state['current'] == 'lab' and len(state['receipts']) == 2
    before = stored()
    # Construct the body-before-seal boundary; this models process interruption,
    # not physical power loss. Recovery must retain the independently read state.
    slot = config / 'contexts.0'
    with slot.open('r+b') as stream:
        stream.truncate(len(before[slot.name]) - 32)
        stream.flush()
        os.fsync(stream.fileno())
    partial = stored()
    context(['doctor'], 10)
    context(apply, 10)
    assert stored() == partial
    assert context(['config', 'recover'])['data']['revision'] == 1
    assert disk() == previous and slot.read_bytes() == b''
    context(apply)
    assert stored() == before
    context([*apply[:-1], '0' * 64], 5)
    assert before == stored()
    link = root / 'context-slot-link'
    os.link(config / 'contexts.1', link)
    try:
        context(['doctor'], 4)
        assert stored() == before and link.read_bytes() == before['contexts.1']
    finally:
        link.unlink()
    context(['doctor'])
    # Two immutable installations. Changing the selected executable is explicit.
    second_binding = ['--from', str(package), '--prefix', str(second), '--manifest-sha256', digest]
    run(['install', *second_binding], exe=package / binary)
    run(['get', 'contexts', '--config-dir', str(config)], exe=second / binary)
    message, _ = run(['uninstall', *binding], exe=package / binary, human=True)
    assert 'uninstalled.' in message and 'Configuration preserved.' in message
    assert not installed.exists() and not Path(str(installed)+'.removing').exists()
    run(['doctor', '--config-dir', str(config)], exe=second / binary)
    assert before == stored()
    timings = {}
    for name, args in [('help',['help']),('schema',['schema','context.add']),('search',['cli','search','context'])]:
        samples = [run(args, exe=second / binary)[1] for _ in range(35)]
        timings[name] = startup_result(samples)
    run(['uninstall', *second_binding], exe=package / binary)
    assert not second.exists() and before == stored()
    result.update(result='PASS', revision=state['revision'], receipts=len(state['receipts']),
                  contexts_preserved=True, concurrent_apply_exit_codes=sorted(codes),
                  recovery_preserved_previous_state=True, hardlink_refused=True, timings=timings)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--root', type=Path)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--windows-trust')
    parser.add_argument('--windows-trust-sha256')
    args = parser.parse_args()
    if os.name != 'nt' and (os.getuid() == 0 or os.getuid() != os.geteuid()):
        raise SystemExit('Ordinary user required.')
    trust = []
    if os.name == 'nt':
        if not args.root or not args.windows_trust or not args.windows_trust_sha256:
            raise SystemExit('Windows requires an independently prepared private root and OS trust receipt.')
        trust = ['--windows-trust', args.windows_trust, '--windows-trust-sha256', args.windows_trust_sha256]
    root = args.root.resolve() if os.name == 'nt' else Path(tempfile.mkdtemp(prefix='obsync-native-', dir=args.root)).resolve()
    try:
        outcome = journey(args.package, root, trust)
        args.receipt.write_text(json.dumps(outcome, indent=2)+'\n')
        print(json.dumps({'event':'cli_native_journey', **outcome}))
    finally:
        if os.name != 'nt':
            shutil.rmtree(root)
