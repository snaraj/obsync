#!/usr/bin/env python3
"""Own one fresh Android emulator for a bounded native acceptance session."""
import argparse
import hashlib
import importlib
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent


def validate(a):
    if not 1 <= a.seconds <= 3600:
        raise ValueError('session duration must be at most one hour')
    if a.port % 2 or not 5554 <= a.port <= 5584:
        raise ValueError('an even emulator console port in the recommended range is required')
    if a.run.exists() or a.run.is_symlink():
        raise ValueError('fresh external run required')
    if not (a.source / 'AGENTS.md').is_file():
        raise ValueError('explicit candidate source required')
    if subprocess.check_output(['git', '-C', str(a.source), 'status', '--porcelain']):
        raise ValueError('clean candidate source required')
    if a.apk.is_symlink() or not a.apk.is_file():
        raise ValueError('regular verified official APK required')
    if hashlib.sha256(a.apk.read_bytes()).hexdigest() != a.apk_sha256:
        raise ValueError('official APK digest mismatch')
    for path in (a.sdk / 'platform-tools/adb', a.sdk / 'emulator/emulator',
                 a.sdk / 'cmdline-tools/latest/bin/avdmanager', a.java / 'bin/java'):
        if not path.is_file():
            raise ValueError('verified Android and Java tooling required')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for key in ('source', 'run', 'sdk', 'java', 'apk'):
        p.add_argument('--' + key, type=Path, required=True)
    p.add_argument('--apk-sha256', required=True)
    p.add_argument('--system-image', default='system-images;android-35;google_apis;arm64-v8a')
    p.add_argument('--port', type=int, default=5584)
    p.add_argument('--gpu', choices=('auto', 'software'), default='auto')
    p.add_argument('--seconds', type=int, default=3600)
    p.add_argument('--online', action='store_true', help='allow normal emulator networking for an explicitly authorized test')
    a = p.parse_args()
    # Refuse links/existing outputs before resolve can hide their identity.
    if a.run.exists() or a.run.is_symlink():
        p.error('fresh run required')
    for key in ('source', 'run', 'sdk', 'java', 'apk'):
        setattr(a, key, getattr(a, key).expanduser().absolute())
    validate(a)
    os.environ['OBSYNC_LAB_SOURCE'] = str(a.source)
    sys.path.insert(0, str(ROOT / 'harness/scripts/validation/lab'))
    lab = importlib.import_module('lab')
    run = lab.external(a.run)
    for port in (a.port, a.port + 1):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', port))
    adb_port = lab.port()
    lab.identity(os.getpid())
    os.umask(0o077)
    run.mkdir(mode=0o700)
    for name in ('runtime/user', 'runtime/avds', 'private', 'evidence'):
        (run / name).mkdir(parents=True, mode=0o700)
    env = os.environ.copy()
    env.update(JAVA_HOME=str(a.java), ANDROID_USER_HOME=str(run / 'runtime/user'),
               ANDROID_EMULATOR_HOME=str(run / 'runtime/user'), ANDROID_AVD_HOME=str(run / 'runtime/avds'),
               ANDROID_HOME=str(a.sdk), ANDROID_SDK_ROOT=str(a.sdk),
               ANDROID_ADB_SERVER_PORT=str(adb_port), ADB_SERVER_SOCKET=f'tcp:127.0.0.1:{adb_port}',
               ADB_MDNS_AUTO_CONNECT='', ADB_VENDOR_KEYS=str(run / 'runtime/user/adbkey'))
    adb = str(a.sdk / 'platform-tools/adb')
    state = {'format': 1, 'run': str(run), 'sdk': str(a.sdk), 'processes': {}, 'devices': {},
             'adbPort': adb_port, 'serial': f'emulator-{a.port}',
             'holder': {'pid': os.getpid(), 'identity': lab.identity(os.getpid())}}
    stopped = False

    def request_stop(*_):
        nonlocal stopped
        stopped = True

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, request_stop)

    def device(*args, timeout=20):
        return subprocess.check_output([adb, '-P', str(adb_port), '-s', state['serial'], *args],
                                       env=env, text=True, stderr=subprocess.DEVNULL, timeout=timeout).strip()

    start = time.time()
    end = time.monotonic() + a.seconds
    stage = 'prepare'
    try:
        with (run / 'private/prepare.log').open('wb') as log:
            subprocess.run([str(a.sdk / 'cmdline-tools/latest/bin/avdmanager'), 'create', 'avd',
                            '-n', 'obsync-native-validation', '-k', a.system_image, '-p',
                            str(run / 'runtime/avds/obsync-native-validation.avd')],
                           input=b'no\n', stdout=log, stderr=log, env=env, check=True, timeout=60)
        stage = 'boot'
        lab.launch(run, state, 'adb', [adb, '-L', f'tcp:{adb_port}', '--one-device',
                                     'obsync-no-usb', 'server', 'nodaemon'], env)
        child = lab.launch(run, state, 'emulator', [str(a.sdk / 'emulator/emulator'), '-avd',
            'obsync-native-validation', '-port', str(a.port), '-no-audio', '-no-boot-anim',
            '-no-snapshot-load', '-no-snapshot-save', '-cores', '2', '-memory', '2048',
            '-gpu', a.gpu], env)
        deadline = min(end, time.monotonic() + 180)
        while time.monotonic() < deadline and not stopped:
            if child.poll() is not None:
                raise RuntimeError('owned emulator exited')
            try:
                if device('shell', 'getprop', 'sys.boot_completed', timeout=5) == '1':
                    break
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                pass
            time.sleep(.5)
        else:
            raise RuntimeError('emulator boot deadline')
        record = state['processes']['emulator']
        current = lab.identity(record['pid'])
        argv = shlex.split(current[25:]) if current else []
        expected = str(a.sdk / 'emulator/qemu/darwin-aarch64/qemu-system-aarch64')
        if not current or current[:24] != record['identity'][:24] or argv != [expected, *record['argv'][1:]]:
            raise RuntimeError('unexpected emulator process identity')
        record.update(identity=current, argv=argv)
        lab.save(run / 'lab.json', state)
        if not a.online:
            device('shell', 'svc', 'wifi', 'disable')
            device('shell', 'svc', 'data', 'disable')
        stage = 'install'
        device('install', str(a.apk), timeout=60)
        device('shell', 'am', 'start', '-n', 'md.obsidian/.MainActivity')
        lab.save(run / 'evidence/android-ready.json', {'result': 'READY', 'freshProfile': True,
            'sourceHead': subprocess.check_output(['git', '-C', str(a.source), 'rev-parse', 'HEAD'], text=True).strip(),
            'apkSha256': a.apk_sha256, 'onlineRequested': a.online, 'graphicsMode': a.gpu, 'startedAtEpoch': start,
            'expiresAtEpoch': start + a.seconds, 'physicalPhone': 'NOT_RUN'})
        print(json.dumps({'result': 'READY', 'expiresAtEpoch': start + a.seconds}), flush=True)
        stage = 'ready'
        while not stopped and time.monotonic() < end and not (run / 'private/stop.json').exists():
            if child.poll() is not None:
                raise RuntimeError('owned emulator exited during session')
            time.sleep(.2)
    except BaseException as error:
        lab.save(run / 'evidence/android-failure.json', {'result': 'FAIL', 'stage': stage,
                                                       'exceptionType': type(error).__name__})
        raise
    finally:
        # Passing the owned in-memory manifest does not broaden lab.load's allowlist.
        lab.down(run, state)
        if any(lab.group_alive(v['pid']) for v in state['processes'].values()):
            raise RuntimeError('owned groups remain; private diagnostic data preserved')
        if (run / 'private').is_symlink():
            raise RuntimeError('private directory became a link')
        shutil.rmtree(run / 'private')
        (run / 'lab.json').unlink()
        lab.save(run / 'evidence/final-cleanup.json', {'result': 'PASS', 'ownedGroupsRemaining': 0,
            'runtimeAbsent': not (run / 'runtime').exists(), 'privateAbsent': not (run / 'private').exists(),
            'manifestAbsent': not (run / 'lab.json').exists(), 'controllerExitMustBeVerified': True,
            'atEpoch': time.time()})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'result': 'FAIL', 'exceptionType': type(error).__name__}), flush=True)
        sys.exit(1)
