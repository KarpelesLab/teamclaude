import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RemoteControl, RemoteAccountManager, createAttachSession } from '../src/tui-remote.js';

// Attach mode: a dashboard driven by polled /teamclaude/status instead of a live
// AccountManager. The control plane here is a real HTTP server serving canned
// status payloads, so the client is exercised over the wire it actually uses.

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const settle = () => new Promise(r => setTimeout(r, 5));

const HOUR = 3600_000;

function statusFixture(over = {}) {
  const reset = Date.now() + HOUR;
  return {
    server: { startedAt: new Date().toISOString(), uptimeSeconds: 42, port: 3456 },
    probe: { enabled: false, intervalSeconds: 0, running: false, accounts: [] },
    warm: { enabled: false, intervalSeconds: 0, running: false, accounts: [] },
    currentAccount: 'bravo',
    switchThreshold: 0.98,
    sessions: { active: 2, known: 3, distribute: true, perAccount: { 0: 1, 1: 1 } },
    routes: [{
      name: 'fable', match: ['*fable*'], bucket: null, color: null, autocreated: true,
      pinned: null, target: 'alpha',
      accounts: [{ name: 'alpha', eligible: true }, { name: 'bravo', eligible: true }],
    }],
    accounts: [
      {
        name: 'alpha', type: 'oauth', orgName: null, priority: 0, disabled: false,
        status: 'active', sessions: 1,
        quota: { unified5h: 0.4, unified5hReset: reset, unified7d: 0.2, unified7dReset: reset, unified7dFable: 0.1, unified7dFableReset: reset },
        usage: { totalRequests: 5 }, rateLimitedUntil: null, pausedUntil: null,
      },
      {
        name: 'bravo', type: 'apikey', orgName: null, priority: 0, disabled: false,
        status: 'active', sessions: 1,
        quota: { unified5h: 0.1, unified5hReset: reset, unified7d: 0.1, unified7dReset: reset },
        usage: { totalRequests: 2 }, rateLimitedUntil: null, pausedUntil: null,
      },
    ],
    ...over,
  };
}

// A stand-in control plane. `routes` maps "METHOD /path" to a handler; anything
// unmapped answers 404, which is how an older server without the switch endpoint
// behaves.
async function fakeServer(t, routes = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body });
      const handler = routes[`${req.method} ${req.url}`];
      if (!handler) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found"}'); return; }
      handler(req, res);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { server, seen, port: server.address().port };
}

const json = payload => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

async function makeSession(t, { routes, status = statusFixture() } = {}) {
  const fake = await fakeServer(t, routes || {
    'GET /teamclaude/status': json(status),
    'POST /teamclaude/reload': json({ ok: true, added: 0 }),
    'POST /teamclaude/switch': json({ ok: true }),
  });
  const control = new RemoteControl({ port: fake.port, apiKey: 'secret' });
  const quits = [];
  const session = createAttachSession({
    control,
    config: { proxy: { port: fake.port, apiKey: 'secret' } },
    onQuit: () => quits.push(true),
  });
  session.tui.render = () => {}; // bypass the terminal, as the other TUI tests do
  return { ...fake, control, session, tui: session.tui, am: session.am, quits };
}

// ── control client ───────────────────────────────────────────

test('the status call carries the proxy API key and returns the payload', async (t) => {
  const { control, seen } = await makeSession(t);
  const status = await control.status();
  assert.equal(status.currentAccount, 'bravo');
  assert.deepEqual(
    seen.map(r => [r.method, r.url, r.key]),
    [['GET', '/teamclaude/status', 'secret']],
  );
});

test('a non-2xx status reply is an error, not a half-empty dashboard', async (t) => {
  const { control } = await makeSession(t, {
    routes: { 'GET /teamclaude/status': (req, res) => { res.writeHead(500); res.end('boom'); } },
  });
  await assert.rejects(() => control.status(), /500/);
});

test('reload posts to the existing control endpoint', async (t) => {
  const { control, seen } = await makeSession(t);
  assert.deepEqual(await control.reload(), { ok: true, added: 0 });
  assert.deepEqual(seen.map(r => [r.method, r.url]), [['POST', '/teamclaude/reload']]);
});

