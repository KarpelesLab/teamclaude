import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { mergeAccountsForSave } from '../src/account-pairing.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

const FIELDS = { adapter: 'openai-chat', modelPrefix: 'models/', serverHeader: 'agy-one' };
const HEADERS = { 'x-bridge-client-ip': '127.0.0.1' };
const entry = (extra = {}) => ({ id: 'x', name: 'x@example.com', type: 'apikey', apiKey: 'k', ...extra });

async function roundTrip(startup, disk) {
  const memConfig = { accounts: [startup] };
  const am = new AccountManager(memConfig.accounts.map(account => ({ ...account })), 0.98);
  await syncAccountsFromDisk({ accounts: [disk] }, memConfig, am);
  const written = mergeAccountsForSave(memConfig.accounts, am.accounts, [disk]);
  await syncAccountsFromDisk({ accounts: written }, memConfig, am);
  return { written: written[0], running: am.accounts[0], memConfig };
}

test('startup carries adapter fields and ordinary accounts default to null', () => {
  const am = new AccountManager([entry({ ...FIELDS, adapterHeaders: HEADERS }), entry({ id: 'y', name: 'y' })], 0.98);
  assert.equal(am.accounts[0].adapter, 'openai-chat');
  assert.equal(am.accounts[0].modelPrefix, 'models/');
  assert.equal(am.accounts[0].serverHeader, 'agy-one');
  assert.deepEqual(am.accounts[0].adapterHeaders, HEADERS);
  for (const field of [...Object.keys(FIELDS), 'adapterHeaders']) assert.equal(am.accounts[1][field], null);
});

test('the running account holds its own copy of adapterHeaders', () => {
  const configured = { ...HEADERS };
  const am = new AccountManager([entry({ adapter: 'openai-chat', adapterHeaders: configured })], 0.98);
  assert.notEqual(am.accounts[0].adapterHeaders, configured, 'a later edit of the config object would mutate the running account');
  configured['x-bridge-client-ip'] = '10.0.0.99';
  assert.equal(am.accounts[0].adapterHeaders['x-bridge-client-ip'], '127.0.0.1');
});

test('runtime additions carry the same adapter fields', async () => {
  const am = new AccountManager([], 0.98);
  const memConfig = { accounts: [] };
  const added = await syncAccountsFromDisk({ accounts: [entry({ ...FIELDS, adapterHeaders: HEADERS })] }, memConfig, am);
  assert.equal(added.added, 1);
  assert.equal(am.accounts[0].adapter, 'openai-chat');
  assert.equal(am.accounts[0].modelPrefix, 'models/');
  assert.equal(am.accounts[0].serverHeader, 'agy-one');
  assert.deepEqual(am.accounts[0].adapterHeaders, HEADERS);
});

test('reload edits survive the next save and a second reload', async () => {
  const startup = entry({ adapter: 'openai-chat', modelPrefix: 'old/', serverHeader: 'old', adapterHeaders: { 'x-bridge-client-ip': '10.0.0.1' } });
  const disk = entry({ adapter: 'openai-chat', modelPrefix: 'models/', serverHeader: 'agy-two', adapterHeaders: HEADERS });
  const { written, running, memConfig } = await roundTrip(startup, disk);
  assert.equal(written.adapter, 'openai-chat');
  assert.equal(written.modelPrefix, 'models/');
  assert.equal(written.serverHeader, 'agy-two');
  assert.deepEqual(written.adapterHeaders, HEADERS);
  assert.equal(running.adapter, 'openai-chat');
  assert.equal(running.modelPrefix, 'models/');
  assert.equal(running.serverHeader, 'agy-two');
  assert.deepEqual(running.adapterHeaders, HEADERS);
  assert.equal(memConfig.accounts[0].serverHeader, 'agy-two');
  assert.deepEqual(memConfig.accounts[0].adapterHeaders, HEADERS);
});

