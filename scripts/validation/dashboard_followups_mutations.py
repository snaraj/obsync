#!/usr/bin/env python3
"""Hostile probes of the dashboard follow-ups, from the repository root.

#268: the account's `device_count` is how many devices can sync -- active and
still pairing -- on `GET /v1/account` and on the dashboard's overview; a
revoked record, archived or not, is not counted. Each probe breaks one
guard and must compile and fail a named behavioural test. It reuses the
archive runner's loop, which restores every source from its exact starting
bytes in finally. Never run beside another build or source editor in this
worktree.
"""
from device_archive_mutations import run

STORE = "crates/obsyncd/src/storage/mod.rs"
SETUP = "crates/obsyncd/src/api/setup.rs"
ADMIN = "crates/obsyncd/src/api/admin.rs"

COUNT = "the_device_count_is_the_devices_that_can_sync"

CASES = [
    # #268, the count. Every record again is the defect itself.
    ("count-every-record", STORE,
     "            .filter(|e| e.record.state != DeviceState::Revoked)\n            .count();\n        working as u64",
     "            .count();\n        working as u64", COUNT),
    ("count-drops-pending", STORE,
     "            .filter(|e| e.record.state != DeviceState::Revoked)\n            .count();\n        working as u64",
     "            .filter(|e| e.record.state == DeviceState::Active)\n            .count();\n        working as u64",
     COUNT),
    # Both surfaces read the same count; each can lose it on its own.
    ("account-counts-every-record", SETUP,
     "    let device_count = app.store.working_device_count();",
     "    let device_count = app.store.devices().len() as u64;", COUNT),
    ("overview-counts-every-record", ADMIN,
     "        Some(a) => render::account(&a, app.store.working_device_count()),",
     "        Some(a) => render::account(&a, app.store.devices().len() as u64),", COUNT),
]


if __name__ == "__main__":
    run(CASES, "dashboard follow-up")
