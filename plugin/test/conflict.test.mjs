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
const { alignInsertions, alignLines, conflictCopyPath, conflictStamp, isMergeableText, threeWayMerge, MAX_ALIGN_CELLS } =
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

test("edits to adjacent lines merge without requiring a shared unchanged line", () => {
  for (const [mine, theirs] of [["ONE\ntwo", "one\nTWO"], ["one\nTWO", "ONE\ntwo"]]) {
    assert.deepEqual(threeWayMerge("one\ntwo", mine, theirs), { ok: true, text: "ONE\nTWO" });
  }
});

test("shared appends on adjacent lines do not turn continued typing into an overlap", () => {
  const base = "Desktop: START\nPhone: START";
  for (const mine of ["Desktop: STARTABC\nPhone: STARTab", "Desktop: STARTABC\nPhone: START"]) {
    const theirs = "Desktop: STARTAB\nPhone: STARTabc";
    for (const [left, right] of [[mine, theirs], [theirs, mine]]) {
      assert.deepEqual(threeWayMerge(base, left, right),
        { ok: true, text: "Desktop: STARTABC\nPhone: STARTabc" });
    }
  }
});

test("adjacent append runs preserve unchanged anchors and Unicode additions", () => {
  const base = "heading\none\ntwo\nlast\n";
  const mine = "heading\none😀A\ntwoB\nlast\n";
  const theirs = "heading\none😀\ntwoBC\nlast\n";
  for (const [left, right] of [[mine, theirs], [theirs, mine]]) {
    assert.deepEqual(threeWayMerge(base, left, right),
      { ok: true, text: "heading\none😀A\ntwoBC\nlast\n" });
  }
});

test("a deletion beside an edited line keeps that edit in either device order", () => {
  for (const [mine, theirs] of [["two\nthree", "one\nTWO\nthree"], ["one\nTWO\nthree", "two\nthree"]]) {
    assert.deepEqual(threeWayMerge("one\ntwo\nthree", mine, theirs), { ok: true, text: "TWO\nthree" });
  }
});

test("adjacent replacements may add lines without swallowing the other replacement", () => {
  assert.deepEqual(threeWayMerge("one\ntwo", "ONE\nextra\ntwo", "one\nTWO"),
    { ok: true, text: "ONE\nextra\nTWO" });
});

test("identical insertions are kept once and different insertions at the same boundary refuse", () => {
  const base = "one\ntwo";
  assert.deepEqual(threeWayMerge(base, "one\nextra\ntwo", "one\nextra\ntwo"),
    { ok: true, text: "one\nextra\ntwo" });
  assert.deepEqual(threeWayMerge(base, "one\nleft\ntwo", "one\nright\ntwo"),
    { ok: false, reason: "overlap" });
});

test("partly overlapping multi-line changes remain conflicts in either order", () => {
  const base = "one\ntwo\nthree";
  for (const [mine, theirs] of [["ONE\nTWO\nthree", "one\nother two\nTHREE"], ["one\nother two\nTHREE", "ONE\nTWO\nthree"]]) {
    assert.deepEqual(threeWayMerge(base, mine, theirs), { ok: false, reason: "overlap" });
  }
});

test("a multi-line replacement remains atomic beside competing appends", () => {
  const base = "first\nold line";
  for (const [mine, theirs] of [["firstA\nnew line", "firstB\nnew line"], ["firstB\nnew line", "firstA\nnew line"]]) {
    assert.deepEqual(threeWayMerge(base, mine, theirs), { ok: false, reason: "overlap" });
  }
});

test("the same replacement text at different base intervals is not the same edit", () => {
  assert.deepEqual(threeWayMerge("one\ntwo", "X\ntwo", "one\nX"), { ok: true, text: "X\nX" });
  for (const [mine, theirs] of [["X", "one\nX"], ["X\ntwo", "X"]]) {
    assert.deepEqual(threeWayMerge("one\ntwo", mine, theirs), { ok: false, reason: "overlap" });
  }
});

