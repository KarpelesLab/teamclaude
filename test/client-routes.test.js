import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { resolveAccountPin } from '../src/server.js';
import {
  parseClientRoutes, routeForClient, resolveClientRoute, clientRoutePolicyActive,
  recordSeatRejection, liveSeatRejection, clearSeatRejection, seatVerdict, combineVerdicts,
  seatAnswer, SEAT_REASONS, clientRoutesStatus, callerSeat, parseSeatPolicies,
} from '../src/client-routes.js';

// Unit half of the client-route (fixed seat) feature, IPM fork AI-1552: the
// table, resolution against live accounts, the spent recording and the
// answers. The request paths are in client-routes-server.test.js and
// client-routes-mitm.test.js.

const HOUR = 3600_000;
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra });
const quiet = (fn) => { const o = console.log; console.log = () => {}; try { return fn(); } finally { console.log = o; } };
const sec = (ms) => String(Math.floor(ms / 1000));

test('parse: routes keep names only, clients match trimmed and case-insensitive', () => {
  const t = parseClientRoutes([{ name: ' seat-7 ', clients: [' Pedro ', 'pedro-ci'], accounts: ['s7@x'] }]);
  assert.deepEqual(t.routes, [{ name: 'seat-7', clients: ['Pedro', 'pedro-ci'], accounts: ['s7@x'] }]);
  assert.equal(routeForClient(t, 'PEDRO').route.name, 'seat-7');
  assert.equal(routeForClient(t, 'pedro-ci ').route.name, 'seat-7');
  assert.equal(routeForClient(t, 'ana'), null);
  assert.deepEqual(t.warnings, []);
});

test('parse: a client on two routes is ambiguous and neither route applies to it', () => {
  const t = parseClientRoutes([
    { name: 'a', clients: ['ana'], accounts: ['a@x'] },
    { name: 'b', clients: ['Ana', 'bob'], accounts: ['b@x'] },
  ]);
  assert.deepEqual(routeForClient(t, 'ana'), { ambiguous: ['a', 'b'] });
  assert.equal(routeForClient(t, 'bob').route.name, 'b');
  assert.ok(t.warnings.some(w => /client "ana" is on 2 routes/.test(w)), t.warnings.join('\n'));
});

test('parse: malformed input never throws and warns', () => {
  assert.deepEqual(parseClientRoutes(undefined).routes, []);
  assert.deepEqual(parseClientRoutes(null).routes, []);
  const notList = parseClientRoutes({ name: 'x' });
  assert.deepEqual(notList.routes, []);
  assert.ok(notList.warnings.length);
  const t = parseClientRoutes([null, { clients: ['a'] }, { name: 'ok', clients: ['b', 7, ''], accounts: [] }, 'x']);
  assert.deepEqual(t.routes, [{ name: 'ok', clients: ['b'], accounts: [] }]);
  assert.ok(t.warnings.some(w => /names no account/.test(w)));
});

test('seat policies map renderer slugs to resolved accounts and default to recommend', () => {
  const route = { name: 's1+s2', clients: ['amy'], accounts: ['a@x', 'b@x'] };
  assert.deepEqual(parseSeatPolicies(undefined, route, [4, 8]), new Map());
  assert.deepEqual(parseSeatPolicies('*=recommend,s2=force', route, [4, 8]), new Map([[4, 'recommend'], [8, 'force']]));
  assert.deepEqual(parseSeatPolicies('*=force,s1=recommend', route, [4, 8]), new Map([[4, 'recommend'], [8, 'force']]));
});

test('seat policies fail closed as a whole on malformed or ambiguous input', () => {
  const route = { name: 's1+s2', clients: ['amy'], accounts: ['a@x', 'b@x'] };
  const invalid = [
    '', 's1', 's1=', 's1=FORCE', 's1=maybe', 's1=force=extra', 's1=force,s1=recommend',
    '*=force,*=recommend', 'other=force', 's1 force', 's1=force,', `${'x'.repeat(41)}=force`,
  ];
  for (const raw of invalid) assert.deepEqual(parseSeatPolicies(raw, route, [4, 8]), new Map(), raw);
  assert.deepEqual(parseSeatPolicies('s1=force', route, [4]), new Map(), 'resolved account count mismatch');
  assert.deepEqual(parseSeatPolicies('s1=force', { ...route, accounts: ['a@x'] }, [4, 8]), new Map(), 'configured account count mismatch');
  assert.deepEqual(parseSeatPolicies('s1=force', { ...route, name: 's1+s1' }, [4, 8]), new Map(), 'duplicate route slug');
  assert.deepEqual(parseSeatPolicies('s1=force', route, [4, 4]), new Map(), 'duplicate account index');
  assert.deepEqual(parseSeatPolicies('s1=force', { ...route, name: 'seat-q' }, [4, 8]), new Map(), 'hand-written multi-account route name');
});

