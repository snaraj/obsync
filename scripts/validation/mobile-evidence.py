#!/usr/bin/env python3
"""Independent persisted-file oracle. Does not drive or query plugin UI/state."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import stat
import time


def sha(data):
    return hashlib.sha256(data).hexdigest()


def private_json(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        raise ValueError('private regular single-link input required')
    return json.loads(path.read_text())


def fixtures(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 32:
        raise ValueError('nonempty bounded expected fixture set required')
    seen = set()
    for item in value:
        name = item['path']
        path = PurePosixPath(name)
        if (not isinstance(name, str) or not re.fullmatch(r'(?:[A-Za-z0-9][A-Za-z0-9 -]{0,60}/){0,3}[A-Za-z0-9][A-Za-z0-9 -]{0,100}(?: \(restored-[a-f0-9]{32}\))?\.md', name)
                or path.is_absolute() or '..' in path.parts or '.' in path.parts
                or name.startswith('.') or str(path) != name or name in seen):
            raise ValueError('unique synthetic relative note path required')
        seen.add(name)
        expected = item['text'].encode('utf-8')
        if not 1 <= len(expected) <= 65536:
            raise ValueError('nonempty bounded expected bytes required')
    return value


def compare(expected, desktop, android):
    # Matching two empty/truncated files must never establish convergence.
    if not expected or desktop != expected or android != expected:
        raise ValueError('persisted bytes do not match independent expected fixture')
    return {'bytes': len(expected), 'expectedSha256': sha(expected),
            'desktopSha256': sha(desktop), 'androidSha256': sha(android)}


def broken_controls(expected, desktop, android):
    compare(expected,desktop,android)
    killed=[]
    for name,left,right in [('both_empty',b'',b''),('android_empty',desktop,b''),
                            ('desktop_empty',b'',android),('both_truncated',desktop[:-1],android[:-1]),
                            ('android_corrupt',desktop,android+b'!')]:
        try:compare(expected,left,right)
        except ValueError:killed.append(name)
        else:raise RuntimeError('broken persisted-byte control survived: '+name)
    try:fixtures([])
    except ValueError:killed.append('missing_fixture_evidence')
    else:raise RuntimeError('empty evidence control survived')
    return killed


def load_controller(path):
    spec = importlib.util.spec_from_file_location('owned_android_controller', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def observe(args):
    expected = fixtures(private_json(args.fixtures))
    desktop = private_json(args.desktop_run / 'lab.json')
    if desktop['run'] != str(args.desktop_run.resolve()) or set(desktop['devices']) != {'A'}:
        raise ValueError('explicit single owned desktop peer required')
    controller = load_controller(args.controller)
    android = controller.live_state(args.android_run)
    if desktop['source_head'] != android['sourceHead']:
        raise ValueError('peer candidate mismatch')
    vault = Path(desktop['devices']['A']['vault'])
    if vault != args.desktop_run / 'runtime/A/Lab-A' or vault.is_symlink():
        raise ValueError('owned disposable desktop vault required')
    if not re.fullmatch('/storage/emulated/0/Documents/Obsync-[A-Za-z0-9-]+', args.android_vault):
        raise ValueError('explicit disposable Android vault required')
    if args.output.exists():
        raise ValueError('evidence destination already exists')
    args.output.mkdir(mode=0o700)
    observations, failure, controls = [], None, None
    started = time.time()
    try:
        for index, item in enumerate(expected):
            host_path = vault / item['path']
            if not host_path.resolve().is_relative_to(vault.resolve()) or host_path.is_symlink():
                raise ValueError('linked note refused')
            android = controller.live_state(args.android_run)
            remote = args.android_vault + '/' + item['path']
            controller.adb_command(android, ['shell', 'test', '!', '-L', shlex.quote(remote)])
            controller.adb_command(android, ['shell', 'test', '-f', shlex.quote(remote)])
            # exec-out escapes each argv itself; shell quoting here becomes literal filename bytes.
            a = controller.adb_command(android, ['exec-out', 'cat', remote], binary=True)
            b = host_path.read_bytes()
            # Save actual exported bytes before comparison, including failures.
            (args.output / f'{index}-android.bin').write_bytes(a)
            (args.output / f'{index}-desktop.bin').write_bytes(b)
            observations.append({'fixtureIndex': index, **compare(item['text'].encode(), b, a)})
            if controls is None:controls=broken_controls(item['text'].encode(),b,a)
    except Exception as error:
        failure = type(error).__name__
    result = {'schema': 1, 'result': 'FAIL' if failure else 'PASS', 'failureType': failure,
              'sourceHead': android['sourceHead'], 'oracle': 'independent host and ADB persisted bytes',
              'driverSha256': sha(Path(__file__).read_bytes()), 'fixtureManifestSha256': sha(args.fixtures.read_bytes()),
              'expectedCount': len(expected), 'verifiedCount': len(observations), 'files': observations,
              'detachedBrokenControls': controls, 'brokenControlScope': 'copies of actual exported bytes; product unchanged',
              'elapsedMs': round((time.time() - started) * 1000), 'physicalPhone': 'NOT_RUN'}
    (args.output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
    return 1 if failure else 0


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['controller', 'android-run', 'desktop-run', 'fixtures', 'output']:
        parser.add_argument('--' + name, type=lambda v: Path(v).absolute(), required=True)
    parser.add_argument('--android-vault', required=True)
    raise SystemExit(observe(parser.parse_args()))
