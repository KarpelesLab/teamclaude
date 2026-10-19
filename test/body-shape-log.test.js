import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { logBodyShape, measureBodyShape } from '../src/body-shape-log.js';

const buf = (o) => Buffer.from(JSON.stringify(o), 'utf8');
const body = buf({ model: 'm', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], tools: [{ name: 't1' }, { name: 't2' }, { name: 't3' }] });

test('measureBodyShape counts bytes, messages and tools', () => {
  assert.deepEqual(measureBodyShape(body), { bytes: body.length, messages: 2, tools: 3 });
});

test('measureBodyShape: non-JSON and missing fields give null counts, never throw', () => {
  assert.deepEqual(measureBodyShape(Buffer.from('not json')), { bytes: 8, messages: null, tools: null });
  assert.deepEqual(measureBodyShape(buf({ messages: [] })), { bytes: 15, messages: 0, tools: null });
  assert.deepEqual(measureBodyShape(Buffer.alloc(0)), { bytes: 0, messages: null, tools: null });
});

test('flag unset (or not "1"): nothing is logged', () => {
  const lines = [];
  logBodyShape('ingress', body, {}, (l) => lines.push(l), {});
  logBodyShape('ingress', body, {}, (l) => lines.push(l), { TEAMCLAUDE_LOG_BODY_SHAPE: 'true' });
  assert.deepEqual(lines, []);
});

test('flag on: one line with stage, ids and counts', () => {
  const lines = [];
  logBodyShape('final-egress', body, { reqId: 7, account: 'acct', model: 'm' }, (l) => lines.push(l), { TEAMCLAUDE_LOG_BODY_SHAPE: '1' });
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `[TeamClaude] body-shape stage=final-egress req=7 account=acct model=m bytes=${body.length} messages=2 tools=3`);
});

test('server.js logs all four stages in order around fold, sanitize and egress', () => {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const at = (s) => src.indexOf(s);
  const order = [
    "logBodyShape('ingress', body",
    'foldSystemMessages(body',
    "logBodyShape('after-system-fold', folded.body",
    'sanitizeToolPairs(folded.body',
    "logBodyShape('after-tool-pair-sanitize', sendBody",
    "headers['content-length'] = String(sendBody.length)",
    "logBodyShape('final-egress', sendBody",
  ].map(at);
  assert.ok(order.every((i) => i >= 0), `missing: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});