test('policy is active with any route or with the switch on, and only then', () => {
  assert.equal(clientRoutePolicyActive(parseClientRoutes([]), {}), false);
  assert.equal(clientRoutePolicyActive(parseClientRoutes([]), { requireClientRoute: false }), false);
  assert.equal(clientRoutePolicyActive(parseClientRoutes([]), { requireClientRoute: true }), true);
  assert.equal(clientRoutePolicyActive(parseClientRoutes([{ name: 'a', clients: ['x'], accounts: ['y'] }]), {}), true);
});

test('resolve: by name per request, so a reload that renumbers accounts follows it', () => {
  const am = quiet(() => new AccountManager([oauth('one'), oauth('two')], 0.98, { clientRoutes: [{ name: 's', clients: ['k'], accounts: ['two'] }] }));
  const route = am.clientRoutes.routes[0];
  assert.deepEqual(resolveClientRoute(am, route, resolveAccountPin), { resolved: true, indices: [1], problem: null });
  am.accounts.shift();
  am.accounts.forEach((a, i) => { a.index = i; });
  assert.deepEqual(resolveClientRoute(am, route, resolveAccountPin).indices, [0]);
});

test('resolve: unknown name, shared name and Codex subscription are unresolved', () => {
  const am = quiet(() => new AccountManager([
    oauth('dup'), oauth('dup'), oauth('codex:x', { provider: 'codex', accountId: 'acct' }), oauth('fine'),
  ], 0.98));
  const r = (accounts) => resolveClientRoute(am, { name: 's', clients: ['k'], accounts }, resolveAccountPin);
  assert.match(r(['nope']).problem, /not configured/);
  assert.match(r(['dup']).problem, /shared by 2 accounts/);
  assert.match(r(['codex:x']).problem, /codex subscription/);
  assert.match(r([]).problem, /names no account/);
  assert.equal(r(['fine']).resolved, true);
  assert.equal(r(['fine', 'nope']).resolved, false, 'one bad name makes the whole route unresolved');
});

// The model routes are a different table: client routes must not appear in,
// or change, anything getRoutes() reports (CLI, TUI and MCP read it).
test('getRoutes() is unchanged when clientRoutes is configured', () => {
  const routes = [{ name: 'fast', match: 'claude-haiku*', accounts: ['one'] }];
  const plain = new AccountManager([oauth('one'), oauth('two')], 0.98, { routes });
  const withSeats = quiet(() => new AccountManager([oauth('one'), oauth('two')], 0.98, {
    routes, clientRoutes: [{ name: 'seat', clients: ['ana'], accounts: ['two'] }],
  }));
  assert.deepEqual(withSeats.getRoutes(), plain.getRoutes());
  assert.deepEqual(withSeats.routes, plain.routes);
  quiet(() => withSeats.setClientRoutes([{ name: 'other', clients: ['bob'], accounts: ['one'] }]));
  assert.deepEqual(withSeats.getRoutes(), plain.getRoutes());
});

test('rejection: a shared-window 429 is spent for every model until its reset', () => {
  const a = oauth('s');
  const now = Date.now();
  const reset = now + 2 * HOUR;
  const rec = recordSeatRejection(a, {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': sec(reset),
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-tokens-limit': '1',
  }, 'claude-opus-4-1', undefined, now);
  assert.equal(rec.scope, 'all');
  assert.equal(rec.resetsAt, Math.floor(reset / 1000) * 1000);
  assert.deepEqual(Object.keys(rec.headers).sort(), [
    'anthropic-ratelimit-unified-5h-reset', 'anthropic-ratelimit-unified-5h-status',
    'anthropic-ratelimit-unified-7d-status', 'anthropic-ratelimit-unified-status',
  ], 'only the unified headers are kept, verbatim');
  assert.ok(liveSeatRejection(a, 'claude-fable-5-1', undefined, now));
  assert.ok(liveSeatRejection(a, 'claude-haiku-4-5', undefined, now));
  assert.equal(liveSeatRejection(a, 'claude-opus-4-1', undefined, reset + 1000), null, 'gone once the window resets');
});

