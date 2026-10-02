#!/usr/bin/env python3
"""Hostile probes of two dashboard follow-ups, from the repository root.

#268: the account's `device_count` is how many devices can sync -- active and
still pairing -- on `GET /v1/account` and on the dashboard's overview; a
revoked record, archived or not, is not counted. #270: a dashboard sign-in
link opens one session, once, within exactly five minutes of its mint -- long
enough for an edge's own sign-in in front of `GET /login`, and no longer,
because the host that opens it may log the whole URL. Each probe breaks one
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
LIFE = "a_sign_in_link_lives_five_minutes_and_opens_once"

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
    # #270, the lifetime. Five minutes survives an edge's sign-in; more keeps
    # a logged copy alive longer; less breaks the edge's path.
    ("link-lifetime-longer", ADMIN,
     "pub const LOGIN_LINK_TTL_SECS: u64 = 300;",
     "pub const LOGIN_LINK_TTL_SECS: u64 = 3600;", LIFE),
    ("link-lifetime-shorter", ADMIN,
     "pub const LOGIN_LINK_TTL_SECS: u64 = 300;",
     "pub const LOGIN_LINK_TTL_SECS: u64 = 60;", LIFE),
    ("link-never-expires", ADMIN,
     "        (link.expires > now).then_some(link.minted_by)",
     "        (link.expires > now || now > 0).then_some(link.minted_by)", LIFE),
    ("link-expiry-off-by-one", ADMIN,
     "        (link.expires > now).then_some(link.minted_by)",
     "        (link.expires >= now).then_some(link.minted_by)", LIFE),
    # Spent once: a copy in a log opens nothing after the browser used it.
    ("link-replayable", ADMIN,
     "        let link = self.links.remove(token)?;",
     "        let link = *self.links.get(token)?;", LIFE),
]


if __name__ == "__main__":
    run(CASES, "dashboard follow-up")
