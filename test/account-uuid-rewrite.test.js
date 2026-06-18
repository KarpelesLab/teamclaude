import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchAccountUuid, AccountUuidPatcher } from '../src/account-uuid-rewrite.js';

const OLD = '4c39e915-eb47-450d-9bf4-4cbbcd049a08';
const NEW = '11111111-2222-3333-4444-555555555555';

test('patches account_uuid inside metadata.user_id (escaped) same-length', () => {
  const body = Buffer.from(JSON.stringify({
    model: 'claude',
    metadata: { user_id: JSON.stringify({ device_id: 'abc', account_uuid: OLD, x: 1 }) },
  }));
  const out = patchAccountUuid(body, NEW);
  assert.equal(out.length, body.length);          // same length
  assert.ok(out.toString().includes(NEW));
  assert.ok(!out.toString().includes(OLD));
  // the inner stringified JSON is still valid and keeps device_id
  const parsed = JSON.parse(out.toString());
  const inner = JSON.parse(parsed.metadata.user_id);
  assert.equal(inner.account_uuid, NEW);
  assert.equal(inner.device_id, 'abc');
});

test('does NOT touch account_uuid outside metadata.user_id (no false positives)', () => {
  // A stray account_uuid in user content must be left intact.
  const body = Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: `here is some json: {"account_uuid":"${OLD}"}` }],
    metadata: { user_id: JSON.stringify({ account_uuid: OLD }) },
  }));
  const out = patchAccountUuid(body, NEW).toString();
  const parsed = JSON.parse(out);
  assert.equal(JSON.parse(parsed.metadata.user_id).account_uuid, NEW); // the metadata one IS rewritten
  assert.ok(parsed.messages[0].content.includes(OLD));                 // the content one is NOT
  assert.ok(!parsed.messages[0].content.includes(NEW));
});

test('streaming: byte-by-byte chunks produce the same result as one-shot (large body, uuid split across chunks)', () => {
  const filler = 'q'.repeat(50_000);
  const body = Buffer.from(JSON.stringify({
    model: 'claude', big: filler,
    metadata: { user_id: JSON.stringify({ device_id: 'd', account_uuid: OLD }) },
    messages: [{ role: 'user', content: `not me: account_uuid":"${OLD}"` }],
  }));
  // Feed one byte at a time to force chunk boundaries inside the UUID/keys.
  const p = new AccountUuidPatcher(NEW);
  const parts = [];
  for (const byte of body) parts.push(p.push(Buffer.from([byte])));
  const streamed = Buffer.concat(parts);
  assert.equal(streamed.length, body.length);
  assert.deepEqual(streamed, patchAccountUuid(body, NEW)); // same as one-shot
  const parsed = JSON.parse(streamed.toString());
  assert.equal(JSON.parse(parsed.metadata.user_id).account_uuid, NEW); // metadata patched
  assert.ok(parsed.messages[0].content.includes(OLD));                 // content untouched
});

test('no-op when already the target / no user_id / bad uuid length', () => {
  const inner = (u) => JSON.stringify({ metadata: { user_id: JSON.stringify({ account_uuid: u }) } });
  const same = Buffer.from(inner(NEW));
  assert.equal(patchAccountUuid(same, NEW), same);             // unchanged instance
  const none = Buffer.from('{"hello":"world"}');
  assert.equal(patchAccountUuid(none, NEW), none);
  const body = Buffer.from(inner(OLD));
  assert.equal(patchAccountUuid(body, 'not-a-uuid'), body);    // wrong length → no-op
});
