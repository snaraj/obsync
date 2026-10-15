#!/usr/bin/env python3
"""Fresh private Android acceptance lifecycle; no personal devices or profiles."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import time
import zipfile


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def sanitized_diagnostic(data):
    text = data.decode('utf-8', errors='replace') if isinstance(data, bytes) else str(data)
    text = re.sub(r'[^\x20-\x7e\n\t]', '', text)
    lines = []
    for line in text.splitlines():
        if re.search(r'(?i)token|secret|password|credential|authorization|recovery|pairing|\bkey\b|adbkey', line):
            lines.append('[credential-related line omitted]')
            continue
        line = re.sub(r'https?://\S+', '[url]', line)
        line = re.sub(r"(?:[A-Za-z]:)?/[^\s'\"<>]+", '[path]', line)
        line = re.sub(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', '[address]', line)
        line = re.sub(r'[A-Za-z0-9_+/=-]{24,}', '[identifier]', line)
        lines.append(line)
    return '\n'.join(lines)[-4096:]


def startup_diagnostics(run, stage, error):
    # The journey may already have credentials: never promote its private logs.
    if stage not in ('prepare', 'boot', 'install'):
        return False
    logs = {}
    for name in ('prepare', 'adb', 'emulator'):
        path = run/'private'/(name+'.log')
        if path.is_file() and not path.is_symlink():
            with path.open('rb') as stream:
                size = stream.seek(0, os.SEEK_END)
                stream.seek(max(0, size-8192))
                tail = stream.read(8192)
            if size > 8192:
                tail = tail.partition(b'\n')[2]  # omit a possibly truncated sensitive line
            logs[name] = sanitized_diagnostic(tail)
    stderr = getattr(error, 'stderr', None) or b''
    if len(stderr) > 8192:
        stderr = stderr[-8192:]
        stderr = stderr.partition(b'\n' if isinstance(stderr, bytes) else '\n')[2]
    save(run/'evidence/startup-diagnostics.json', {'stage': stage, 'logs': logs,
        'exceptionType': type(error).__name__, 'returncode': getattr(error, 'returncode', None),
        'stderr': sanitized_diagnostic(stderr)})
    return True


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def identity(pid):
    r = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart=,command='],
                       capture_output=True, text=True, check=False)
    return r.stdout.strip() if r.returncode == 0 else None


def checked_file(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('regular artifact required: ' + path.name)
    return path


def pinned_file(item):
    path = checked_file(Path(item['path']).expanduser().absolute())
    if not re.fullmatch('[0-9a-f]{64}', item['sha256']) or digest(path) != item['sha256']:
        raise ValueError('artifact SHA-256 mismatch: ' + path.name)
    return path


def archive_files(path):
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            for entry in archive.infolist():
                if not entry.is_dir():
                    if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                        continue  # symlinks are not executed; targets are checked independently
                    with archive.open(entry) as stream:
                        yield entry.filename, hashlib.file_digest(stream, 'sha256').hexdigest()
    else:
        with tarfile.open(path, 'r:*') as archive:
            for entry in archive:
                if entry.isfile():
                    with archive.extractfile(entry) as stream:
                        yield entry.name, hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_assets(path, sdk, java, image):
    assets = json.loads(checked_file(path).read_text())
    apk = assets['apk']
    if not re.fullmatch(r'https://github\.com/obsidianmd/obsidian-releases/releases/download/v[^/]+/Obsidian-[^/]+\.apk', apk['url']):
        raise ValueError('official Obsidian release URL required')
    apk_path = pinned_file(apk)
    verified = set()
    proofs = []
    for item in assets['archives']:
        url = item['url']
        if not (url.startswith('https://dl.google.com/android/repository/') or
                url.startswith('https://github.com/adoptium/temurin21-binaries/releases/download/')):
            raise ValueError('official tooling archive URL required')
        archive = pinned_file(item)
        root = Path(item['installRoot']).expanduser().absolute()
        prefix = item.get('prefix', '')
        count = 0
        for name, expected in archive_files(archive):
            if not name.startswith(prefix):
                raise ValueError('archive member outside declared prefix')
            rel = PurePosixPath(name[len(prefix):])
            if rel.is_absolute() or '..' in rel.parts:
                raise ValueError('unsafe archive member')
            installed = root.joinpath(*rel.parts)
            checked_file(installed)
            if digest(installed) != expected:
                raise ValueError('installed tooling differs from official archive: ' + str(rel))
            verified.add(installed.resolve())
            count += 1
        if not count:
            raise ValueError('empty tooling archive')
        proofs.append({'sha256': item['sha256'], 'url': url, 'verifiedFiles': count})
    image_path = sdk / 'system-images' / Path(*image.split(';')[1:])
    required = [sdk/'platform-tools/adb', sdk/'emulator/emulator',
                sdk/'cmdline-tools/latest/bin/avdmanager', java/'bin/java']
    required += list(image_path.glob('*.img')) + list(image_path.glob('kernel*'))
    if not any(p.suffix == '.img' for p in required):
        raise ValueError('verified installed system image required')
    for p in required:
        if p.resolve() not in verified:
            raise ValueError('required tool/image absent from verified archives: ' + p.name)
    for tree in (sdk/'platform-tools', sdk/'emulator', sdk/'cmdline-tools/latest', image_path, java):
        for p in tree.rglob('*'):
            if p.is_file() and p.name != 'package.xml' and p.resolve() not in verified:
                raise ValueError('unverified installed tooling file: ' + p.name)
    return apk_path, {'apkSha256': apk['sha256'], 'apkUrl': apk['url'], 'archives': proofs}


def validate(a):
    if not 1 <= a.seconds <= 86400:
        raise ValueError('session duration must be 1..86400 seconds')
    if not 1 <= a.boot_seconds <= 900:
        raise ValueError('boot budget must be 1..900 seconds')
    if a.port % 2 or not 5554 <= a.port <= 5584:
        raise ValueError('even console port 5554..5584 required')
    if not re.fullmatch(r'system-images;android-\d+;[\w_-]+;[\w_-]+', a.system_image):
        raise ValueError('installed system-image identifier required')
    if a.run.exists() or a.run.is_symlink():
        raise ValueError('fresh run required; existing data preserved')
    for parent in [a.run.parent, *a.run.parent.parents]:
        if parent.is_symlink():
            raise ValueError('run parent must not contain symlinks')
    common = Path(subprocess.check_output(['git', '-C', str(a.source), 'rev-parse',
                  '--path-format=absolute', '--git-common-dir'], text=True).strip()).parent
    for root in (a.source.resolve(), common.resolve()):
        run = a.run.resolve()
        if root == run or root in run.parents or run in root.parents:
            raise ValueError('run must be outside repository and its ancestors')
    head = subprocess.check_output(['git', '-C', str(a.source), 'rev-parse', 'HEAD'], text=True).strip()
    if not re.fullmatch('[0-9a-f]{40}', a.source_head) or head != a.source_head:
        raise ValueError('exact candidate source head required')
    if subprocess.check_output(['git', '-C', str(a.source), 'status', '--porcelain']):
        raise ValueError('clean candidate source required')
    if shutil.disk_usage(a.run.parent).free < 20 * 1024**3:
        raise ValueError('20 GiB free required')
    for port in [a.port, a.port + 1]:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', port))
    if len(set(a.reverse)) != len(a.reverse) or any(not 1024 <= p <= 65535 for p in a.reverse):
        raise ValueError('unique nonprivileged reverse ports required')
    return verify_assets(a.assets, a.sdk, a.java, a.system_image)


def adb_env(state):
    if state.get('targetKind')=='usb':return dict(state['environment'])
    # Do not inherit any host Android keys, homes, sockets or discovery settings.
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ADB', 'ANDROID_'))}
    env.update(state['environment'])
    return env


def live_state(run):
    if run.is_symlink():
        raise ValueError('linked run refused')
    state = json.loads(checked_file(run/'android.json').read_text())
    if state.get('format') != 1 or state.get('run') != str(run.resolve()):
        raise ValueError('not this Android run')
    if time.time() >= state['expiresAtEpoch']:
        raise ValueError('expired Android session')
    for record in [state['holder'], *state['processes'].values()]:
        if identity(record['pid']) != record['identity']:
            raise RuntimeError('owned process identity changed; no command sent')
    if state.get('targetKind')=='usb':
        spec=importlib.util.spec_from_file_location('android_usb',Path(__file__).with_name('android-usb.py'))
        usb=importlib.util.module_from_spec(spec);spec.loader.exec_module(usb);usb.target_guard(state)
        return state
    if state.get('targetKind') not in (None,'emulator') or not re.fullmatch('emulator-(555[468]|55[678][02468])', state['serial']):
        raise ValueError('owned emulator serial required')
    return state


def adb_command(state, args, timeout=30, binary=False):
    if state.get('targetKind')=='usb' and (args[0] in ('root','unroot','remount','disable-verity','enable-verity','reboot','install','uninstall','usb','tcpip','connect','disconnect','devices') or args[:3] in (['shell','pm','clear'],['shell','cmd','package']) and 'clear' in args):
        raise ValueError('USB fixture forbids root/trust/app replacement or wipe, discovery, transport change, and reboot')
    # Every call is scoped, including discovery of this private server's devices.
    argv = [str(Path(state['sdk'])/'platform-tools/adb'), '-P', str(state['adbPort']),
            '-s', state['serial'], *args]
    remaining = state['expiresAtEpoch'] - time.time()
    if remaining <= 0:
        raise TimeoutError('Android lifecycle deadline before device command')
    return subprocess.check_output(argv, env=adb_env(state), text=not binary,
                                   stderr=subprocess.PIPE, timeout=min(timeout, remaining))


def register_emulator(state, port):
    # Disable both USB and automatic emulator discovery. Register only our port
    # with the private server's standard host service (ADB length-prefixed wire).
    request = f'host:emulator:{port}'.encode('ascii')
    with socket.create_connection(('127.0.0.1', state['adbPort']), timeout=2) as conn:
        conn.sendall(f'{len(request):04x}'.encode('ascii') + request)
        # This notification intentionally has no reply. The next boot-property
        # command independently proves that the exact serial became usable.


def check_reverse(state):
    if not state['reversePorts']:
        return
    lines = adb_command(state, ['reverse', '--list']).splitlines()
    for port in state['reversePorts']:
        pair = [f'tcp:{port}', f'tcp:{port}']
        if not any(line.split()[-2:] == pair for line in lines):
            raise RuntimeError('owned adb reverse missing; reconnect explicitly before retry')


def exit_code(child):
    # WNOWAIT retains this original child PID even after exit, so its PGID
    # cannot be reused before cleanup finishes signalling the whole group.
    status = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    if status is None:
        return None
    return status.si_status if status.si_code == os.CLD_EXITED else -status.si_status


def group_members(pgid):
    result = subprocess.run(['ps', '-g', str(pgid), '-o', 'pid=,pgid=,stat='],
                            capture_output=True, text=True, check=False)
    if result.returncode not in (0, 1) or result.stderr.strip():
        raise RuntimeError('owned group inspection failed')
    members = []
    for line in result.stdout.splitlines():
        pid, group, status = line.split()
        if int(group) != pgid:
            raise RuntimeError('group inspection returned another process group')
        members.append((int(pid), status))
    return members


def adb_listener(owned, state):
    child = owned.children['adb']
    deadline = min(time.time()+10, state['expiresAtEpoch'])
    while time.time() < deadline:
        if exit_code(child) is not None:
            raise RuntimeError('adb exited before listener proof: exit='+str(exit_code(child)))
        result = subprocess.run(['lsof', '-nP', '-a', '-p', str(child.pid), '-iTCP:'+str(state['adbPort']),
                                 '-sTCP:LISTEN', '-Fn'], capture_output=True, text=True, check=False)
        listeners = [line[1:] for line in result.stdout.splitlines() if line.startswith('n')]
        if listeners:
            if listeners != [f"127.0.0.1:{state['adbPort']}"]:
                raise RuntimeError('private adb listener is not exclusively IPv4 loopback')
            save(owned.run/'evidence/adb-listener.json', {'result':'PASS', 'pid':child.pid,
                 'address':'127.0.0.1', 'port':state['adbPort'], 'usbDisabled':state.get('targetKind')!='usb','usbScope':'one supplied serial' if state.get('targetKind')=='usb' else 'disabled'})
            return
        if result.returncode not in (0, 1):
            raise RuntimeError('private adb listener inspection failed')
        time.sleep(.1)
    raise TimeoutError('private adb loopback listener proof deadline')


class Owned:
    def __init__(self, run, state):
        self.run, self.state, self.children = run, state, {}

    def launch(self, name, argv, env):
        with (self.run/'private'/f'{name}.log').open('ab') as log:
            child = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=log, start_new_session=True)
        self.children[name] = child  # custody precedes any operation that can fail
        return child

    def record(self, name):
        child = self.children[name]
        previous = None
        for _ in range(40):
            current = identity(child.pid)
            if exit_code(child) is not None:
                raise RuntimeError(name + ' exited before startup; inspect private log')
            if current and current == previous:
                self.state['processes'][name] = {'pid': child.pid, 'identity': current}
                save(self.run/'android.json', self.state)
                return
            previous = current
            time.sleep(.1)
        raise RuntimeError(name + ' process identity did not settle')

    def require_running(self, phase):
        ended = []
        for name in ('emulator', 'adb'):
            code = exit_code(self.children[name])
            if code is not None:
                ended.append(f'{name} exit={code}')
        if ended:
            raise RuntimeError('owned process exited during '+phase+': '+', '.join(ended))

    def stop(self, term_seconds=10):
        if not isinstance(term_seconds,int) or not 1 <= term_seconds <= 90:
            raise ValueError('bounded owned shutdown grace required')
        failures = []
        for name, child in reversed(list(self.children.items())):
            try:
                # No controller observation reaps this leader. Its reserved PID
                # proves custody of the original PGID while descendants remain.
                exit_code(child)
                for sig, budget in ((signal.SIGTERM,term_seconds), (signal.SIGKILL,5)):
                    try:
                        os.killpg(child.pid, sig)
                    except (ProcessLookupError, PermissionError):
                        if any(not status.startswith('Z') for _,status in group_members(child.pid)):
                            raise
                    deadline = time.monotonic()+budget
                    while time.monotonic() < deadline:
                        if not any(not status.startswith('Z') for _,status in group_members(child.pid)):
                            break
                        time.sleep(.1)
                    else:
                        continue
                    break
                else:
                    raise RuntimeError('owned group still has live members')
                child.wait(timeout=5)  # reap only after the last group signal
                deadline = time.monotonic()+5
                while group_members(child.pid):
                    if time.monotonic() >= deadline:
                        raise RuntimeError('owned group remains after reaping leader')
                    time.sleep(.1)
            except Exception:
                failures.append(name)
        if failures:
            raise RuntimeError('cleanup incomplete: ' + ','.join(failures))


def execute(a):
    apk, proof = validate(a)
    adb_port = free_port()
    controller_identity = identity(os.getpid())
    if not controller_identity:
        raise RuntimeError('controller identity unavailable before fixture creation')
    os.umask(0o077)
    started = time.time()
    state = {'format': 1, 'run': str(a.run.resolve()), 'sourceHead': a.source_head,
             'sdk': str(a.sdk), 'adbPort': adb_port, 'serial': f'emulator-{a.port}',
             'processes': {}, 'expiresAtEpoch': started + a.seconds,
             'reversePorts': a.reverse, 'holder': {'pid': os.getpid(), 'identity': controller_identity},
             'environment': {'HOME': str(a.run/'runtime/user'), 'JAVA_HOME': str(a.java), 'ANDROID_USER_HOME': str(a.run/'runtime/user'),
                 'ANDROID_EMULATOR_HOME': str(a.run/'runtime/user'), 'ANDROID_AVD_HOME': str(a.run/'runtime/avds'),
                 'ANDROID_HOME': str(a.sdk), 'ANDROID_SDK_ROOT': str(a.sdk),
                 'ADB_SERVER_SOCKET': f'tcp:127.0.0.1:{adb_port}', 'ANDROID_ADB_SERVER_PORT': str(adb_port),
                 'ADB_USB': '0', 'ADB_EMU': '0', 'ADB_MDNS': '0',
                 'ADB_MDNS_AUTO_CONNECT': '', 'ADB_VENDOR_KEYS': str(a.run/'runtime/user/adbkey')}}
    owned = Owned(a.run, state)
    stage, result, failure = 'prepare', 'FAIL', None
    deadline = time.monotonic() + a.seconds
    previous_handlers = {}

    def interrupted(signum, _frame):
        raise InterruptedError('Android lifecycle interrupted by signal ' + str(signum))

    for sig in (signal.SIGTERM, signal.SIGINT):
        previous_handlers[sig] = signal.signal(sig, interrupted)
    created = False
    try:
        a.run.mkdir(mode=0o700)
        created = True
        for name in ('runtime/user', 'runtime/avds', 'private', 'evidence'):
            (a.run/name).mkdir(parents=True, mode=0o700)
        save(a.run/'android.json', state)
        save(a.run/'evidence/assets.json', proof)
        env = adb_env(state)
        with (a.run/'private/prepare.log').open('wb') as log:
            subprocess.run([str(a.sdk/'cmdline-tools/latest/bin/avdmanager'), 'create', 'avd',
                '-n', 'obsync-acceptance', '-k', a.system_image, '-d', a.device,
                '-p', str(a.run/'runtime/avds/obsync-acceptance.avd')], input=b'no\n',
                stdout=log, stderr=log, env=env, check=True, timeout=min(60, a.seconds))
        stage = 'boot'
        adb = str(a.sdk/'platform-tools/adb')
        owned.launch('adb', [adb, '-L', f'tcp:{adb_port}', '--one-device',
                            'obsync-no-usb', 'server', 'nodaemon'], env)
        owned.record('adb')  # require the server alive before any client can autostart
        adb_listener(owned, state)
        emulator = owned.launch('emulator', [str(a.sdk/'emulator/emulator'), '-avd', 'obsync-acceptance',
            '-port', str(a.port), '-no-audio', '-no-boot-anim', '-no-snapshot-load', '-no-snapshot-save',
            '-no-metrics', '-crash-report-mode', 'never', '-cores', '2', '-memory', '2048', '-gpu', a.gpu], env)
        boot_deadline = min(deadline, time.monotonic() + a.boot_seconds)
        while time.monotonic() < boot_deadline:
            owned.require_running('boot')
            try:
                register_emulator(state, a.port + 1)
                if adb_command(state, ['shell', 'getprop', 'sys.boot_completed'], timeout=3).strip() == '1':
                    break
            except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
                pass
            time.sleep(.3)
        else:
            raise TimeoutError('emulator boot deadline; try another explicit graphics mode in a fresh run')
        owned.record('emulator')  # record actual qemu identity after launcher exec
        if not a.online:
            adb_command(state, ['shell', 'svc', 'wifi', 'disable'])
            adb_command(state, ['shell', 'svc', 'data', 'disable'])
        for port in a.reverse:
            adb_command(state, ['reverse', f'tcp:{port}', f'tcp:{port}'])
        check_reverse(state)
        stage = 'install'
        output = adb_command(state, ['install', str(apk)], timeout=90)
        if output.strip() != 'Success' and not output.rstrip().endswith('\nSuccess'):
            raise RuntimeError('APK install did not report Success')
        package_paths = adb_command(state, ['shell', 'pm', 'path', 'md.obsidian']).splitlines()
        if len(package_paths) != 1 or not package_paths[0].startswith('package:/data/app/'):
            raise RuntimeError('unexpected installed Obsidian package layout')
        installed = adb_command(state, ['exec-out', 'cat', package_paths[0][8:]], binary=True, timeout=60)
        if hashlib.sha256(installed).hexdigest() != proof['apkSha256']:
            raise RuntimeError('installed APK differs from verified official bytes')
        activity = adb_command(state, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', 'md.obsidian']).strip().splitlines()[-1]
        if not re.fullmatch(r'md\.obsidian/[\w.$]+', activity):
            raise RuntimeError('Obsidian launch activity unresolved')
        adb_command(state, ['shell', 'am', 'start', '-W', '-n', activity])
        save(a.run/'evidence/android-ready.json', {'result': 'READY', 'freshProfile': True,
            'sourceHead': a.source_head, 'apkSha256': proof['apkSha256'], 'installedApkVerified': True,
            'graphicsMode': a.gpu, 'systemImage': a.system_image, 'expiresAtEpoch': state['expiresAtEpoch'],
            'facts': {name: adb_command(state, ['shell', 'getprop', name]).strip() for name in
                      ('ro.build.version.release', 'ro.build.version.sdk', 'ro.build.version.security_patch', 'ro.product.cpu.abi')},
            'physicalPhone': 'NOT_RUN', 'productAcceptance': 'NOT_RUN'})
        print(json.dumps({'result': 'READY', 'run': str(a.run)}), flush=True)
        stage = 'journey'
        command_env = env | {'OBSYNC_ANDROID_RUN': str(a.run), 'OBSYNC_ANDROID_SERIAL': state['serial'],
                             'OBSYNC_ANDROID_ADB_PORT': str(adb_port)}
        journey = owned.launch('journey', a.command, command_env)
        while exit_code(journey) is None:
            if time.monotonic() >= deadline:
                raise TimeoutError('Android lifecycle deadline')
            owned.require_running('journey')
            time.sleep(.2)
        if time.monotonic() >= deadline:
            raise TimeoutError('Android lifecycle deadline after journey')
        if exit_code(journey):
            raise RuntimeError('journey exited ' + str(exit_code(journey)) + '; journey must emit sanitized phase evidence')
        result = 'PASS'
    except BaseException as error:
        failure = {'stage': stage, 'exceptionType': type(error).__name__, 'detail': sanitized_diagnostic(str(error))[:400]}
        if created and (a.run/'evidence').is_dir():
            startup_diagnostics(a.run, stage, error)
        raise
    finally:
        # Block further interruption while tearing down the children we own.
        for sig in previous_handlers:
            signal.signal(sig, signal.SIG_IGN)
        cleanup = 'FAIL'
        try:
            owned.stop()
            for name in ('runtime', 'private') if created else ():
                if (a.run/name).is_symlink():
                    raise RuntimeError('owned runtime directory became a link; preserved')
                if (a.run/name).exists():
                    shutil.rmtree(a.run/name)
            if created:
                (a.run/'android.json').unlink(missing_ok=True)
            cleanup = 'PASS'
        finally:
            try:
                if created:
                    (a.run/'evidence').mkdir(mode=0o700, exist_ok=True)
                    save(a.run/'evidence/result.json', {'result': result if cleanup == 'PASS' else 'FAIL',
                        'journeyResult': result, 'cleanup': cleanup, 'failure': failure, 'sourceHead': a.source_head,
                        'ownedGroupsRemaining': 0 if cleanup == 'PASS' else None,
                        'runtimeAbsent': not (a.run/'runtime').exists(),
                        'privateAbsent': not (a.run/'private').exists(),
                        'manifestAbsent': not (a.run/'android.json').exists(),
                        'controllerExitMustBeVerified': True,
                        'durationSeconds': round(time.time()-started, 3), 'budgetSeconds': a.seconds,
                        'productAcceptance': 'NOT_ASSERTED', 'physicalPhone': 'NOT_RUN'})
            finally:
                for sig, handler in previous_handlers.items():
                    signal.signal(sig, handler)


def app_pid(state):
    try:
        value=adb_command(state,['shell','pidof','md.obsidian']).strip()
    except subprocess.CalledProcessError as error:
        if error.returncode==1: return None
        raise
    if not value.isdigit() or int(value)<=1:
        raise RuntimeError('one owned Obsidian process required')
    return int(value)


def devtools_present(state,pid):
    text=adb_command(state,['shell','cat','/proc/net/unix'])
    return any(line.split()[-1:]==[f'@webview_devtools_remote_{pid}'] for line in text.splitlines())


def stopped_app(state):
    old=app_pid(state)
    adb_command(state,['shell','am','force-stop','md.obsidian'])
    deadline=time.monotonic()+10
    while app_pid(state) is not None or (old and devtools_present(state,old)):
        if time.monotonic()>=deadline:
            raise TimeoutError('old Obsidian process/devtools socket absence deadline')
        time.sleep(.1)
    return old


def lifecycle(run, action, boot_seconds=240):
    state=live_state(run)
    if state.get('targetKind')=='usb' and action=='reboot':raise ValueError('physical device reboot needs separate explicit authorization and lifecycle support')
    check_reverse(state)
    if action=='home':
        pid=app_pid(state)
        if pid is None: raise RuntimeError('running owned Obsidian required')
        adb_command(state,['shell','input','keyevent','KEYCODE_HOME'])
        activities=adb_command(state,['shell','dumpsys','activity','activities'])
        resumed=[line for line in activities.splitlines() if 'ResumedActivity' in line]
        if not resumed or any('md.obsidian' in line for line in resumed):
            raise RuntimeError('home did not prove Obsidian backgrounded')
        if app_pid(state)!=pid: raise RuntimeError('Obsidian process changed while backgrounding')
        proof={'result':'BACKGROUNDED','applicationPid':pid,'processRetained':True}
    elif action=='restart-app':
        boot=adb_command(state,['shell','cat','/proc/sys/kernel/random/boot_id']).strip()
        if (run/'evidence/android-trust.json').exists():
            current=json.loads((run/'evidence/android-trust-current.json').read_text())
            if current.get('bootId')!=boot:
                raise RuntimeError('reapply owned synthetic CA for this boot before starting app network')
        old=stopped_app(state)
        activity=adb_command(state,['shell','cmd','package','resolve-activity','--brief','md.obsidian']).strip().splitlines()[-1]
        if not re.fullmatch(r'md\.obsidian/[\w.$]+',activity):
            raise RuntimeError('official Obsidian launch activity unresolved')
        launch_started=round(time.time()*1000)
        adb_command(state,['shell','am','start','-W','-n',activity])
        deadline=time.monotonic()+30
        while True:
            new=app_pid(state)
            if new and new!=old and devtools_present(state,new): break
            if time.monotonic()>=deadline: raise TimeoutError('fresh Obsidian process/devtools deadline')
            time.sleep(.2)
        proof={'result':'RESTARTED' if old else 'STARTED','oldPid':old,
               'oldProcessAndSocketAbsent':old is not None,'oldApplicationAlreadyAbsent':old is None,'newPid':new,
               'freshDevtoolsSocket':True,'appDataReset':False,'nativeEnrollmentRetention':'NOT_ASSERTED',
               'launchStartedAtEpochMs':launch_started}
    elif action=='reboot':
        if not 1<=boot_seconds<=900: raise ValueError('boot deadline must be 1..900 seconds')
        old=stopped_app(state)  # preserve Android stopped-package flag through reboot
        before=adb_command(state,['shell','cat','/proc/sys/kernel/random/boot_id']).strip()
        adb_command(state,['reboot'])
        deadline=min(time.monotonic()+boot_seconds,time.monotonic()+max(0,state['expiresAtEpoch']-time.time()))
        after=None
        while time.monotonic()<deadline:
            try:
                register_emulator(state,int(state['serial'].split('-')[1])+1)
                after=adb_command(state,['shell','cat','/proc/sys/kernel/random/boot_id'],timeout=3).strip()
                ready=adb_command(state,['shell','getprop','sys.boot_completed'],timeout=3).strip()
                if after!=before and ready=='1': break
            except (OSError,subprocess.SubprocessError): pass
            time.sleep(.3)
        else: raise TimeoutError('owned Android device reboot deadline')
        if app_pid(state) is not None:
            raise RuntimeError('Obsidian unexpectedly running before post-reboot trust restoration')
        mappings=adb_command(state,['reverse','--list'])
        had_reverse=all(any(line.split()[-2:]==[f'tcp:{p}',f'tcp:{p}'] for line in mappings.splitlines()) for p in state['reversePorts'])
        for port in state['reversePorts']:
            adb_command(state,['reverse',f'tcp:{port}',f'tcp:{port}'])
        check_reverse(state)
        proof={'result':'REBOOTED','oldPid':old,'oldBootId':before,'newBootId':after,
               'actualGuestReboot':True,'reverseMappingsSurvived':had_reverse,'reverseMappingsRestored':True,
               'applicationStopped':True,'trustReapplyRequired':(run/'evidence/android-trust.json').exists(),
               'nextStep':'android-trust.py reapply with original pinned CA and pretrust receipt, then restart-app',
               'physicalDeviceReboot':'NOT_RUN'}
    else: raise ValueError('unknown owned Android lifecycle action')
    proof.update(sourceHead=state['sourceHead'],atEpoch=time.time())
    save(run/'evidence'/('android-'+action+'-'+str(time.time_ns())+'.json'),proof)
    return proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    for action in ('run', 'preflight'):
        p = sub.add_parser(action)
        for name in ('source', 'run', 'sdk', 'java', 'assets'):
            p.add_argument('--'+name, type=lambda v: Path(v).expanduser().absolute(), required=True)
        p.add_argument('--source-head', required=True)
        p.add_argument('--system-image', default='system-images;android-35;google_apis;arm64-v8a')
        p.add_argument('--device', default='pixel_8')
        p.add_argument('--port', type=int, default=5584)
        p.add_argument('--seconds', type=int, default=14400)
        p.add_argument('--boot-seconds', type=int, default=240)
        p.add_argument('--gpu', choices=('auto', 'software', 'host', 'swiftshader'), default='software')
        p.add_argument('--reverse', type=int, action='append', default=[])
        p.add_argument('--online', action='store_true')
        if action == 'run':
            p.add_argument('command', nargs=argparse.REMAINDER)
    for action in ('home','restart-app','reboot'):
        p=sub.add_parser(action)
        p.add_argument('--run',type=lambda v:Path(v).expanduser().absolute(),required=True)
        p.add_argument('--boot-seconds',type=int,default=240)
    p = sub.add_parser('adb')
    p.add_argument('--run', type=lambda v: Path(v).expanduser().absolute(), required=True)
    p.add_argument('command', nargs=argparse.REMAINDER)
    a = parser.parse_args()
    if a.action in ('home','restart-app','reboot'):
        print(json.dumps(lifecycle(a.run,a.action,a.boot_seconds)))
    elif a.action == 'adb':
        state = live_state(a.run)
        check_reverse(state)
        command = a.command[1:] if a.command[:1] == ['--'] else a.command
        if not command or command[0].startswith('-') or command[0] in ('start-server', 'kill-server', 'server', 'connect', 'disconnect', 'usb', 'tcpip'):
            parser.error('scoped device command required')
        sys.stdout.buffer.write(adb_command(state, command, binary=True))
    elif a.action == 'preflight':
        _, proof = validate(a)
        print(json.dumps({'result': 'VERIFIED', 'assets': proof, 'emulatorStarted': False}))
    else:
        a.command = a.command[1:] if a.command[:1] == ['--'] else a.command
        if not a.command:
            parser.error('one bounded journey command is required')
        execute(a)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'result': 'FAIL', 'exceptionType': type(error).__name__, 'detail': str(error)[:400]}), file=sys.stderr)
        sys.exit(1)
