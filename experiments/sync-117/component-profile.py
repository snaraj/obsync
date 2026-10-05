#!/usr/bin/env python3
"""Owned Pi component lab. Stage verified inputs first; no installation or sudo."""
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tarfile
import threading
import time

ROOT = Path(__file__).resolve().parent
if ROOT.parent != Path('/tmp').resolve() or not re.fullmatch(r'obsync-pi-lab-[a-f0-9]{16}', ROOT.name):
    raise SystemExit('refused: expected exact task scratch')
if ROOT.is_symlink() or ROOT.stat().st_uid != os.getuid() or ROOT.stat().st_mode & 0o077:
    raise SystemExit('refused: scratch custody')
os.umask(0o077)
MANIFEST = ROOT / 'owned.json'
children = []


def save(path, value):
    temporary = path.with_suffix('.new')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def identity(pid):
    if sys.platform == 'darwin':
        result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart=,uid=,command='], capture_output=True, text=True)
        return {'pid': pid, 'start': result.stdout.strip(), 'uid': os.getuid()} if result.returncode == 0 else None
    try:
        raw = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'start': raw[19], 'uid': Path(f'/proc/{pid}').stat().st_uid}
    except FileNotFoundError:
        return None


def checked(record):
    current = identity(record['pid'])
    if current is not None and current != record:
        raise RuntimeError('process identity changed; no signal sent')
    return current


def group_exists(pid):
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


def stop(record):
    current = checked(record)
    if not group_exists(record['pid']):
        return
    if current is None:
        raise RuntimeError('leader absent with remaining group; preserve scratch')
    os.killpg(record['pid'], signal.SIGTERM)
    for _ in range(100):
        for child in children:
            child.poll()
        if not group_exists(record['pid']):
            return
        time.sleep(.1)
    if checked(record) is None:
        raise RuntimeError('leader absent with remaining group; preserve scratch')
    os.killpg(record['pid'], signal.SIGKILL)
    for _ in range(50):
        for child in children:
            child.poll()
        if not group_exists(record['pid']):
            return
        time.sleep(.1)
    raise RuntimeError('group remains; preserve scratch')


def cleanup():
    state = json.loads(MANIFEST.read_text())
    if state['format'] != 1 or state['root'] != str(ROOT) or state['uid'] != os.getuid():
        raise RuntimeError('foreign manifest')
    if state['launcher']['pid'] != os.getpid() and checked(state['launcher']):
        (ROOT / 'stop-request').touch(mode=0o600)
        for _ in range(300):
            if checked(state['launcher']) is None:
                break
            time.sleep(.1)
        else:
            raise RuntimeError('launcher stop pending; preserve scratch')
        state = json.loads(MANIFEST.read_text())
    for record in reversed(state['children']):
        stop(record)
    for directory in ('runtime',):
        target = ROOT / directory
        if target.is_symlink():
            raise RuntimeError('scratch directory became a symlink')
        if target.exists():
            shutil.rmtree(target)
    # Retain private failure logs for local diagnosis; remove live setup inputs.
    (ROOT / 'private/client.json').unlink(missing_ok=True)
    (ROOT / 'private/setup-token').unlink(missing_ok=True)
    (ROOT / 'inputs/tls.key').unlink(missing_ok=True)
    save(ROOT / 'evidence/teardown.json', {'processGroupsRemaining': 0,
         'runtimeExists': (ROOT / 'runtime').exists(), 'privateExists': (ROOT / 'private').exists(),
         'inputsRetained': True, 'privateLogsRetained': True,
         'launcherExitsAfterReceipt': state['launcher']['pid'] == os.getpid()})


def spawn(argv, env=None, output=None, errors=None):
    child = subprocess.Popen(argv, env=env or {'PATH': os.defpath}, stdout=output,
                             stderr=errors if errors is not None else output, start_new_session=True)
    children.append(child)
    state = json.loads(MANIFEST.read_text())
    record = identity(child.pid)
    if record is None:
        child.wait(timeout=5)
        raise RuntimeError('child exited before ownership record')
    state['children'].append(record)
    save(MANIFEST, state)
    return child