test("an insertion and replacement beginning at the same boundary are conservatively refused", () => {
  for (const [mine, theirs] of [["inserted\none\ntwo", "ONE\ntwo"], ["ONE\ntwo", "inserted\none\ntwo"]]) {
    assert.deepEqual(threeWayMerge("one\ntwo", mine, theirs), { ok: false, reason: "overlap" });
  }
});

test("unchanged lines between and after neighboring edits remain in order", () => {
  assert.deepEqual(threeWayMerge("first\none\ntwo\nlast", "first\nONE\ntwo\nlast", "first\none\nTWO\nlast"),
    { ok: true, text: "first\nONE\nTWO\nlast" });
});

test("concurrent appends to one line keep both additions in the same order on both devices", () => {
  for (const [mine, theirs] of [["note: A", "note: B"], ["note: B", "note: A"]]) {
    assert.deepEqual(threeWayMerge("note: ", mine, theirs), { ok: true, text: "note: AB" });
  }
});

test("a shared appended prefix is kept once without splitting Unicode characters", () => {
  for (const [mine, theirs] of [["note: shared 😀", "note: shared 😄"], ["note: shared 😄", "note: shared 😀"]]) {
    assert.deepEqual(threeWayMerge("note: ", mine, theirs), { ok: true, text: "note: shared 😀😄" });
  }
  assert.deepEqual(threeWayMerge("note: ", "note: abc", "note: ab"), { ok: true, text: "note: abc" });
  assert.deepEqual(threeWayMerge("note: ", "note: 😀A", "note: 😀B"), { ok: true, text: "note: 😀AB" });
});

test("typing continues before an addition already learned from the other device", () => {
  for (const [mine, theirs] of [["note: AaaBbb", "note: AaaB"], ["note: AaaB", "note: AaaBbb"]]) {
    assert.deepEqual(threeWayMerge("note: AB", mine, theirs), { ok: true, text: "note: AaaBbb" });
  }
  assert.deepEqual(threeWayMerge("note: AB", "note: AaB", "note: AaabB"), { ok: true, text: "note: AaabB" });
  assert.deepEqual(threeWayMerge("note: 😀😄", "note: 😀X😄", "note: 😀😄Y"), { ok: true, text: "note: 😀X😄Y" });
});

test("insertions before the first character preserve every original anchor", () => {
  for (const [mine, theirs] of [["my line", "liXne"], ["liXne", "my line"]]) {
    assert.deepEqual(threeWayMerge("line", mine, theirs), { ok: true, text: "my liXne" });
  }
  const base = "Desktop control 42\nphone7\nABCDEFGHIJKL";
  const mine = "Desktop control 42\nphone7\nABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const theirs = "Desktop control 42\nphone7\nabcdefghijklmnopqrstuvwxyzABCDEFGHIJKL";
  for (const [a, b] of [[mine, theirs], [theirs, mine]]) {
    assert.deepEqual(threeWayMerge(base, a, b),
      { ok: true, text: "Desktop control 42\nphone7\nabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" });
  }
  for (const [a, b] of [["A😀", "B😀"], ["B😀", "A😀"]]) {
    assert.deepEqual(threeWayMerge("😀", a, b), { ok: true, text: "AB😀" });
  }
  for (const [a, b] of [["my line", "their line"], ["their line", "my line"]]) {
    assert.deepEqual(threeWayMerge("line", a, b), { ok: true, text: "my their line" });
  }
  for (const [a, b] of [["prefix line", "linX"], ["linX", "prefix line"]]) {
    assert.deepEqual(threeWayMerge("line", a, b), { ok: false, reason: "overlap" });
  }
});

test("different inserted words retain their own leading separators", () => {
  for (const space of [" ", "\t", "\u2003", "  "]) {
    const a = "# Both" + space + "A001 A002", b = "# Both" + space + "B001 B002";
    for (const [mine, theirs] of [[a, b], [b, a]]) {
      assert.deepEqual(threeWayMerge("# Both", mine, theirs),
        { ok: true, text: "# Both" + space + "A001 A002" + space + "B001 B002" });
    }
    for (const [mine, theirs] of [[a, "# Both" + space], ["# Both" + space, a]]) {
      assert.deepEqual(threeWayMerge("# Both", mine, theirs), { ok: true, text: a });
    }
    assert.deepEqual(threeWayMerge("# Both", a, a), { ok: true, text: a });
  }
  for (const [a, b] of [["left A right", "left B right"], ["left B right", "left A right"]]) {
    assert.deepEqual(threeWayMerge("left right", a, b), { ok: true, text: "left A B right" });
  }
});