test('switching names the account in the request body', async (t) => {
  const { control, seen } = await makeSession(t);
  await control.switchAccount('alpha');
  assert.deepEqual(seen.map(r => [r.method, r.url]), [['POST', '/teamclaude/switch']]);
  assert.deepEqual(JSON.parse(seen[0].body), { account: 'alpha' });
});

test('a server without the switch endpoint says so instead of reporting success', async (t) => {
  const { control } = await makeSession(t, {
    routes: { 'GET /teamclaude/status': json(statusFixture()) }, // no switch route
  });
  await assert.rejects(() => control.switchAccount('alpha'), /does not support/i);
});

// ── status → account-manager adapter ─────────────────────────

test('a status payload fills the read surface the dashboard renders from', async (t) => {
  const { am } = await makeSession(t);
  am.applyStatus(statusFixture());

  assert.deepEqual(am.accounts.map(a => a.name), ['alpha', 'bravo']);
  assert.deepEqual(am.accounts.map(a => a.index), [0, 1]);
  assert.equal(am.accounts[0].quota.unified7dFable, 0.1);
  assert.equal(am.currentIndex, 1); // "bravo"
  assert.equal(am.switchThreshold, 0.98);
  assert.equal(am.distributeSessions, true);
  assert.deepEqual(am.sessionStats(), { active: 2, known: 3, perAccount: { 0: 1, 1: 1 } });
  assert.equal(am.getRoutes()[0].name, 'fable');
  assert.equal(am.connected, true);
});

test('an unknown current account marks nothing current rather than guessing', async (t) => {
  const { am } = await makeSession(t);
  am.applyStatus(statusFixture({ currentAccount: 'gone' }));
  assert.equal(am.currentIndex, -1);
});

test('previewRouteIndex resolves a route target by glob', async (t) => {
  const { am } = await makeSession(t);
  am.applyStatus(statusFixture());
  assert.equal(am.previewRouteIndex('claude-fable-5'), 0); // route target "alpha"
  assert.equal(am.previewRouteIndex('claude-opus-4'), null); // no route matches
});

test('a route with no serving account yields no marker', async (t) => {
  const { am } = await makeSession(t);
  const status = statusFixture();
  status.routes[0].target = null;
  am.applyStatus(status);
  assert.equal(am.previewRouteIndex('claude-fable-5'), null);
});

test('a status payload with no routes and no quota data renders nothing rather than throwing', async (t) => {
  const { am } = await makeSession(t);
  am.applyStatus({ accounts: [{ name: 'alpha', type: 'oauth', status: 'active' }] });
  assert.deepEqual(am.getRoutes(), []);
  assert.equal(am.previewRouteIndex('claude-fable-5'), null);
  assert.deepEqual(am.accounts[0].quota, {});
  assert.deepEqual(am.sessionStats(), { active: 0, known: 0, perAccount: {} });
  am.refreshExpiredQuotas(); // server-side concern; must be a harmless no-op here
});

test('a lost connection keeps the last snapshot and says it is stale', async (t) => {
  const { am } = await makeSession(t);
  am.applyStatus(statusFixture());
  am.markDisconnected(new Error('ECONNREFUSED'));

  assert.equal(am.connected, false);
  assert.match(am.lastError, /ECONNREFUSED/);
  assert.deepEqual(am.accounts.map(a => a.name), ['alpha', 'bravo']); // last known state kept

  am.applyStatus(statusFixture());
  assert.equal(am.connected, true);
  assert.equal(am.lastError, null);
});

// ── polling ──────────────────────────────────────────────────

test('a poll applies the payload; a failing poll flags the header and logs once', async (t) => {
  let fail = false;
  const { session, am, tui } = await makeSession(t, {
    routes: {
      'GET /teamclaude/status': (req, res) => {
        if (fail) { res.writeHead(503); res.end('down'); return; }
        json(statusFixture())(req, res);
      },
    },
  });

  await session.poll();
  assert.equal(am.connected, true);
  assert.equal(am.accounts.length, 2);

  fail = true;
  await session.poll();
  assert.equal(am.connected, false);
  const dropped = tui.log.filter(l => /lost|503/i.test(l.msg));
  assert.equal(dropped.length, 1);

  await session.poll(); // still down — do not repeat the message every second
  assert.equal(tui.log.filter(l => /lost|503/i.test(l.msg)).length, 1);
});

// ── keys ─────────────────────────────────────────────────────

