"""A synthetic obsync device, so an end-to-end run proves the SYNC path.

WHY THIS EXISTS. `compose-e2e` and `helm-e2e` bring a documented deployment up
and prove it answers `/readyz`. A deployment that answers a probe and cannot
enrol a device is still broken for every reader of those guides, and issue #78
says so in the order a first deployment meets it: first boot with the setup
token, a second device paired through the API, one file pushed and pulled, a
restart that keeps both, and the refusals that say the API is closed to
everything else.

None of that is the protocol's own test -- `crates/obsyncd/src/api` proves the
wire contract in process, against fakes, at unit speed. What this proves is the
DEPLOYMENT: the same flow through a TLS terminator, containers, and volumes
that outlive a restart, which is where the reference activation's refusals
lived.

IT IS A DEVICE, NOT A CLIENT LIBRARY. It signs the way `docs/protocol.md`
says a device signs, computes the version id the way the server recomputes it,
and holds opaque bytes where a real device holds ciphertext. It never asks the
server to decrypt anything, because no request on this API can (requirement 6):
the chunk body and the manifest are bytes the server stores and returns, and
this client generates them with `secrets.token_bytes` rather than pretending to
encrypt. A stronger crypto fake would test this file.

WHAT IT REFUSES TO DO. It prints no credential: not the setup token it is
given, not a device secret the server mints, not the state file's contents. A
refusal prints the decision, the route, and the status -- never the request it
was signed with. The state file that carries the two device credentials between
phases is written `0600` into the caller's scratch directory, which both
end-to-end scripts delete from an EXIT trap.

PHASES, because a restart happens between them:

  enroll  first boot, pairing, push, pull, and the negative probes; writes the
          state file.
  verify  the same two devices AFTER the restart: the file is still there and
          still byte-for-byte, the nonce spent before the restart is still
          refused (the journal remembers it), and a freshly signed request
          still works.
  proxy   after `enroll`, the properties a reverse proxy in front can break
          while `/readyz` stays green: the largest chunk the protocol admits,
          a full 32 MiB batch download, a 55 s long poll held open and a
          long poll woken by a write, the client address the server records
          when the client forges `X-Forwarded-For`, and the server's own port
          unreachable from where the client stands.
  bench   the numbers docs/benchmarks.md names (B1, B2, B3, B7) against a
          fresh deployment, with the server's CPU, memory, write bytes and --
          optionally -- fsync calls read from its /proc entry. It proves
          nothing and refuses only a broken run; the numbers are the output.

Requirement 12: one START line with the budgets, one line per proven property
with its duration, one SUMMARY with the decision.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import http.client
import json
import os
import resource
import secrets
import signal
import socket
import ssl
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

# docs/protocol.md, "Authentication". The tag is part of the signed string, so
# a signature for another protocol version cannot be replayed into this one.
PROTOCOL = "obsync/v1"
CLOCK_SKEW_SECS = 300
# docs/protocol.md, "Devices": the closed platform list. A synthetic device is
# honest about being one.
PLATFORM = "linux"
APP_VERSION = "e2e"
# A domain id is 32 hex and is owner metadata the server never interprets
# (docs/protocol.md, "Domains").
DOMAIN_ID = "e2e" + "0" * 29
# Opaque "ciphertext", and deliberately LARGER THAN 1 MiB: that is the request
# body ceiling a stock reverse proxy applies, and a terminator that keeps it
# turns a large note into a refusal the server never made and cannot explain
# (requirement 8, "any size, one path"). A file this size proves the path a
# reader's proxy configuration has to leave open; it is still small enough for
# a runner to hold twice.
CHUNK_BYTES = 2 * 1024 * 1024
# The nonce log is 600 s deep and rests on the journal volume, so the replay
# probe after a restart is only meaningful inside that window. Every restart
# these scripts perform is bounded by their own readiness budget, which is far
# below this.
NONCE_WINDOW_SECS = 600
# docs/protocol.md, "Chunks": the largest body `PUT /v1/chunks/{sid}` admits
# (8 MiB of plaintext plus the AES-GCM tag) and the ciphertext sum one
# `POST /v1/chunks/get` may carry. A proxy with a smaller body ceiling or a
# response buffer it cannot spill refuses one of these, and the server never
# sees why.
CHUNK_MAX_BYTES = 8 * 1024 * 1024 + 16
BATCH_MAX_BYTES = 32 * 1024 * 1024
# docs/protocol.md, "Change feed": the longest wait a device may ask for. A
# proxy whose read timeout is shorter (HAProxy's common `timeout server 30s`)
# cuts every idle poll, and a device reads that as offline. The client waits
# well past it so the proxy, never this client, is what a cut measures.
LONG_POLL_SECS = 55
LONG_POLL_CLIENT_TIMEOUT = 75
# A documentation address (RFC 5737, TEST-NET-3): what a client forges in
# `X-Forwarded-For`. A deployment that records it lets any device name its own
# address on the dashboard.
FORGED_ADDRESS = "203.0.113.9"


class Denied(Exception):
    """Every refusal this client makes. Never a silent fallback."""


class _Pinned(http.client.HTTPSConnection):
    """HTTPS to a fixed address, with the NAME the certificate carries.

    A deployment's certificate is for the name its devices use, and CI reaches
    it on a loopback port. Connecting to the address while presenting -- and
    verifying -- the name is what `curl --resolve` does, and it is why nothing
    here ever disables verification.
    """

    def __init__(self, host: str, port: int, address: tuple[str, int], context: ssl.SSLContext, timeout: int):
        super().__init__(host, port, context=context, timeout=timeout)
        self._address = address

    def connect(self) -> None:
        sock = socket.create_connection(self._address, timeout=self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class Credential:
    """One device's id and secret. Its repr deliberately hides the secret."""

    def __init__(self, device_id: str, secret: str):
        self.device_id = device_id
        self.secret = secret

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return f"Credential(device_id={self.device_id!r}, secret=<redacted>)"


class Signature:
    """The headers one signed request carried, so a replay can be built."""

    def __init__(self, device_id: str, ts: str, nonce: str, sig: str, method: str, target: str, body: bytes):
        self.device_id = device_id
        self.ts = ts
        self.nonce = nonce
        self.sig = sig
        self.method = method
        self.target = target
        self.body = body


