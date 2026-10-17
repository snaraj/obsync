"""The shared proxy wire oracle refuses broken grants; no browser/mobile claim."""
from __future__ import annotations

import base64
import contextlib
import io
import re
import ssl
import subprocess
import tempfile
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import api_flow

ROOT = Path(__file__).resolve().parents[2]
CHUNK = b"\x00\xffSYNTHETIC_CORS_CHUNK"
STATE = {"first": {"device_id": "11" * 16, "secret": "22" * 32}, "sid": "33" * 32, "chunk": base64.b64encode(CHUNK).decode()}
NAMES = {"authorization", "x-obsync-device", "x-obsync-ts", "x-obsync-nonce", "x-obsync-sig", "x-service-secret"}


class Response:
    will_close = True

    def __init__(self, status, fields, body):
        self.status, self.fields, self.body = status, fields, body

    def getheaders(self):
        return self.fields

    def read(self):
        return self.body


class Connection:
    """Only HTTP response fixtures; signing and header construction are real."""
    def __init__(self, server):
        self.server = server

    def request(self, method, target, body, headers):
        self.server.calls.append((method, target, body, headers))

    def getresponse(self):
        method, target, _, headers = self.server.calls[-1]
        fields, body = [], b""
        if method == "OPTIONS":
            requested = headers.get("Access-Control-Request-Headers", "")
            if "Origin" not in headers or requested in ["Cookie", "*", "X-HTTP-Method-Override", "Proxy-Authorization", "Sec-Fetch-Site", "X-Obsync-Device, x-obsync-device"]:
                kind, status = "negative", 400
            elif target not in ["/v1/account", "/v1/devices/heartbeat"] or headers["Access-Control-Request-Method"] != ("GET" if target == "/v1/account" else "POST"):
                kind, status = "negative", 404
            else:
                kind, status = "preflight", 204
                fields = [("Access-Control-Allow-Origin", "*"), ("Access-Control-Allow-Methods", headers["Access-Control-Request-Method"]), ("Access-Control-Allow-Headers", ", ".join(sorted(n.lower() for n in requested.split(", ")))), ("Access-Control-Max-Age", "0"), ("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers")]
        else:
            fields = [("Access-Control-Allow-Origin", "*")]
            if target == "/v1/account":
                self.server.accounts += 1
                kind, status, body = ("success", 200, b"{}") if self.server.accounts == 1 else ("refusal", 401, b'{"error":"bad_signature"}')
            elif target == "/v1/devices/heartbeat":
                kind, status = "success", 204
            else:
                kind, status, body = "binary", 200, CHUNK
        if self.server.modify:
            status, fields, body = self.server.modify(kind, status, fields, body)
        return Response(status, fields, body)

    def close(self):
        pass


class Server(api_flow.Server):
    def __init__(self, modify=None):
        super().__init__("fixture.example.invalid", 1, "127.0.0.1", None)
        self.calls, self.accounts, self.modify = [], 0, modify

    def _connection(self, timeout):
        return Connection(self), True


def run(modify=None):
    server = Server(modify)
    flow = api_flow.Flow(server, "unused")
    flow.load = lambda: STATE
    with contextlib.redirect_stdout(io.StringIO()):
        api_flow.cors(flow)
    return server


