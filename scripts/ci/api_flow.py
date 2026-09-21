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
import secrets
import socket
import ssl
import sys
import time

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

    def __init__(self, host: str, port: int, address: str, cacert: str, timeout: int = 15):
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
    ) -> tuple[int, dict[str, str], bytes]:
        """One request, signed as `docs/protocol.md` says, or unsigned."""
        headers = {"Content-Length": str(len(body))}
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
        connection = _Pinned(self.host, self.port, self.address, self.context, self.timeout)
        try:
            connection.request(method, target, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

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


def enroll(flow: Flow, token: str) -> None:
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


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("phase", choices=("enroll", "verify"))
    parser.add_argument("--host", required=True, help="the name the certificate carries")
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--address", required=True, help="the address that name is reached on")
    parser.add_argument("--cacert", required=True, help="the authority that signed the deployment's certificate")
    parser.add_argument("--state", required=True, help="where the two credentials rest between phases")
    arguments = parser.parse_args(argv)

    server = Server(arguments.host, arguments.port, arguments.address, arguments.cacert)
    flow = Flow(server, arguments.state)
    print(
        f"api-flow: START phase={arguments.phase} url=https://{arguments.host}:{arguments.port} "
        f"address={arguments.address} chunk_bytes={CHUNK_BYTES} nonce_window={NONCE_WINDOW_SECS}s",
        flush=True,
    )
    try:
        if arguments.phase == "enroll":
            # The token is the one credential this client is GIVEN, and stdin
            # is how it arrives: an argument would put it in the process table
            # of every process on the runner.
            token = sys.stdin.read().strip()
            if not token:
                raise Denied("no setup token on stdin")
            enroll(flow, token)
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
