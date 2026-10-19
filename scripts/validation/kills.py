"""One verdict for every cargo mutation runner in this directory (review of 1cc99e32).

A test run that fails is not, by itself, a killed mutant: a sandbox with no
loopback fails every server test at its listener, and the runners used to
count that as a kill. So a mutant is KILLED only when, in this environment:

- the selector passes on the unmutated source and runs at least one test,
  checked before any mutation and again when the mutant fails, on a copy of
  the test binary built once from the starting bytes;
- the mutant compiles, and every selected test that fails ends at a
  verdict: its own thread's last panic is at an `assert!`, `assert_eq!`,
  `assert_ne!`, `panic!` or `unreachable!` in the source (the column Rust
  reports is the macro's own), or at an `.expect` whose message VERDICTS
  lists for that test. A test that ends at any other `.expect`, an
  `.unwrap`, an index or anything else failed in its setup or its harness,
  and that is ERROR whatever the baseline did;
- a second run of the same mutant fails the same tests at the same sites.

The evidence (each failing test, its assertion's site, and the first line of
its message) is printed. A failure the unmutated binary shares, one that does
not repeat where it failed, or one that does not end at an assertion is ERROR,
never a kill, and a runner that meets one cannot report success.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# `thread 'name' (id) panicked at file:line:col:` then the message; older
# toolchains omit the id. A test's helper threads panic as '<unnamed>'.
PANIC = re.compile(r"^thread '([^']+)'(?: \(\d+\))? panicked at ([^\n]+):\n([^\n]*)", re.M)
FAILING = re.compile(r"^---- (\S+) stdout ----$", re.M)
PASSED = re.compile(r"^test result: ok\. (\d+) passed", re.M)


def baseline_failure(baseline):
    """Why the unmutated run (returncode, output) cannot judge, or None."""
    code, output = baseline
    passed = PASSED.search(output)
    if code == 0 and passed and int(passed.group(1)) > 0:
        return None
    shared = PANIC.findall(output)
    return f"{shared[-1][0]} at {shared[-1][1]}: {shared[-1][2]}" if shared else "it runs no test"


ASSERTIONS = ("assert!", "assert_eq!", "assert_ne!", "panic!", "unreachable!")
# The tests that state a verdict with `.expect` or `.expect_err` on the code
# under test's own answer (a thread's join included) rather than with an
# assertion macro, and each such verdict's message. An ending counts at an
# `expect` call only when its message is listed here for its own test, so a
# setup `.expect` (a listener, a folder, a test's first requests) never does.
# scripts/ci/test_mutation_kills.py holds every message to the source.
VERDICTS = {
    "api::auth::tests::a_device_at_its_share_is_refused_and_no_other_device_is": (
        "the device's share is spent", "answered again once its nonces expire"),
    "api::auth::tests::a_flush_that_panics_answers_every_member_and_blocks_nobody": (
        "a member was left waiting on a flush that panicked",),
    "api::auth::tests::a_member_woken_on_a_lock_a_flush_poisoned_is_answered": (
        "a member woken on a poisoned lock panicked",),
    "api::auth::tests::a_share_still_refuses_after_a_reload": ("the reloaded nonces count",),
    "api::auth::tests::concurrent_requests_share_an_fsync_and_none_is_answered_before_its_own": (
        "every accepted nonce is in a durable batch",),
    "api::chunks::tests::a_chunk_shorter_than_its_plan_fails_the_read_instead_of_misframing": ("short chunk",),
    "api::edge::tests::edge_mode_refuses_an_unparseable_or_repeated_edge_header": ("refuses",),
    "api::edge::tests::edge_mode_refuses_the_edge_headers_from_an_untrusted_peer": ("refuses",),
    "api::edge::tests::edge_mode_requires_the_request_id": ("refuses",),
    "api::pairing::tests::a_reveal_needs_a_live_claim_not_yet_approved": ("refused",),
    "api::pairing::tests::a_revealed_creator_pub_rides_the_wait_and_the_envelope": (
        "the creator's alone", "one key per pairing"),
    "api::pairing::tests::a_swept_pairing_tells_its_creator_how_it_ended": ("stranger",),
    "cli::tests::export_refuses_key_inputs_without_echoing_or_reading_them": ("server interfaces never accept content keys",),
    "storage::blobs::tests::a_cut_upload_keeps_its_temp_until_a_start_repairs_its_fan_out": (
        "the first start after the cut",),
    "storage::journal::tests::a_snapshot_is_read_a_file_at_a_time_to_the_index_it_was_written_from": ("canonical",),
    "storage::tests::a_batch_past_the_watermark_is_tried_post_by_post": ("a post thread",),
    "storage::tests::a_batch_the_volume_refuses_answers_every_member_and_keeps_none": ("a post thread",),
    "storage::tests::a_new_fan_out_directory_is_durable_in_its_parent_before_its_chunk_is_acknowledged": (
        "refused before the rename", "the leaf's name is still not durable"),
    "storage::tests::a_writer_s_fsync_holds_the_journal_and_never_the_index_and_nothing_is_applied_before_it": (
        "the index is free during the fsync",),
    "storage::tests::a_young_recovery_key_holds_only_the_last_device_and_the_reset_restores_the_guard": (
        "the last device stays while the key is young",
        "a key with no registration time does not hold the last device"),
    "storage::tests::account_recovery_is_immutable_and_survives_journal_and_snapshot_replay": (
        "a key one millisecond short of the hold keeps the last device",
        "recovery permits the last device to leave once the hold has passed"),
    "storage::tests::only_a_revoked_device_is_archived_and_the_record_survives": (
        "only a revoked device is archived",),
    "storage::tests::posts_queued_behind_an_fsync_share_the_next_one_and_none_is_visible_before_it": (
        "an answered seq is in the feed",),
    "storage::tests::puts_that_arrive_together_are_measured_against_each_other_and_exactly_one_is_refused": (
        "measured against the bytes the first holds",),
}


def source_at(site):
    """The source text from a panic's `file:line:column` onward, or "" when
    it is not this repository's (the standard library's own, say) or there
    is no site."""
    try:
        path, line, column = site.rsplit(":", 2)
        return (ROOT / path).read_text().splitlines()[int(line) - 1][int(column) - 1:]
    except (OSError, ValueError, IndexError):
        return ""


def is_verdict(test, at, message, source):
    """Whether `test` ended at a verdict: an assertion macro, or an `expect`
    whose message is one VERDICTS lists for that test."""
    said = source(at)
    if said.startswith(ASSERTIONS):
        return True
    return said.startswith("expect") and any(
        message == verdict or message.startswith(verdict + ": ") for verdict in VERDICTS.get(test, ()))


def endings(output):
    """Each failing test and the last panic on its own thread (the one that
    ended it), as {test: (site, message)}; a helper thread's panic is not one."""
    last = {thread: (at, message) for thread, at, message in PANIC.findall(output)}
    return {test: last.get(test, ("", "")) for test in set(FAILING.findall(output))}