class ProxyCors(unittest.TestCase):
    def test_anonymous_preflight_then_real_device_auth_success_and_refusal(self):
        server = run()
        preflights = [c for c in server.calls if c[0] == "OPTIONS"]
        self.assertEqual(len(preflights), 13)
        self.assertIn("/login", [c[1] for c in preflights])
        self.assertIn("/v1/admin/overview", [c[1] for c in preflights])
        for _, _, body, headers in preflights:
            self.assertEqual(body, b"")
            self.assertNotIn("Cookie", headers)
            self.assertNotIn("Authorization", headers)
            self.assertFalse(any(n.startswith("X-Obsync-") for n in headers))
        for method, target, _, headers in preflights[:2]:
            self.assertEqual(headers["Origin"], "app://obsidian.md")
            expected = NAMES | ({"content-type"} if target.endswith("heartbeat") else set())
            self.assertEqual({n.strip().lower() for n in headers["Access-Control-Request-Headers"].split(",")}, expected)
            self.assertEqual(headers["Access-Control-Request-Method"], "GET" if target.endswith("account") else "POST")
        actual = [c for c in server.calls if c[0] != "OPTIONS"]
        self.assertEqual(len(actual), 4)
        for _, _, _, headers in actual:
            self.assertEqual(headers["Origin"], "app://obsidian.md")
            self.assertEqual(headers["X-Obsync-Device"], STATE["first"]["device_id"])
            self.assertEqual(len(headers["X-Obsync-Sig"]), 64)
            self.assertEqual(headers["Authorization"], "Bearer SYNTHETIC_EDGE")
            self.assertNotIn("Cookie", headers)
        self.assertNotEqual(actual[0][3]["X-Obsync-Nonce"], actual[1][3]["X-Obsync-Nonce"])

    def test_response_corruptions_are_refused_by_the_real_oracle(self):
        cases = [
            ("preflight", "remove", "Access-Control-Allow-Origin", ""),
            ("success", "remove", "Access-Control-Allow-Origin", ""),
            ("refusal", "remove", "Access-Control-Allow-Origin", ""),
            ("success", "append", "Access-Control-Allow-Credentials", "true"),
            ("preflight", "append", "Access-Control-Allow-Credentials", "false"),
            ("success", "append", "Access-Control-Expose-Headers", "*"),
            ("success", "append", "Set-Cookie", "SYNTHETIC_COOKIE=1"),
            ("preflight", "replace", "Access-Control-Allow-Methods", "GET, POST"),
            ("preflight", "replace", "Access-Control-Allow-Headers", "*"),
            ("preflight", "replace", "Access-Control-Max-Age", "600"),
            ("preflight", "remove", "Vary", ""),
            ("negative", "append", "Access-Control-Allow-Origin", "*"),
            ("negative", "append", "Access-Control-Allow-Headers", "*"),
            ("success", "append", "access-control-allow-origin", "*"),
        ]
        for kind, operation, name, value in cases:
            with self.subTest(kind=kind, operation=operation, header=name):
                def modify(found, status, fields, body):
                    if found == kind:
                        if operation in ["remove", "replace"]:
                            fields = [(n, v) for n, v in fields if n.lower() != name.lower()]
                        if operation != "remove":
                            fields = fields + [(name, value)]
                    return status, fields, body
                with self.assertRaises(api_flow.Denied):
                    run(modify)

    def test_changed_binary_bytes_and_preflight_status_are_refused(self):
        for kind in ["binary", "preflight", "preflight_body"]:
            with self.subTest(kind=kind), self.assertRaises(api_flow.Denied):
                run(lambda found, status, fields, body: (200 if kind == "preflight" else status, fields, b"changed" if kind in ["binary", "preflight_body"] else body) if found == ("preflight" if kind == "preflight_body" else kind) else (status, fields, body))

    def test_same_case_duplicate_response_is_not_collapsed_before_validation(self):
        for wanted, code in [("preflight", 204), ("success", 200), ("success", 204), ("refusal", 401), ("binary", 200), ("negative", 400), ("negative", 404)]:
            with self.subTest(kind=wanted, code=code), self.assertRaisesRegex(api_flow.Denied, "duplicate CORS response header"):
                run(lambda kind, status, fields, body: (status, fields + [("Access-Control-Allow-Origin", "*"), ("Access-Control-Allow-Origin", "*")], body) if kind == wanted and status == code else (status, fields, body))

    def test_both_proxy_entrypoints_run_the_shared_cors_phase_after_enroll(self):
        # Include enclosing control flow, not just the invocation: a comment,
        # dead branch or swallowed refusal must change these executions.
        ci = (ROOT / "scripts/ci/proxy-e2e.sh").read_text()
        matrix = (ROOT / "scripts/validation/proxy_matrix.sh").read_text()
        blocks = [
            (ci[ci.index('  prove "it syncs:'):ci.index('  client proxy --expect-address')].split("\n", 1)[1], ["cors"]),
            (matrix[matrix.index('  prove "${proxy}: enrol, pair'):matrix.index("  # What the proxy saw")].split("\n", 1)[1], ["-B", "/synthetic/scripts/ci/api_flow.py", "cors", "--host", "fixture.invalid", "--port", "1", "--address", "127.0.0.1", "--cacert", "/synthetic/ca.crt", "--state", "/synthetic/state"]),
        ]
        stubs = r"""
set -euo pipefail
record="$1"; refusal="$2"
root=/synthetic; HOST=fixture.invalid; PORT=1; scratch=/synthetic
state=/synthetic/state; proxy=caddy
client() { printf '%s\n' "$@" >> "$record"; return "$refusal"; }
python3() { printf '%s\n' "$@" >> "$record"; return "$refusal"; }
prove() { :; }
deny() { exit 7; }
"""
        for block, wanted in blocks:
            for refusal in [0, 9]:
                with self.subTest(command=wanted[0], refusal=refusal), tempfile.TemporaryDirectory() as directory:
                    record = Path(directory) / "calls"
                    result = subprocess.run(["bash", "-c", stubs + block, "fixture", str(record), str(refusal)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
                    self.assertTrue(record.is_file(), "CORS helper never ran")
                    self.assertEqual(record.read_text().splitlines(), wanted, "one exact CORS invocation")
                    self.assertEqual(result.returncode, 7 if refusal else 0, "helper refusal must reach deny; success must continue")


class ProxyCertificateFixtures(unittest.TestCase):
    def certificate(self, script, scratch, missing_aki=False):
        text = (ROOT / script).read_text()
        if script.startswith("scripts/ci/"):
            block = text[text.index("openssl req -x509"):text.index("# (3) The stack")]
        else:
            block = text[text.index('tls="${scratch}/tls"'):text.index("export OBSYNC_IMAGE")]
        if missing_aki:
            # OpenSSL 3 adds AKI when unspecified; make the hostile fixture
            # explicitly omit it instead of relying on generator defaults.
            block = block.replace(r"authorityKeyIdentifier=keyid,issuer\n", r"authorityKeyIdentifier=none\n")
        subprocess.run(["bash", "-c", 'set -e; scratch="$1"; HOST=fixture.proxy.invalid; prove() { :; }; deny() { exit 1; }; ' + block, "fixture", str(scratch)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return scratch / "ca.crt", scratch / "tls/tls.crt", scratch / "tls/tls.key"

    def handshake(self, ca, cert, key):
        client = ssl.create_default_context(cafile=str(ca))
        client.verify_flags |= ssl.VERIFY_X509_STRICT
        server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server.load_cert_chain(str(cert), str(key))
        ci, co, si, so = (ssl.MemoryBIO() for _ in range(4))
        c = client.wrap_bio(ci, co, server_hostname="fixture.proxy.invalid")
        s = server.wrap_bio(si, so, server_side=True)
        for _ in range(20):
            try:
                c.do_handshake()
                return
            except ssl.SSLWantReadError:
                pass
            si.write(co.read())
            try:
                s.do_handshake()
            except ssl.SSLWantReadError:
                pass
            ci.write(so.read())
        self.fail("synthetic TLS handshake never settled")

    def test_issued_leaf_links_to_its_ca_and_strict_verification_succeeds(self):
        for script in ["scripts/ci/proxy-e2e.sh", "scripts/validation/proxy_matrix.sh"]:
            with self.subTest(script=script), tempfile.TemporaryDirectory() as directory:
                ca, cert, key = self.certificate(script, Path(directory))
                ca_text = subprocess.check_output(["openssl", "x509", "-in", str(ca), "-noout", "-text"], text=True)
                leaf_text = subprocess.check_output(["openssl", "x509", "-in", str(cert), "-noout", "-text"], text=True)
                ski = re.search(r"X509v3 Subject Key Identifier:\s*([A-Fa-f0-9:]+)", ca_text)
                aki = re.search(r"X509v3 Authority Key Identifier:\s*(?:keyid:)?([A-Fa-f0-9:]+)", leaf_text)
                self.assertIsNotNone(ski, "fixture CA has an SKI")
                self.assertIsNotNone(aki, "fixture leaf has an AKI")
                self.assertEqual(aki[1].lower(), ski[1].lower())
                self.handshake(ca, cert, key)

    def test_missing_aki_keeps_the_strict_verifier_refusal(self):
        for script in ["scripts/ci/proxy-e2e.sh", "scripts/validation/proxy_matrix.sh"]:
            with self.subTest(script=script), tempfile.TemporaryDirectory() as directory:
                ca, cert, key = self.certificate(script, Path(directory), missing_aki=True)
                leaf = subprocess.check_output(["openssl", "x509", "-in", str(cert), "-noout", "-text"], text=True)
                self.assertNotIn("X509v3 Authority Key Identifier:", leaf, "hostile leaf must actually omit AKI")
                with self.assertRaisesRegex(ssl.SSLCertVerificationError, "Missing Authority Key Identifier"):
                    self.handshake(ca, cert, key)


if __name__ == "__main__":
    unittest.main()
