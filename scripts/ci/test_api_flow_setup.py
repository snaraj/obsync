"""Execute the deployment oracle's occupied-setup boundary, before pairing."""
from __future__ import annotations

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import api_flow


class PairingReached(Exception):
    """Stop at the next phase: these fixtures assert setup, not pairing."""


class SetupServer:
    def __init__(self, status=409, code="recover_only_required", count=1):
        self.status, self.code, self.count = status, code, count
        self.setup_bodies = []

    def call(self, method, target, body=b"", cred=None):
        if (method, target) == ("POST", "/v1/setup"):
            self.setup_bodies.append(json.loads(body))
            if len(self.setup_bodies) == 1:
                return 201, {}, b'{"device_id":"synthetic-device","device_secret":"synthetic-secret"}'
            return self.status, {}, json.dumps({"error": self.code}).encode()
        if (method, target) == ("GET", "/v1/account"):
            return 200, {}, json.dumps({"device_count": self.count}).encode()
        if (method, target) == ("POST", "/v1/pairing"):
            raise PairingReached
        raise AssertionError("unexpected fixture route")


def run(server):
    with contextlib.redirect_stdout(io.StringIO()):
        try:
            api_flow.pair_two(api_flow.Flow(server, "unused"), "SYNTHETIC_SETUP_TOKEN")
        except PairingReached:
            return
    raise AssertionError("setup fixture never reached the pairing boundary")


class OccupiedSetup(unittest.TestCase):
    def test_both_stripped_and_false_mode_refuse_before_pairing(self):
        server = SetupServer()
        run(server)
        self.assertEqual(len(server.setup_bodies), 3)
        self.assertNotIn("recover_only", server.setup_bodies[0])
        self.assertEqual(server.setup_bodies[1], server.setup_bodies[0])
        self.assertIs(server.setup_bodies[2]["recover_only"], False)

    def test_success_wrong_status_old_code_and_missing_code_are_not_acceptance(self):
        for status, code in [(201, "recover_only_required"), (403, "recover_only_required"),
                             (409, "already_set_up"), (409, "bad_recovery_proof"), (409, None)]:
            with self.subTest(status=status, code=code), self.assertRaises(api_flow.Denied):
                run(SetupServer(status, code))

    def test_refusal_does_not_hide_an_extra_enrollment(self):
        with self.assertRaisesRegex(api_flow.Denied, "2 devices after setup, not 1"):
            run(SetupServer(count=2))


if __name__ == "__main__":
    unittest.main()
