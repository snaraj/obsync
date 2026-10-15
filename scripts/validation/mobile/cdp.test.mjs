import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newConsoleSummary, observeConsoleEvent } from './cdp.mjs';

test('stability logs distinguish buffered/outgoing events from current incoming refusals', () => {
  const s = newConsoleSummary(1000);
  const log = (timestamp, value, type = 'log') => observeConsoleEvent(s, {method: 'Runtime.consoleAPICalled', params: {timestamp, type, args: [{value}]}});
  log(999, 'obsync pull path_class=manifest reason=outside_sync_scope', 'error');
  log(1001, 'obsync push path_class=manifest reason=outside_sync_scope');
  log(1002, 'obsync pull path_class=chunk reason=outside_sync_scope');
  assert.equal(s.errors, 1); assert.equal(s.windowErrors, 0);
  assert.equal(s.incomingManifestScopeRefusals, 0);
  assert.equal(s.reasons.outside_sync_scope, 3);
  log(1000, 'obsync pull reason=outside_sync_scope path_class=manifest');
  assert.equal(s.incomingManifestScopeRefusals, 1);
  log(1003, 'native error', 'error');
  assert.equal(s.windowErrors, 1);
  observeConsoleEvent(s, {method:'Runtime.exceptionThrown', params:{timestamp:999}});
  assert.equal(s.exceptions, 1); assert.equal(s.windowExceptions, 0);
  observeConsoleEvent(s, {method:'Runtime.exceptionThrown', params:{timestamp:1000}});
  assert.equal(s.windowExceptions, 1);
  // A missing timestamp cannot hide a live failure.
  log(undefined, 'obsync pull path_class=manifest reason=outside_sync_scope', 'error');
  assert.equal(s.windowErrors, 2); assert.equal(s.incomingManifestScopeRefusals, 2);
});
