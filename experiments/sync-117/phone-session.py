#!/usr/bin/env python3
"""Synthetic phone session (requires explicit exposure authorization), with two accountless TLS relays and a hard expiry."""
import argparse
import hashlib
import http.server
import importlib
import ipaddress
import io
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
import urllib.error
import urllib.request
import urllib.parse
import zipfile

ROOT = Path(__file__).resolve().parent
HARNESS = ROOT / 'harness/scripts/validation/lab'

def sha(body):
    return hashlib.sha256(body).hexdigest()

def watch_expiry(stop, read_deadline, stop_relays):
    """Independent of a blocked native driver or HTTP request."""
    while not stop.wait(.2):
        deadline = read_deadline()
        if deadline is not None and time.monotonic() >= deadline:
            stop.set()
            stop_relays()
            return

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--preflight', type=Path, required=True)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--local-control-only', action='store_true', help='check native setup and code regeneration, then clean up; creates no public relay')
    a = p.parse_args()
    source, preflight, run = a.source.resolve(strict=True), a.preflight.resolve(strict=True), a.run.resolve()
    os.environ['OBSYNC_LAB_SOURCE'] = str(source)
    sys.path.insert(0, str(HARNESS))
    lab = importlib.import_module('lab')
    run = lab.external(run)
    if run.exists():
        raise ValueError('fresh run required')
    facts = json.loads((preflight / 'preflight.json').read_text())
    head = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if facts['sourceHead'] != head or subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain']):
        raise ValueError('preflight source does not match clean current source')
    binary = preflight / 'obsyncd'
    vault = facts['fixtureVault']
    if not re.fullmatch(r'Obsync-Phone-Validation-[0-9]+-[0-9]+-[0-9]+', vault):
        raise ValueError('unexpected fixture vault')
    archive = preflight / (vault + '.zip')
    if binary.is_symlink() or archive.is_symlink() or sha(binary.read_bytes()) != facts['serverSha256'] or sha(archive.read_bytes()) != facts['zipSha256']:
        raise ValueError('preflight artifact mismatch')
    if set(facts['pluginHashes']) != {'main.js', 'manifest.json', 'styles.css'}:
        raise ValueError('unexpected plugin artifact names')
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    children = []
    server = None
    server_thread = None
    started = None
    deadline = None
    network = {'format': 1, 'sourceHead': head, 'ttlSeconds': 3600, 'processes': {}}
    # Source extraction is owned by this attempt and never contains credentials.
    inputs = run.parent / (run.name + '-inputs')
    if inputs.exists():
        raise ValueError('fresh inputs required')
    inputs.mkdir(mode=0o700)
    plugin = inputs / 'plugin'
    plugin.mkdir(mode=0o700)
    try:
        with zipfile.ZipFile(archive) as z:
            for name, digest in facts['pluginHashes'].items():
                body = z.read(vault + '/.obsidian/plugins/obsync-private-sync/' + name)
                if sha(body) != digest:
                    raise ValueError('ZIP plugin mismatch')
                (plugin / name).write_bytes(body)
    except BaseException:
        if not inputs.is_symlink():
            shutil.rmtree(inputs)
        raise

    def save_network():
        lab.save(run / 'private/phone-network.json', network)

    def tunnel(name, local):
        nonlocal started, deadline
        if started is None:
            started = time.time()
            deadline = time.monotonic() + 3600
            network['startedAtEpoch'] = started
            network['expiresAtEpoch'] = started + 3600
        command = ['/opt/homebrew/bin/cloudflared', 'tunnel', '--config', os.devnull,
                   '--url', local, '--no-autoupdate']
        logpath = run / 'private' / (name + '.log')
        with logpath.open('wb') as log:
            child = subprocess.Popen(command, stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                                     start_new_session=True, env={'PATH': os.defpath, 'NO_COLOR': '1'})
        children.append(child)
        record = {'pid': child.pid, 'identity': lab.identity(child.pid), 'argv': command}
        if not record['identity']:
            raise RuntimeError('relay exited during startup')
        network['processes'][name] = record
        save_network()
        until = time.monotonic() + 60
        while time.monotonic() < until and not stop.is_set():
            if child.poll() is not None:
                raise RuntimeError('relay exited during startup; private log retained until cleanup')
            found = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', logpath.read_text())
            if found:
                return child, found.group()
            stop.wait(.2)
        raise TimeoutError('relay readiness deadline')

    def stop_child(child):
        if child.poll() is None:
            record = next(x for x in network['processes'].values() if x['pid'] == child.pid)
            if lab.identity(child.pid) != record['identity']:
                raise RuntimeError('relay identity changed; no signal sent')
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if lab.identity(child.pid) != record['identity']:
                    raise RuntimeError('relay identity changed before bounded kill')
                child.kill()
                child.wait(timeout=5)

    dns_results = {}
    def wait_dns(url, label):
        samples = dns_results[label] = []
        until = time.monotonic() + 120
        host = urllib.parse.urlparse(url).hostname
        while time.monotonic() < until and not stop.is_set():
            answer = subprocess.run(['/usr/bin/dig', '+time=2', '+tries=1', '+short', host],
                capture_output=True, text=True, timeout=5)
            addresses = []
            for line in answer.stdout.splitlines():
                try:
                    addresses.append(ipaddress.ip_address(line.strip()))
                except ValueError:
                    pass
            samples.append({'atEpoch': time.time(), 'returncode': answer.returncode,
                            'addressCount': len(addresses)})
            if addresses:
                lab.save(run / 'evidence/dns-publication.json', dns_results)
                return
            stop.wait(2)
        raise TimeoutError('DNS publication deadline')

    # A separate watchdog ensures relay expiry even while a driver is blocked.
    def stop_relays():
        for child in list(children):
            stop_child(child)

    watchdog = threading.Thread(target=watch_expiry,
        args=(stop, lambda: deadline, stop_relays), daemon=True)
    watchdog.start()
    result = 'FAIL'
    stage = 'local-lab'
    probe_errors = []
    try:
        lab.up(SimpleNamespace(source_repo=source, binary=binary, plugin=plugin,
               obsidian='/Applications/Obsidian.app/Contents/MacOS/Obsidian',
               fixture=None, faults=False, devices=1), run)
        for step in ('init', 'setup-first'):
            stage = step
            subprocess.run(['node', str(HARNESS / 'journeys.mjs'), str(run), step], check=True, timeout=150)
        state = lab.load(run)
        stage = 'desktop-setting-control'
        subprocess.run(['node', str(ROOT / 'phone-route.mjs'), str(run)], check=True, timeout=90)
        if a.local_control_only:
            for command in ('generate', 'regenerate'):
                stage = 'local-pair-' + command
                subprocess.run(['node', str(ROOT / 'phone-pair.mjs'), str(ROOT / 'harness'),
                    str(run), command], check=True, timeout=90)
            result = 'LOCAL_CONTROL_PASS'
            lab.save(run / 'evidence/local-control.json', {'result': 'PASS', 'nativeSetup': True,
                'nativeSettings': True, 'nativeCodeRegeneration': True, 'publicRelaysStarted': False})
            return
        stage = 'api-relay-start'
        api_child, api_url = tunnel('api-tunnel', state['url'])
        # Quick Tunnel creation can precede its DNS records. Avoid priming the
        # native resolver's negative cache before the recursive reply exists.
        stage = 'dns-publication'
        wait_dns(api_url, 'api')
        # Read-only HTTPS probe validates normal system certificate trust.
        until = time.monotonic() + 120
        stage = 'trusted-https-readiness'
        while True:
            try:
                with urllib.request.urlopen(api_url + '/readyz', timeout=10) as r:
                    if json.load(r).get('ready') is not True:
                        raise ValueError('remote readiness is false')
                break
            except (OSError, ValueError) as error:
                reason = getattr(error, 'reason', None)
                probe_errors.append({'type': type(error).__name__, 'httpStatus': getattr(error, 'code', None),
                    'reasonType': type(reason).__name__, 'verifyCode': getattr(reason, 'verify_code', None)})
                if stop.is_set() or time.monotonic() >= until:
                    raise TimeoutError('trusted HTTPS readiness deadline') from None
                stop.wait(1)
        state['url'] = api_url
        state['transport'] = 'Account initialized locally; sync through trusted HTTPS relay. Disposable credentials; mock desktop keychain.'
        lab.save(run / 'lab.json', state)
        stage = 'desktop-https-setting'
        subprocess.run(['node', str(ROOT / 'phone-route.mjs'), str(run)], check=True, timeout=90)
        stage = 'zip-preparation'
        with zipfile.ZipFile(archive) as z:
            entries = {name: z.read(name) for name in z.namelist()}
        entries[vault + '/.obsidian/plugins/obsync-private-sync/data.json'] = json.dumps({'serverUrl': api_url}).encode()
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as z:
            for name, body in sorted(entries.items()):
                z.writestr(name, body)
        payload = output.getvalue()
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            if len(z.namelist()) != len(entries) or any(z.read(n) != b for n, b in entries.items()):
                raise ValueError('delivery ZIP verification failed')
        endpoint = '/' + os.urandom(24).hex() + '/' + vault + '.zip'

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_GET(self):
                self.respond(True)
            def do_HEAD(self):
                self.respond(False)
            def respond(self, body):
                if self.path != endpoint:
                    self.send_response(404)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                self.send_response(200)
                for key, value in {'Content-Type': 'application/zip', 'Content-Length': str(len(payload)),
                    'Content-Disposition': 'attachment; filename="' + vault + '.zip"',
                    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
                    'Content-Security-Policy': "default-src 'none'"}.items():
                    self.send_header(key, value)
                self.end_headers()
                if body:
                    self.wfile.write(payload)

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        local = 'http://127.0.0.1:' + str(server.server_port)
        with urllib.request.urlopen(local + endpoint, timeout=5) as r:
            if r.read() != payload:
                raise ValueError('local download mismatch')
        try:
            urllib.request.urlopen(local + '/', timeout=5)
            raise ValueError('unexpected directory listing')
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
        stage = 'download-relay-start'
        download_child, download_url = tunnel('download-tunnel', local)
        stage = 'download-dns-publication'
        wait_dns(download_url, 'download')
        stage = 'download-trusted-https-verification'
        with urllib.request.urlopen(download_url + endpoint, timeout=30) as response:
            if response.read() != payload:
                raise ValueError('trusted HTTPS download bytes differ')
        (run / 'private/download-url.txt').write_text(download_url + endpoint)
        lab.save(run / 'evidence/phone-network-ready.json', {
            'result': 'READY', 'sourceHead': head, 'pluginHashes': facts['pluginHashes'],
            'zipSha256': sha(payload), 'zipMembers': sorted(entries), 'trustedHttpsReadiness': True,
            'ttlSeconds': 3600, 'expiresAtEpoch': network['expiresAtEpoch'],
            'setupCompletedBeforePublicExposure': True, 'physicalPhone': 'NOT_RUN'})
        print(json.dumps({'result': 'READY', 'downloadUrlFile': str(run / 'private/download-url.txt'),
                          'expiresAtEpoch': network['expiresAtEpoch']}), flush=True)
        download_stopped = False
        stage = 'ready'
        while not stop.wait(.2):
            if (run / 'private/stop-phone.json').exists():
                result = 'STOPPED_BY_CONTROLLER'
                break
            if (run / 'private/stop-download.json').exists() and not download_stopped:
                stop_child(download_child)
                server.shutdown()
                server.server_close()
                server_thread.join(timeout=5)
                download_stopped = True
                lab.save(run / 'evidence/download-stopped.json', {'result': 'PASS', 'relayAbsent': download_child.poll() is not None})
            if api_child.poll() is not None or (not download_stopped and download_child.poll() is not None):
                raise RuntimeError('active relay exited unexpectedly')
        if stop.is_set():
            result = 'STOPPED_OR_EXPIRED'
    except Exception as error:
        logs = {}
        for path in (run / 'private').glob('*-tunnel.log'):
            body = path.read_text(errors='replace')
            logs[path.name] = {token: body.count(token) for token in (
                'Registered tunnel connection', 'failed to dial', 'timeout',
                'Unable to reach the origin service', 'protocol=quic', 'protocol=http2',
                'ERR', 'Requesting new quick Tunnel', 'quick Tunnel has been created')}
        if (run / 'evidence').is_dir():
            lab.save(run / 'evidence/phone-session-failure.json', {'result': 'FAIL', 'stage': stage,
                'exceptionType': type(error).__name__, 'probeErrors': probe_errors, 'relayLogCounts': logs,
                'dnsPublication': dns_results})
        raise
    finally:
        stop.set()
        watchdog.join(timeout=12)
        for child in reversed(children):
            stop_child(child)
        if server is not None:
            server.shutdown()
            server.server_close()
        if server_thread is not None:
            server_thread.join(timeout=5)
        if (run / 'lab.json').exists() and not lab.load(run).get('stopped'):
            lab.down(run)
        if inputs.is_symlink():
            raise RuntimeError('inputs became a link; preserved')
        shutil.rmtree(inputs)
        if (run / 'evidence').is_dir():
            lab.save(run / 'evidence/phone-network-cleanup.json', {'result': result,
                     'relayChildrenAbsent': all(c.poll() is not None for c in children),
                     'inputsAbsent': not inputs.exists(), 'atEpoch': time.time()})
        if (run / 'lab.json').exists():
            importlib.import_module('finalize').finalize(run)

if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        print(json.dumps({'result': 'FAIL', 'exceptionType': type(error).__name__,
                          'detail': 'Session refused or failed; only reduced evidence retained.'}), flush=True)
        sys.exit(1)
