#!/usr/bin/env python3
"""Hostile probes of the device-archive guards (#247), from the repository root.

`POST /v1/devices/{id}/archive` takes a revoked device off the lists a person
manages, and destroys nothing: the record still answers that device `403
device_revoked` and still names the versions it wrote. Every guard around it
is load-bearing — a revoked device only, never the asking one, under device
authentication, with the flag on the journal before the answer and refused for
an active device in the index as well as in the store. Each probe removes or
inverts one guard and must fail a named behavioural test. Sources are restored
from their exact starting bytes in finally, including on failure or interrupt.
Never run beside another build or source editor in this worktree.
"""
from pathlib import Path

from kills import Judge

STORE = "crates/obsyncd/src/storage/mod.rs"
INDEX = "crates/obsyncd/src/storage/index.rs"
API = "crates/obsyncd/src/api/devices.rs"
ADMIN = "crates/obsyncd/src/api/admin.rs"
ROUTER = "crates/obsyncd/src/api/mod.rs"
RENDER = "crates/obsyncd/src/api/render.rs"

ARCHIVED = "an_archived_device_is_still_refused_as_revoked_and_still_named"
STORED = "only_a_revoked_device_is_archived_and_the_record_survives"
REPLAYED = "a_replayed_archive_frame_never_hides_a_device_that_syncs"
DASHBOARD = "the_dashboard_archives_a_revoked_device_under_its_csrf_check"
ROUTES = "exactly_the_documented_unauthenticated_routes_answer_without_a_credential"

CASES = [
    # THE STATE CHECK, in the store. Archiving a device that still syncs hides
    # it from the person who would have revoked it.
    ("state-check-gone", STORE,
     "        if state != DeviceState::Revoked {\n            return Err(StoreError::DeviceNotRevoked);\n        }\n        self.commit(&mut journal, index, |_| {\n            vec![Frame::DeviceUpdate {\n                device_id: *id,\n                name: None,\n                policy: None,\n                app_version: None,\n                archived: Some(true),\n            }]\n",
     "        self.commit(&mut journal, index, |_| {\n            vec![Frame::DeviceUpdate {\n                device_id: *id,\n                name: None,\n                policy: None,\n                app_version: None,\n                archived: Some(true),\n            }]\n",
     STORED),
    ("state-check-admits-pending", STORE,
     "        if state != DeviceState::Revoked {\n            return Err(StoreError::DeviceNotRevoked);\n        }",
     "        if state == DeviceState::Active {\n            return Err(StoreError::DeviceNotRevoked);\n        }", STORED),
    # THE SAME CHECK, in the index: a frame is applied by replay too.
    ("index-guard-gone", INDEX,
     "                    if let Some(flag) = archived\n                        && entry.record.state == DeviceState::Revoked\n                    {",
     "                    if let Some(flag) = archived {", REPLAYED),
    # THE UNKNOWN DEVICE. Archiving nothing must not answer as done.
    ("unknown-device-ignored", STORE,
     "            .map(|entry| entry.record.state)\n            .ok_or(StoreError::UnknownDevice)?;\n        if state != DeviceState::Revoked {\n            return Err(StoreError::DeviceNotRevoked);\n        }\n        self.commit(&mut journal, index, |_| {\n            vec![Frame::DeviceUpdate {",
     "            .map(|entry| entry.record.state)\n            .unwrap_or(DeviceState::Revoked);\n        if state != DeviceState::Revoked {\n            return Err(StoreError::DeviceNotRevoked);\n        }\n        self.commit(&mut journal, index, |_| {\n            vec![Frame::DeviceUpdate {",
     STORED),
    # DURABILITY. The flag rides the journal, fsynced before the answer; an
    # archive that only touched the in-memory index is undone by a restart.
    ("flag-not-journaled", STORE,
     "        self.commit(&mut journal, index, |_| {\n            vec![Frame::DeviceUpdate {\n                device_id: *id,\n                name: None,\n                policy: None,\n                app_version: None,\n                archived: Some(true),\n            }]\n        })?;\n        Ok(())\n    }",
     "        drop(journal);\n        drop(index);\n        if let Some(entry) = self.index().devices.get_mut(id) {\n            entry.record.archived = true;\n        }\n        Ok(())\n    }",
     STORED),
    # THE RECORD IS NOT DESTROYED. Deleting it instead would turn the device's
    # refusal into an unknown credential's, and orphan the versions it wrote.
    ("record-deleted-instead", STORE,
     "        self.commit(&mut journal, index, |_| {\n            vec![Frame::DeviceUpdate {\n                device_id: *id,\n                name: None,\n                policy: None,\n                app_version: None,\n                archived: Some(true),\n            }]\n        })?;",
     "        self.commit(&mut journal, index, |_| {\n            vec![Frame::DeviceDelete { device_id: *id }]\n        })?;",
     ARCHIVED),
    # AUTHENTICATION. The route writes, so it authenticates first.
    ("auth-gone", API,
     "    let authed = auth::device(app, req, client)?;\n    let target = render::device_id(id)?;\n    if target == authed.id {",
     "    let authed = auth::device(app, req, client)?;\n    let target = render::device_id(id)?;\n    if false {",
     ARCHIVED),
    # SELF-ARCHIVE. A device tidying itself away is a device nobody can see to
    # revoke, and a person left wondering where it went.
    ("self-archive-allowed", API,
     "    if target == authed.id {\n        return Err(ApiError::new(\n            409,\n            \"own_device\",\n            \"a device cannot archive itself\",\n        ));\n    }\n",
     "", ARCHIVED),
    # THE DASHBOARD'S DOUBLE SUBMIT. A session alone is not a mutation.
    ("dashboard-csrf-gone", ADMIN,
     "pub fn archive(app: &App, req: &mut Request, id: &str) -> Result<Response, ApiError> {\n    mutating_session(app, req)?;",
     "pub fn archive(app: &App, req: &mut Request, id: &str) -> Result<Response, ApiError> {\n    session(app, req)?;",
     DASHBOARD),
    # THE WIRE. A client that does not read the flag must still be correct, so
    # the field is stated and the device stays in the list.
    ("flag-not-stated", RENDER,
     "        (\"archived\", b(d.archived)),\n", "", ARCHIVED),
    # THE LOG LINE. One structured line names the device, who asked, and how
    # long the durable write took (AGENTS.md requirement 12).
    ("decision-not-logged", API,
     "    app.log.info(\n        \"device_archived\",",
     "    app.log.debug(\n        \"not_device_archived\",", ARCHIVED),
    ("duration-not-measured", API,
     "            (\"duration_ms\", Val::ms(started.elapsed().as_millis() as u64)),\n",
     "", ARCHIVED),
    # THE ROUTE TABLE. Neither archive route may answer an anonymous caller.
    ("route-answers-anonymously", ROUTER,
     "        | Route::PluginManifest\n        | Route::DashboardFile(_) => false,\n",
     "        | Route::PluginManifest\n        | Route::DeviceArchive(_)\n        | Route::DashboardFile(_) => false,\n",
     ROUTES),
    ("admin-route-answers-anonymously", ROUTER,
     "        | Route::PluginManifest\n        | Route::DashboardFile(_) => false,\n",
     "        | Route::PluginManifest\n        | Route::AdminArchive(_)\n        | Route::DashboardFile(_) => false,\n",
     ROUTES),
]


