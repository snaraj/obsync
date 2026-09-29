#!/usr/bin/env python3
"""Reproduce the server speed guard probes (1.1.5, the journal group commit)
from the repository root.

Each probe must compile and fail a behavioral regression. A probe is one or
more exact substitutions, each of which must match exactly once. Sources are
restored from their exact starting bytes in finally, including on failure or
interrupt. Never run beside another build or source editor in this worktree.
"""
from pathlib import Path
import subprocess
import sys

STORE = "crates/obsyncd/src/storage/mod.rs"

SHARED = "posts_queued_behind_an_fsync_share_the_next_one_and_none_is_visible_before_it"
ONE_FILE = "two_posts_for_one_file_never_share_a_batch_so_a_repost_is_recognised"
BYTES = "a_batch_stops_taking_posts_at_its_byte_ceiling"
REFUSED = "a_batch_the_volume_refuses_answers_every_member_and_keeps_none"
WATERMARK = "a_batch_past_the_watermark_is_tried_post_by_post"

CASES = [
    # A turn takes every queued post, not only its own.
    ("group-commit-takes-the-queue", STORE, [(
        "            if first_of_file && fits {",
        "            if first_of_file && batch.is_empty() {",
    )], SHARED),
    # A turn stops at the post ceiling.
    ("group-commit-post-ceiling", STORE, [(
        "|| (batch.len() < GROUP_MAX_POSTS && weight + post.weight() <= GROUP_MAX_BYTES);",
        "|| weight + post.weight() <= GROUP_MAX_BYTES;",
    )], SHARED),
    # And at the byte ceiling.
    ("group-commit-byte-ceiling", STORE, [(
        "|| (batch.len() < GROUP_MAX_POSTS && weight + post.weight() <= GROUP_MAX_BYTES);",
        "|| batch.len() < GROUP_MAX_POSTS;",
    )], BYTES),
    # One post per file per turn, so a file's posts land in arrival order and
    # a repost is recognised rather than journalled twice.
    ("group-commit-one-post-per-file", STORE, [(
        "            if first_of_file && fits {",
        "            if fits {",
    )], ONE_FILE),
    # A batch's frames are applied only after its fsync returns: nothing of
    # the batch is readable while the fsync runs.
    ("group-commit-nothing-visible-before-fsync", STORE, [(
        "        drop(index);\n        let written = journal.append_all(&records);",
        "        let mut index = index;\n        for record in &records {\n            index.apply(record);\n"
        "        }\n        drop(index);\n        let written = journal.append_all(&records);",
    )], SHARED),
    # Each post's seq skips its own edit event.
    ("group-commit-seq-counts-the-edit", STORE, [(
        "seq = Seq(seq.0 + if post.edit.is_some() { 2 } else { 1 });",
        "seq = Seq(seq.0 + 1);",
    )], SHARED),
    # A refused batch is tried again post by post, so every member is told.
    ("group-commit-refusal-told-to-all", STORE, [(
        "                for member in writers {\n                    answers.extend(self.commit_batch(journal, vec![member]));",
        "                for member in writers.into_iter().take(1) {\n                    answers.extend(self.commit_batch(journal, vec![member]));",
    )], REFUSED),
    # A batch past the watermark is retried post by post, so the one that
    # fits lands.
    ("group-commit-watermark-per-post", STORE, [(
        "            Err(_) if writers.len() > 1 => {",
        "            Err(_) if writers.len() > usize::MAX - 1 => {",
    )], WATERMARK),
]


def main():
    # Probe names on the command line run only those; none runs them all.
    chosen = [case for case in CASES if not sys.argv[1:] or case[0] in sys.argv[1:]]
    paths = {Path(path) for _, path, _, _ in chosen}
    originals = {path: path.read_bytes() for path in paths}
    failures = []
    try:
        for name, path, edits, selector in chosen:
            source = originals[Path(path)].decode()
            for old, new in edits:
                if source.count(old) != 1:
                    raise RuntimeError(f"{name}: mutation context moved")
                source = source.replace(old, new, 1)
            Path(path).write_text(source)
            try:
                result = subprocess.run(
                    ["cargo", "test", "-p", "obsyncd", "--lib", selector],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, timeout=600, check=False,
                )
                compiled = "could not compile" not in result.stdout
                killed = compiled and result.returncode != 0 and "FAILED" in result.stdout
                print(f"{name}: {'KILLED' if killed else 'NOT A KILL'}", flush=True)
                if not killed:
                    failures.append(name)
                    print(result.stdout, flush=True)
                else:
                    print("\n".join(line for line in result.stdout.splitlines()
                                    if "FAILED" in line or "test result:" in line), flush=True)
            finally:
                Path(path).write_bytes(originals[Path(path)])
    finally:
        for path, original in originals.items():
            path.write_bytes(original)
    if failures:
        raise SystemExit("Unkilled probes: " + ", ".join(failures))
    print(f"All {len(chosen)} server probes compiled and were killed.")


if __name__ == "__main__":
    main()
