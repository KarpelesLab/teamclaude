import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  forbiddenAddressReason, isForbiddenForwardAddress, forbiddenForwardReason,
  guardedLookup, allowLoopbackForward, FORBIDDEN_FORWARD,
} from '../src/forward-target.js';

// The policy behind both transparent forward paths (CONNECT tunnel, plain-HTTP
// relay): never to this machine's loopback, the unspecified address, or
// link-local — the three that turn a low-trust remote key into a local caller
// at our own listener, or into a reader of cloud metadata. Everything else,
// RFC1918 included, is a legitimate place to proxy to.

test('loopback, unspecified and link-local addresses are forbidden in every spelling', () => {
  const forbidden = {
    '127.0.0.1': 'loopback', '127.255.0.9': 'loopback', '::1': 'loopback',
    '::ffff:127.0.0.1': 'loopback',   // how Node reports a mapped IPv4 peer
    '::ffff:7f00:1': 'loopback',      // the same address in hex
    '::127.0.0.1': 'loopback',        // deprecated IPv4-compatible form
    '0.0.0.0': 'unspecified', '0.1.2.3': 'unspecified', '::': 'unspecified',
    '169.254.169.254': 'link-local', 'fe80::1': 'link-local', 'FE80::1%eth0': 'link-local', 'febf::1': 'link-local',
  };
  for (const [ip, why] of Object.entries(forbidden)) {
    assert.equal(forbiddenAddressReason(ip), why, ip);
    assert.equal(isForbiddenForwardAddress(ip), true, ip);
  }
});

test('public and private (LAN) addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '10.0.0.5', '172.16.4.4', '192.168.1.20', '2001:db8::1', '::ffff:10.0.0.5', 'fec0::1', 'fd00::1']) {
    assert.equal(forbiddenAddressReason(ip), null, ip);
  }
  assert.equal(forbiddenAddressReason('not-an-ip'), null);
  assert.equal(forbiddenAddressReason(undefined), null);
});

test('forbiddenForwardReason refuses by name for the obvious spellings, and by resolved address otherwise', () => {
  assert.match(forbiddenForwardReason('localhost'), /loopback name/);
  assert.match(forbiddenForwardReason('LOCALHOST.'), /loopback name/);
  assert.match(forbiddenForwardReason('foo.localhost'), /loopback name/);
  assert.match(forbiddenForwardReason('127.0.0.1'), /loopback address/);
  assert.match(forbiddenForwardReason('::1'), /loopback address/);
  // A DNS alias for loopback gets past the name and is caught by the address.
  assert.equal(forbiddenForwardReason('localtest.me'), null);
  assert.match(forbiddenForwardReason('localtest.me', '127.0.0.1'), /resolves to 127\.0\.0\.1, a loopback/);
  assert.match(forbiddenForwardReason('metadata.internal', '169.254.169.254'), /link-local/);
  assert.equal(forbiddenForwardReason('example.com', '93.184.216.34'), null);
  assert.equal(forbiddenForwardReason('nas.lan', '192.168.1.20'), null);
});

// The lookup wrapper is what makes the policy hold against DNS: it sees every
// address the name has and refuses the dial before any SYN is sent.
function fakeLookup(table) {
  return (host, _opts, cb) => {
    const rows = table[host];
    if (!rows) { const e = new Error(`getaddrinfo ENOTFOUND ${host}`); e.code = 'ENOTFOUND'; return cb(e); }
    cb(null, rows);
  };
}
const lookupAsync = (fn, host, opts = { all: true }) => new Promise((resolve, reject) => {
  fn(host, opts, (err, ...rest) => (err ? reject(err) : resolve(rest)));
});

test('guardedLookup refuses when ANY resolved address is forbidden, in either callback shape', async () => {
  const table = {
    'good.example': [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800::1', family: 6 }],
    'sneaky.example': [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }],
    'metadata.example': [{ address: '169.254.169.254', family: 4 }],
  };
  const lookup = guardedLookup(null, { lookup: fakeLookup(table) });

  const [all] = await lookupAsync(lookup, 'good.example');
  assert.deepEqual(all, table['good.example']);
  const [addr, family] = await lookupAsync(lookup, 'good.example', {});
  assert.equal(addr, '93.184.216.34'); assert.equal(family, 4);

  for (const host of ['sneaky.example', 'metadata.example']) {
    await assert.rejects(lookupAsync(lookup, host), (err) => {
      assert.equal(err.code, FORBIDDEN_FORWARD, host);
      assert.match(err.message, /refused/);
      return true;
    });
  }
  // A resolver failure is passed through untouched — a 502, not a 403.
  await assert.rejects(lookupAsync(lookup, 'missing.example'), { code: 'ENOTFOUND' });
});

test('the test hook admits loopback only, and only for its registered server', async () => {
  const table = { 'me.example': [{ address: '127.0.0.1', family: 4 }], 'link.example': [{ address: '169.254.1.1', family: 4 }] };
  const server = {};
  allowLoopbackForward(server);
  const registered = guardedLookup({ server }, { lookup: fakeLookup(table) });
  const other = guardedLookup({ server: {} }, { lookup: fakeLookup(table) });

  const [rows] = await lookupAsync(registered, 'me.example');
  assert.equal(rows[0].address, '127.0.0.1');
  await assert.rejects(lookupAsync(registered, 'link.example'), { code: FORBIDDEN_FORWARD });
  await assert.rejects(lookupAsync(other, 'me.example'), { code: FORBIDDEN_FORWARD });
});
