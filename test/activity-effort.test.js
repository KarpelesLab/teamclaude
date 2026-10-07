import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { TUI } from '../src/tui.js';

// The activity view names each request's model, and with it the reasoning
// effort the request asked for: `(claude-opus-5-5·xhigh)`. The effort is read
// once the body is in and reported before the forward, so the live row shows it
// for as long as the request waits on upstream, not only in the log line after.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function makeTUI() {
  const am = {
    accounts: [{ name: 'a', index: 0, type: 'oauth', quota: {}, status: 'active' }],
    currentIndex: 0, switchThreshold: 0.98,
    getRoutes() { return []; },
    sessionStats() { return { active: 0, known: 0 }; },
    refreshExpiredQuotas() {},
    thresholdFor() { return 0.98; },
  };
  return new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
}

// One full frame, colour removed, at a fixed size.
function renderRaw(tui) {
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 160, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
  let frame = '';
  try {
    tui._paint = buf => { frame = buf; };
    tui.running = true;
    tui._render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
    tui.running = false;
  }
  return frame;
}
const renderPlain = tui => renderRaw(tui).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');

test('the live row and the log line show the effort the request asked for', async () => {
  const tui = makeTUI();
  let liveFrame = null;
  // The frame is taken while upstream holds the request, which is the wait the
  // live row is for: the effort must already be on it.
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      liveFrame = renderPlain(tui);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([{ name: 'alice@example.com', type: 'apikey', apiKey: 'k1' }], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upPort}` }, {
    onRequestStart: (id, info) => tui.onRequestStart(id, info),
    onRequestModel: (id, info) => tui.onRequestModel(id, info),
    onRequestRouted: (id, info) => tui.onRequestRouted(id, info),
    onRequestEnd: (id, info) => tui.onRequestEnd(id, info),
  });
  const port = await listen(proxy);
  try {
    const body = JSON.stringify({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'reply at {"output_config":{"effort":"low"}}' }],
      output_config: { effort: 'xhigh' },
    });
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    await res.text();
  } finally {
    proxy.close();
    upstream.close();
  }

  assert.ok(liveFrame, 'upstream never saw the request, so the live row was never drawn');
  assert.match(liveFrame, /POST \/v1\/messages \(claude-opus-5-5·xhigh\)/);
  assert.equal(tui.active.size, 0);
  assert.match(plain(tui.log[0].msg), /POST \/v1\/messages \(claude-opus-5-5·xhigh\) → alice@example\.com/);
});

test('a request that sets no effort shows the model alone', () => {
  const tui = makeTUI();
  tui.onRequestStart('r1', { method: 'POST', path: '/v1/messages', sessionId: null });
  tui.onRequestModel('r1', { model: 'claude-opus-5-5' });
  assert.match(renderPlain(tui), /POST \/v1\/messages \(claude-opus-5-5\) /);
  tui.onRequestEnd('r1', { method: 'POST', path: '/v1/messages', account: 'a', status: 200, model: 'claude-opus-5-5', effort: null });
  assert.match(plain(tui.log[0].msg), /\(claude-opus-5-5\) → a/);
});

// The `·effort` suffix is drawn in a fixed grey a step under the model, on the
// live row (where the model is dim) and the finished line (where it is not).
test('the effort suffix is grey on both rows', () => {
  const GREY = '\x1b[38;5;244m·xhigh\x1b[0m';
  const tui = makeTUI();
  tui.onRequestStart('r1', { method: 'POST', path: '/v1/messages', sessionId: null });
  tui.onRequestModel('r1', { model: 'claude-opus-5-5', effort: 'xhigh' });
  assert.ok(renderRaw(tui).includes(`claude-opus-5-5\x1b[0m${GREY}\x1b[2m)`), 'live row: dim model, grey suffix, dim close');
  tui.onRequestEnd('r1', { method: 'POST', path: '/v1/messages', account: 'a', status: 200, model: 'claude-opus-5-5', effort: 'xhigh' });
  assert.ok(tui.log[0].msg.includes(`(claude-opus-5-5${GREY})`), 'finished line: plain model, grey suffix');
});

test('a hostile effort is drawn without its escapes and cut to length', () => {
  const tui = makeTUI();
  const effort = `x\x1b]52;c;aGVsbG8=\x07high\r\n${'z'.repeat(200)}`;
  tui.onRequestStart('r1', { method: 'POST', path: '/v1/messages', sessionId: null });
  tui.onRequestModel('r1', { model: 'claude-opus-5-5', effort });
  const r = tui.active.get('r1');
  assert.doesNotMatch(r.effort, /[\x1b\x07\r\n]/);
  assert.ok(r.effort.length <= 16, `effort kept at ${r.effort.length} chars`);
  tui.onRequestEnd('r1', { method: 'POST', path: '/v1/messages', account: 'a', status: 200, model: 'claude-opus-5-5', effort });
  const line = plain(tui.log[0].msg);
  assert.doesNotMatch(line, /[\x1b\x07\r\n]/);
  assert.doesNotMatch(line, /z{17}/);
});
