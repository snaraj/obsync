/**
 * Three-way character merge and conflict naming. The rules under test: text
 * always merges, as concurrent typing does in a collaborative editor; no
 * inserted character is lost or repeated; a deletion on either side holds;
 * both devices compute the same bytes whichever side is their own; and a
 * conflict copy, still made for what has no text merge, is named unambiguously.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { conflictCopyPath, conflictStamp, isMergeableText, mergeText, textChanges, MERGE_STEPS } =
  require("../build/sync/conflict.js");

const lines = (...values) => values.join("\n");

/** Both argument orders, as the two devices that close one fork compute it. */
function merges(base, a, b, expected) {
  assert.equal(mergeText(base, a, b), expected, JSON.stringify({ base, a, b }));
  assert.equal(mergeText(base, b, a), expected, JSON.stringify({ base, a: b, b: a }));
}

/** Apply `textChanges(before, after)` back to `before`. */
function replay(before, changes) {
  let out = "", at = 0;
  for (const change of changes) {
    out += before.slice(at, change.from) + change.insert;
    at = change.to;
  }
  return out + before.slice(at);
}

test("a clean merge takes both sides' changes", () => {
  const base = lines("one", "two", "three", "four", "five");
  merges(base, lines("ONE", "two", "three", "four", "five"), lines("one", "two", "three", "four", "FIVE"),
    lines("ONE", "two", "three", "four", "FIVE"));
});

test("edits to adjacent lines and characters merge without a shared unchanged line", () => {
  merges("one\ntwo", "ONE\ntwo", "one\nTWO", "ONE\nTWO");
  merges("ab", "Ab", "aB", "AB");
});

test("two devices typing at the same place both keep every character, in one order on both", () => {
  merges("note: ", "note: A", "note: B", "note: AB");
  merges("0", "0ABC", "0abc", "0ABCabc");
  merges("one\ntwo", "one\nleft\ntwo", "one\nright\ntwo", "one\nleft\nright\ntwo");
  merges("😀", "A😀", "B😀", "AB😀");
});

test("typing elsewhere on one line merges character by character", () => {
  merges("line", "my line", "liXne", "my liXne");
  merges("left right", "left A right", "left B right", "left A B right");
  merges("note: 😀😄", "note: 😀X😄", "note: 😀😄Y", "note: 😀X😄Y");
  merges("Desktop: START\nPhone: START", "Desktop: STARTABC\nPhone: START", "Desktop: START\nPhone: STARTabc",
    "Desktop: STARTABC\nPhone: STARTabc");
});

test("replacing the same characters keeps both replacements", () => {
  merges("word!", "wordX", "wordY", "wordXY");
  merges("one\ntwo\nthree", "ONE\nTWO\nthree", "one\ntwo!\nTHREE", "ONE\nTWO!\nTHREE");
});

test("a deletion holds, and text typed inside a deleted range survives", () => {
  const base = lines("a", "b", "c");
  merges(base, lines("a", "c"), base, lines("a", "c"));
  merges(base, lines("a", "c"), lines("a", "c"), lines("a", "c"));
  merges(base, lines("a", "c"), lines("a", "b!", "c"), "a\n!c");
  merges("keep this sentence", "keep sentence", "keep this whole sentence", "keep whole sentence");
  merges("abcdef", "af", "abXcdef", "aXf");
});

test("deletions on both sides combine", () => {
  merges("abcdef", "acdef", "abcdf", "acdf");
  merges("abcdef", "aef", "abf", "af");
});

test("an identical change on both sides lands once", () => {
  merges("one\ntwo", "one\nextra\ntwo", "one\nextra\ntwo", "one\nextra\ntwo");
  merges(lines("a", "b", "c"), lines("a", "B", "c"), lines("a", "B", "c"), lines("a", "B", "c"));
});

test("one typed stream seen at two lengths lands once", () => {
  // Typing continues after the text both heads already hold: their shared
  // text is no new insertion, at any length one side has seen.
  merges("note: AB", "note: AaaBbb", "note: AaaB", "note: AaaBbb");
  merges("note: ", "note: abc", "note: ab", "note: abc");
});

test("the native long typing failure keeps all 823 tokens on one line", () => {
  const stream = (who, count) => Array.from({ length: count }, (_, i) => ` ${who}${String(i + 1).padStart(3, "0")}`).join("");
  const text = (a, m) => "# Both" + stream("A", a) + stream("M", m) + "\nthe line nobody edits\nthe last fixed line\n";
  const base = text(408, 406), mine = text(412, 408), theirs = text(408, 411);
  assert.equal(base.length, 4119);
  merges(base, mine, theirs, text(412, 411));
});

test("edits at the head and the tail, a trailing newline and an empty base", () => {
  merges(lines("a", "b", "c"), lines("head", "a", "b", "c"), lines("a", "b", "c", "tail"), lines("head", "a", "b", "c", "tail"));
  merges("a\nb\n", "A\nb\n", "a\nb\n", "A\nb\n");
  merges("", "", "only theirs", "only theirs");
  merges("", "mine", "theirs", "minetheirs");
});

