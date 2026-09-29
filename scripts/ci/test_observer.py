"""The observer scanner catches a planted secret in every encoding, and passes
a capture that holds only ciphertext.

scripts/ci/observer.mjs proves obsync's on-the-wire blindness: it records the
terminator->server hop and searches it for anything that must never cross. A
scanner is only evidence if it FAILS when a secret is present, so this plants
one sentinel in each encoding a leak could take -- UTF-8, UTF-16LE, hex,
base64, base64url, base32, percent-encoded, a JSON \\u escape, and base64
nested inside a JSON string -- and requires a FAIL on each, then requires a
PASS on a capture of the same shape carrying only random ciphertext. A change
that made the scanner miss an encoding, or pass everything, turns one of these
red.

Run by the gate under `python3 -B -m unittest discover -s scripts/ci`.
"""

import base64
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
OBSERVER = os.path.join(HERE, "observer.mjs")
NODE = shutil.which("node")

# A distinctive sentinel and a 32-byte key, neither a substring of the other.
SENTINEL = "SENTINEL-observer-secret-note-body-zzz"
VRK_HEX = "00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f"


def _b32(data: bytes) -> str:
    return base64.b32encode(data).decode().rstrip("=")


def _message(method: str, target: str, body: bytes) -> bytes:
    head = f"{method} {target} HTTP/1.1\r\nHost: obsync.invalid\r\nContent-Length: {len(body)}\r\n\r\n"
    return head.encode("latin1") + body


def _capture(tmp: str, up: bytes, down: bytes = b"") -> str:
    cap = tempfile.mkdtemp(dir=tmp)
    with open(os.path.join(cap, "c1.up"), "wb") as handle:
        handle.write(up)
    with open(os.path.join(cap, "c1.down"), "wb") as handle:
        handle.write(down or _message_response())
    return cap


def _message_response() -> bytes:
    body = b'{"seq":7,"conflicted":false}'
    return b"HTTP/1.1 201 Created\r\nContent-Length: %d\r\n\r\n%s" % (len(body), body)


def _scan(cap: str, needles: dict) -> dict:
    fd, needles_file = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w") as handle:
        json.dump(needles, handle)
    try:
        result = subprocess.run(
            [NODE, OBSERVER, "scan", "--capture", cap, "--needles", needles_file, "--json"],
            capture_output=True,
            text=True,
            check=False,
        )
    finally:
        os.unlink(needles_file)
    return json.loads(result.stdout)


@unittest.skipIf(NODE is None, "node is not installed")
class ObserverScanner(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.text_needles = {"text": {"note": SENTINEL}}
        self.key_needles = {"hex": {"vrk": VRK_HEX}}

    def _bodies_for_sentinel(self):
        raw = SENTINEL.encode("utf-8")
        yield "utf8", raw
        yield "utf16le", SENTINEL.encode("utf-16le")
        yield "hex-lower", raw.hex().encode()
        yield "hex-upper", raw.hex().upper().encode()
        yield "base64", base64.b64encode(raw)
        yield "base64url", base64.urlsafe_b64encode(raw)
        yield "base32", _b32(raw).encode()
        yield "json-nested-base64", json.dumps({"manifest_ct": base64.b64encode(raw).decode()}).encode()

    def test_each_encoding_of_a_sentinel_is_caught(self):
        for name, body in self._bodies_for_sentinel():
            cap = _capture(self.tmp, _message("POST", "/v1/files/aa/versions", body))
            out = _scan(cap, self.text_needles)
            self.assertEqual(out["decision"], "fail", f"missed the sentinel in {name}: {out}")
            self.assertTrue(any(h["label"] == "text:note" for h in out["hits"]), name)

    def test_percent_encoded_sentinel_in_the_target_is_caught(self):
        from urllib.parse import quote

        target = "/v1/changes?since=0&note=" + quote(SENTINEL)
        cap = _capture(self.tmp, _message("GET", target, b""))
        out = _scan(cap, self.text_needles)
        self.assertEqual(out["decision"], "fail", out)

    def test_json_unicode_escape_of_a_sentinel_is_caught(self):
        escaped = "".join(f"\\u{ord(c):04x}" for c in SENTINEL)
        body = ('{"detail":"' + escaped + '"}').encode()
        cap = _capture(self.tmp, _message("POST", "/v1/x", body))
        out = _scan(cap, self.text_needles)
        self.assertEqual(out["decision"], "fail", out)

    def test_raw_vault_key_bytes_are_caught(self):
        body = b"prefix" + bytes.fromhex(VRK_HEX) + b"suffix"
        cap = _capture(self.tmp, _message("PUT", "/v1/chunks/aa", body))
        out = _scan(cap, self.key_needles)
        self.assertEqual(out["decision"], "fail", out)
        self.assertTrue(any(h["label"] == "key:vrk" for h in out["hits"]))

    def test_a_key_derived_from_the_vault_key_is_caught(self):
        # domain-map key = HKDF-SHA256(ikm=vrk, salt="obsync/v1/domainmap",
        # info="", L=32), exactly observer.mjs's derivation. RFC 5869:
        # PRK = HMAC(salt, ikm); OKM = HMAC(PRK, info || 0x01)[:32].
        import hashlib
        import hmac

        vrk = bytes.fromhex(VRK_HEX)
        prk = hmac.new(b"obsync/v1/domainmap", vrk, hashlib.sha256).digest()
        okm = hmac.new(prk, b"\x01", hashlib.sha256).digest()
        body = b"lead" + okm + b"tail"
        cap = _capture(self.tmp, _message("PUT", "/v1/chunks/bb", body))
        out = _scan(cap, self.key_needles)
        self.assertEqual(out["decision"], "fail", out)
        self.assertTrue(any(h["label"] == "key:derived:domain-map" for h in out["hits"]), out)

    def test_a_ciphertext_only_capture_passes(self):
        ciphertext = base64.b64encode(os.urandom(4096))
        manifest = base64.b64encode(os.urandom(512)).decode()
        body = json.dumps({"manifest_ct": manifest, "sids": [os.urandom(32).hex()]}).encode()
        cap = _capture(
            self.tmp,
            _message("PUT", "/v1/chunks/" + os.urandom(32).hex(), ciphertext)
            + _message("POST", "/v1/files/" + os.urandom(16).hex() + "/versions", body),
        )
        out = _scan(cap, {"text": {"note": SENTINEL}, "hex": {"vrk": VRK_HEX}})
        self.assertEqual(out["decision"], "pass", out)
        self.assertEqual(out["hits"], [])

    def test_the_visibility_inventory_names_the_route_and_headers(self):
        cap = _capture(self.tmp, _message("POST", "/v1/files/" + "a" * 32 + "/versions", b"{}"))
        out = _scan(cap, {"text": {"note": SENTINEL}})
        self.assertIn("POST /v1/files/{id}/versions ×1", out["visible"]["routes"])
        self.assertIn("content-length", out["visible"]["requestHeaders"])


if __name__ == "__main__":
    unittest.main()
