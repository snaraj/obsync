import assert from 'node:assert/strict';
import test from 'node:test';
import { Resolver } from 'node:dns';
import { checkServerIdentity } from 'node:tls';

// CVE-2026-105482: reject the entire name before c-ares can truncate it.
test('DNS refuses embedded NUL rather than resolving a different name', () => {
  const resolver = new Resolver();
  resolver.setServers(['127.0.0.1']);
  try {
    assert.throws(() => resolver.resolve4('example.test\0.trusted.test', () => {}),
      { code: 'ERR_INVALID_ARG_VALUE' });
  } finally {
    resolver.cancel();
  }
});

// CVE-2026-106069: resolver-dependent IP spellings must not authenticate
// against a different normalized address. Canonical IP/DNS controls still work.
test('TLS rejects ambiguous numeric identities', () => {
  assert.ok(checkServerIdentity('0127.0.0.1', {
    subjectaltname: 'IP Address:87.0.0.1', subject: {},
  }));
  assert.equal(checkServerIdentity('example.test', {
    subjectaltname: 'DNS:example.test',
  }), undefined);
  assert.equal(checkServerIdentity('127.0.0.1', {
    subjectaltname: 'IP Address:127.0.0.1',
  }), undefined);
});