test("random concurrent edits never lose, repeat or reorder a character and agree in both orders", () => {
  let seed = 7;
  const random = (n) => Math.floor(((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * n);
  let next = 0x4e00;
  // Distinct characters, skipping the surrogate range that is not text alone.
  const fresh = () => String.fromCodePoint(next === 0xd800 ? (next = 0xe000) && next++ : next++);
  const edit = (base) => {
    const chars = [...base], deleted = new Set();
    for (let op = 0, ops = 1 + random(5); op < ops; op++) {
      if (random(2) === 0 && chars.length > 0) {
        const at = random(chars.length);
        for (const c of chars.splice(at, 1 + random(Math.min(4, chars.length - at)))) if (base.includes(c)) deleted.add(c);
      } else chars.splice(random(chars.length + 1), 0, ...Array.from({ length: 1 + random(3) }, fresh));
    }
    const text = chars.join("");
    return { text, deleted, inserted: [...text].filter((c) => !base.includes(c)) };
  };
  for (let trial = 0; trial < 3000; trial++) {
    const base = Array.from({ length: random(30) }, fresh).join("");
    const a = edit(base), b = edit(base);
    const merged = mergeText(base, a.text, b.text);
    const out = [...merged];
    const context = JSON.stringify({ base, a: a.text, b: b.text, merged });
    assert.equal(mergeText(base, b.text, a.text), merged, context);
    for (const side of [a, b]) {
      const at = side.inserted.map((c) => out.indexOf(c));
      assert.ok(at.every((p, i) => p >= 0 && (i === 0 || p > at[i - 1])), `insertions lost or reordered ${context}`);
    }
    assert.equal(out.length, new Set(out).size, `a character repeated ${context}`);
    for (const c of base) assert.equal(out.includes(c), !a.deleted.has(c) && !b.deleted.has(c), `deletion ${context}`);
  }
});

test("text changes reproduce the edited text and never split a surrogate pair", () => {
  let seed = 11;
  const random = (n) => Math.floor(((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * n);
  // 😀 and 😄 share a high surrogate, 😀 and 🨀 a low one: both ends of a
  // shared run can fall inside a pair.
  const pieces = ["a", "b", " ", "\n", "😀", "😄", "🨀"];
  const make = (n) => Array.from({ length: n }, () => pieces[random(pieces.length)]).join("");
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (let trial = 0; trial < 3000; trial++) {
    const before = make(random(25)), after = make(random(25));
    const changes = textChanges(before, after);
    assert.equal(replay(before, changes), after);
    for (let i = 0; i < changes.length; i++) {
      const { from, to, insert } = changes[i];
      assert.ok(from <= to && (i === 0 || from > changes[i - 1].to), "sorted, separated changes");
      assert.ok(!lone.test(insert) && !lone.test(before.slice(from, to)), "whole code points only");
    }
  }
});

test("a long note with edits far apart merges precisely", () => {
  const body = Array.from({ length: 50000 }, (_, i) => `line ${i} some text here`).join("\n");
  merges(body, "TOP " + body + " END", body.replace("line 25000 some", "line 25000 SOME"),
    "TOP " + body.replace("line 25000 some", "line 25000 SOME") + " END");
});

test("thousands of edited lines on both sides merge line by line", () => {
  // A device back from a day offline: unchanged lines anchor the alignment,
  // so each side's edits land on their own lines.
  const base = Array.from({ length: 3000 }, (_, i) => `para ${i} ${"x".repeat(20)}`).join("\n");
  const a = base.split("\n").map((line, i) => (i % 2 ? `${line} A${i}` : line)).join("\n");
  const b = base.split("\n").map((line, i) => (i % 3 ? line : `B${i} ${line}`)).join("\n");
  const both = base.split("\n").map((line, i) => `${i % 3 ? "" : `B${i} `}${line}${i % 2 ? ` A${i}` : ""}`).join("\n");
  merges(base, a, b, both);
});

test("work past every alignment bound still keeps every side's text", () => {
  // Identical lines give no anchor and more differences than Myers explores:
  // regions are taken whole, which may place text less precisely but keeps it.
  const base = Array.from({ length: 4000 }, () => "same line").join("\n");
  const a = base.split("\n").map((line, i) => (i % 2 ? `${line} A${i}` : line)).join("\n");
  const b = base.split("\n").map((line, i) => (i % 3 ? line : `B${i} ${line}`)).join("\n");
  const merged = mergeText(base, a, b);
  assert.equal(mergeText(base, b, a), merged);
  for (let i = 1; i < 4000; i += 2) assert.ok(merged.includes(` A${i}`), `A${i}`);
  for (let i = 0; i < 4000; i += 3) assert.ok(merged.includes(`B${i} `), `B${i}`);
  const replaced = Array.from({ length: 3000 }, (_, i) => `new ${i} ${"y".repeat(20)}`).join("\n");
  assert.equal(replay(base, textChanges(base, replaced)), replaced, "a whole rewrite is still an exact change");
  assert.ok(MERGE_STEPS > 0);
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
