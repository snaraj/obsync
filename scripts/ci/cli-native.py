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
import sys
import time


def startup_result(samples):
    assert len(samples) == 35
    assert max(samples[:5]) < 1000, ('cold launch', samples[:5])
    warm = sorted(samples[5:])
    assert warm[28] < 250, ('warm p95', warm[28])
    return {'samples_ms': samples, 'first_five_ms': samples[:5],
            'warm_p95_ms': warm[28], 'warm_median_ms': statistics.median(warm)}


def journey(package, root, trust=()):
    binary = 'obsync.exe' if os.name == 'nt' else 'obsync'
    package = package.resolve()
    config, installed, second = root / 'config', root / 'installed', root / 'second'
    digest = hashlib.sha256((package / 'package-manifest.json').read_bytes()).hexdigest()
    result = {'commands': 0, 'platform': json.loads((package / 'package-manifest.json').read_text())['platform'],
              'manifest_sha256': digest, 'binary_sha256': hashlib.sha256((package / binary).read_bytes()).hexdigest(),
              'clock': vars(time.get_clock_info('perf_counter'))}

    def run(args, code=0, exe=None, human=False, env=None):
        started = time.perf_counter_ns()
        proc = subprocess.run([str(exe or installed / binary), *args, *trust,
                               *([] if human else ['-o', 'json'])], env=env or {}, capture_output=True, timeout=8)
        elapsed = (time.perf_counter_ns() - started) / 1e6
        assert proc.returncode == code, (args[0], proc.returncode, proc.stdout.decode(errors='replace'),
                                         proc.stderr.decode(errors='replace'))
        stream, other = (proc.stderr, proc.stdout) if human and code else (proc.stdout, proc.stderr)
        assert not other and len(stream) <= 65536
        result['commands'] += 1
        return (stream.decode() if human else json.loads(stream)), elapsed

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

    def write_fixture_state(value, magic=b'OBSYNC-CONTEXT-1\n'):
        raw = json.dumps(value, separators=(',', ':')).encode()
        frame = magic + len(raw).to_bytes(4, 'big') + raw
        frame += hashlib.sha256(frame).digest()
        for number in (0, 1):
            (config / f'contexts.{number}').write_bytes(frame if number == value['revision'] % 2 else b'')

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
    # Seed valid sealed boundary states in this disposable fixture, then drive
    # the installed binary and independently inspect every resulting snapshot.
    try:
        capped = json.loads(json.dumps(state))
        capped['revision'] = 9007199254740991
        write_fixture_state(capped)
        context(['doctor'])
        _, boundary_apply = plan(['config', 'use-context', 'lab'])
        capped_bytes = stored()
        refusal = context(boundary_apply, 5)
        assert refusal['error']['code'] == 'revision_conflict' and stored() == capped_bytes

        saturated = json.loads(json.dumps(state))
        saturated['receipts'] = [dict(state['receipts'][-1], id=f'{n:032x}') for n in range(64)]
        write_fixture_state(saturated)
        context(['doctor'])
        _, capacity_apply = plan(['config', 'use-context', 'lab'])
        saturated_bytes = stored()
        refusal = context(capacity_apply, 9)
        assert refusal['error']['code'] == 'operation_capacity' and stored() == saturated_bytes

        expired_id = saturated['receipts'][0]['id']
        saturated['receipts'][0]['expires_at'] = 1
        survivors = saturated['receipts'][1:]
        write_fixture_state(saturated)
        context(['doctor'])
        replacement, replacement_apply = plan(['config', 'use-context', 'lab'])
        assert context(replacement_apply)['data']['replayed'] is False
        pruned = disk()
        assert pruned['revision'] == 3 and pruned['current'] == 'lab'
        assert pruned['contexts'] == state['contexts'] and len(pruned['receipts']) == 64
        assert pruned['receipts'][:-1] == survivors
        assert pruned['receipts'][-1]['id'] == replacement['id']
        assert all(r['id'] != expired_id for r in pruned['receipts'])
        pruned_bytes = stored()
        assert context(replacement_apply)['data']['replayed'] is True and stored() == pruned_bytes
        for field, value in [('id', 'g' * 32), ('digest', 'g' * 64),
                             ('operation', 'unknown'), ('name', 'Invalid'),
                             ('current', 'Invalid'), (None, None)]:
            malformed = json.loads(json.dumps(state))
            if field:
                malformed['receipts'][0][field] = value
            magic = b'OBSYNC-CONTEXT-1\n' if field else b'OBSYNC-CONTEXT-2\n'
            write_fixture_state(malformed, magic)
            malformed_bytes = stored()
            for args in (['doctor'], ['config', 'recover']):
                try:
                    refusal = context(args, 4)
                except AssertionError as error:
                    raise AssertionError(('sealed snapshot', field or 'magic')) from error
                assert refusal['error']['code'] == 'invalid_config'
                assert stored() == malformed_bytes
    finally:
        for number in (0, 1):
            (config / f'contexts.{number}').write_bytes(before[f'contexts.{number}'])
    assert stored() == before and disk() == state
    context(['doctor'])
    # Public human/default-path journey, still isolated under the owned fixture.
    key = 'APPDATA' if os.name == 'nt' else ('HOME' if sys.platform == 'darwin' else 'XDG_CONFIG_HOME')
    default_env = {key: str(root)}
    defaults = root / ('Library/Application Support/obsync' if sys.platform == 'darwin' else 'obsync')
    text, _ = run(['doctor'], human=True, env=default_env)
    assert 'No server yet.' in text and 'obsync config set-context' in text and not defaults.exists()
    planned, _ = run(['context', 'add', 'home', '--server', 'https://example.invalid'], env=default_env)
    assert planned['state'] == 'planned' and not defaults.exists()
    for extra in [[], ['--non-interactive'], ['--plan']]:
        text, _ = run(['context', 'add', 'home', '--server', 'https://example.invalid', *extra],
                      human=True, env=default_env)
        assert 'in 5 minutes' in text and 'Unix milliseconds' not in text and not defaults.exists()
    refused, _ = run(['doctor'], 4, env={key: 'relative-fixture'})
    assert refused['error']['code'] == 'unsafe_config' and not defaults.exists()
    text, _ = run(['context', 'add', 'home', '--server', 'https://example.invalid', '--yes'],
                  human=True, env=default_env)
    assert 'Added server "home".' in text and 'selected server' in text and 'Receipt:' not in text
    assert run(['context', 'current'], env=default_env)[0]['data']['context']['name'] == 'home'
    default_before = {p.name:p.read_bytes() for p in defaults.iterdir()}
    refused, _ = run(['context', 'add', 'work', '--server', 'https://example.invalid', '--yes', '--plan'],
                     2, env=default_env)
    assert refused['error']['code'] == 'invalid_input'
    assert default_before == {p.name:p.read_bytes() for p in defaults.iterdir()}
    run(['context', 'add', 'other', '--server', 'https://example.invalid', '--yes'], env=default_env)
    assert run(['context', 'current'], env=default_env)[0]['data']['context']['name'] == 'home'
    run(['context', 'remove', 'other', '--yes'], env=default_env)
    run(['context', 'add', 'work', '--server', 'https://example.invalid', '--use', '--yes'], env=default_env)
    assert run(['context', 'current'], env=default_env)[0]['data']['context']['name'] == 'work'
    run(['context', 'use', 'home', '--yes'], env=default_env)
    run(['context', 'remove', 'work', '--yes'], env=default_env)
    assert [v['name'] for v in run(['context', 'list'], env=default_env)[0]['data']['items']] == ['home']
    text, _ = run(['context', 'lsit'], 2, human=True)
    assert "Did you mean 'obsync context list'" in text
    text, _ = run(['context', 'add', 'bad', '--server', 'example.invalid', '--yes'], 2,
                  human=True, env=default_env)
    assert 'Add https://' in text
    text, _ = run(['help'], human=True)
    assert len(text.splitlines()) <= 16 and 'windows-trust' not in text
    assert 'install' in run(['help', '--all'], human=True)[0]
    table, _ = run(['cli', 'search', 'context'], human=True)
    entries = run(['cli', 'search', 'context'])[0]['data']['items']
    column = table.splitlines()[0].index('DESCRIPTION')
    for line, item in zip(table.splitlines()[1:], entries, strict=True):
        assert line[:column].rstrip() == item['command'] and line[column:] == item['summary']
    assert 'implemented_local' not in table
    if os.name != 'nt':
        # A real terminal exercises confirmation, cancellation and revalidation.
        import pty
        import select
        def terminal(args, answer, expected=0, during=None, prompt=True, piped=None):
            master, slave = pty.openpty()
            child = subprocess.Popen([str(installed / binary), *args], env=default_env,
                                     stdin=subprocess.PIPE if piped == 'input' else slave,
                                     stdout=subprocess.PIPE if piped == 'output' else slave, stderr=slave)
            os.close(slave)
            if piped == 'input':
                child.stdin.write(b'n\n')
                child.stdin.close()
            output, responded = bytearray(), False
            deadline = time.monotonic()+12
            try:
                while child.poll() is None or select.select([master], [], [], 0)[0]:
                    assert time.monotonic() < deadline and len(output) < 65536
                    if not select.select([master], [], [], 0.1)[0]:
                        continue
                    try:
                        part = os.read(master, 4096)
                    except OSError:
                        break
                    if not part:
                        break
                    output.extend(part)
                    if b'Apply? [y/N]' in output and not responded:
                        if during:
                            during()
                        os.write(master, answer)
                        responded = True
                assert child.wait(timeout=2) == expected, bytes(output)
                if piped == 'output':
                    output.extend(child.stdout.read(65536))
                    child.stdout.close()
                assert responded == prompt, bytes(output)
                result['commands'] += 1
                return output.decode()
            finally:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=2)
                os.close(master)
        snapshot = {p.name:p.read_bytes() for p in defaults.iterdir()}
        for flags in [['--plan'], ['--non-interactive'], ['-o', 'json'], ['-o', 'jsonl']]:
            text = terminal(['context', 'remove', 'home', *flags], b'n\n', prompt=False)
            assert 'plan' in text.lower() and snapshot == {p.name:p.read_bytes() for p in defaults.iterdir()}
        for piped in ['input', 'output']:
            text = terminal(['context', 'remove', 'home'], b'n\n', prompt=False, piped=piped)
            assert 'plan' in text.lower() and snapshot == {p.name:p.read_bytes() for p in defaults.iterdir()}
        assert 'Cancelled.' in terminal(['context', 'remove', 'home'], b'n\n')
        assert snapshot == {p.name:p.read_bytes() for p in defaults.iterdir()}
        # The person's thinking time does not consume execution time, but the
        # exact plan lifetime/revision still decides whether apply is permitted.
        assert 'Added server "terminal".' in terminal(
            ['context', 'add', 'terminal', '--server', 'https://example.invalid'], b'y\n',
            during=lambda:time.sleep(5.1))
        def competing_change():
            run(['context', 'use', 'terminal', '--yes'], env=default_env)
        text = terminal(['context', 'remove', 'home'], b'y\n', 5, competing_change)
        assert 'revision_conflict' in text
        assert len(run(['context', 'list'], env=default_env)[0]['data']['items']) == 2
    # Two independently verified installations preserve contexts.

    second_binding = ['--from', str(package), '--prefix', str(second), '--manifest-sha256', digest]
    run(['install', *second_binding], exe=package / binary)
    run(['get', 'contexts', '--config-dir', str(config)], exe=second / binary)
    message, _ = run(['uninstall', *binding], exe=package / binary, human=True)
    assert 'uninstalled.' in message and 'Configuration preserved.' in message
    assert not installed.exists() and not Path(str(installed)+'.removing').exists()
    run(['doctor', '--config-dir', str(config)], exe=second / binary)
    assert before == stored()
    # Replace package content at the SAME executable path only after complete
    # uninstall. This uses a distinct verified manifest, not a repeat of A.
    alternate = root / 'replacement-package'
    alternate_binding = ['--from', str(package), '--prefix', str(alternate), '--manifest-sha256', digest]
    run(['install', *alternate_binding], exe=package / binary)
    readme = alternate / 'README.md'
    readme.write_bytes(readme.read_bytes()+b'\nSynthetic replacement package.\n')
    manifest_path = alternate / 'package-manifest.json'
    manifest = json.loads(manifest_path.read_bytes())
    for item in manifest['files']:
        if item['name'] == 'README.md':
            item.update(size=readme.stat().st_size, sha256=hashlib.sha256(readme.read_bytes()).hexdigest())
    manifest_path.write_text(json.dumps(manifest, separators=(',', ':'))+'\n')
    next_digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    replacement = ['--from', str(alternate), '--prefix', str(installed), '--manifest-sha256', next_digest]
    lockpath = Path(str(installed)+'.lock')
    lock_inode = lockpath.stat().st_ino
    original_binding = lockpath.read_bytes()
    for field, value in [('schema_version', 2), ('target_digest', '0'*64),
                         ('manifest_sha256', 'a'*63), ('manifest_sha256', 'z'*64),
                         ('manifest_sha256', '0'*64), ('extra', True)]:
        foreign = json.loads(original_binding)
        foreign[field] = value
        raw = json.dumps(foreign).encode()
        lockpath.write_bytes(raw)
        refused, _ = run(['install', *replacement], 4, exe=alternate / binary)
        assert refused['error']['code'] == 'installation_binding' and not installed.exists()
        assert lockpath.read_bytes() == raw
    lockpath.write_bytes(original_binding)
    for suffix in ('.pending', '.removing'):
        unfinished = Path(str(installed)+suffix)
        unfinished.mkdir()
        sentinel = unfinished / 'sentinel'
        sentinel.write_bytes(b'preserve unfinished installation')
        try:
            refused, _ = run(['install', *replacement], 4, exe=alternate / binary)
            assert refused['error']['code'] == 'installation_binding' and not installed.exists()
            assert lockpath.read_bytes() == original_binding and sentinel.read_bytes() == b'preserve unfinished installation'
        finally:
            sentinel.unlink()
            unfinished.rmdir()
    run(['install', *replacement], exe=alternate / binary)
    assert lockpath.stat().st_ino == lock_inode
    assert {p.name:p.read_bytes() for p in installed.iterdir()} == {p.name:p.read_bytes() for p in alternate.iterdir()}
    current_binding = lockpath.read_bytes()
    refused, _ = run(['install', *binding], 4, exe=package / binary)
    assert refused['error']['code'] == 'installation_binding' and lockpath.read_bytes() == current_binding
    run(['version'], exe=installed / binary)
    run(['uninstall', *replacement], exe=alternate / binary)
    assert not installed.exists() and before == stored()
    timings = {}
    for name, args in [('help',['help']),('schema',['schema','context.add']),('search',['cli','search','context'])]:
        samples = [run(args, exe=second / binary)[1] for _ in range(35)]
        timings[name] = startup_result(samples)
    run(['uninstall', *second_binding], exe=package / binary)
    assert not second.exists() and before == stored()
    result.update(result='PASS', revision=state['revision'], receipts=len(state['receipts']),
                  contexts_preserved=True, human_default_journey=True, stable_install_path=True, concurrent_apply_exit_codes=sorted(codes),
                  recovery_preserved_previous_state=True, hardlink_refused=True,
                  revision_limit_refused=True, expired_receipt_pruned=True,
                  invalid_stored_cases=6, timings=timings)
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
