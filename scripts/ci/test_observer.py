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
    _seal(cap)
    return cap


def _seal(cap):
    sizes = {part: os.path.getsize(os.path.join(cap, f"c1.{part}")) for part in ("up", "down")}
    with open(os.path.join(cap, "index.jsonl"), "w") as handle:
        handle.write(json.dumps({"n": 1, **sizes}) + "\n")
    with open(os.path.join(cap, "complete.json"), "w") as handle:
        json.dump({"version": 1, "connections": 1, "errors": []}, handle)


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
    out = json.loads(result.stdout)
    if result.returncode != (0 if out["decision"] == "pass" else 1):
        raise AssertionError("scanner verdict and exit disagree")
    return out


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
            _message_response() + _message_response(),
        )
        out = _scan(cap, {"text": {"note": SENTINEL}, "hex": {"vrk": VRK_HEX}})
        self.assertEqual(out["decision"], "pass", out)
        self.assertEqual(out["hits"], [])

    def test_a_recovery_word_that_is_a_protocol_field_name_is_not_a_hit(self):
        # "address" is a BIP-39 word AND a device-list field name: a phrase
        # holding it must not fail every capture that lists devices.
        devices = b'{"devices":[{"name":"Mac","address":"192.0.2.1","country":"XX"}]}'
        down = b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s" % (len(devices), devices)
        cap = _capture(self.tmp, _message("GET", "/v1/devices", b""), down)
        out = _scan(cap, {"phrase": "abandon ability address"})
        self.assertEqual(out["decision"], "pass", out)
        self.assertEqual(out["skipped"], ["recovery:word:2"], out)

    def test_a_recovery_word_in_a_value_is_still_caught(self):
        # The same phrase, with a word that is NOT protocol vocabulary sent as
        # a value: the per-word needle still fires.
        cap = _capture(self.tmp, _message("PATCH", "/v1/devices/" + "a" * 32, b'{"name":"ability"}'))
        out = _scan(cap, {"phrase": "abandon ability address"})
        self.assertEqual(out["decision"], "fail", out)
        self.assertTrue(any(h["label"] == "recovery:word:1" for h in out["hits"]), out)

    def test_the_visibility_inventory_names_the_route_and_headers(self):
        cap = _capture(self.tmp, _message("POST", "/v1/files/" + "a" * 32 + "/versions", b"{}"))
        out = _scan(cap, {"text": {"note": SENTINEL}})
        self.assertIn("POST /v1/files/{id}/versions ×1", out["visible"]["routes"])
        self.assertIn("content-length", out["visible"]["requestHeaders"])


    def test_missing_work_never_passes(self):
        empty = tempfile.mkdtemp(dir=self.tmp)
        self.assertEqual(_scan(empty, self.text_needles)["decision"], "fail")
        cap = _capture(self.tmp, _message("POST", "/v1/x", SENTINEL.encode()))
        for needles in ({}, {"text": {}}, {"hex": {"key": "zzzz"}}, {"text": {"note": ""}}, {"codes": [""]}):
            self.assertEqual(_scan(cap, needles)["decision"], "fail")

    def test_failed_report_does_not_repeat_the_secret(self):
        cap = _capture(self.tmp, _message("POST", "/" + SENTINEL, json.dumps({SENTINEL: "public"}).encode()))
        out = _scan(cap, self.text_needles)
        self.assertEqual(out["decision"], "fail")
        self.assertNotIn(SENTINEL, json.dumps(out))
        self.assertEqual(out["visible"], {})

    def test_uninventoried_files_and_links_refuse(self):
        for mode in ("extra", "link"):
            cap = _capture(self.tmp, _message("POST", "/v1/x", b"ciphertext"))
            if mode == "extra":
                with open(os.path.join(cap, "unread.bin"), "wb") as handle:
                    handle.write(SENTINEL.encode())
            else:
                os.rename(os.path.join(cap, "c1.up"), os.path.join(self.tmp, "outside"))
                os.symlink(os.path.join(self.tmp, "outside"), os.path.join(cap, "c1.up"))
            self.assertEqual(_scan(cap, self.text_needles)["decision"], "fail")

    def test_recorder_short_writes_and_io_failures(self):
        # Real sockets and the recorder's actual fs calls. Short writes must
        # be completed; write/flush failures must latch even after recovery.
        source = r'''
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
const module = process.argv[1]; process.argv[1] = "recorder-test";
const { startRecorder, readCapture, scan, buildNeedles } = await import(module);
const mode = process.argv[2], out = process.argv[3];
const server = http.createServer((req, res) => { req.resume(); req.on("end", () => res.end("public")); });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const relay = await startRecorder({ listen: "127.0.0.1:0", upstream: `127.0.0.1:${server.address().port}`, out });
const write = fs.writeSync, flush = fs.fsyncSync;
let calls = 0;
fs.writeSync = (fd, data, offset, length, ...rest) => {
  calls++;
  if (mode === "write" && calls === 1) throw new Error("injected");
  return write(fd, data, offset, Math.min(length, 3), ...rest);
};
if (mode === "flush") fs.fsyncSync = () => { throw new Error("injected"); };
try {
  await new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${relay.port}/`, { method: "POST", agent: false }, (res) => {
      res.resume(); res.on("end", resolve); res.on("error", resolve);
    });
    req.on("error", resolve); req.setTimeout(3000, () => req.destroy()); req.end("public");
  });
  if (mode === "short") await relay.close();
  else await assert.rejects(relay.close(), /recorder_failed/);
} finally {
  fs.writeSync = write; fs.fsyncSync = flush;
  await new Promise((resolve) => server.close(resolve));
}
assert.ok(calls > 0);
const result = scan(readCapture(out), buildNeedles({ text: { note: "SENTINEL-not-sent" } }));
assert.equal(result.decision, mode === "short" ? "pass" : "fail");
if (mode !== "short") assert.ok(result.errors.length);
'''
        for mode in ("short", "write", "flush"):
            with self.subTest(mode=mode):
                cap = os.path.join(self.tmp, mode)
                result = subprocess.run([NODE, "--input-type=module", "-e", source, OBSERVER, mode, cap],
                                        capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_raw_incomplete_header_is_scanned_and_refused(self):
        cap = _capture(self.tmp, b"POST /v1/x HTTP/1.1\r\nX-Test: " + SENTINEL.encode())
        out = _scan(cap, self.text_needles)
        self.assertEqual(out["decision"], "fail")
        self.assertTrue(out["hits"])
        self.assertIn("http_header_truncated", out["errors"])

    def test_close_delimited_bodies_are_scanned(self):
        for body, decision in [(SENTINEL.encode(), "fail"), (b"ciphertext-only", "pass")]:
            cap = _capture(self.tmp, _message("GET", "/v1/x", b""), b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + body)
            self.assertEqual(_scan(cap, self.text_needles)["decision"], decision)
        # Raw-byte scanning alone cannot find this nested encoded value;
        # dropping the close-delimited body must also lose this test.
        nested = json.dumps({"inside": base64.b64encode(SENTINEL.encode()).decode()}).encode()
        body = json.dumps({"data": base64.b64encode(nested).decode()}).encode()
        cap = _capture(self.tmp, _message("GET", "/v1/x", b""), b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + body)
        self.assertEqual(_scan(cap, self.text_needles)["decision"], "fail")

    def test_bodyless_responses_still_refuse_duplicate_framing(self):
        cap = _capture(self.tmp, _message("GET", "/v1/x", b""),
                       b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n")
        self.assertEqual(_scan(cap, self.text_needles)["decision"], "fail")

    def test_needle_builder_refuses_an_empty_corpus(self):
        source = '''import assert from "node:assert/strict";
const module = process.argv[1]; process.argv[1] = "needle-test";
const { buildNeedles } = await import(module);
assert.throws(() => buildNeedles({}), /needles_empty/);
'''
        result = subprocess.run([NODE, "--input-type=module", "-e", source, OBSERVER], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_bad_framing_refuses_even_without_a_hit(self):
        for headers, body in [
            (b"Content-Length: -1", b""), (b"Content-Length: NaN", b""),
            (b"Content-Length: 20", b"short"),
            (b"Content-Length: 0\r\nContent-Length: 0", b""),
            (b"Content-Length: 0\r\nTransfer-Encoding: chunked", b"0\r\n\r\n"),
            (b"Transfer-Encoding: xchunked", b"0\r\n\r\n"),
            (b"Transfer-Encoding: chunked", b"3\r\nab"),
            (b"Transfer-Encoding: chunked", b"3\r\nabc\r\n"),
            (b"Transfer-Encoding: chunked", b"Q\r\nabc\r\n0\r\n\r\n"),
        ]:
            with self.subTest(headers=headers, body=body):
                cap = _capture(self.tmp, b"POST /v1/x HTTP/1.1\r\n" + headers + b"\r\n\r\n" + body)
                self.assertEqual(_scan(cap, self.text_needles)["decision"], "fail")

    def test_chunk_framing_handles_embedded_terminators_and_trailers(self):
        body = b"before0\r\n\r\nafter"
        wire = hex(len(body))[2:].encode() + b"\r\n" + body + b"\r\n0\r\nX-Trailer: "
        for trailer, decision in [(b"public", "pass"), (SENTINEL.encode(), "fail")]:
            cap = _capture(self.tmp, b"POST /v1/x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n" + wire + trailer + b"\r\n\r\n")
            self.assertEqual(_scan(cap, self.text_needles)["decision"], decision)

    def test_unknown_or_broken_compression_refuses(self):
        import gzip
        for encoding, body, decision in [
            (b"gzip", b"broken", "fail"), (b"unknown", b"public", "fail"),
            (b"gzip", gzip.compress(SENTINEL.encode()), "fail"),
            (b"gzip", gzip.compress(b"ciphertext-only"), "pass"),
        ]:
            head = b"POST /v1/x HTTP/1.1\r\nContent-Encoding: " + encoding + b"\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n"
            self.assertEqual(_scan(_capture(self.tmp, head + body), self.text_needles)["decision"], decision)

    def test_base64_needles_at_every_byte_alignment(self):
        for offset in range(3):
            body = base64.b64encode(b"x" * offset + bytes.fromhex(VRK_HEX) + b"suffix")
            out = _scan(_capture(self.tmp, _message("POST", "/v1/x", body)), self.key_needles)
            self.assertEqual(out["decision"], "fail")
            self.assertTrue(out["hits"])

    def test_protocol_words_do_not_exempt_secret_values(self):
        body = b'{"address":"address","other":"public"}'
        out = _scan(_capture(self.tmp, _message("POST", "/v1/x", body)), {"phrase": "abandon ability address"})
        self.assertEqual(out["decision"], "fail")
        self.assertTrue(any(hit["label"] == "recovery:word:2" for hit in out["hits"]))

    def test_decode_budget_is_a_refusal(self):
        value = "public"
        for _ in range(15):
            value = [value]
        cap = _capture(self.tmp, _message("POST", "/v1/x", json.dumps(value).encode()))
        self.assertEqual(_scan(cap, self.text_needles)["decision"], "fail")

    def test_missing_or_mismatched_recording_evidence_refuses(self):
        for action in ("missing_receipt", "missing_direction", "wrong_count", "write_failure", "wrong_bytes"):
            with self.subTest(action=action):
                cap = _capture(self.tmp, _message("GET", "/v1/x", b""))
                if action == "missing_receipt":
                    os.unlink(os.path.join(cap, "complete.json"))
                elif action == "missing_direction":
                    os.unlink(os.path.join(cap, "c1.down"))
                elif action == "wrong_bytes":
                    with open(os.path.join(cap, "c1.up"), "ab") as handle:
                        handle.write(_message("GET", "/v1/y", b""))
                else:
                    with open(os.path.join(cap, "complete.json"), "w") as handle:
                        json.dump({"version": 1, "connections": 2 if action == "wrong_count" else 1,
                                   "errors": ["recorder_write"] if action == "write_failure" else []}, handle)
                self.assertEqual(_scan(cap, self.text_needles)["decision"], "fail")


if __name__ == "__main__":
    unittest.main()
