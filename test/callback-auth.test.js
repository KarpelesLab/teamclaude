import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  approvalUrl, callbackBase, callbackClientId, CALLBACK_CLIENT_ID, loginCallback, refreshCallbackToken,
  getCallbackAuthPath, loadCallbackToken, saveCallbackToken, clearCallbackToken,
  callbackCall, callbackWhoami, logoutCallback,
} from '../src/callback-auth.js';

// Sign-in to callback.net: a poll-token OAuth2 flow. The client asks for a poll
// token, shows a URL, and polls until the user has approved in a browser; the
// poll answers with a code, the code buys a token. Everything here runs against
// a stand-in for the platform's REST API that speaks its real shapes: the
// `{ result, data }` envelope, `{ retry: true }` for a poll with nothing yet,
// a BARE token document from the form-posted OAuth2:token, bare OpenID claims
// from OAuth2:me, and `invalid_request_token` / `token_expired` for an access
// token that has lapsed.

const CLIENT = 'oaap-test00-aaaa-bbbb-cccc-dddddddd';
const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/**
 * The stand-in API. `state` is the test's to read and to steer:
 * `pollsBeforeApproval` empty polls, then the code; `access` is the access
 * token the API currently honours, `refresh` the refresh token it accepts.
 */
async function mockApi(t, overrides = {}) {
  const state = {
    pollsBeforeApproval: 0, access: 'at-1', refresh: 'rt-1', nextAccess: 2,
    seen: [], revoked: [], refuseRefresh: false, xox: undefined, lifetime: 900,
    ...overrides,
  };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace('/_special/rest/', '');
    const raw = await readBody(req);
    const auth = req.headers.authorization || null;
    state.seen.push({ method: req.method, path, auth, raw, type: req.headers['content-type'] || null, rest: req.headers['sec-rest-http'] || null });

    if (path === `OAuth2/App/${CLIENT}:token_create`) {
      return json(res, 200, { result: 'success', data: { polltoken: 'poll-1', lifetime: state.lifetime, xox: state.xox } });
    }
    if (path === `OAuth2/App/${CLIENT}:token_poll`) {
      if (JSON.parse(raw).polltoken !== 'poll-1') return json(res, 403, { result: 'error', code: 403, token: 'error_login_required', error: 'Access denied' });
      if (state.pollsBeforeApproval > 0) { state.pollsBeforeApproval--; return json(res, 200, { result: 'success', data: { retry: true } }); }
      return json(res, 200, { result: 'success', data: state.pollReply ?? { response: { code: 'code-1' } } });
    }
    if (path.startsWith('OAuth2/App/')) {
      return json(res, 404, { result: 'error', code: 404, token: 'error_not_found', error: 'Not Found: OAuth2\\App' });
    }
    if (path === 'OAuth2:token') {
      const form = Object.fromEntries(new URLSearchParams(raw));
      if (form.client_id !== CLIENT) return json(res, 400, { result: 'error', code: 400, token: 'error_invalid_client_id', error: 'Invalid value for client_id on field client_id' });
      if (form.grant_type === 'authorization_code' && form.code === 'code-1') {
        return json(res, 200, { access_token: state.access, refresh_token: state.refresh, token_type: 'Bearer', expires_in: 3600 });
      }
      if (form.grant_type === 'refresh_token' && form.refresh_token === state.refresh && !state.refuseRefresh) {
        state.access = `at-${state.nextAccess++}`;
        // No refresh_token restated: the old one stays good.
        return json(res, 200, { access_token: state.access, token_type: 'Bearer', expires_in: 3600 });
      }
      return json(res, 400, { result: 'error', code: 400, token: 'error_invalid_grant', error: 'Invalid grant' });
    }
    if (path === 'OAuth2:me') {
      if (!auth) return json(res, 403, { result: 'redirect', code: 403, exception: 'Exception\\Login', error: 'Identification required to access private API', redirect_url: '/login' });
      if (auth !== `Bearer ${state.access}`) return json(res, 401, { result: 'error', code: 401, token: 'invalid_request_token', extra: 'token_expired', error: 'The access token has expired' });
      // OpenID claims, no envelope — the shape the live endpoint answers with.
      return json(res, 200, { iss: 'https://x', sub: 'oaur-1', aud: [CLIENT], exp: 1, iat: 0, email: 'someone@example.com', name: 'Some\x1b[2JOne' });
    }
    if (path === 'User/@') {
      return json(res, 403, { result: 'error', code: 403, token: 'error_access_denied', error: 'Access denied to this API, missing appropriate scope' });
    }
    if (path === 'OAuth2:revoke') {
      state.revoked.push(JSON.parse(raw).token);
      return json(res, 200, { result: 'success', data: true });
    }
    return json(res, 404, { result: 'error', code: 404, token: 'error_not_found', error: 'Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { state, base: `http://127.0.0.1:${server.address().port}` };
}

// The token file sits beside the config, so each test that touches it gets a
// config path of its own.
async function tempConfig(t) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-callback-'));
  const prev = { c: process.env.TEAMCLAUDE_CONFIG, r: process.env.TEAMROUTER_CONFIG };
  delete process.env.TEAMROUTER_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = join(dir, 'config.json');
  t.after(async () => {
    if (prev.c === undefined) delete process.env.TEAMCLAUDE_CONFIG; else process.env.TEAMCLAUDE_CONFIG = prev.c;
    if (prev.r !== undefined) process.env.TEAMROUTER_CONFIG = prev.r;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const noSleep = async () => {};

// ── the pieces ───────────────────────────────────────────────

test('the approval URL is the API\'s own, or a short link only when it looks like one', () => {
  const base = 'https://www.callback.net';
  const full = approvalUrl(base, CLIENT, 'poll-1');
  const u = new URL(full);
  assert.equal(u.origin, base);
  assert.equal(u.pathname, '/_rest/OAuth2:auth');
  assert.deepEqual(Object.fromEntries(u.searchParams), { response_type: 'code', client_id: CLIENT, redirect_uri: 'polltoken:poll-1', scope: 'profile user_credentials' });
  // The platform's short links come without a scheme.
  assert.equal(approvalUrl(base, CLIENT, 'poll-1', 'oid.jp/P2KA3Z'), 'https://oid.jp/P2KA3Z');
  assert.equal(approvalUrl(base, CLIENT, 'poll-1', 'https://oid.jp/P2KA3Z'), 'https://oid.jp/P2KA3Z');
  // Anything else is not taken on trust: another scheme, a query, a path that
  // goes somewhere, terminal escapes, a non-string.
  for (const odd of ['http://oid.jp/P2KA3Z', 'javascript:alert(1)', 'oid.jp/a?next=evil', 'oid.jp/a/b', 'oid.jp/\x1b[2J', 'localhost/x', '', null, 7, { a: 1 }]) {
    assert.equal(approvalUrl(base, CLIENT, 'poll-1', odd), full, JSON.stringify(odd));
  }
});

test('the API origin can only be overridden to https, or to plain http on this machine', () => {
  const warned = [];
  const at = (v) => callbackBase(v === undefined ? {} : { TEAMCLAUDE_CALLBACK_API_BASE: v }, (m) => warned.push(m));
  assert.equal(at(undefined), 'https://www.callback.net');
  assert.equal(at('https://staging.example.net/'), 'https://staging.example.net');
  assert.equal(at('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(warned.length, 0);
  assert.equal(at('http://staging.example.net'), 'https://www.callback.net');
  assert.equal(at('not a url'), 'https://www.callback.net');
  assert.equal(warned.length, 2);
  assert.match(warned[0], /must be https/);
  // The new prefix wins, as for every other variable.
  assert.equal(callbackBase({ TEAMROUTER_CALLBACK_API_BASE: 'https://a.example', TEAMCLAUDE_CALLBACK_API_BASE: 'https://b.example' }), 'https://a.example');
});

test('the client id is the built-in one unless the environment names another', () => {
  assert.equal(callbackClientId({}), CALLBACK_CLIENT_ID);
  assert.match(CALLBACK_CLIENT_ID, /^oaap-[a-z0-9-]+$/);
  assert.equal(callbackClientId({ TEAMCLAUDE_CALLBACK_CLIENT_ID: ' oaap-other ' }), 'oaap-other');
});

// ── signing in ───────────────────────────────────────────────

test('sign-in polls until the approval arrives, then trades the code for a token', async (t) => {
  const api = await mockApi(t, { pollsBeforeApproval: 2, xox: 'oid.jp/AbC123' });
  const urls = [];
  const sleeps = [];
  const token = await loginCallback({
    clientId: CLIENT, base: api.base, now: () => 1_000_000,
    onUrl: (url, info) => urls.push([url, info.lifetimeSeconds]),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(urls, [['https://oid.jp/AbC123', 900]]);
  assert.equal(sleeps.length, 2, 'one pause per empty poll');
  assert.deepEqual(token, { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600, client_id: CLIENT, obtained_at: 1_000_000 });

  const paths = api.state.seen.map((s) => s.path);
  assert.deepEqual(paths, [
    `OAuth2/App/${CLIENT}:token_create`,
    `OAuth2/App/${CLIENT}:token_poll`, `OAuth2/App/${CLIENT}:token_poll`, `OAuth2/App/${CLIENT}:token_poll`,
    'OAuth2:token',
  ]);
  // The API calls ask for the JSON envelope; the token exchange is a form post.
  assert.equal(api.state.seen[0].rest, 'false');
  assert.deepEqual(JSON.parse(api.state.seen[0].raw), { scope: 'profile user_credentials' }, 'the scope goes with token_create, since the short link carries none');
  const exchange = api.state.seen.at(-1);
  assert.equal(exchange.type, 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(exchange.raw)), { client_id: CLIENT, grant_type: 'authorization_code', code: 'code-1' });
  assert.ok(api.state.seen.every((s) => s.auth === null), 'nothing is sent as anyone before the token exists');
});

test('without a short link the user is sent to the API\'s own authorization page', async (t) => {
  const api = await mockApi(t);
  let shown = null;
  await loginCallback({ clientId: CLIENT, base: api.base, onUrl: (url) => { shown = url; }, sleep: noSleep });
  assert.equal(shown, `${api.base}/_rest/OAuth2:auth?response_type=code&client_id=${CLIENT}&redirect_uri=polltoken%3Apoll-1&scope=profile+user_credentials`);
});

test('a sign-in nobody approves ends when the poll token does, not never', async (t) => {
  const api = await mockApi(t, { pollsBeforeApproval: Infinity, lifetime: 120 });
  // The clock is the test's: each pause moves it a minute, so the 2-minute poll
  // token is dead after two.
  let clock = 0;
  await assert.rejects(
    loginCallback({ clientId: CLIENT, base: api.base, now: () => clock, sleep: async () => { clock += 60_000; } }),
    /not approved within 2 minutes/,
  );
  assert.equal(api.state.seen.filter((s) => s.path.endsWith(':token_poll')).length, 3);
});

test('a reply that is not what the flow expects is an error, never a token', async (t) => {
  const unknown = await mockApi(t);
  await assert.rejects(loginCallback({ clientId: 'oaap-nope', base: unknown.base, sleep: noSleep }), (err) => {
    assert.equal(err.token, 'error_not_found');
    assert.equal(err.code, 404);
    return true;
  });
  const noCode = await mockApi(t, { pollReply: { response: { state: 'x' } } });
  await assert.rejects(loginCallback({ clientId: CLIENT, base: noCode.base, sleep: noSleep }), /without an authorization code/);
  await assert.rejects(loginCallback({ clientId: '', base: unknown.base }), /no callback\.net client id/);
});

// ── the stored token ─────────────────────────────────────────

test('the token is kept beside the config, private, and a damaged file reads as signed out', async (t) => {
  const dir = await tempConfig(t);
  assert.equal(getCallbackAuthPath(), join(dir, 'config.callback.json'));
  assert.equal(await loadCallbackToken(), null);

  const token = { access_token: 'at-1', refresh_token: 'rt-1', client_id: CLIENT, obtained_at: 1 };
  await saveCallbackToken(token);
  assert.deepEqual(await loadCallbackToken(), token);
  if (process.platform !== 'win32') assert.equal((await stat(getCallbackAuthPath())).mode & 0o777, 0o600);

  for (const damaged of ['', '{not json', '[]', '{"access_token":""}', '{"refresh_token":"rt-1"}']) {
    await writeFile(getCallbackAuthPath(), damaged);
    assert.equal(await loadCallbackToken(), null, JSON.stringify(damaged));
  }
  await clearCallbackToken();
  await clearCallbackToken(); // nothing there: still not an error
  await assert.rejects(stat(getCallbackAuthPath()), { code: 'ENOENT' });
});

// ── using it ─────────────────────────────────────────────────

test('an expired access token is renewed once, saved, and the call repeated', async (t) => {
  await tempConfig(t);
  const api = await mockApi(t, { access: 'at-current' });
  await saveCallbackToken({ access_token: 'at-stale', refresh_token: 'rt-1', client_id: CLIENT, obtained_at: 1 });

  const me = await callbackWhoami({ base: api.base, now: () => 5 });
  // The display name carried a terminal escape; it does not reach the caller.
  assert.deepEqual(me, { id: 'oaur-1', email: 'someone@example.com', name: 'Some One' });
  assert.deepEqual(api.state.seen.map((s) => [s.path, s.auth]), [
    ['OAuth2:me', 'Bearer at-stale'],
    ['OAuth2:token', null],
    ['OAuth2:me', 'Bearer at-2'],
  ]);
  // The refresh token was not restated by the server and is kept.
  assert.deepEqual(await loadCallbackToken(), { access_token: 'at-2', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600, client_id: CLIENT, obtained_at: 5 });
});

test('a session the server will not renew asks for a new sign-in; no token at all does too', async (t) => {
  await tempConfig(t);
  const api = await mockApi(t, { refuseRefresh: true });
  await assert.rejects(callbackCall('GET', 'OAuth2:me', null, { base: api.base }), (err) => err.loginRequired === true && /not signed in/.test(err.message));

  const stale = { access_token: 'at-stale', refresh_token: 'rt-1', client_id: CLIENT, obtained_at: 1 };
  await saveCallbackToken(stale);
  await assert.rejects(callbackCall('GET', 'OAuth2:me', null, { base: api.base }), (err) => err.loginRequired === true && err.token === 'error_invalid_grant');
  // The stored token is left alone: refusing is the server's word, deleting is the user's.
  assert.deepEqual(await loadCallbackToken(), stale);

  await saveCallbackToken({ access_token: 'at-stale', client_id: CLIENT, obtained_at: 1 });
  await assert.rejects(callbackCall('GET', 'OAuth2:me', null, { base: api.base }), /expired and cannot be renewed/);
  // An endpoint the grant does not cover is a plain refusal, not a sign-in prompt.
  await saveCallbackToken({ access_token: 'at-1', refresh_token: 'rt-1', client_id: CLIENT, obtained_at: 1 });
  await assert.rejects(callbackCall('GET', 'User/@', null, { base: api.base }), (err) => err.token === 'error_access_denied' && !err.loginRequired);
  await assert.rejects(refreshCallbackToken({ access_token: 'a', refresh_token: 'wrong', client_id: CLIENT, obtained_at: 1 }, { base: api.base }), (err) => err.code === 400);
});

test('signing out revokes the grant and forgets the token, reachable server or not', async (t) => {
  await tempConfig(t);
  const api = await mockApi(t);
  assert.deepEqual(await logoutCallback({ base: api.base }), { wasSignedIn: false, revoked: false });

  await saveCallbackToken({ access_token: 'at-1', refresh_token: 'rt-1', client_id: CLIENT, obtained_at: 1 });
  assert.deepEqual(await logoutCallback({ base: api.base }), { wasSignedIn: true, revoked: true });
  assert.deepEqual(api.state.revoked, ['rt-1'], 'the refresh token: revoking it ends the whole grant');
  assert.equal(await loadCallbackToken(), null);

  // A server that cannot be reached must not keep the token on disk.
  await saveCallbackToken({ access_token: 'at-1', refresh_token: 'rt-1', client_id: CLIENT, obtained_at: 1 });
  const dead = async () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await logoutCallback({ base: api.base, fetchImpl: dead }), { wasSignedIn: true, revoked: false });
  assert.equal(await loadCallbackToken(), null);
});

// ── the command ──────────────────────────────────────────────

function runCli(configPath, base, cliArgs) {
  // The child must not inherit a proxy from the shell: see test/README.md.
  const env = {
    ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1',
    TEAMCLAUDE_CALLBACK_API_BASE: base, TEAMCLAUDE_CALLBACK_CLIENT_ID: CLIENT,
  };
  for (const key of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(key) || /^TEAMROUTER_/.test(key)) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'callback', ...cliArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('teamclaude callback: login prints the URL and saves the token, status names the user, logout forgets', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-callback-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  const tokenPath = join(dir, 'config.callback.json');
  const api = await mockApi(t);

  const before = await runCli(configPath, api.base, ['status']);
  assert.equal(before.code, 1);
  assert.match(before.stderr, /Not signed in to callback\.net/);

  const login = await runCli(configPath, api.base, ['login', '--no-browser']);
  assert.equal(login.code, 0, login.stderr);
  assert.ok(login.stdout.includes(`${api.base}/_rest/OAuth2:auth?response_type=code&client_id=${CLIENT}`), login.stdout);
  assert.match(login.stdout, /Signed in to callback\.net as Some One <someone@example\.com>/);
  const saved = JSON.parse(await readFile(tokenPath, 'utf8'));
  assert.equal(saved.access_token, 'at-1');
  assert.equal(saved.client_id, CLIENT);
  await assert.rejects(stat(configPath), { code: 'ENOENT' }, 'signing in does not create or touch the config');

  const status = await runCli(configPath, api.base, ['status']);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Signed in to callback\.net as Some One <someone@example\.com>/);

  // Already signed in: nothing is replaced unless asked.
  const again = await runCli(configPath, api.base, ['login', '--no-browser']);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /Already signed in to callback\.net as Some One/);
  assert.equal(api.state.seen.filter((s) => s.path.endsWith(':token_create')).length, 1);

  const logout = await runCli(configPath, api.base, ['logout']);
  assert.equal(logout.code, 0, logout.stderr);
  assert.match(logout.stdout, /Signed out of callback\.net\./);
  assert.deepEqual(api.state.revoked, ['rt-1']);
  await assert.rejects(stat(tokenPath), { code: 'ENOENT' });

  const bad = await runCli(configPath, api.base, ['frobnicate']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Usage: teamclaude callback login/);
});
