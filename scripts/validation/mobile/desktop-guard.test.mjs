import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, lstatSync, symlinkSync, linkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { assertAndroidObservation, owned, privateRead, privateSave, contained } = await import(process.env.OBSYNC_DESKTOP_GUARD_MODULE ?? './desktop-guard.mjs');
const now = 1_800_000_000_000, invitation = now - 5000, appPid = 1234;
const valid = () => ({ code: '123 456', observedAt: new Date(now - 1000).toISOString(), appPid });
test('independent fresh exact SAS witness is accepted', () => {
  assert.equal(assertAndroidObservation(valid(), ['123 456'], invitation, appPid, now), '123 456');
});
for (const [name, observation, codes, started, pid, clock] of [
  ['mismatch', valid(), ['654 321'], invitation, appPid, now],
  ['missing creator', valid(), [], invitation, appPid, now],
  ['duplicate creator', valid(), ['123 456', '123 456'], invitation, appPid, now],
  ['stale witness', { ...valid(), observedAt: now - 60001 }, ['123 456'], now - 90000, appPid, now],
  ['before invitation', { ...valid(), observedAt: invitation - 1 }, ['123 456'], invitation, appPid, now],
  ['future witness', { ...valid(), observedAt: now + 2001 }, ['123 456'], invitation, appPid, now],
  ['expired invitation', valid(), ['123 456'], now - 600001, appPid, now],
  ['invalid invitation time', valid(), ['123 456'], undefined, appPid, now],
  ['future invitation', valid(), ['123 456'], now + 3000, appPid, now],
  ['changed Android process', { ...valid(), appPid: 5678 }, ['123 456'], invitation, appPid, now],
  ['ambiguous Android process', valid(), ['123 456'], invitation, NaN, now],
  ['invalid timestamp', { ...valid(), observedAt: 'invalid' }, ['123 456'], invitation, appPid, now],
  ['invalid SAS', { ...valid(), code: '123456' }, ['123456'], invitation, appPid, now],
  ['extra witness field', { ...valid(), creator: true }, ['123 456'], invitation, appPid, now],
]) test(`refuses ${name}`, () => {
  assert.throws(() => assertAndroidObservation(observation, codes, started, pid, clock));
});
test('private files are owned, exclusive, nonlinked and mode 0600', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'obsync-desktop-guard-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o700);
  const file = join(root, 'secret');
  privateSave(file, 'synthetic-private-value');
  assert.equal(privateRead(file), 'synthetic-private-value');
  assert.throws(() => privateSave(file, 'overwrite'));
  chmodSync(file, 0o644); assert.throws(() => privateRead(file)); chmodSync(file, 0o600);
  symlinkSync(file, join(root, 'link')); assert.throws(() => privateRead(join(root, 'link')));
  linkSync(file, join(root, 'hardlink')); assert.throws(() => privateRead(file));
  const publicDir = join(root, 'public'); mkdirSync(publicDir, { mode: 0o755 });
  chmodSync(publicDir, 0o755); // The caller's umask must not make the hostile fixture private.
  assert.equal(lstatSync(publicDir).mode & 0o777, 0o755);
  assert.throws(() => owned(publicDir, true));
  assert.throws(() => privateSave(join(publicDir, 'secret'), 'value'));
});
test('owned path containment rejects siblings and the root itself', () => {
  assert.equal(contained('/owned', '/owned/private/input'), '/owned/private/input');
  for (const path of ['/other/input', '/owned', '/owned/../other/input']) assert.throws(() => contained('/owned', path));
});
