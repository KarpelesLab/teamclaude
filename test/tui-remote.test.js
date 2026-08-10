import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RemoteControl, createAttachSession } from '../src/tui-remote.js';

// Attach mode: a dashboard driven by polled /teamclaude/status instead of a live
// AccountManager. The control plane here is a real HTTP server serving canned
// status payloads, so the client is exercised over the wire it actually uses.

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

// Every action here crosses a real socket, so wait for the thing to have
// happened rather than for a duration: a fixed sleep is a race that a loaded
// machine loses, and these tests run alongside the rest of the suite.
async function waitFor(predicate, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const logged = tui => waitFor(() => tui.log.length > 0, 'a message in the pane');
const reached = seen => waitFor(() => seen.length > 0, 'a request to reach the server');
// Only for asserting that nothing happens: there is no condition to wait on, so
// this has to be a duration, and it is generous on purpose.
const nothingHappens = () => new Promise(r => setTimeout(r, 50));

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
  // fetch() pools keep-alive sockets, and server.close() waits for them: without
  // dropping them explicitly the teardown lingers and leaves sockets behind for
  // whatever runs next.
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { server, seen, port: server.address().port };
}

// The three members _call reads off a fetch reply. Cheaper than a real Response,
// and it keeps these tests free of fetch globals.
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });

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

// The endpoint answers 404 for an account it cannot resolve, which is a
// different failure from the path not existing at all — and the only thing
// separating them is the control plane's own { ok: false, error } shape.
test('an unresolvable account is reported by reason, not as a missing feature', async (t) => {
  const { control } = await makeSession(t, {
    routes: {
      'GET /teamclaude/status': json(statusFixture()),
      'POST /teamclaude/switch': (req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no such account "ghost"', accounts: ['alpha', 'bravo'] }));
      },
    },
  });
  await assert.rejects(() => control.switchAccount('ghost'), /no such account "ghost"/);
});

// Something else listening on the configured port answers 200 to anything. A
// bare 200 is not evidence that an account was switched.
test('a 200 from something that is not this control plane is not a switch', async (t) => {
  const { control } = await makeSession(t, {
    routes: {
      'GET /teamclaude/status': json(statusFixture()),
      'POST /teamclaude/switch': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>hello</html>');
      },
    },
  });
  await assert.rejects(() => control.switchAccount('alpha'), /not a teamclaude control endpoint/);
});