def classify(first, again, baseline, source=source_at):
    """The verdict and its evidence from the mutant's run `first`, its repeat
    `again` (None when there was none) and the unmutated `baseline`; each is
    (returncode, output). Its one other input is the source at each panic's
    site, through `source`, so a test can hold it to every case."""
    code, output = first
    if "could not compile" in output:
        return "NOT A KILL", "the mutant did not compile"
    if code == 0:
        return "NOT A KILL", "the selected tests passed"
    ended = endings(output)
    if not ended:
        return "ERROR", "no selected test failed: a harness failure, not an assertion"
    for test, (at, message) in sorted(ended.items()):
        if not is_verdict(test, at, message, source):
            return "ERROR", (f"{test} ended at {at or 'no panic on its own thread'}, not at an assertion "
                             f"or a listed verdict ({message}): a setup or harness failure, never a kill")
    why = baseline_failure(baseline)
    if why is not None:
        return "ERROR", f"the unmutated binary fails here too ({why}): the environment's failure, not the mutant's"
    repeat = endings(again[1]) if again is not None and again[0] != 0 else {}
    if {test: at for test, (at, _) in repeat.items()} != {test: at for test, (at, _) in ended.items()}:
        return "ERROR", "the failure did not repeat in the same tests at the same sites"
    return "KILLED", "\n".join(f"  {test} at {at}: {message}" for test, (at, message) in sorted(ended.items()))


class Judge:
    """Builds the unmutated test binary of each crate once, refuses to start
    unless every selector passes on it, then judges each mutant (`test`)."""

    def __init__(self, selections):
        self.scratch = tempfile.TemporaryDirectory(prefix="kills-")
        self.binaries = {}
        try:
            for crate in sorted({crate for crate, _ in selections}):
                self.binaries[crate] = self._build(crate)
            refused = []
            for crate, selector in sorted(set(selections)):
                why = baseline_failure(self.baseline(crate, selector))
                if why is not None:
                    refused.append(f"{crate} {selector}: {why}")
            if refused:
                raise SystemExit("ERROR: no mutant can be judged here, because the unmutated "
                                 "baseline does not pass:\n" + "\n".join(refused))
        except BaseException:
            self.scratch.cleanup()
            raise

    def _build(self, crate):
        built = subprocess.run(
            ["cargo", "test", "-p", crate, "--lib", "--no-run", "--message-format=json"],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
        for line in built.stdout.splitlines():
            message = json.loads(line) if line.startswith("{") else {}
            if (message.get("reason") == "compiler-artifact" and message.get("executable")
                    and message["profile"]["test"] and "lib" in message["target"]["kind"]):
                copy = Path(self.scratch.name) / crate
                shutil.copy2(message["executable"], copy)
                return copy, Path(message["manifest_path"]).parent
        raise SystemExit(f"ERROR: cargo built no library test binary for {crate}")

    def baseline(self, crate, selector):
        binary, home = self.binaries[crate]
        ran = subprocess.run([str(binary), selector], cwd=home, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, timeout=600, check=False,
                             env={**os.environ, "CARGO_MANIFEST_DIR": str(home)})
        return ran.returncode, ran.stdout

    def test(self, selector, crate="obsyncd"):
        """Judge the mutation now in the tree: call it before restoring it."""
        command = ["cargo", "test", "-p", crate, "--lib", selector]

        def run():
            try:
                done = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, text=True, timeout=600, check=False)
                return done.returncode, done.stdout
            except subprocess.TimeoutExpired as expired:
                partial = expired.stdout or b""
                if isinstance(partial, bytes):
                    partial = partial.decode(errors="replace")
                return 0, partial + "\n(timed out: not a kill)"

        first = run()
        if first[0] == 0 or "could not compile" in first[1] or not FAILING.search(first[1]):
            return classify(first, None, None)
        return classify(first, run(), self.baseline(crate, selector))

    def close(self):
        self.scratch.cleanup()