def owned_rss():
    total = 0
    if sys.platform == 'darwin':
        for child in children:
            if child.poll() is None:
                result = subprocess.run(['ps', '-p', str(child.pid), '-o', 'rss='], capture_output=True, text=True)
                total += int(result.stdout.strip() or 0) * 1024
        return total
    for child in children:
        if child.poll() is not None:
            continue
        pending, seen = [child.pid], set()
        while pending:
            pid = pending.pop()
            if pid in seen:
                continue
            seen.add(pid)
            if len(seen) > 128:
                raise RuntimeError('owned descendant budget')
            try:
                if os.getpgid(pid) != child.pid or Path(f'/proc/{pid}').stat().st_uid != os.getuid():
                    raise RuntimeError('owned descendant identity mismatch')
                status = Path(f'/proc/{pid}/status').read_text()
                pending.extend(map(int, Path(f'/proc/{pid}/task/{pid}/children').read_text().split()))
            except (FileNotFoundError, ProcessLookupError):
                continue
            total += sum(int(row.split()[1]) * 1024 for row in status.splitlines() if row.startswith('VmRSS:'))
    return total


def wait(child, seconds, interval=.2):
    deadline = time.monotonic() + seconds
    while child.poll() is None:
        if time.monotonic() > deadline or time.monotonic() > end or (ROOT / 'stop-request').exists():
            raise RuntimeError('lab deadline or stop request')
        size = sum(path.stat().st_size for path in ROOT.rglob('*') if path.is_file() and not path.is_symlink())
        if size > 2 * 1024**3 or shutil.disk_usage(ROOT).free < 4 * 1024**3:
            raise RuntimeError('disk budget')
        if owned_rss() > 1024**3:
            raise RuntimeError('owned process memory budget')
        time.sleep(interval)
    if child.returncode:
        raise RuntimeError('owned child failed; private logs retained until cleanup')


def capture(argv, path, env=None, allow_refusal=False):
    with path.open('wb') as output, path.with_suffix('.stderr').open('wb') as errors:
        child = spawn(argv, env, output, errors)
        try:
            wait(child, 10, .002)
        except RuntimeError:
            if not allow_refusal or child.poll() != 6:
                raise
    return path.read_bytes()


class Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_):
        pass
    def setup(self):
        super().setup()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    def relay(self):
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 <= length <= 16 * 1024 * 1024:
            self.send_error(413)
            return
        body = self.rfile.read(length)
        upstream = http.client.HTTPConnection('127.0.0.1', backend, timeout=15)
        try:
            headers = {key: value for key, value in self.headers.items()
                       if key.lower() not in ('connection', 'transfer-encoding', 'x-forwarded-proto', 'x-forwarded-for')}
            headers.update({'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '127.0.0.1'})
            upstream.request(self.command, self.path, body, headers)
            response = upstream.getresponse()
            data = response.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                raise RuntimeError('response budget')
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in ('connection', 'transfer-encoding', 'content-length'):
                    self.send_header(key, value)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        finally:
            upstream.close()
    do_GET = do_POST = do_PUT = relay


if sys.argv[1:] == ['cleanup']:
    cleanup()
    print('PI_LAB_CLEANUP=PASS')
    raise SystemExit(0)
if sys.argv[1:] != ['run'] or MANIFEST.exists():
    raise SystemExit('refused: new owned run required')

end = time.monotonic() + 600
os.nice(10)
if hasattr(os, 'sched_setaffinity'):
    os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:2])
for name in ('runtime', 'private', 'evidence'):
    (ROOT / name).mkdir(mode=0o700)
save(MANIFEST, {'format': 1, 'root': str(ROOT), 'uid': os.getuid(),
               'launcher': identity(os.getpid()), 'children': []})
signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
signal.signal(signal.SIGHUP, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
summary = {'result': 'FAIL', 'cpuAffinity': 2 if hasattr(os, 'sched_setaffinity') else None, 'nicenessIncrement': 10, 'sharedHostIdle': 'NOT_PROVEN', 'startLoad': os.getloadavg()}
proxy = None
try:
    expected = json.loads((ROOT / 'inputs/verified.json').read_text())
    actual = set()
    for path in (ROOT / 'inputs').rglob('*'):
        if path.is_symlink():
            raise RuntimeError('input link')
        if path.is_file() and path != ROOT / 'inputs/verified.json':
            actual.add(str(path.relative_to(ROOT / 'inputs')))
    if actual != set(expected['sha256']) or not {'server.tar.gz', 'node.tar.gz', 'crypto.js', 'tls.crt', 'tls.key'} <= actual:
        raise RuntimeError('input inventory mismatch')
    for relative, digest in expected['sha256'].items():
        path = ROOT / 'inputs' / relative
        if relative.startswith('/') or '..' in Path(relative).parts or path.is_symlink() or not path.is_file():
            raise RuntimeError('invalid input path')
        if not re.fullmatch('[a-f0-9]{64}', digest) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError('input hash mismatch')
    summary['provenance'] = expected['provenance']
    summary['inputsSha256'] = {name: digest for name, digest in expected['sha256'].items() if name != 'tls.key'}
    # Archives have already passed publisher/signed-checksum verification on the controller.
    server_files = {'LICENSE', 'dashboard/index.html', 'obsyncd', 'obsyncd.service',
                    'plugin/main.js', 'plugin/manifest.json', 'plugin/styles.css'}
    with tarfile.open(ROOT / 'inputs/server.tar.gz') as archive:
        members = archive.getmembers()
        if {item.name for item in members} != server_files or len(members) != len(server_files):
            raise RuntimeError('server archive inventory')
        if any(not item.isfile() or item.size > 64 * 1024**2 for item in members) or sum(item.size for item in members) > 64 * 1024**2:
            raise RuntimeError('server archive member')
        for item in members:
            path = ROOT / 'runtime/server' / item.name
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            path.write_bytes(archive.extractfile(item).read())
    binary = ROOT / 'runtime/server/obsyncd'; binary.chmod(0o700)
    with tarfile.open(ROOT / 'inputs/node.tar.gz') as archive:
        member = archive.getmember('node-v26.10.0-' + ('darwin-arm64' if sys.platform == 'darwin' else 'linux-arm64') + '/bin/node')
        if not member.isfile() or member.size > 160 * 1024**2:
            raise RuntimeError('runtime member')
        node = ROOT / 'runtime/node'; node.write_bytes(archive.extractfile(member).read()); node.chmod(0o700)
    for pass_name in ('sample-1', 'sample-2', 'sample-3'):
        data = ROOT / 'runtime' / pass_name
        (data / 'blobs').mkdir(parents=True, mode=0o700); (data / 'journal').mkdir(mode=0o700)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); backend = sock.getsockname()[1]
        proxy = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(ROOT / 'inputs/tls.crt', ROOT / 'inputs/tls.key')
        proxy.socket = context.wrap_socket(proxy.socket, server_side=True)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True); thread.start()
        env = {'PATH': os.defpath, 'OBSYNC_EDGE': 'none', 'OBSYNC_LISTEN': f'127.0.0.1:{backend}',
               'OBSYNC_PUBLIC_URL': f'https://obsync-bench.invalid:{proxy.server_port}',
               'OBSYNC_TRUSTED_PROXY_CIDRS': '127.0.0.1/32', 'OBSYNC_BLOBS_DIR': str(data / 'blobs'),
               'OBSYNC_JOURNAL_DIR': str(data / 'journal'), 'OBSYNC_BLOBS_CAPACITY': '8GiB',
               'OBSYNC_JOURNAL_CAPACITY': '4GiB', 'OBSYNC_DASHBOARD_DIR': str(ROOT / 'runtime/server/dashboard'),
               'OBSYNC_PLUGIN_DIR': str(ROOT / 'runtime/server/plugin')}
        argv = [str(binary), 'serve']
        with (ROOT / f'private/{pass_name}-server.log').open('w') as log:
            server = spawn(argv, env, log)
            ready = False
            for _ in range(60):
                if server.poll() is not None: break
                try:
                    conn = http.client.HTTPConnection('127.0.0.1', backend, timeout=.5)
                    conn.request('GET', '/readyz'); response = conn.getresponse()
                    ready = response.status == 200 and json.loads(response.read()).get('ready') is True
                    conn.close()
                except (OSError, ValueError): pass
                if ready: break
                time.sleep(.25)
            if not ready: raise RuntimeError('readiness deadline')
            token = capture([str(binary), 'setup-token'], ROOT / 'private/setup-token', env).decode().strip()
            save(ROOT / 'private/client.json', {'port': proxy.server_port, 'setupToken': token, 'pass': pass_name})
            with (ROOT / 'private/client.log').open('a') as client_log:
                wait(spawn([str(node), '--max-old-space-size=256', str(ROOT / 'component-profile.mjs'), str(ROOT)], output=client_log), 180)
            record = next(item for item in json.loads(MANIFEST.read_text())['children'] if item['pid'] == server.pid)
            stop(record); server.wait(timeout=5)
        proxy.shutdown(); proxy.server_close(); thread.join(timeout=5); proxy = None
    summary['result'] = 'PASS'
except BaseException as error:
    summary['failureType'] = type(error).__name__
    (ROOT / 'private/failure.txt').write_text(str(error) + '\n')
finally:
    if proxy:
        proxy.shutdown(); proxy.server_close()
    summary['endLoad'] = os.getloadavg()
    save(ROOT / 'evidence/result.json', summary)
    try:
        cleanup()
    except BaseException as error:
        summary.update({'result': 'FAIL', 'teardownFailure': type(error).__name__})
        save(ROOT / 'evidence/result.json', summary)
        raise
print('PI_LAB=' + summary['result'])
raise SystemExit(0 if summary['result'] == 'PASS' else 1)