test('keys that would need write endpoints are inert in attach mode', async (t) => {
  const { tui, am, seen } = await makeSession(t);
  am.applyStatus(statusFixture());
  for (const k of ['g', 'd', 'p', 'a', 'r']) tui._key(k);
  await settle();
  assert.equal(tui.mode, 'normal');
  assert.deepEqual(tui.log, []);
  assert.deepEqual(seen, []); // nothing was sent to the server
});

test('R reloads the running server and reports the outcome', async (t) => {
  const { tui, seen } = await makeSession(t);
  tui._key('R');
  await settle();
  assert.deepEqual(seen.map(r => [r.method, r.url]), [['POST', '/teamclaude/reload']]);
  assert.equal(tui.log.length, 1);
  assert.match(tui.log[0].msg, /reload/i);
});

test('R reports a failed reload instead of pretending it worked', async (t) => {
  const { tui } = await makeSession(t, {
    routes: { 'GET /teamclaude/status': json(statusFixture()) }, // no reload route
  });
  tui._key('R');
  await settle();
  assert.match(tui.log[0].msg, /failed/i);
});

test('s switches the running server to the selected account', async (t) => {
  const { tui, am, seen } = await makeSession(t);
  am.applyStatus(statusFixture());

  tui._key('s');
  assert.equal(tui.mode, 'select');
  tui._key('up'); // from "bravo" (current) to "alpha"
  tui._key('enter');
  await settle();

  assert.equal(tui.mode, 'normal');
  assert.deepEqual(JSON.parse(seen.at(-1).body), { account: 'alpha' });
  assert.match(tui.log[0].msg, /alpha/);
});

test('a rejected switch is reported and leaves the view alone', async (t) => {
  const { tui, am } = await makeSession(t, {
    routes: { 'GET /teamclaude/status': json(statusFixture()) }, // no switch route
  });
  am.applyStatus(statusFixture());
  tui._key('s');
  tui._key('enter');
  await settle();
  assert.equal(tui.mode, 'normal');
  assert.match(tui.log[0].msg, /switch failed/i);
});

test('route pinning is not offered in attach mode', async (t) => {
  const { tui, am } = await makeSession(t);
  am.applyStatus(statusFixture());
  tui._key('s');
  tui._key('right');
  tui._key('tab');
  assert.equal(tui.selRoute, null); // no per-route pin target to cycle to
});

test('switching with nothing marked current starts at the first account', async (t) => {
  const { tui, am, seen } = await makeSession(t);
  am.applyStatus(statusFixture({ currentAccount: 'gone' }));
  tui._key('s');
  tui._key('enter');
  await settle();
  assert.deepEqual(JSON.parse(seen.at(-1).body), { account: 'alpha' });
});

test('q leaves attach mode without touching the server', async (t) => {
  const { tui, quits, seen } = await makeSession(t);
  tui.stop = () => {}; // no terminal to restore in a test
  tui._key('q');
  assert.deepEqual(quits, [true]);
  assert.deepEqual(seen, []);
});

// ── rendering ────────────────────────────────────────────────

function renderToString(tui) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = chunk => { chunks.push(chunk); return true; };
  try { tui.running = true; tui._render(); } finally { process.stdout.write = orig; }
  return stripAnsi(chunks.join(''));
}

test('the dashboard renders accounts from a status payload alone', async (t) => {
  const { tui, am } = await makeSession(t);
  am.applyStatus(statusFixture());
  const out = renderToString(tui);

  assert.match(out, /alpha/);
  assert.match(out, /bravo/);
  assert.match(out, /oauth/);
  assert.match(out, /▲/); // connected
  assert.match(out, /switch/); // attach footer
  assert.doesNotMatch(out, /settings/); // settings screen is not reachable here
});

test('a stale dashboard says so instead of looking live', async (t) => {
  const { tui, am } = await makeSession(t);
  am.applyStatus(statusFixture());
  am.markDisconnected(new Error('ECONNREFUSED'));
  const out = renderToString(tui);

  assert.match(out, /▼/); // disconnected marker in the header
  assert.doesNotMatch(out, /▲/);
});

test('attach mode does not present an activity stream it cannot see', async (t) => {
  const { tui, am } = await makeSession(t);
  am.applyStatus(statusFixture());
  const out = renderToString(tui);
  assert.doesNotMatch(out, /Activity/);
});