test('removing adapter fields on disk deletes their mirrors instead of resurrecting them', async () => {
  const { written, running, memConfig } = await roundTrip(entry({ ...FIELDS, adapterHeaders: HEADERS }), entry());
  for (const field of [...Object.keys(FIELDS), 'adapterHeaders']) {
    assert.equal(field in written, false, `${field} was resurrected by the save`);
    assert.equal(field in memConfig.accounts[0], false);
    assert.equal(running[field], null);
  }
});

test('reload keeps the malformed adapterHeaders text in config but drops it from the running account', async () => {
  const invalid = { 'x-bridge-client-ip': 42 };
  const startup = entry({ adapterHeaders: HEADERS });
  const disk = entry({ adapterHeaders: invalid });
  const { written, running, memConfig } = await roundTrip(startup, disk);
  assert.equal(running.adapterHeaders, null, 'the invalid value must never reach the running account');
  assert.deepEqual(memConfig.accounts[0].adapterHeaders, invalid, 'the mirror keeps the operator text as written');
  assert.deepEqual(written.adapterHeaders, invalid, 'the save must not silently rewrite the operator text');
});

test('a __proto__ adapterHeaders entry is refused with a warning, never silently accepted', () => {
  const origLog = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    // JSON.parse, not an object literal: a literal's __proto__ key invokes the
    // prototype setter and never becomes an own property to iterate.
    const am = new AccountManager([entry({ adapter: 'openai-chat', adapterHeaders: JSON.parse('{"__proto__":"10.0.0.1","x-ok":"fine"}') })], 0.98);
    assert.deepEqual(am.accounts[0].adapterHeaders, { 'x-ok': 'fine' }, '__proto__ must not ride the running account');
    assert.equal(Object.getPrototypeOf(am.accounts[0].adapterHeaders), Object.prototype, 'the surviving set is an ordinary object');
  } finally {
    console.log = origLog;
  }
  assert.ok(lines.some((l) => l.includes('adapterHeaders')), 'the refused entry must be announced, not dropped silently');
});

test('malformed adapterHeaders are dropped without failing account construction', () => {
  const am = new AccountManager([
    entry({ id: 'a', name: 'a', adapterHeaders: ['x-bridge-client-ip'] }),
    entry({ id: 'b', name: 'b', adapterHeaders: { 'x-bridge-client-ip': 42 } }),
    entry({ id: 'c', name: 'c', adapterHeaders: { 'bad name': 'x', 'x-ok': 'fine' } }),
    entry({ id: 'd', name: 'd', adapterHeaders: { 'x-smuggle': 'one\r\nx-injected: two' } }),
    entry({ id: 'e', name: 'e', adapterHeaders: {} }),
    entry({ id: 'f', name: 'f', adapterHeaders: { 'x-ctrl': 'a\x07b' } }),
    entry({ id: 'g', name: 'g', adapterHeaders: { 'x-emoji': '\u{1F600}' } }),
    entry({ id: 'h', name: 'h', adapterHeaders: { 'X-Dup': 'one', 'x-dup': 'two', 'x-ok': 'fine' } }),
  ], 0.98);
  assert.equal(am.accounts[0].adapterHeaders, null, 'an array is not a header set');
  assert.equal(am.accounts[1].adapterHeaders, null, 'a non-string value drops the set it would smuggle');
  assert.deepEqual(am.accounts[2].adapterHeaders, { 'x-ok': 'fine' }, 'an invalid name drops only its own entry');
  assert.equal(am.accounts[3].adapterHeaders, null, 'a CR/LF value is header injection');
  assert.equal(am.accounts[4].adapterHeaders, null, 'an empty set is no headers');
  assert.equal(am.accounts[5].adapterHeaders, null, 'a control character throws ERR_INVALID_CHAR in Node\'s HTTP client');
  assert.equal(am.accounts[6].adapterHeaders, null, 'a code point beyond Latin-1 throws the same');
  assert.deepEqual(am.accounts[7].adapterHeaders, { 'X-Dup': 'one', 'x-ok': 'fine' },
    'a case-variant duplicate would silently evict the first entry at send time');
});
