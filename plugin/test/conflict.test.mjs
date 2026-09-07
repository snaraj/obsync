/**
 * Three-way merge and conflict naming. The rule under test throughout is
 * "never silently discard an edit": a hunk both sides moved differently must
 * refuse to merge, and a refusal must produce a conflict copy whose name is
 * unambiguous.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { alignLines, conflictCopyPath, conflictStamp, isMergeableText, threeWayMerge, MAX_ALIGN_CELLS } =
  require("../build/sync/conflict.js");

const lines = (...values) => values.join("\n");

test("a clean merge takes both sides' changes", () => {
  const base = lines("one", "two", "three", "four", "five");
  const mine = lines("ONE", "two", "three", "four", "five");
  const theirs = lines("one", "two", "three", "four", "FIVE");
  const merged = threeWayMerge(base, mine, theirs);
  assert.equal(merged.ok, true);
  assert.equal(merged.text, lines("ONE", "two", "three", "four", "FIVE"));
});

test("an insertion on one side lands once", () => {
  const base = lines("a", "b", "c");
  const mine = lines("a", "b", "b2", "c");
  const theirs = lines("a", "b", "c");
  assert.equal(threeWayMerge(base, mine, theirs).text, lines("a", "b", "b2", "c"));
  assert.equal(threeWayMerge(base, theirs, mine).text, lines("a", "b", "b2", "c"));
});

test("the same edit on both sides is applied once, not twice", () => {
  const base = lines("a", "b", "c");
  const same = lines("a", "B", "c");
  const merged = threeWayMerge(base, same, same);
  assert.equal(merged.ok, true);
  assert.equal(merged.text, same);
});

test("overlapping edits refuse to merge", () => {
  const base = lines("a", "b", "c");
  const mine = lines("a", "mine", "c");
  const theirs = lines("a", "theirs", "c");
  const merged = threeWayMerge(base, mine, theirs);
  assert.equal(merged.ok, false);
  assert.equal(merged.reason, "overlap");
});

test("a delete on one side is honoured; delete versus edit refuses", () => {
  const base = lines("a", "b", "c");
  assert.equal(threeWayMerge(base, lines("a", "c"), base).text, lines("a", "c"));
  assert.equal(threeWayMerge(base, lines("a", "c"), lines("a", "c")).text, lines("a", "c"));
  const clash = threeWayMerge(base, lines("a", "c"), lines("a", "b!", "c"));
  assert.equal(clash.ok, false);
  assert.equal(clash.reason, "overlap");
});

test("edits at the head and the tail of a file merge", () => {
  const base = lines("a", "b", "c");
  const merged = threeWayMerge(base, lines("head", "a", "b", "c"), lines("a", "b", "c", "tail"));
  assert.equal(merged.ok, true);
  assert.equal(merged.text, lines("head", "a", "b", "c", "tail"));
});

test("a trailing newline survives a merge", () => {
  const base = "a\nb\n";
  const mine = "A\nb\n";
  const theirs = "a\nb\n";
  const merged = threeWayMerge(base, mine, theirs);
  assert.equal(merged.text, "A\nb\n");
  assert.ok(merged.text.endsWith("\n"));
});

test("an empty base merges a one-sided creation", () => {
  const merged = threeWayMerge("", "", lines("only theirs"));
  assert.equal(merged.ok, true);
  assert.equal(merged.text, lines("only theirs"));
});

test("alignment refuses a file it cannot afford to align", () => {
  const rows = Math.ceil(Math.sqrt(MAX_ALIGN_CELLS)) + 2;
  const base = Array.from({ length: rows }, (_, i) => `base ${i}`).join("\n");
  const mine = Array.from({ length: rows }, (_, i) => `mine ${i}`).join("\n");
  assert.equal(alignLines(base.split("\n"), mine.split("\n")), null);
  const merged = threeWayMerge(base, mine, base);
  assert.equal(merged.ok, false);
  assert.equal(merged.reason, "too_large");
});

test("alignment maps common lines and skips changed ones", () => {
  const map = alignLines(["a", "b", "c"], ["a", "x", "c"]);
  assert.equal(map.get(0), 0);
  assert.equal(map.get(2), 2);
  assert.equal(map.has(1), false);
});

test("conflict copies are named unambiguously", () => {
  const when = new Date(2026, 8, 7, 14, 32);
  assert.equal(conflictStamp(when), "2026-09-07 1432");
  assert.equal(
    conflictCopyPath("Notes/Ideas.md", "iPhone", when),
    "Notes/Ideas (conflict from iPhone, 2026-09-07 1432).md",
  );
  assert.equal(
    conflictCopyPath("Ideas", "windows-ab12", when),
    "Ideas (conflict from windows-ab12, 2026-09-07 1432)",
  );
  assert.equal(
    conflictCopyPath("a/b/.hidden", "linux", when),
    "a/b/.hidden (conflict from linux, 2026-09-07 1432)",
  );
  assert.equal(
    conflictCopyPath("archive.tar.gz", "macos", when),
    "archive.tar (conflict from macos, 2026-09-07 1432).gz",
  );
});

test("a hostile device name cannot escape the folder or break the path", () => {
  const when = new Date(2026, 0, 2, 3, 4);
  const path = conflictCopyPath("Notes/Ideas.md", "../../etc/passwd:*?", when);
  assert.equal(path.includes(".."), false);
  assert.equal(path.startsWith("Notes/"), true);
  assert.equal(path.slice("Notes/".length).includes("/"), false);
  assert.equal(conflictCopyPath("Ideas.md", "   ", when), "Ideas (conflict from another device, 2026-01-02 0304).md");
  const long = conflictCopyPath("Ideas.md", "x".repeat(200), when);
  assert.ok(long.length < 120, "an absurd device name is trimmed");
});

test("only text files are merge candidates", () => {
  const text = new TextEncoder().encode("# note\n");
  assert.equal(isMergeableText("a.md", text), true);
  assert.equal(isMergeableText("a.txt", text), true);
  assert.equal(isMergeableText("a.png", text), false);
  assert.equal(isMergeableText("a.md", Uint8Array.from([0x23, 0x00, 0x41])), false, "NUL means binary");
});