test('a rejection reported with 200 is still a rejection', async (t) => {
  const { control } = await makeSession(t, {
    routes: {
      'GET /teamclaude/status': json(statusFixture()),
      'POST /teamclaude/reload': json({ ok: false, error: 'reload not supported' }),
    },
  });
  await assert.rejects(() => control.reload(), /reload not supported/);
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

// The payload comes from another process over a port the user configured, so a
// reply can be JSON and still not be the status this dashboard expects.
test('a payload missing the fields the renderer formats reads as unknown, not a crash', async (t) => {
  const { am, tui } = await makeSession(t);
  am.applyStatus({ accounts: [{ status: 'active' }, {}] });
  assert.deepEqual(am.accounts.map(a => [a.name, a.type]), [['(unnamed)', '?'], ['(unnamed)', '?']]);
  const out = renderToString(tui);
  assert.match(out, /\(unnamed\)/);
});

// "Connected, no accounts" would send the user looking at their account list;
// the actual problem is that the port answers from something else entirely.
test('a reply that is not a status payload is a connection problem, not an empty fleet', async (t) => {
  const { session, am, tui } = await makeSession(t, {
    routes: { 'GET /teamclaude/status': json({ hello: 'this is some other service' }) },
  });
  await session.poll();
  assert.equal(am.connected, false);
  assert.match(tui.log[0].msg, /not a teamclaude status endpoint/);
  assert.deepEqual(am.accounts, []);
});

test('an empty but genuine fleet is reported as such, without pointing at dead keys', async (t) => {
  const { session, am, tui } = await makeSession(t, {
    routes: { 'GET /teamclaude/status': json({ accounts: [], switchThreshold: 0.98 }) },
  });
  await session.poll();
  assert.equal(am.connected, true);
  const out = renderToString(tui);
  assert.match(out, /server reports no accounts/);
  assert.doesNotMatch(out, /\[g\]/); // never point at a key attach mode ignores
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

test('a wedged server does not collect one pending request per tick', async (t) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { session, seen } = await makeSession(t, {
    routes: {
      'GET /teamclaude/status': async (req, res) => {
        await held; // accepted, answered only when the test lets go
        json(statusFixture())(req, res);
      },
    },
  });

  const first = session.poll();
  await reached(seen); // let that one reach the server, where it now hangs
  await session.poll(); // a tick landing while the first is still in flight
  await session.poll();
  assert.equal(seen.length, 1);

  release();
  await first;
  assert.equal(seen.length, 1);
  await session.poll(); // the door reopens once the outstanding call finishes
  assert.equal(seen.length, 2);
});

// A server that accepts the connection and then goes silent — SIGSTOPped, or the
// laptop suspended mid-request — must read as lost contact. Without a deadline the
// dashboard sits on a frozen snapshot under a green marker for minutes.
test('a poll that never gets an answer becomes a lost connection, not a live view', async (t) => {
  const never = new Promise(() => {});
  const fake = await fakeServer(t, { 'GET /teamclaude/status': async () => { await never; } });
  const control = new RemoteControl({ port: fake.port, apiKey: 'secret', timeoutMs: 60 });
  const session = createAttachSession({ control, config: { proxy: { port: fake.port } }, onQuit: () => {} });
  session.tui.render = () => {};

  await session.am.applyStatus(statusFixture()); // start from a good snapshot
  await session.poll();

  assert.equal(session.am.connected, false);
  assert.match(session.tui.log[0].msg, /no reply within/);
  assert.deepEqual(session.am.accounts.map(a => a.name), ['alpha', 'bravo']); // snapshot kept, marked stale
  session.stop();
});

test('the poll deadline is derived from the poll interval', async (t) => {
  const fake = await fakeServer(t, { 'GET /teamclaude/status': json(statusFixture()) });
  const control = new RemoteControl({ port: fake.port });
  const session = createAttachSession({ control, config: { proxy: { port: fake.port } }, onQuit: () => {}, pollMs: 4000 });
  assert.equal(control.timeoutMs, 12_000);
  session.stop();

  const fixed = new RemoteControl({ port: fake.port, timeoutMs: 250 });
  createAttachSession({ control: fixed, config: {}, onQuit: () => {}, pollMs: 4000 }).stop();
  assert.equal(fixed.timeoutMs, 250); // an explicit deadline is not overridden
});

// A general (non-family) route is drawn as a marker column on every account row,
// which reaches into route.accounts. The payload is not ours to trust.
test('a general route renders, and a half-specified one does not take the dashboard down', async (t) => {
  const { tui, am } = await makeSession(t);
  const status = statusFixture();
  status.routes = [
    { name: 'bulk', match: ['*opus*'], color: 'green', autocreated: false, pinned: 'alpha', target: 'alpha',
      accounts: [{ name: 'alpha', eligible: true }] },
    { name: 'broken' }, // no match, no accounts, no target
  ];
  am.applyStatus(status);

  assert.deepEqual(am.getRoutes().map(r => r.accounts), [[{ name: 'alpha', eligible: true }], []]);
  assert.deepEqual(am.getRoutes()[1].match, []);
  const out = renderToString(tui);
  assert.match(out, /alpha/);
  assert.match(out, /bravo/);
  assert.equal(am.previewRouteIndex('claude-opus-4'), 0); // the general route still resolves
});

test('the control client talks to the host it was given', async () => {
  const calls = [];
  const control = new RemoteControl({
    port: 3456, host: '192.0.2.10',
    fetchImpl: async url => { calls.push(url); return reply(200, '{"accounts":[]}'); },
  });
  await control.status();
  assert.deepEqual(calls, ['http://192.0.2.10:3456/teamclaude/status']);
});

test('on loopback a 401 blames the port, not the key the server never checks', async (t) => {
  const unauthorized = (req, res) => { res.writeHead(401); res.end('nope'); };
  const local = await fakeServer(t, { 'GET /teamclaude/status': unauthorized });
  await assert.rejects(
    () => new RemoteControl({ port: local.port, host: '127.0.0.1', apiKey: 'k' }).status(),
    /something other than teamclaude/i,
  );
  // A non-loopback server DOES gate on the key, so there the key is the suspect.
  const remote = new RemoteControl({
    port: 3456, host: '192.0.2.10', apiKey: 'k',
    fetchImpl: async () => reply(401, 'nope'),
  });
  await assert.rejects(() => remote.status(), /rejected the proxy API key/i);
});

// ── keys ─────────────────────────────────────────────────────

test('keys that would need write endpoints are inert in attach mode', async (t) => {
  const { tui, am, seen } = await makeSession(t);
  am.applyStatus(statusFixture());
  for (const k of ['g', 'd', 'p', 'a', 'r']) tui._key(k);
  await nothingHappens();
  assert.equal(tui.mode, 'normal');
  assert.deepEqual(tui.log, []);
  assert.deepEqual(seen, []); // nothing was sent to the server
});

test('R reloads the running server and reports the outcome', async (t) => {
  const { tui, seen } = await makeSession(t);
  tui._key('R');
  await logged(tui);
  assert.deepEqual(seen.map(r => [r.method, r.url]), [['POST', '/teamclaude/reload']]);
  assert.equal(tui.log.length, 1);
  assert.match(tui.log[0].msg, /reload/i);
});

test('R reports a failed reload instead of pretending it worked', async (t) => {
  const { tui } = await makeSession(t, {
    routes: { 'GET /teamclaude/status': json(statusFixture()) }, // no reload route
  });
  tui._key('R');
  await logged(tui);
  assert.match(tui.log[0].msg, /failed/i);
});

test('s switches the running server to the selected account', async (t) => {
  const { tui, am, seen } = await makeSession(t);
  am.applyStatus(statusFixture());

  tui._key('s');
  assert.equal(tui.mode, 'select');
  tui._key('up'); // from "bravo" (current) to "alpha"
  tui._key('enter');
  await logged(tui);

  assert.equal(tui.mode, 'normal');
  assert.deepEqual(JSON.parse(seen.at(-1).body), { account: 'alpha' });
  assert.match(tui.log[0].msg, /alpha/);
});

// The server applies a switch to a disabled account and says so with
// eligible:false. The row already carries the disabled marker, but the moment of
// choosing is where it matters.
test('switching to an account that cannot serve says so', async (t) => {
  const { tui, am } = await makeSession(t, {
    routes: {
      'GET /teamclaude/status': json(statusFixture()),
      'POST /teamclaude/switch': json({ ok: true, account: 'alpha', eligible: false }),
    },
  });
  am.applyStatus(statusFixture());
  tui._key('s');
  tui._key('enter');
  await logged(tui);
  assert.match(tui.log[0].msg, /cannot serve requests/);
});

test('the server\'s own reason for ineligibility is what gets shown', async (t) => {
  const { tui, am } = await makeSession(t, {
    routes: {
      'GET /teamclaude/status': json(statusFixture()),
      'POST /teamclaude/switch': json({
        ok: true, account: 'alpha', eligible: false,
        reason: 'outranked by higher-priority account "bravo"',
      }),
    },
  });
  am.applyStatus(statusFixture());
  tui._key('s');
  tui._key('enter');
  await logged(tui);
  assert.match(tui.log[0].msg, /it is outranked by higher-priority account "bravo"/);
});

// The reason crosses the wire and is drawn into a fixed-width frame.
test('a reason carrying control characters cannot corrupt the frame', async (t) => {
  const { tui, am } = await makeSession(t, {
    routes: {
      'GET /teamclaude/status': json(statusFixture()),
      'POST /teamclaude/switch': json({
        ok: true, account: 'alpha', eligible: false,
        reason: `disabled\x1b[2J\r\n${'x'.repeat(200)}`,
      }),
    },
  });
  am.applyStatus(statusFixture());
  tui._key('s');
  tui._key('enter');
  await logged(tui);

  const msg = tui.log[0].msg;
  assert.doesNotMatch(msg, /\x1b/);
  assert.doesNotMatch(msg, /[\r\n]/);
  assert.ok(msg.length < 120, `reason should be clamped, got ${msg.length} chars`);
  assert.match(msg, /disabled/);
});

test('a switch reports the name the server settled on', async (t) => {
  const { tui, am } = await makeSession(t, {
    routes: {
      'GET /teamclaude/status': json(statusFixture()),
      // resolveAccountPin canonicalises what it is given; the echo is the truth.
      'POST /teamclaude/switch': json({ ok: true, account: 'bravo (Acme)' }),
    },
  });
  am.applyStatus(statusFixture());
  tui._key('s');
  tui._key('enter');
  await logged(tui);
  assert.match(tui.log[0].msg, /Switched to "bravo \(Acme\)"/);
});

test('a rejected switch is reported and leaves the view alone', async (t) => {
  const { tui, am } = await makeSession(t, {
    routes: { 'GET /teamclaude/status': json(statusFixture()) }, // no switch route
  });
  am.applyStatus(statusFixture());
  tui._key('s');
  tui._key('enter');
  await logged(tui);
  assert.equal(tui.mode, 'normal');
  assert.match(tui.log[0].msg, /switch failed/i);
});

test('a row that vanished between polls reports that nothing happened', async (t) => {
  const { tui, am, seen } = await makeSession(t);
  am.applyStatus(statusFixture());
  tui._key('s');
  tui._key('down'); // cursor on the second account
  am.applyStatus(statusFixture({ accounts: [statusFixture().accounts[0]] })); // it goes away
  tui._key('enter');
  await logged(tui);

  assert.equal(tui.mode, 'normal');
  assert.match(tui.log[0].msg, /no longer listed/i);
  assert.deepEqual(seen, []); // and nothing was asked of the server
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
  await logged(tui);
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
