import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { inspect } from "node:util";

const require = createRequire(import.meta.url);
const backup = require("../build/recoveryBackup.js");
const pairing = require("../build/pairing.js");
const PREFIX = "obsync-recovery-v2";
// The fixed 256-bit BIP39 vectors already used by pairing.test.mjs.
const VECTORS = [
  [0x00, `${"abandon ".repeat(23)}art`],
  [0xff, `${"zoo ".repeat(23)}vote`],
  [0x80, "letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd " +
    "amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless"],
];
const PHRASE = VECTORS[0][1], LIVE = `${PREFIX} ${PHRASE}`;
const zeros = () => new Uint8Array(32);

async function refused(operation, code, label) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof backup.BackupFailure, `${label}: fixed failure type`);
    assert.equal(error.code, code, `${label}: fixed failure code`);
    assert.equal(error.message, code, `${label}: fixed failure message`);
    assert.ok(!Object.hasOwn(error, "cause"), `${label}: source cause must be absent`);
    return true;
  }, label);
}

test("canonical v2 backup matches all three fixed BIP39 vectors", async () => {
  for (const [value, phrase] of VECTORS) {
    const root = new Uint8Array(32).fill(value);
    const encoded = await backup.encodeRecoveryBackup(root);
    assert.equal(encoded, `${PREFIX} ${phrase}`, "encoder must preserve canonical BIP39 text");
    assert.match(encoded, /^obsync-recovery-v2(?: [a-z]+){24}$/, "encoder must emit exact ASCII grammar");
    assert.ok(Buffer.byteLength(encoded, "utf8") <= 512, "encoded backup must fit byte limit");
    assert.deepEqual(await backup.parseRecoveryBackup(encoded), root, "live fixed vector must decode");
    assert.deepEqual(await backup.parseLegacyRecoveryHistory(phrase), root, "history fixed vector must decode");
  }
});

test("encoding snapshots caller entropy before awaiting checksum", async () => {
  const root = zeros();
  const pending = backup.encodeRecoveryBackup(root);
  root.fill(0xff);
  assert.equal(await pending, LIVE, "encoding must use detached pre-await entropy");
  const allocation = new Uint8Array(64).fill(0xff);
  const view = allocation.subarray(16, 48);
  view.fill(0);
  const fromView = backup.encodeRecoveryBackup(view);
  allocation.fill(0xff);
  assert.equal(await fromView, LIVE, "encoding must snapshot only the selected entropy view");
});

test("live and explicit history parsing accept only ASCII outer and separator whitespace", async () => {
  for (const space of [" ", "\t", "\r", "\n", " \t\r\n "]) {
    assert.deepEqual(await backup.parseRecoveryBackup(space + LIVE.replaceAll(" ", space) + space), zeros(),
      "live ASCII whitespace must preserve the root");
    assert.deepEqual(await backup.parseLegacyRecoveryHistory(space + PHRASE.replaceAll(" ", space) + space), zeros(),
      "history ASCII whitespace must preserve the root");
  }
});

test("the byte ceiling includes outer whitespace: 512 accepted, 513 refused", async () => {
  for (const [parser, text] of [[backup.parseRecoveryBackup, LIVE], [backup.parseLegacyRecoveryHistory, PHRASE]]) {
    const atLimit = " ".repeat(512 - text.length) + text;
    assert.equal(Buffer.byteLength(atLimit), 512);
    let staged;
    await assert.doesNotReject(async () => { staged = await parser(atLimit); }, "exact byte ceiling must be accepted");
    assert.deepEqual(staged, zeros(), "exact byte ceiling must preserve staged entropy");
    await refused(() => parser(" " + atLimit), "backup_text", "513-byte backup must be refused before trimming");
  }
});

test("non-ASCII whitespace, confusables and unsupported ASCII controls never normalize", async () => {
  for (const char of ["\u00a0", "\u2003", "\u200b", "\ufeff", "\u2028", "\u202e", "\u2066", "\u{1f600}",
    "\0", "\x01", "\x08", "\x0b", "\x0c", "\x1f", "\x7f"]) {
    for (const [parser, text] of [[backup.parseRecoveryBackup, LIVE], [backup.parseLegacyRecoveryHistory, PHRASE]]) {
      await refused(() => parser(char + text), "backup_text", "non-grammar outer character must be refused");
      await refused(() => parser(text.replace(" ", char)), "backup_text", "non-grammar separator must be refused");
    }
  }
  await refused(() => backup.parseRecoveryBackup(LIVE.replace("o", "\u043e")), "backup_text",
    "Cyrillic prefix confusable must be refused");
  await refused(() => backup.parseRecoveryBackup(LIVE.replace("abandon", "\uff41bandon")), "backup_text",
    "fullwidth word confusable must be refused");
});