test("insertion-only text avoids a refused grid without changing its allocation bound", () => {
  const base = Array.from({ length: 2100 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
  const expensive = "X" + [...base].join("X") + "X";
  const simple = "Y" + base;
  assert.equal(alignLines([...base], [...expensive]), null, "the general LCS table still refuses its original budget");
  for (const [mine, theirs] of [[expensive, simple], [simple, expensive]]) {
    assert.deepEqual(threeWayMerge(base, mine, theirs), { ok: true, text: "XY" + [...base].join("X") + "X" });
  }
});

test("linear insertion proofs match every accepted bounded LCS alignment", () => {
  const words = length => length === 0 ? [""] : [...words(length - 1), ...words(length - 1).filter(s => s.length === length - 1).flatMap(s => [s + "a", s + "b"])];
  for (const base of words(4)) for (const side of words(6)) {
    const expected = alignLines([...base], [...side]);
    assert.deepEqual(alignInsertions([...base], [...side]), expected.size === base.length ? expected : null,
      JSON.stringify({ base, side }));
  }
});

test("insertion proof reads at most a linear number of points on long inputs", () => {
  const base = Array.from({ length: 10000 }, (_, i) => String.fromCodePoint(0x4e00 + i));
  const side = ["X", ...base.flatMap(c => [c, "X"])];
  let reads = 0;
  const counted = items => new Proxy(items, { get(target, property) {
    if (/^[0-9]+$/.test(String(property))) reads++;
    return Reflect.get(target, property);
  } });
  const result = alignInsertions(counted(base), counted(side));
  assert.equal(result.size, base.length);
  assert.ok(reads <= 4 * (base.length + side.length), `point reads=${reads}`);
  for (let i = 0; i < base.length; i++) assert.equal(result.get(i), 1 + i * 2);
});

test("the native long typing failure keeps all 823 tokens on one line", () => {
  const stream = (who, count) => Array.from({ length: count }, (_, i) => ` ${who}${String(i + 1).padStart(3, "0")}`).join("");
  const text = (a, m) => "# Both" + stream("A", a) + stream("M", m) + "\nthe line nobody edits\nthe last fixed line\n";
  const base = text(408, 406), mine = text(412, 408), theirs = text(408, 411);
  assert.equal(base.length, 4119);
  for (const [a, b] of [[mine, theirs], [theirs, mine]]) {
    assert.deepEqual(threeWayMerge(base, a, b), { ok: true, text: text(412, 411) });
  }
});

test("replacements of existing characters are not classified as appends", () => {
  for (const [mine, theirs] of [["wordX", "wordY"], ["wordY", "wordX"], ["word!A", "wordX"], ["wordX", "word!A"]]) {
    assert.deepEqual(threeWayMerge("word!", mine, theirs), { ok: false, reason: "overlap" });
  }
});

test("appending cannot absorb a competing multi-line replacement", () => {
  assert.deepEqual(threeWayMerge("one\ntwo", "oneX", "oneY"), { ok: false, reason: "overlap" });
  assert.deepEqual(threeWayMerge("one\ntwo", "oneX\ntwo", "oneY"), { ok: false, reason: "overlap" });
  assert.deepEqual(threeWayMerge("one\ntwo", "one\ntwoX", "twoY"), { ok: false, reason: "overlap" });
  for (const [mine, theirs] of [["oneX\nextra\ntwo", "oneY\ntwo"], ["oneY\ntwo", "oneX\nextra\ntwo"]]) {
    assert.deepEqual(threeWayMerge("one\ntwo", mine, theirs), { ok: false, reason: "overlap" });
  }
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