def run(cases, what):
    """Apply each case alone, run its selector, restore the exact bytes."""
    originals = {Path(path): Path(path).read_bytes() for _, path, *_ in cases}
    failures = []
    judge = Judge({("obsyncd", case[-1]) for case in cases})
    try:
        for name, path, old, new, selector in cases:
            source = originals[Path(path)].decode()
            if source.count(old) != 1:
                raise RuntimeError(f"{name}: mutation context moved")
            mutated = source.replace(old, new, 1)
            # A route may be named in exactly one arm, so a probe that moves
            # one into the unauthenticated list takes it out of the other.
            if name.endswith("answers-anonymously"):
                arm = "DeviceArchive" if name.startswith("route") else "AdminArchive"
                line = f"        | Route::{arm}(_)\n"
                assert mutated.count(line) == 2, f"{name}: the route is not named twice"
                # split() drops the separator: put the moved line back.
                head, tail = mutated.split(line, 1)
                mutated = head + line + tail.replace(line, "", 1)
            Path(path).write_text(mutated)
            try:
                verdict, evidence = judge.test(selector)
                print(f"{name}: {verdict}\n{evidence}", flush=True)
                if verdict != "KILLED":
                    failures.append(f"{name} ({verdict})")
            finally:
                Path(path).write_bytes(originals[Path(path)])
    finally:
        for path, original in originals.items():
            path.write_bytes(original)
        judge.close()
    if failures:
        raise SystemExit("Unkilled probes: " + ", ".join(failures))
    print(f"All {len(cases)} {what} probes compiled and were killed.")


def main():
    run(CASES, "archive")


if __name__ == "__main__":
    main()
