"""Compare emitted plugin routes with real server CORS, without a third route list.

Run this file directly after building plugin/build and target/debug/obsyncd.
Cold unittest discovery exercises the resolver parser without build prerequisites.
The resolver parser deliberately supports only its current closed match grammar;
new routing syntax requires an explicit test update rather than silently skipping it.
"""
import http.client
import io
import itertools
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def server_targets(source):
    body = source.split('let r = match (method, segs.as_slice()) {')[1].split('_ => return None,')[0]
    arms = list(re.finditer(
        r'^\s*\("([A-Z]+)", \[([^\]\n]*)\]\)(?: if matches!\(\*name, ([^\n]*)\))? =>',
        body, re.MULTILINE,
    ))
    assert len(arms) == body.count('=>'), 'unsupported server resolver arm'
    targets = []
    for arm in arms:
        segments = []
        for token in filter(None, (part.strip() for part in arm[2].split(','))):
            if re.fullmatch(r'"[a-z0-9./-]+"', token):
                segments.append([json.loads(token)])
            elif token in ('id', 'sid', 'f', 'v', 'op'):
                # Both hex widths used by production routes; regex matching below
                # determines which concrete method/path belongs to the client.
                segments.append(['1' * 32, '1' * 64])
            elif token == 'name' and arm[3]:
                choices = arm[3].split(' | ')
                assert all(re.fullmatch(r'"[a-z0-9.-]+"', choice) for choice in choices), \
                    'unsupported dashboard route guard'
                segments.append([json.loads(choice) for choice in choices])
            else:
                raise AssertionError('unsupported server route segment')
        targets.extend((arm[1], '/' + '/'.join(parts)) for parts in itertools.product(*segments))
    assert targets, 'server route inventory must not be empty'
    return targets


def client_targets(targets):
    # Evaluate the compiled export, including its real RegExp matching behavior.
    program = r'''
const { ROUTES } = require('./plugin/build/transport.js');
const fs = require('node:fs'), assert = require('node:assert/strict');
const targets = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.ok(ROUTES.length, 'client route inventory must not be empty');
for (const route of ROUTES) {
  assert.equal(route.path.flags, '', 'unsupported client route flags');
  const source = route.path.source;
  assert.ok(source.startsWith('^') && source.endsWith('$'), 'client routes must be anchored');
  const path = source.slice(1, -1).replace(/\[0-9a-f\]\{(32|64)\}/g,
    (_, n) => '1'.repeat(Number(n))).replaceAll('\\/', '/');
  assert.match(path, /^\/[a-z0-9/-]+$/, 'unsupported client route regex');
  assert.ok(route.path.test(path), 'client representative must match its route');
  targets.push([route.method, path]);
}
console.log(JSON.stringify([...new Map(targets.map(([method, path]) =>
  [method + ' ' + path, {method, path, allowed: ROUTES.some(route =>
    route.method === method && route.path.test(path))}])).values()]));
'''
    result = subprocess.run(['node', '-e', program], cwd=ROOT, input=json.dumps(targets),
                            text=True, capture_output=True, timeout=10, check=True)
    return json.loads(result.stdout)