test("prefix is exact lowercase and mandatory; history never strips it", async () => {
  for (const prefix of ["OBSYNC-RECOVERY-V2", "Obsync-recovery-v2", "obsync-recovery-v1", "obsync-recovery-v3",
    "obsync-recovery-v", "obsync-recovery-v2x", "xobsync-recovery-v2", "\"obsync-recovery-v2\""]) {
    await refused(() => backup.parseRecoveryBackup(`${prefix} ${PHRASE}`), "backup_format",
      "nonexact prefix must be refused");
  }
  await refused(() => backup.parseRecoveryBackup(PHRASE), "backup_format", "stripped live prefix must be refused");
  await refused(() => backup.parseLegacyRecoveryHistory(LIVE), "backup_phrase", "history must not strip a live prefix");
  await refused(() => backup.parseRecoveryBackup(`${PREFIX} ${LIVE}`), "backup_phrase", "duplicate prefix must be refused");
});

test("both parsers enforce lowercase words, exact count, checksum and end of input", async () => {
  const words = PHRASE.split(" ");
  for (const phrase of [words.slice(0, 23).join(" "), `${PHRASE} abandon`, `${PHRASE} ${PHRASE}`,
    PHRASE.replace("abandon", "Abandon"), PHRASE.toUpperCase(), PHRASE.replace("abandon", "unknownbackupword"),
    `${words.slice(0, 23).join(" ")} abandon`, `${PHRASE}.`, `${PHRASE} trailing`, ""]) {
    await refused(() => backup.parseRecoveryBackup(`${PREFIX} ${phrase}`), "backup_phrase", "invalid live phrase must be refused");
    await refused(() => backup.parseLegacyRecoveryHistory(phrase), "backup_phrase", "invalid history phrase must be refused");
  }
});

test("encoding refuses wrong entropy types and lengths with fixed failures", async (t) => {
  const encodePhrase = pairing.recoveryPhrase;
  let calls = 0;
  t.mock.method(pairing, "recoveryPhrase", async (root) => {
    calls++;
    return encodePhrase(root);
  });
  for (const root of [new Uint8Array(31), new Uint8Array(33), [], Array(32).fill(0), new ArrayBuffer(32), null]) {
    await refused(() => backup.encodeRecoveryBackup(root), "backup_entropy", "invalid entropy must be refused");
  }
  assert.equal(calls, 0, "invalid entropy must be refused before phrase encoding");
  for (const text of [null, 123, {}, { toString() { throw new Error("SENTINEL-BACKUP-COERCION"); } }]) {
    for (const parser of [backup.parseRecoveryBackup, backup.parseLegacyRecoveryHistory]) {
      await refused(() => parser(text), "backup_text", "non-text backup must be refused without coercion");
    }
  }
});

test("decoding yields independent staged bytes and invokes only the selected phrase decoder", async (t) => {
  const staged = zeros();
  const calls = [];
  t.mock.method(pairing, "entropyFromPhrase", async (words) => {
    calls.push([...words]);
    return staged.slice();
  });
  const live = await backup.parseRecoveryBackup(LIVE);
  const history = await backup.parseLegacyRecoveryHistory(PHRASE);
  assert.deepEqual(calls, [PHRASE.split(" "), PHRASE.split(" ")], "selected codecs must only decode staged phrase words");
  live.fill(0xff);
  assert.deepEqual(history, zeros(), "returned staged roots must not share storage");
  assert.deepEqual(staged, zeros(), "staged result must not mutate source entropy");
  await refused(() => backup.parseRecoveryBackup(PHRASE), "backup_format", "live codec must never fall back to history");
  assert.equal(calls.length, 2, "stripped prefix must not invoke any phrase decoder");
});

test("underlying failures never retain sentinel, phrase, cause or source properties", async (t) => {
  const sentinel = "SENTINEL-BACKUP-SOURCE-ERROR";
  const unsafe = new Error(`${sentinel} ${PHRASE}`, { cause: { phrase: PHRASE, sentinel } });
  unsafe.backup = LIVE;
  t.mock.method(pairing, "recoveryPhrase", async () => { throw unsafe; });
  t.mock.method(pairing, "entropyFromPhrase", async () => { throw unsafe; });
  for (const [operation, code] of [[() => backup.encodeRecoveryBackup(zeros()), "backup_entropy"],
    [() => backup.parseRecoveryBackup(LIVE), "backup_phrase"],
    [() => backup.parseLegacyRecoveryHistory(PHRASE), "backup_phrase"]]) {
    let caught;
    try { await operation(); } catch (error) { caught = error; }
    assert.ok(caught instanceof backup.BackupFailure, "source errors must be replaced with fixed backup failures");
    assert.equal(caught.message, code, "backup failure message must be value-free");
    assert.equal(caught.code, code, "backup failure code must be value-free");
    assert.ok(!Object.hasOwn(caught, "cause") && !Object.hasOwn(caught, "backup"), "source properties must not survive wrapping");
    const diagnostic = inspect(caught, { showHidden: true, depth: null });
    assert.ok(!diagnostic.includes(sentinel) && !diagnostic.includes(PHRASE) && !diagnostic.includes(LIVE),
      "all backup error properties and diagnostics must be value-free");
  }
});
