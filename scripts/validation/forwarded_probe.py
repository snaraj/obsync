#!/usr/bin/env python3
"""Prove whose address the server believes, from outside the process.

Runs after `scripts/ci/api_flow.py enroll` has left its device state, against
a deployment from `deploy/proxies/compose.yml` (or the edge leg of
`scripts/validation/proxy_matrix.sh`). Stdlib only, and self-contained, so it
can be mounted alone into a throwaway container on the deployment's network.

  through  a signed heartbeat THROUGH the proxy carrying a client-forged
           `X-Forwarded-For` and `Forwarded`: the device's recorded address
           must be neither the forgery nor the proxy's own address, which
           proves the proxy's header was believed and the client's was not.
  direct   the same forgery sent straight to the server from a peer outside
           `OBSYNC_TRUSTED_PROXY_CIDRS`: the recorded address must be that
           peer's own.
  edge     the edge's connecting-address and request-id headers, unsigned:
           `--expect refused` requires `421 edge_required`, `--expect
           admitted` requires the request to reach authentication instead.
  longpoll a signed change-feed request that waits the full 55 s through the
           proxy: a proxy timeout below it cuts the request short.

It prints no credential. One line per decision, and exit 1 on any failure.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import http.client
import json
import secrets
import socket
import ssl
import sys
import time

FORGED = "192.0.2.66"


def request(args, method, target, body=b"", cred=None, headers=None):
    head = dict(headers or {})
    head["Content-Length"] = str(len(body))
    if body:
        head["Content-Type"] = "application/json"
    if cred is not None:
        ts, nonce = str(int(time.time())), secrets.token_hex(16)
        canonical = f"obsync/v1\n{method}\n{target}\n{ts}\n{nonce}\n{hashlib.sha256(body).hexdigest()}"
        sig = hmac.new(bytes.fromhex(cred["secret"]), canonical.encode(), hashlib.sha256).hexdigest()
        head.update({"X-Obsync-Device": cred["device_id"], "X-Obsync-Ts": ts, "X-Obsync-Nonce": nonce, "X-Obsync-Sig": sig})
    if args.cacert:
        context = ssl.create_default_context(cafile=args.cacert)
        conn = http.client.HTTPSConnection(args.host, args.port, context=context, timeout=75)
        conn.sock = context.wrap_socket(socket.create_connection((args.address, args.port), 75), server_hostname=args.host)
    else:
        conn = http.client.HTTPConnection(args.host, args.port, timeout=75)
    try:
        conn.request(method, target, body=body, headers=head)
        response = conn.getresponse()
        return response.status, response.read()
    finally:
        conn.close()


def recorded_address(args, cred, forged_headers):
    status, answer = request(args, "POST", "/v1/devices/heartbeat", b'{"app_version":"e2e"}', cred, forged_headers)
    if status != 204:
        raise SystemExit(f"forwarded-probe: DENY heartbeat answered {status}: {answer[:200]!r}")
    status, answer = request(args, "GET", "/v1/devices", cred=cred)
    if status != 200:
        raise SystemExit(f"forwarded-probe: DENY device list answered {status}")
    for device in json.loads(answer)["devices"]:
        if device.get("device_id") == cred["device_id"]:
            return device.get("address")
    raise SystemExit("forwarded-probe: DENY the probing device is not in its own list")


def own_address(host, port):
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect((socket.gethostbyname(host), port))
        return probe.getsockname()[0]
    finally:
        probe.close()


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", choices=("through", "direct", "edge", "longpoll"))
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--address", help="through: the address the host name is reached on")
    parser.add_argument("--cacert", help="through: the authority that signed the proxy's leaf")
    parser.add_argument("--state", help="the device state api_flow.py enroll wrote")
    parser.add_argument("--proxy", help="through: the proxy's own address, which must not be recorded")
    parser.add_argument("--client", help="through: the address the proxy saw, which must be recorded")
    parser.add_argument("--expect", choices=("refused", "admitted"), help="edge: the required outcome")
    args = parser.parse_args(argv)
    forged = {"X-Forwarded-For": FORGED, "Forwarded": f"for={FORGED}"}

    if args.mode == "edge":
        status, answer = request(args, "GET", "/v1/account", headers={"CF-Connecting-IP": FORGED, "CF-Ray": "probe"})
        code = json.loads(answer or b"{}").get("error")
        refused = status == 421 and code == "edge_required"
        ok = refused if args.expect == "refused" else (status == 401 and not refused)
        print(f"forwarded-probe: edge peer={own_address(args.host, args.port)} status={status} code={code} expect={args.expect} decision={'pass' if ok else 'deny'}")
        return 0 if ok else 1

    with open(args.state, encoding="utf-8") as stream:
        cred = json.load(stream)["first"]
    if args.mode == "longpoll":
        status, answer = request(args, "GET", "/v1/changes?since=0&limit=1", cred=cred)
        head = json.loads(answer)["head_seq"]
        began = time.monotonic()
        status, answer = request(args, "GET", f"/v1/changes?since={head}&wait=55", cred=cred)
        held = time.monotonic() - began
        # Held the whole wait (nothing else writes here meanwhile) and answered.
        ok = status == 200 and held >= 50
        print(f"forwarded-probe: longpoll status={status} held={held:.1f}s decision={'pass' if ok else 'deny'}")
        return 0 if ok else 1
    address = recorded_address(args, cred, forged)
    if args.mode == "through":
        ok = address not in (FORGED, args.proxy) and address == (args.client or address)
        print(
            f"forwarded-probe: through recorded={address} client={args.client} forged={FORGED} "
            f"proxy={args.proxy} decision={'pass' if ok else 'deny'}"
        )
    else:
        mine = own_address(args.host, args.port)
        ok = address == mine
        print(f"forwarded-probe: direct recorded={address} peer={mine} forged={FORGED} decision={'pass' if ok else 'deny'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