class CorsRouteInventory(unittest.TestCase):
    def test_current_resolver_grammar_supported(self):
        self.assertTrue(server_targets((ROOT / 'crates/obsyncd/src/api/mod.rs').read_text()))

    def test_unsupported_resolver_arm_is_not_silently_skipped(self):
        source = (ROOT / 'crates/obsyncd/src/api/mod.rs').read_text()
        source = source.replace('        _ => return None,',
            '        ("GET" | "POST", ["v1", "new"]) => (Route::Account, "/v1/new"),\n'
            '        _ => return None,')
        with self.assertRaisesRegex(AssertionError, '^unsupported server resolver arm$',
                                   msg='unsupported resolver arm must fail inventory'):
            server_targets(source)

    def test_cli_runs_live_oracle_and_propagates_refusal(self):
        original_main, calls = unittest.main, []

        def main():
            module = sys.modules['__main__']
            self.assertTrue('CorsRoutes' in vars(module), 'CLI must include the live CORS oracle')
            method = 'test_compiled_client_routes_equal_real_server_cors'
            self.assertTrue(hasattr(module.CorsRoutes, method), 'CLI must include the live CORS test')

            def refuse(instance):
                calls.append('live')
                instance.fail('planted live CORS refusal')

            with patch.object(module.CorsRoutes, method, refuse):
                original_main(module=module, argv=['cors-routes', 'CorsRoutes'],
                              testRunner=unittest.TextTestRunner(stream=io.StringIO()))

        with patch('unittest.main', main):
            with self.assertRaises(SystemExit, msg='CLI must propagate the live CORS refusal') as out:
                runpy.run_path(str(Path(__file__).resolve()), run_name='__main__')
        self.assertEqual(calls, ['live'], 'CLI must execute the composed CORS oracle')
        self.assertEqual(out.exception.code, 1, 'CLI must fail when the live CORS oracle fails')


if __name__ == '__main__':
    class CorsRoutes(unittest.TestCase):
        def test_compiled_client_routes_equal_real_server_cors(self):
            targets = client_targets(server_targets((ROOT / 'crates/obsyncd/src/api/mod.rs').read_text()))
            scratch = tempfile.TemporaryDirectory(prefix='obsync-cors-routes-')
            self.addCleanup(scratch.cleanup)
            directory = Path(scratch.name).resolve()
            log = (directory / 'server.log').open('w')
            self.addCleanup(log.close)
            process = subprocess.Popen([str(ROOT / 'target/debug/obsyncd'), 'serve'], cwd=ROOT,
                stdout=log, stderr=log, env={
                    'PATH': os.environ['PATH'], 'OBSYNC_LISTEN': '127.0.0.1:0', 'OBSYNC_EDGE': 'none',
                    'OBSYNC_BLOBS_DIR': str(directory / 'blobs'),
                    'OBSYNC_JOURNAL_DIR': str(directory / 'journal'),
                    'OBSYNC_BLOBS_CAPACITY': '4GiB', 'OBSYNC_JOURNAL_CAPACITY': '4GiB',
                    'OBSYNC_DASHBOARD_DIR': str(ROOT / 'dashboard'),
                    'OBSYNC_PLUGIN_DIR': str(ROOT / 'plugin/dist'),
                })

            def stop():
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                    self.fail('CORS fixture shutdown timed out')
                self.assertEqual(process.returncode, 0, 'CORS fixture must stop cleanly')

            self.addCleanup(stop)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                self.assertIsNone(process.poll(), 'CORS fixture exited before readiness')
                found = re.search(r'event=serve_start[^\n]*addr=127\.0\.0\.1:(\d+)',
                                  (directory / 'server.log').read_text())
                if found:
                    port = int(found[1])
                    break
                time.sleep(.025)
            else:
                self.fail('CORS fixture startup timed out')
            for target in targets:
                with self.subTest(method=target['method'], path=target['path']):
                    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
                    try:
                        connection.request('OPTIONS', target['path'], headers={
                            'Origin': 'http://cors.invalid',
                            'Access-Control-Request-Method': target['method'],
                            'Access-Control-Request-Headers': 'authorization, content-type',
                        })
                        response = connection.getresponse()
                        response.read()
                        self.assertEqual(response.status, 204 if target['allowed'] else 404,
                                         'server CORS grant must equal compiled client routes')
                        self.assertEqual(response.getheader('Access-Control-Allow-Origin'),
                                         '*' if target['allowed'] else None,
                                         'server CORS origin must equal compiled client routes')
                        self.assertIsNone(response.getheader('Access-Control-Allow-Credentials'),
                                          'server CORS must remain credential-free')
                    finally:
                        connection.close()

    unittest.main()