class Server:
    """The deployment under test, reached the way its devices reach it."""

    def __init__(self, host: str, port: int, address: str, cacert: str, timeout: int = 15, keepalive: bool = False):
        self.host = host
        self.port = port
        self.address = (address, port)
        self.timeout = timeout
        # The signature of the last signed request, which the replay probe
        # re-sends verbatim. Never printed.
        self.last: Signature | None = None
        # A CA file is REQUIRED: a run that fell back to the system store
        # would prove nothing about the certificate the deployment serves, and
        # a run with verification off would prove nothing at all.
        self.context = ssl.create_default_context(cafile=cacert)
        # The bench reuses one connection per thread, as a device's HTTP stack
        # does; a TLS handshake per request would measure this client. The
        # proving phases keep a fresh connection per request, which is the
        # stricter case for a proxy and the one they were written against.
        self.keepalive = keepalive
        self._local = threading.local()

    def _connection(self, timeout: int) -> tuple[http.client.HTTPSConnection, bool]:
        """A connection for this request, and whether to close it after."""
        if not self.keepalive:
            return _Pinned(self.host, self.port, self.address, self.context, timeout), True
        held = getattr(self._local, "held", None)
        # Reopened well inside the server's 60 s idle limit, so a request is
        # never written into a connection the server is closing.
        if held is None or time.monotonic() - held[1] > 20:
            if held is not None:
                held[0].close()
            held = (_Pinned(self.host, self.port, self.address, self.context, timeout), time.monotonic())
        self._local.held = (held[0], time.monotonic())
        held[0].timeout = timeout
        if held[0].sock is not None:
            held[0].sock.settimeout(timeout)
        return held[0], False

    def call(
        self,
        method: str,
        target: str,
        body: bytes = b"",
        cred: Credential | None = None,
        sid: str | None = None,
        replay: Signature | None = None,
        skew: int = 0,
        corrupt: bool = False,
        timeout: int | None = None,
        extra: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        """One request, signed as `docs/protocol.md` says, or unsigned."""
        headers = {"Content-Length": str(len(body))}
        # Headers outside the signed string -- a forged `X-Forwarded-For` --
        # which is exactly why the server must not believe them.
        headers.update(extra or {})
        if body:
            # A chunk body is ciphertext the server stores without reading;
            # every other body on this API is JSON.
            headers["Content-Type"] = "application/octet-stream" if sid is not None else "application/json"
        if replay is not None:
            # The point of a replay is that every header is the one the server
            # already accepted, so the nonce is what refuses it.
            headers.update(
                {
                    "X-Obsync-Device": replay.device_id,
                    "X-Obsync-Ts": replay.ts,
                    "X-Obsync-Nonce": replay.nonce,
                    "X-Obsync-Sig": replay.sig,
                }
            )
        elif cred is not None:
            signature = self.sign(cred, method, target, body, sid=sid, skew=skew, corrupt=corrupt)
            headers.update(
                {
                    "X-Obsync-Device": signature.device_id,
                    "X-Obsync-Ts": signature.ts,
                    "X-Obsync-Nonce": signature.nonce,
                    "X-Obsync-Sig": signature.sig,
                }
            )
            self.last = signature
        connection, close = self._connection(timeout or self.timeout)
        try:
            connection.request(method, target, body=body, headers=headers)
            response = connection.getresponse()
            result = response.status, dict(response.getheaders()), response.read()
            if response.will_close:
                close = True
            return result
        except BaseException:
            close = True
            raise
        finally:
            if close:
                connection.close()
                if self.keepalive:
                    self._local.held = None

    def sign(
        self,
        cred: Credential,
        method: str,
        target: str,
        body: bytes,
        sid: str | None = None,
        skew: int = 0,
        corrupt: bool = False,
    ) -> Signature:
        """The signed string of `docs/protocol.md`, "Authentication"."""
        ts = str(int(time.time()) + skew)
        nonce = secrets.token_hex(16)
        # A chunk upload signs the sid, which IS the body's hash, so the
        # server verifies the signature without buffering the body.
        body_hash = sid if sid is not None else hashlib.sha256(body).hexdigest()
        canonical = f"{PROTOCOL}\n{method}\n{target}\n{ts}\n{nonce}\n{body_hash}"
        signature = hmac.new(bytes.fromhex(cred.secret), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
        if corrupt:
            # One flipped hex digit: a signature of the right SHAPE that no
            # key produces, which is what separates `bad_signature` from
            # `missing_auth`.
            flipped = "0" if signature[0] != "0" else "1"
            signature = flipped + signature[1:]
        return Signature(cred.device_id, ts, nonce, signature, method, target, body)


class Flow:
    """The properties, numbered and timed, with one refusal grammar."""

    def __init__(self, server: Server, state_path: str):
        self.server = server
        self.state_path = state_path
        self.proven = 0
        self.started = time.time()
        self.step_at = self.started

    def prove(self, message: str) -> None:
        now = time.time()
        self.proven += 1
        print(f"api-flow: ({self.proven}) {message} [{now - self.step_at:.1f}s]", flush=True)
        self.step_at = now

    def expect(self, status: int, wanted: int, route: str, body: bytes = b"") -> None:
        if status != wanted:
            raise Denied(f"{route} answered {status}, not {wanted}: {self.code(body) or body[:200]!r}")

    def expect_code(self, status: int, wanted: int, code: str, route: str, body: bytes) -> None:
        self.expect(status, wanted, route, body)
        found = self.code(body)
        if found != code:
            raise Denied(f"{route} answered {status} with error {found!r}, not {code!r}")

    @staticmethod
    def code(body: bytes) -> str | None:
        try:
            return json.loads(body).get("error")
        except (ValueError, AttributeError):
            return None

    @staticmethod
    def parse(body: bytes, route: str) -> dict:
        try:
            parsed = json.loads(body)
        except ValueError as error:
            raise Denied(f"{route} did not answer JSON: {error}") from error
        if not isinstance(parsed, dict):
            raise Denied(f"{route} answered {type(parsed).__name__}, not an object")
        return parsed

    def save(self, state: dict) -> None:
        """The two credentials, written where only this run can read them."""
        handle = os.open(self.state_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(state, stream)

    def load(self) -> dict:
        try:
            with open(self.state_path, encoding="utf-8") as stream:
                return json.load(stream)
        except OSError as error:
            raise Denied(f"no state from the enroll phase at {self.state_path}: {error}") from error


def version_id_of(file_id: str, parents: list[str], manifest_ct: str, sids: list[str]) -> str:
    """The version identity the server recomputes (`storage::version_id_of`).

    A device that cannot compute this cannot name a version at all: the server
    refuses `422 version_id_mismatch` for any id it does not derive itself from
    the file, the sorted parents, the manifest ciphertext and the sids. Writing
    it here rather than reading the server's expectation out of a refusal is
    the point -- the two sides agree, or this run says they do not.
    """
    digest = hashlib.sha256()
    digest.update(bytes.fromhex(file_id))
    for parent in sorted(bytes.fromhex(p) for p in parents):
        digest.update(parent)
    digest.update(base64.b64decode(manifest_ct))
    for sid in sids:
        digest.update(bytes.fromhex(sid))
    return digest.hexdigest()


def pair_two(flow: Flow, token: str) -> tuple[Credential, Credential]:
    """First boot and one pairing: the two devices every later phase uses."""
    server = flow.server

    # (1) First boot. The setup token is the credential, and it creates the
    # account and the first device in one call.
    body = json.dumps(
        {
            "setup_token": token,
            "account_name": "end to end",
            "device": {"name": "first device", "platform": PLATFORM, "app_version": APP_VERSION},
        }
    ).encode("utf-8")
    status, _, answer = server.call("POST", "/v1/setup", body=body)
    flow.expect(status, 201, "POST /v1/setup", answer)
    created = flow.parse(answer, "POST /v1/setup")
    first = Credential(created["device_id"], created["device_secret"])
    status, _, answer = server.call("POST", "/v1/setup", body=body)
    flow.expect_code(status, 409, "already_set_up", "a second POST /v1/setup", answer)
    flow.prove("first boot: the setup token created the account and device one; a second setup is 409 already_set_up")

    # (2) The account reads back, signed. This is the first proof the
    # credential the server just minted actually authenticates.
    status, _, answer = server.call("GET", "/v1/account", cred=first)
    flow.expect(status, 200, "GET /v1/account", answer)
    account = flow.parse(answer, "GET /v1/account")
    if account.get("device_count") != 1:
        raise Denied(f"the account reports {account.get('device_count')} devices after setup, not 1")
    flow.prove(f"device one is enrolled: GET /v1/account is 200 with {account.get('device_count')} device")

    # (3) Pair a second device, through the API, exactly as a phone does.
    status, _, answer = server.call("POST", "/v1/pairing", body=b"{}", cred=first)
    flow.expect(status, 201, "POST /v1/pairing", answer)
    pairing = flow.parse(answer, "POST /v1/pairing")
    pairing_id = pairing["pairing_id"]
    claim = json.dumps(
        {
            "enroll_token": pairing["enroll_token"],
            "name": "second device",
            "platform": PLATFORM,
            "app_version": APP_VERSION,
        }
    ).encode("utf-8")
    status, _, answer = server.call("POST", f"/v1/pairing/{pairing_id}/claim", body=claim)
    flow.expect(status, 201, "the pairing claim", answer)
    claimed = flow.parse(answer, "the pairing claim")
    second = Credential(claimed["device_id"], claimed["device_secret"])

    # A claimed device holds a credential and NO authority until the creator
    # approves. That is the boundary worth probing, not the happy path.
    status, _, answer = server.call("GET", "/v1/account", cred=second)
    flow.expect_code(status, 403, "device_pending", "GET /v1/account as the unapproved device", answer)
    status, _, answer = server.call("GET", f"/v1/pairing/{pairing_id}/envelope", cred=second)
    flow.expect_code(status, 409, "not_approved", "the envelope before approval", answer)
    flow.prove("the second device is claimed and powerless: 403 device_pending on the API, 409 not_approved on its envelope")

    # (4) Approval, and the envelope the claimant collects exactly once. The
    # envelope is opaque to the server: it is the vault key wrapped for the new
    # device, and nothing on this path can read it (requirement 6).
    envelope = base64.b64encode(secrets.token_bytes(64)).decode("ascii")
    envelope_nonce = secrets.token_hex(12)
    approve = json.dumps({"envelope": envelope, "nonce": envelope_nonce}).encode("utf-8")
    status, _, answer = server.call("POST", f"/v1/pairing/{pairing_id}/approve", body=approve, cred=first)
    flow.expect(status, 204, "the pairing approval", answer)
    status, _, answer = server.call("GET", f"/v1/pairing/{pairing_id}/envelope", cred=second)
    flow.expect(status, 200, "the envelope after approval", answer)
    delivered = flow.parse(answer, "the envelope after approval")
    if delivered.get("envelope") != envelope or delivered.get("nonce") != envelope_nonce:
        raise Denied("the envelope the claimant collected is not the one the creator sealed")
    status, _, answer = server.call("GET", f"/v1/pairing/{pairing_id}/envelope", cred=second)
    flow.expect_code(status, 410, "envelope_consumed", "a second envelope fetch", answer)
    flow.prove("pairing completes: the creator's envelope reaches the claimant byte for byte, once, and the second fetch is 410")
    return first, second


def enroll(flow: Flow, token: str) -> None:
    server = flow.server
    first, second = pair_two(flow, token)

    # (5) Push one file from device one: a chunk, then the version that names
    # it. The sid IS the body's hash, so a corrupted upload cannot be stored.
    chunk = secrets.token_bytes(CHUNK_BYTES)
    sid = hashlib.sha256(chunk).hexdigest()
    status, _, answer = server.call("PUT", f"/v1/chunks/{sid}", body=chunk, cred=first, sid=sid)
    flow.expect(status, 201, f"PUT /v1/chunks/{sid[:8]}…", answer)
    file_id = secrets.token_hex(16)
    manifest_ct = base64.b64encode(secrets.token_bytes(48)).decode("ascii")
    version_id = version_id_of(file_id, [], manifest_ct, [sid])
    version = json.dumps(
        {
            "version_id": version_id,
            "parents": [],
            "sids": [sid],
            "bytes": len(chunk),
            "domain_id": DOMAIN_ID,
            "manifest_ct": manifest_ct,
            "manifest_nonce": secrets.token_hex(12),
            "deleted": False,
        }
    ).encode("utf-8")
    status, _, answer = server.call("POST", f"/v1/files/{file_id}/versions", body=version, cred=first)
    flow.expect(status, 201, "POST /v1/files/{id}/versions", answer)
    posted = flow.parse(answer, "POST /v1/files/{id}/versions")
    flow.prove(
        f"push: {len(chunk)} bytes stored under its own hash and one version at seq "
        f"{posted.get('seq')}, whose id this device computed and the server recomputed"
    )

    # (6) Pull it from device two, which is the whole point of pairing.
    pull(flow, second, file_id, version_id, sid, chunk, "pull")

    # (7) The refusals. Each is a boundary a deployment behind a proxy can
    # quietly lose, and each names the code the protocol states.
    status, _, answer = server.call("GET", "/v1/changes?since=0")
    flow.expect_code(status, 401, "missing_auth", "an unsigned GET /v1/changes", answer)
    status, _, answer = server.call("GET", "/v1/account", cred=first, corrupt=True)
    flow.expect_code(status, 401, "bad_signature", "a GET /v1/account whose signature was altered", answer)
    status, _, answer = server.call("GET", "/v1/account", cred=first, skew=-(CLOCK_SKEW_SECS + 60))
    flow.expect_code(status, 401, "stale_timestamp", "a GET /v1/account signed outside the window", answer)
    status, _, answer = server.call("GET", "/v1/account", cred=first)
    flow.expect(status, 200, "GET /v1/account", answer)
    spent = server.last
    status, _, answer = server.call("GET", "/v1/account", replay=spent)
    flow.expect_code(status, 401, "replayed_nonce", "a replay of that exact request", answer)
    flow.prove("the API is closed: missing_auth, bad_signature, stale_timestamp and replayed_nonce are each refused by name")

    flow.save(
        {
            "first": {"device_id": first.device_id, "secret": first.secret},
            "second": {"device_id": second.device_id, "secret": second.secret},
            "file_id": file_id,
            "version_id": version_id,
            "sid": sid,
            "chunk": base64.b64encode(chunk).decode("ascii"),
            "spent": {
                "device_id": spent.device_id,
                "ts": spent.ts,
                "nonce": spent.nonce,
                "sig": spent.sig,
                "method": spent.method,
                "target": spent.target,
                "at": int(time.time()),
            },
        }
    )


def pull(flow: Flow, cred: Credential, file_id: str, version_id: str, sid: str, chunk: bytes, label: str) -> None:
    """The second device reads the feed and fetches the bytes back."""
    server = flow.server
    status, _, answer = server.call("GET", "/v1/changes?since=0", cred=cred)
    flow.expect(status, 200, "GET /v1/changes", answer)
    feed = flow.parse(answer, "GET /v1/changes")
    changes = [c for c in feed.get("changes", []) if c.get("version_id") == version_id]
    if not changes:
        raise Denied(f"the change feed does not carry version {version_id[:8]}…: {len(feed.get('changes', []))} changes")
    entry = changes[0]
    if entry.get("file_id") != file_id or entry.get("sids") != [sid]:
        raise Denied("the feed entry names another file or another chunk")
    status, _, body = server.call("GET", f"/v1/chunks/{sid}", cred=cred)
    flow.expect(status, 200, f"GET /v1/chunks/{sid[:8]}…", body)
    if body != chunk:
        raise Denied(f"the chunk came back {len(body)} bytes, not the {len(chunk)} that were pushed")
    if hashlib.sha256(body).hexdigest() != sid:
        raise Denied("the chunk that came back does not hash to the sid it was stored under")
    flow.prove(f"{label}: the second device sees the version in the feed and reads back all {len(body)} bytes, hash for hash")


def verify(flow: Flow) -> None:
    """After the restart: the data, the spent nonce, and the credential."""
    server = flow.server
    state = flow.load()
    first = Credential(state["first"]["device_id"], state["first"]["secret"])
    second = Credential(state["second"]["device_id"], state["second"]["secret"])
    chunk = base64.b64decode(state["chunk"])

    pull(flow, second, state["file_id"], state["version_id"], state["sid"], chunk, "persistence")

    spent = state["spent"]
    elapsed = int(time.time()) - int(spent["at"])
    if elapsed >= NONCE_WINDOW_SECS:
        raise Denied(
            f"the restart took {elapsed}s, past the {NONCE_WINDOW_SECS}s nonce window, so a replay would be "
            "refused or accepted for the wrong reason and this run can judge neither"
        )
    replay = Signature(spent["device_id"], spent["ts"], spent["nonce"], spent["sig"], spent["method"], spent["target"], b"")
    status, _, answer = server.call(spent["method"], spent["target"], replay=replay)
    # A restart resets an in-memory cache. This one is on the journal volume
    # and fsynced before the request it accepted was answered, so the nonce is
    # still spent -- which is the durability claim, not a detail.
    flow.expect_code(status, 401, "replayed_nonce", "a replay of a request signed BEFORE the restart", answer)
    flow.prove(f"the nonce log survived the restart: a nonce spent {elapsed}s ago is still refused")

    status, _, answer = server.call("GET", "/v1/account", cred=first)
    flow.expect(status, 200, "GET /v1/account after the restart", answer)
    account = flow.parse(answer, "GET /v1/account after the restart")
    if account.get("device_count") != 2:
        raise Denied(f"the account reports {account.get('device_count')} devices after the restart, not the 2 that paired")
    flow.prove("both devices survived: a freshly signed request reads an account of 2 devices")


def put_chunk(flow: Flow, cred: Credential, chunk: bytes, route: str = "PUT /v1/chunks/{sid}") -> str:
    """Store one chunk under its own hash; `201` new or `200` already held."""
    sid = hashlib.sha256(chunk).hexdigest()
    status, _, answer = flow.server.call("PUT", f"/v1/chunks/{sid}", body=chunk, cred=cred, sid=sid)
    if status not in (200, 201):
        flow.expect(status, 201, route, answer)
    return sid


def post_version(flow: Flow, cred: Credential, file_id: str, parents: list[str], sids: list[str], size: int) -> dict:
    """One version naming chunks already stored, with the id the server derives."""
    manifest_ct = base64.b64encode(secrets.token_bytes(48)).decode("ascii")
    version_id = version_id_of(file_id, parents, manifest_ct, sids)
    body = json.dumps(
        {
            "version_id": version_id,
            "parents": parents,
            "sids": sids,
            "bytes": size,
            "domain_id": DOMAIN_ID,
            "manifest_ct": manifest_ct,
            "manifest_nonce": secrets.token_hex(12),
            "deleted": False,
        }
    ).encode("utf-8")
    status, _, answer = flow.server.call("POST", f"/v1/files/{file_id}/versions", body=body, cred=cred)
    flow.expect(status, 201, "POST /v1/files/{id}/versions", answer)
    posted = flow.parse(answer, "POST /v1/files/{id}/versions")
    posted["version_id"] = version_id
    return posted


def head_seq(flow: Flow, cred: Credential) -> int:
    """The journal head, which is where a device's next long poll starts."""
    status, _, answer = flow.server.call("GET", "/v1/changes?since=0&limit=1", cred=cred)
    flow.expect(status, 200, "GET /v1/changes", answer)
    return int(flow.parse(answer, "GET /v1/changes")["head_seq"])


def await_change(flow: Flow, cred: Credential, since: int, sid: str, budget: float) -> dict:
    """Long-poll from `since` until the feed carries a version of chunk `sid`, as a device does.

    A page can come back EMPTY before its wait: the journal also holds frames
    that are not changes (a scrub step every few seconds), and a poll whose
    `since` is behind them answers at once. The page's `seq` is the cursor a
    device continues from, so the loop does exactly that.
    """
    deadline = time.monotonic() + budget
    while time.monotonic() < deadline:
        status, _, answer = flow.server.call(
            "GET", f"/v1/changes?since={since}&wait={LONG_POLL_SECS}", cred=cred, timeout=LONG_POLL_CLIENT_TIMEOUT
        )
        flow.expect(status, 200, "a long poll", answer)
        page = flow.parse(answer, "a long poll")
        for change in page.get("changes", []):
            if change.get("sids") == [sid]:
                return change
        since = int(page["seq"])
    raise Denied(f"no version of chunk {sid[:8]}… reached the feed within {budget:.0f}s")


def multipart_parts(headers: dict[str, str], body: bytes) -> list[tuple[str, bytes]]:
    """(sid, bytes) per part of a `POST /v1/chunks/get` answer, framing checked."""
    content_type = next((v for k, v in headers.items() if k.lower() == "content-type"), "")
    marker = "boundary="
    if not content_type.startswith("multipart/mixed") or marker not in content_type:
        raise Denied(f"the batch answer is {content_type!r}, not multipart/mixed with a boundary")
    delimiter = b"--" + content_type.split(marker, 1)[1].strip().strip('"').encode("ascii")
    parts: list[tuple[str, bytes]] = []
    at = 0
    while True:
        if body[at : at + len(delimiter)] != delimiter:
            raise Denied(f"the batch answer lost its framing at byte {at}")
        at += len(delimiter)
        if body[at : at + 4] == b"--\r\n":
            break
        head_end = body.index(b"\r\n\r\n", at)
        fields = {}
        for line in body[at + 2 : head_end].decode("ascii").split("\r\n"):
            name, _, value = line.partition(":")
            fields[name.strip().lower()] = value.strip()
        length = int(fields["content-length"])
        start = head_end + 4
        parts.append((fields.get("x-obsync-sid", ""), body[start : start + length]))
        at = start + length + 2
    if at + 4 != len(body):
        raise Denied(f"the batch answer carries {len(body) - at - 4} bytes after its closing delimiter")
    return parts


def proxy(flow: Flow, expect_address: str, bypass: str) -> None:
    """What a reverse proxy in front can break while `/readyz` stays green."""
    server = flow.server
    state = flow.load()
    first = Credential(state["first"]["device_id"], state["first"]["secret"])
    second = Credential(state["second"]["device_id"], state["second"]["secret"])

    # (1) The largest chunk the protocol admits, both ways. A stock proxy's
    # 1 MiB body ceiling, or an 8 MiB one written as `8m`, refuses it.
    chunk = secrets.token_bytes(CHUNK_MAX_BYTES)
    sid = put_chunk(flow, first, chunk, "the largest admissible chunk")
    status, _, body = server.call("GET", f"/v1/chunks/{sid}", cred=second)
    flow.expect(status, 200, "GET of the largest admissible chunk", body)
    if body != chunk:
        raise Denied(f"the largest chunk came back {len(body)} bytes, not {len(chunk)}")
    flow.prove(f"the largest chunk: {len(chunk)} bytes (8 MiB + 16) up through the proxy and back, hash for hash")

    # (2) A full batch: four chunks summing to exactly the 32 MiB ceiling, in
    # one multipart answer the proxy has to pass through whole.
    batch = [secrets.token_bytes(BATCH_MAX_BYTES // 4) for _ in range(4)]
    sids = [put_chunk(flow, first, part, "a batch chunk") for part in batch]
    file_id = secrets.token_hex(16)
    post_version(flow, first, file_id, [], sids, BATCH_MAX_BYTES)
    status, headers, body = server.call(
        "POST", "/v1/chunks/get", body=json.dumps({"sids": sids}).encode("utf-8"), cred=second, timeout=60
    )
    flow.expect(status, 200, "POST /v1/chunks/get", body)
    parts = multipart_parts(headers, body)
    if [p[0] for p in parts] != sids or [p[1] for p in parts] != batch:
        raise Denied("the batch answer does not carry the four chunks, in request order, byte for byte")
    flow.prove(f"a full batch: {sum(len(p[1]) for p in parts)} bytes of chunks in one multipart answer, in order, byte for byte")

    # (3) The long poll, held for the whole wait. A proxy read timeout under
    # 55 s answers 502/504 here, which a device reads as offline. A page that
    # comes back early and empty because a non-change frame landed between
    # reading the head and asking (see `await_change`) is not a hold, so the
    # poll is re-asked from the page's cursor, a bounded number of times.
    since = head_seq(flow, second)
    held = 0.0
    for _ in range(5):
        started = time.monotonic()
        status, _, answer = server.call(
            "GET", f"/v1/changes?since={since}&wait={LONG_POLL_SECS}", cred=second, timeout=LONG_POLL_CLIENT_TIMEOUT
        )
        held = time.monotonic() - started
        flow.expect(status, 200, f"a {LONG_POLL_SECS}s long poll", answer)
        page = flow.parse(answer, "the long poll")
        if page.get("changes"):
            raise Denied("the long poll answered with changes nobody made")
        if held >= LONG_POLL_SECS - 5:
            break
        since = int(page["seq"])
    else:
        raise Denied(f"no long poll was held: the last answered after {held:.1f}s of a {LONG_POLL_SECS}s wait")
    flow.prove(f"the long poll: held {held:.1f}s of a {LONG_POLL_SECS}s wait and answered 200, not a proxy timeout")

    # (4) ...and woken by a write. A proxy that buffers the response delays the
    # wake to the end of the wait, which is every edit arriving 55 s late. The
    # chunk goes up first, so the waiting device knows which sid it waits for
    # and the timer covers the version post alone.
    note = secrets.token_bytes(1024)
    note_sid = put_chunk(flow, first, note)
    woken: dict = {}

    def poll() -> None:
        try:
            await_change(flow, second, head_seq(flow, second), note_sid, LONG_POLL_CLIENT_TIMEOUT)
            woken["at"] = time.monotonic()
        except (Denied, OSError) as error:
            woken["error"] = error

    poller = threading.Thread(target=poll)
    poller.start()
    time.sleep(2)
    written = time.monotonic()
    post_version(flow, first, secrets.token_hex(16), [], [note_sid], len(note))
    poller.join(LONG_POLL_CLIENT_TIMEOUT + 5)
    if "at" not in woken:
        raise Denied(f"the write never reached the waiting device: {woken.get('error', 'no answer')}")
    delay = woken["at"] - written
    if delay > 5:
        raise Denied(f"the write reached the waiting device {delay:.1f}s late: the proxy held the answer")
    flow.prove(f"the woken long poll: a write reached the device already waiting {delay * 1000:.0f} ms after it was posted")

    # (5) The address the server records. The client forges X-Forwarded-For;
    # a proxy that passes it through unchanged -- or adds a SECOND header, of
    # which the server reads the first -- makes the forgery the device's
    # address on the dashboard.
    status, _, answer = server.call(
        "POST",
        "/v1/devices/heartbeat",
        body=json.dumps({"app_version": APP_VERSION}).encode("utf-8"),
        cred=first,
        extra={"X-Forwarded-For": FORGED_ADDRESS},
    )
    flow.expect(status, 204, "POST /v1/devices/heartbeat", answer)
    status, _, answer = server.call("GET", "/v1/devices", cred=first)
    flow.expect(status, 200, "GET /v1/devices", answer)
    devices = flow.parse(answer, "GET /v1/devices").get("devices", [])
    recorded = next((d.get("address") for d in devices if d.get("device_id") == first.device_id), None)
    if recorded != expect_address:
        raise Denied(
            f"the server recorded {recorded!r} for this device, not the client address {expect_address!r} "
            f"(the forged value was {FORGED_ADDRESS!r})"
        )
    flow.prove(f"the client address: the server recorded {recorded}, the address the proxy saw, not the forged {FORGED_ADDRESS}")

    # (6) The server's own port, from where the client stands. Only the proxy
    # may reach it; a connection here is a path around every rule above. A
    # client on the server's own host always can, so a single-host run says
    # `--bypass none` and proves the listener's address its own way.
    if bypass == "none":
        print("api-flow: the bypass is not asked here: client and server share a host", flush=True)
        return
    host, _, port = bypass.rpartition(":")
    try:
        socket.create_connection((host, int(port)), timeout=5).close()
    except OSError as error:
        flow.prove(f"the bypass is closed: a direct connection to the server at {bypass} failed ({type(error).__name__})")
    else:
        raise Denied(f"the client reached the server directly at {bypass}, around the proxy")


class ServerProcess:
    """The server's own counters, read from its /proc entry (bench only).

    The bench runs in the server's PID namespace with `CAP_SYS_PTRACE`, which
    is what `/proc/<pid>/io` asks of a reader that is not its owner. Nothing
    here writes to the process.
    """

    def __init__(self, proc: str):
        self.proc = proc
        self.pid = os.path.basename(proc)
        try:
            with open(os.path.join(proc, "comm"), encoding="ascii") as stream:
                comm = stream.read().strip()
        except OSError as error:
            raise Denied(f"cannot read {proc}: {error}") from error
        if comm != "obsyncd":
            raise Denied(f"{proc} is {comm!r}, not obsyncd: the counters would describe another process")
        self.tick = os.sysconf("SC_CLK_TCK")

    def _read(self, name: str) -> str:
        with open(os.path.join(self.proc, name), encoding="ascii") as stream:
            return stream.read()

    def cpu_seconds(self) -> float:
        # Fields 14 and 15 of stat, counted after the parenthesised name.
        fields = self._read("stat").rsplit(")", 1)[1].split()
        return (int(fields[11]) + int(fields[12])) / self.tick

    def kib(self, key: str) -> int:
        for line in self._read("status").splitlines():
            if line.startswith(key + ":"):
                return int(line.split()[1])
        raise Denied(f"{self.proc}/status has no {key}")

    def io(self) -> dict[str, int]:
        return {k: int(v) for k, v in (line.split(": ") for line in self._read("io").splitlines())}

    def sample(self) -> dict:
        io = self.io()
        return {"cpu": self.cpu_seconds(), "write_bytes": io["write_bytes"], "syscw": io["syscw"]}


class Fsyncs:
    """The server's fsync-family calls, counted by `strace -c` on every thread.

    Attaching traces EVERY syscall of the server, so a scenario measured under
    it is never timed: the bench counts calls in their own passes.
    """

    CALLS = "fsync,fdatasync,sync_file_range,syncfs"

    def __init__(self, pid: str):
        self.pid = pid
        self.output = tempfile.NamedTemporaryFile(prefix="strace-", suffix=".txt", delete=False).name
        # strace's own messages go to a FILE: it announces every thread the
        # server starts, and a pipe nobody drains would fill, block strace,
        # and with it every traced thread of the server.
        self.messages = tempfile.NamedTemporaryFile(prefix="strace-", suffix=".log", delete=False).name
        self.process: subprocess.Popen | None = None

    def __enter__(self) -> "Fsyncs":
        with open(self.messages, "w", encoding="utf-8") as sink:
            self.process = subprocess.Popen(
                ["strace", "-f", "-c", "-e", f"trace={self.CALLS}", "-p", self.pid, "-o", self.output],
                stderr=sink,
            )
        # strace says when it holds every thread; counting before that misses calls.
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and self.process.poll() is None:
            with open(self.messages, encoding="utf-8") as said:
                if "attached" in said.read():
                    return self
            time.sleep(0.1)
        raise Denied(f"strace could not attach to pid {self.pid} within 15s")

    def __exit__(self, *_: object) -> None:
        assert self.process is not None
        self.process.send_signal(signal.SIGINT)
        self.process.wait(timeout=30)
        os.unlink(self.messages)

    def counts(self) -> dict[str, int]:
        found: dict[str, int] = {}
        with open(self.output, encoding="utf-8") as stream:
            for line in stream:
                words = line.split()
                # One row per call name, then a `total` row that repeats them.
                if len(words) >= 5 and words[-1].isidentifier() and words[3].isdigit() and words[-1] != "total":
                    found[words[-1]] = int(words[3])
        os.unlink(self.output)
        return found


class Bench:
    """B1, B2, B3 and B7, each as one timed scenario with server deltas."""

    def __init__(self, flow: Flow, process: ServerProcess | None, strace: bool):
        self.flow = flow
        self.process = process
        self.strace = strace
        self.results: dict[str, dict] = {}

    def measure(self, name: str, body, fsyncs: bool = False) -> dict:
        before = self.process.sample() if self.process else None
        client_before = resource.getrusage(resource.RUSAGE_SELF)
        started = time.monotonic()
        if fsyncs and self.process:
            with Fsyncs(self.process.pid) as counter:
                result = body()
            result["fsyncs"] = counter.counts()
        else:
            result = body()
        result["wall_s"] = round(time.monotonic() - started, 3)
        client_after = resource.getrusage(resource.RUSAGE_SELF)
        result["client_cpu_s"] = round(
            (client_after.ru_utime + client_after.ru_stime) - (client_before.ru_utime + client_before.ru_stime), 2
        )
        if self.process and before:
            after = self.process.sample()
            result["server_cpu_s"] = round(after["cpu"] - before["cpu"], 2)
            result["server_write_mib"] = round((after["write_bytes"] - before["write_bytes"]) / 2**20, 2)
            result["server_write_calls"] = after["syscw"] - before["syscw"]
            result["server_rss_mib"] = round(self.process.kib("VmRSS") / 1024, 1)
            result["server_rss_peak_mib"] = round(self.process.kib("VmHWM") / 1024, 1)
        self.results[name] = result
        self.flow.prove(f"bench {name}: " + " ".join(f"{k}={v}" for k, v in result.items() if k != "latencies_ms"))
        return result

    def push_notes(self, cred: Credential, count: int, size: int, concurrency: int) -> dict:
        """B1's shape: per note, `exists`, `PUT`, version post -- as the plugin does."""
        flow = self.flow

        def one(_: int) -> None:
            note = secrets.token_bytes(size)
            sid = hashlib.sha256(note).hexdigest()
            status, _, answer = flow.server.call(
                "POST", "/v1/chunks/exists", body=json.dumps({"sids": [sid]}).encode("utf-8"), cred=cred
            )
            flow.expect(status, 200, "POST /v1/chunks/exists", answer)
            put_chunk(flow, cred, note)
            post_version(flow, cred, secrets.token_hex(16), [], [sid], size)

        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            list(pool.map(one, range(count)))
        return {"files": count, "file_bytes": size, "concurrency": concurrency, "requests": 3 * count}

    def b1(self, cred: Credential, count: int, size: int, concurrency: int) -> None:
        result = self.measure("b1", lambda: self.push_notes(cred, count, size, concurrency))
        result["files_per_s"] = round(count / result["wall_s"], 1)
        result["requests_per_s"] = round(3 * count / result["wall_s"], 1)

    def b1_fsyncs(self, cred: Credential, count: int, size: int, concurrency: int) -> None:
        result = self.measure("b1-fsyncs", lambda: self.push_notes(cred, count, size, concurrency), fsyncs=True)
        total = sum(result["fsyncs"].values())
        result["fsyncs_per_file"] = round(total / count, 2)
        result["fsyncs_per_request"] = round(total / (3 * count), 2)

    def idle(self, name: str, seconds: int) -> None:
        self.measure(name, lambda: (time.sleep(seconds), {"idle_s": seconds})[1], fsyncs=self.strace)

    def b2(self, pusher: Credential, observer: Credential, rounds: int) -> None:
        flow = self.flow

        def run() -> dict:
            latencies = []
            file_id = secrets.token_hex(16)
            note = secrets.token_bytes(1024)
            parents = [post_version(flow, pusher, file_id, [], [put_chunk(flow, pusher, note)], len(note))["version_id"]]
            for _ in range(rounds):
                edit = secrets.token_bytes(1024)
                sid = hashlib.sha256(edit).hexdigest()
                seen: dict = {}

                def observe() -> None:
                    # The other device, already waiting on its long poll: it
                    # sees the version, then fetches the bytes, as a device does.
                    try:
                        await_change(flow, observer, head_seq(flow, observer), sid, LONG_POLL_CLIENT_TIMEOUT)
                        status, _, body = flow.server.call("GET", f"/v1/chunks/{sid}", cred=observer)
                        flow.expect(status, 200, "the observer's chunk fetch", body)
                        seen["at"] = time.monotonic()
                        seen["body"] = body
                    except (Denied, OSError) as error:
                        seen["error"] = error

                watcher = threading.Thread(target=observe)
                watcher.start()
                time.sleep(0.2)
                started = time.monotonic()
                status, _, answer = flow.server.call(
                    "POST", "/v1/chunks/exists", body=json.dumps({"sids": [sid]}).encode("utf-8"), cred=pusher
                )
                flow.expect(status, 200, "POST /v1/chunks/exists", answer)
                put_chunk(flow, pusher, edit)
                parents = [post_version(flow, pusher, file_id, parents, [sid], len(edit))["version_id"]]
                watcher.join(LONG_POLL_CLIENT_TIMEOUT + 5)
                if seen.get("body") != edit:
                    raise Denied(f"the observer did not receive the edit that was pushed: {seen.get('error')}")
                latencies.append((seen["at"] - started) * 1000)
            ordered = sorted(latencies)
            return {
                "rounds": rounds,
                "p50_ms": round(statistics.median(ordered), 1),
                "p95_ms": round(ordered[min(len(ordered) - 1, int(0.95 * len(ordered)))], 1),
                "max_ms": round(ordered[-1], 1),
                "latencies_ms": [round(v, 1) for v in latencies],
            }

        self.measure("b2", run)

    def b3(self, uploader: Credential, downloader: Credential, total: int, chunk_bytes: int) -> None:
        flow = self.flow
        peak = {"server_kib": 0, "stop": False}

        def watch_rss() -> None:
            while not peak["stop"]:
                if self.process:
                    peak["server_kib"] = max(peak["server_kib"], self.process.kib("VmRSS"))
                time.sleep(0.1)

        def run() -> dict:
            watcher = threading.Thread(target=watch_rss, daemon=True)
            watcher.start()
            count = total // chunk_bytes
            digests: list[str] = []
            started = time.monotonic()
            for _ in range(count):
                # One chunk in flight, as the plugin's 8 MiB in-flight budget
                # allows for chunks of this size (docs/architecture.md).
                digests.append(put_chunk(flow, uploader, secrets.token_bytes(chunk_bytes)))
            file_id = secrets.token_hex(16)
            post_version(flow, uploader, file_id, [], digests, count * chunk_bytes)
            upload_s = time.monotonic() - started
            started = time.monotonic()
            per_batch = max(1, BATCH_MAX_BYTES // CHUNK_MAX_BYTES)
            received = 0
            for at in range(0, count, per_batch):
                wanted = digests[at : at + per_batch]
                status, headers, body = flow.server.call(
                    "POST", "/v1/chunks/get", body=json.dumps({"sids": wanted}).encode("utf-8"), cred=downloader,
                    timeout=120,
                )
                flow.expect(status, 200, "POST /v1/chunks/get", body)
                for sid, part in multipart_parts(headers, body):
                    if hashlib.sha256(part).hexdigest() != sid:
                        raise Denied("a downloaded chunk does not hash to its sid")
                    received += len(part)
            download_s = time.monotonic() - started
            peak["stop"] = True
            watcher.join(2)
            mib = count * chunk_bytes / 2**20
            return {
                "bytes": count * chunk_bytes,
                "chunk_bytes": chunk_bytes,
                "upload_mib_s": round(mib / upload_s, 1),
                "download_mib_s": round(mib / download_s, 1),
                "received_bytes": received,
                "server_rss_during_peak_mib": round(peak["server_kib"] / 1024, 1),
                "client_rss_peak_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
            }

        self.measure("b3", run)


def bench(flow: Flow, token: str, arguments: argparse.Namespace) -> None:
    process = ServerProcess(arguments.proc) if arguments.proc else None
    if arguments.strace and not process:
        raise Denied("--strace needs --proc: the calls are counted on the server's own pid")
    first, second = pair_two(flow, token)
    runner = Bench(flow, process, arguments.strace)
    wanted = set(arguments.scenarios.split(","))
    if "b7" in wanted:
        runner.idle("b7-idle-fresh", arguments.idle_secs)
    if "b1" in wanted:
        runner.b1(first, arguments.files, arguments.file_bytes, arguments.concurrency)
        if arguments.strace:
            runner.b1_fsyncs(first, arguments.fsync_files, arguments.file_bytes, arguments.concurrency)
    if "b7" in wanted:
        runner.idle("b7-idle-loaded", arguments.idle_secs)
    if "b2" in wanted:
        runner.b2(first, second, arguments.rounds)
    if "b3" in wanted:
        runner.b3(first, second, arguments.b3_bytes, arguments.b3_chunk_bytes)
    if arguments.results:
        document = {
            "meta": {
                "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(flow.started)),
                "machine": os.uname().machine,
                "kernel": os.uname().release,
                "cpus": os.cpu_count(),
                "parameters": {
                    k: v for k, v in vars(arguments).items() if k not in ("state", "cacert", "results", "proc")
                },
            },
            "scenarios": runner.results,
        }
        with open(arguments.results, "w", encoding="utf-8") as stream:
            json.dump(document, stream, indent=2)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("phase", choices=("enroll", "verify", "proxy", "bench"))
    parser.add_argument("--host", required=True, help="the name the certificate carries")
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--address", required=True, help="the address that name is reached on")
    parser.add_argument("--cacert", required=True, help="the authority that signed the deployment's certificate")
    parser.add_argument("--state", required=True, help="where the two credentials rest between phases")
    proxied = parser.add_argument_group("proxy phase")
    proxied.add_argument("--expect-address", help="the client address the proxy must hand the server")
    proxied.add_argument("--bypass", help="host:port of the server's own listener, which must be unreachable")
    measured = parser.add_argument_group("bench phase")
    measured.add_argument("--scenarios", default="b7,b1,b2,b3", help="comma-separated: b1, b2, b3, b7")
    measured.add_argument("--files", type=int, default=10_000, help="B1: notes pushed")
    measured.add_argument("--file-bytes", type=int, default=2048, help="B1: bytes per note")
    measured.add_argument("--concurrency", type=int, default=4, help="B1: requests in flight, the desktop default")
    measured.add_argument("--fsync-files", type=int, default=500, help="B1 under strace: notes pushed")
    measured.add_argument("--rounds", type=int, default=30, help="B2: edits observed")
    measured.add_argument("--b3-bytes", type=int, default=2 * 1024**3, help="B3: bytes up and down")
    measured.add_argument("--b3-chunk-bytes", type=int, default=4 * 1024**2 + 16, help="B3: the chunker's target")
    measured.add_argument("--idle-secs", type=int, default=60, help="B7: each idle window")
    measured.add_argument("--proc", help="the server's /proc entry, e.g. /proc/1 in its PID namespace")
    measured.add_argument("--strace", action="store_true", help="count fsync calls in separate, untimed passes")
    measured.add_argument("--results", help="where the JSON results are written")
    arguments = parser.parse_args(argv)
    if arguments.phase == "proxy" and not (arguments.expect_address and arguments.bypass):
        parser.error("the proxy phase needs --expect-address and --bypass")

    server = Server(
        arguments.host, arguments.port, arguments.address, arguments.cacert, keepalive=arguments.phase == "bench"
    )
    flow = Flow(server, arguments.state)
    print(
        f"api-flow: START phase={arguments.phase} url=https://{arguments.host}:{arguments.port} "
        f"address={arguments.address} chunk_bytes={CHUNK_BYTES} nonce_window={NONCE_WINDOW_SECS}s",
        flush=True,
    )
    try:
        if arguments.phase in ("enroll", "bench"):
            # The token is the one credential this client is GIVEN, and stdin
            # is how it arrives: an argument would put it in the process table
            # of every process on the runner.
            token = sys.stdin.read().strip()
            if not token:
                raise Denied("no setup token on stdin")
            if arguments.phase == "enroll":
                enroll(flow, token)
            else:
                bench(flow, token, arguments)
        elif arguments.phase == "proxy":
            proxy(flow, arguments.expect_address, arguments.bypass)
        else:
            verify(flow)
    except Denied as error:
        print(f"api-flow: DENY {error}", file=sys.stderr, flush=True)
        print(
            f"api-flow: SUMMARY phase={arguments.phase} steps={flow.proven} "
            f"duration={time.time() - flow.started:.1f}s decision=deny",
            file=sys.stderr,
            flush=True,
        )
        return 1
    except (OSError, ssl.SSLError) as error:
        print(f"api-flow: DENY the deployment could not be reached: {error}", file=sys.stderr, flush=True)
        return 1
    print(
        f"api-flow: SUMMARY phase={arguments.phase} steps={flow.proven} "
        f"duration={time.time() - flow.started:.1f}s decision=pass",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