test('rejection: a 7d_oi rejection is Fable only', () => {
  const a = oauth('s');
  const now = Date.now();
  recordSeatRejection(a, {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
    'anthropic-ratelimit-unified-7d_oi-reset': sec(now + 24 * HOUR),
  }, 'claude-fable-5-1', undefined, now);
  assert.ok(liveSeatRejection(a, 'claude-fable-5-1', undefined, now));
  assert.equal(liveSeatRejection(a, 'claude-opus-4-1', undefined, now), null);
});

test('rejection: none is recorded without a reset that parses, or with one in the past', () => {
  const a = oauth('s');
  assert.equal(recordSeatRejection(a, { 'anthropic-ratelimit-unified-5h-status': 'rejected' }, null), null);
  assert.equal(recordSeatRejection(a, { 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': 'soon' }, null), null);
  assert.equal(recordSeatRejection(a, { 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': sec(Date.now() - HOUR) }, null), null);
  assert.equal(recordSeatRejection(a, { 'anthropic-ratelimit-unified-5h-status': 'allowed', 'anthropic-ratelimit-unified-5h-reset': sec(Date.now() + HOUR) }, null), null);
  assert.equal(liveSeatRejection(a, null), null);
});

test('verdict: disabled, error, throttled, capped, spent; the switch threshold is ignored', () => {
  const am = quiet(() => new AccountManager([oauth('s')], 0.5));
  const a = am.accounts[0];
  assert.equal(seatVerdict(am, a, 'claude-opus-4-1'), null);
  a.quota.unified5h = 0.9; // past the 0.5 threshold: rotation would leave, a bound seat does not
  assert.equal(am.unavailableReason(a, 'claude-opus-4-1'), 'quota');
  assert.equal(seatVerdict(am, a, 'claude-opus-4-1'), null);
  a.quota.unified5h = null;
  a.disabled = true;
  assert.deepEqual(seatVerdict(am, a, null), { kind: 'unavailable', reason: 'disabled' });
  a.disabled = false;
  a.status = 'error';
  assert.deepEqual(seatVerdict(am, a, null), { kind: 'unavailable', reason: 'error' });
  a.status = 'throttled';
  a.rateLimitedUntil = Date.now() + 42_000;
  const v = seatVerdict(am, a, null);
  assert.equal(v.kind, 'throttled');
  assert.ok(v.retryAfter >= 41 && v.retryAfter <= 42, String(v.retryAfter));
  recordSeatRejection(a, { 'anthropic-ratelimit-unified-7d-status': 'rejected', 'anthropic-ratelimit-unified-7d-reset': sec(Date.now() + 48 * HOUR) }, null);
  assert.equal(seatVerdict(am, a, null).kind, 'spent', 'a throttle behind a live rejection is the spent window');
  clearSeatRejection(a);
  a.status = 'active';
  a.rateLimitedUntil = null;
  a.maxUsage = 0.5;
  a.quota.unified5h = 0.6;
  assert.equal(seatVerdict(am, a, null).kind, 'capped');
});

test('combined verdicts: throttled beats spent, all spent is spent, else unavailable', () => {
  const spent = { kind: 'spent', rejection: { resetsAt: 2, headers: {}, scope: 'all', at: 0 } };
  const spentLater = { kind: 'spent', rejection: { resetsAt: 9, headers: {}, scope: 'all', at: 0 } };
  assert.deepEqual(combineVerdicts([spent, { kind: 'throttled', retryAfter: 30 }, { kind: 'throttled', retryAfter: 5 }]), { kind: 'throttled', retryAfter: 5 });
  assert.equal(combineVerdicts([spentLater, spent]), spent);
  assert.equal(combineVerdicts([spent, { kind: 'unavailable', reason: 'error' }]).kind, 'unavailable');
  assert.equal(combineVerdicts([null, null]), null);
});

test('answers: status codes and the headers Claude Code keys on', () => {
  const noSeat = seatAnswer(SEAT_REASONS.noSeat);
  assert.equal(noSeat.status, 403);
  assert.equal(JSON.parse(noSeat.body).error.type, 'permission_error');
  assert.equal(seatAnswer(SEAT_REASONS.foreignPin, { seat: 's', detail: 't' }).status, 403);
  assert.equal(seatAnswer(SEAT_REASONS.operatorUnpinned).status, 403);

  const rejection = { headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': '1900000000' }, resetsAt: 1_900_000_000_000, scope: 'all', at: 0 };
  const spent = seatAnswer(SEAT_REASONS.spent, { seat: 'seat-7', verdict: { kind: 'spent', rejection } });
  assert.equal(spent.status, 429);
  assert.equal(spent.headers['x-should-retry'], 'false');
  assert.equal(spent.headers['anthropic-ratelimit-unified-5h-reset'], '1900000000');
  assert.equal(spent.headers['retry-after'], undefined);
  assert.match(JSON.parse(spent.body).error.message, /seat "seat-7" is out of quota until 2030-03-17T17:46:40.000Z\. Use `cg kimi on`/);

  const offered = seatAnswer(SEAT_REASONS.spent, {
    seat: 'seat-q', verdict: { kind: 'spent', rejection }, queue: { pinned: 'qa', next: 'qb' },
  });
  const offeredMessage = JSON.parse(offered.body).error.message;
  assert.equal(offered.status, 429);
  assert.equal(offered.headers['x-should-retry'], 'false');
  assert.equal(offered.headers['anthropic-ratelimit-unified-5h-reset'], undefined, 'the offer must not trigger the generic plan-limit banner');
  assert.match(offeredMessage, /\/ipm:handoff/);
  assert.match(offeredMessage, /start a new conversation/);
  assert.match(offeredMessage, /reprocess the full conversation/);
  assert.match(offeredMessage, /cold prompt cache/);
  assert.match(offeredMessage, /next prompt confirms/);
  assert.match(offeredMessage, /No additional confirmation prompt is required/);

  const noSibling = seatAnswer(SEAT_REASONS.spent, {
    seat: 'seat-q', verdict: { kind: 'spent', rejection }, queue: { pinned: 'qa', next: null },
  });
  assert.equal(noSibling.headers['anthropic-ratelimit-unified-5h-reset'], '1900000000', 'no offer keeps the ordinary spent response');

  const throttled = seatAnswer(SEAT_REASONS.throttled, { verdict: { kind: 'throttled', retryAfter: 12 } });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers['retry-after'], '12');
  assert.equal(throttled.headers['x-should-retry'], undefined, 'a throttle stays retryable');

  const capped = seatAnswer(SEAT_REASONS.capped, { verdict: { kind: 'capped', reason: 'spend-capped' } });
  assert.equal(capped.status, 429);
  assert.equal(capped.headers['x-should-retry'], 'false');
  assert.ok(!Object.keys(capped.headers).some(h => h.startsWith('anthropic-ratelimit-')), 'no invented unified headers for an operator cap');

  const down = seatAnswer(SEAT_REASONS.unavailable, { seat: 's', detail: 'disabled' });
  assert.equal(down.status, 503);
  assert.equal(down.headers['x-should-retry'], 'false');
});

test('status: clientRoutes lists every route with resolved, caller.seat describes the key\'s own', () => {
  const am = quiet(() => new AccountManager([oauth('s7@x'), oauth('s3@x')], 0.98, {
    clientRoutes: [
      { name: 'seat-7', clients: ['pedro'], accounts: ['s7@x'] },
      { name: 'seat-9', clients: ['ana'], accounts: ['gone@x'] },
    ],
  }));
  am.accounts[0].quota.unified5h = 0.4;
  am.accounts[0].quota.unified5hReset = Date.now() + HOUR;
  const routes = clientRoutesStatus(am, resolveAccountPin);
  assert.deepEqual(routes.map(r => [r.name, r.resolved]), [['seat-7', true], ['seat-9', false]]);
  assert.deepEqual(routes[0].clients, ['pedro']);
  assert.deepEqual(routes[0].accounts, ['s7@x']);
  assert.match(routes[1].problem, /not configured/);

  const seat = callerSeat(am, 'pedro', resolveAccountPin);
  assert.equal(seat.name, 'seat-7');
  assert.equal(seat.state, 'ok');
  assert.equal(seat.windows['5h'].utilization, 0.4);
  assert.equal(seat.resetsAt, am.accounts[0].quota.unified5hReset);
  assert.equal(callerSeat(am, 'ana', resolveAccountPin).state, 'unavailable');
  assert.equal(callerSeat(am, 'nobody', resolveAccountPin), null);
});
