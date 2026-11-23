// The (state, event) tables test/routing-config-model.test.js drives: the
// hold machine of one account, and the removal machine of the pointers a
// removal renumbers. Every expected outcome comes from the docs sentence a row
// cites, quoted whole in SENTENCES, or is marked inferred with the reason.
// No test reads `expect`: the invariants judge most outcomes, and the test
// checks that a path takes every row. No invariant judges quota-below,
// quota-above, rcur-at or pcur-at.
//
// A row is `{ id, machine, state, event, shape, expect, docs, reachable }`.
// `shape` holds the request fields the row depends on, or null. `docs` is the
// docs line the sentence starts on, or `{ inferred }`. `reachable` is true, or
// why AccountManager's public API cannot reach the row; every row here is
// reachable, and the field keeps the schema open to one that is not.
//
// Hold states: `free`; `billed`; `denied<n>`, the entitlement cooldown after
// the n-th denial in a row; `released<n>`, that cooldown over with the n
// denials still counted; `error`, refused by upstream. A timed state's
// deadline is probed by a request 1 ms before its end, at it and 1 ms after.
// Removal states name a pointer, and its events say where the removed account
// sits: at a lower index than the account the pointer names, at it, or higher.

/** The docs sentences the rows cite: the line each starts on, and the
 * sentence whole. */
const SENTENCES = /** @type {Record<string, [string, string]>} */ ({
  billing: ['docs/routing.md:68', "An HTTP `400` with Anthropic's `invalid_request_error` message beginning `Your credit balance is too low to access the Anthropic API.`, or an HTTP `400` or `402` with a structured `billing_error`, excludes that account from automatic rotation for five minutes."],
  retry: ['docs/routing.md:80', 'The next request after the cooldown retries the account.'],
  denied: ['docs/routing.md:88', 'TeamClaude fails the current request over to another account and keeps the denied account out of automatic rotation for a cooldown shared by later requests.'],
  expires: ['docs/routing.md:88', 'The cooldown expires on its own, so an organization policy change can recover without restarting the proxy, and it lengthens while the denials keep coming with no served request in between: 5 min, 15 min, then 1 h for every one after that.'],
  flight: ['docs/routing.md:88', 'A `403` to a request sent before the last denial was recorded was already in flight then and does not count as another.'],
  clears: ['docs/routing.md:90', 'The denial stays on the account past its cooldown, until it delivers a whole completion (`/v1/messages`) for a request sent after the last denial.'],
  refused: ['docs/routing.md:108', "On an OAuth account, any of these in a JSON `400` or a `403` puts the account in `error` with upstream's message (see [Why an account is in `error`](accounts.md#why-an-account-is-in-error)), and the request fails over."],
  error: ['docs/accounts.md:275', 'It also leaves rotation when upstream refuses the account itself ([account refusals](routing.md#account-refusals)).'],
  advisorCap: ['docs/routing.md:195', "An account's [`maxUsage`](quota.md#per-account-usage-caps) cap on the advisor's family holds in both modes: while another account can serve the request, selection and a failover hop stay off an account whose cap bars that family, since the advisor call would cross it."],
  stays: ['docs/routing.md:19', 'It stays on the current one and only rotates when that account nears `switchThreshold` (default `0.98`).'],
  dropped: ['docs/accounts.md:156', 'Account **removals** made on disk (`teamclaude remove` from another shell, or a hand edit) are applied by the same reload: a running account whose entry is gone from the file is dropped from the fleet, and the reload reports how many it added and how many it removed.'],
  pinsDeleted: ['docs/routing.md:409', 'And a pin can simply **cease to exist**: removing an account deletes the pins that named it, [`teamclaude release`](usage.md#releasing-the-conversations-on-an-account) deletes the pins on one account on your say-so, and a conversation idle past the known window is forgotten along with all of them.'],
  returns: ['docs/routing.md:417', 'Traffic that returns before the destination has served anything is preempted off the rolled account again as soon as anywhere better is available, because the stay was never confirmed.'],
  roll: ['docs/routing.md:409', "With `preempt` on, a **pinned conversation** (and the sticky current account) is re-routed when its account's governing weekly window **rolls over** — the account just became both the freshest and the furthest-dated choice, so staying would burn the window that gained a full week while sooner-expiring quota goes unspent."],
});

import { FABLE, H, MIN, OPUS } from './routing-model.js';

/** Each timed hold state and its documented length. */
export const DEADLINES = { billed: 5 * MIN, denied1: 5 * MIN, denied2: 15 * MIN, denied3: 60 * MIN };

/** @typedef {{ id: string, machine: string, state: string, event: string, shape: { advisor: boolean }|null,
 *   expect: string, docs: string|{ inferred: string }, reachable: true|string }} TransitionRow */

/** The sentence each row that cites one cites, by row id, which the test
 * finds on the docs line the row names. @type {Record<string, string>} */
export const QUOTES = {};

/** @typedef {[string, string]|{ inferred: string }} Cite */

/** @returns {TransitionRow} */
const row = (/** @type {string} */ id, /** @type {string} */ machine, /** @type {string} */ state, /** @type {string} */ event,
  /** @type {{ advisor: boolean }|null} */ shape, /** @type {string} */ expect, /** @type {Cite} */ cite) => {
  if (Array.isArray(cite)) QUOTES[id] = cite[1];
  return { id, machine, state, event, shape, expect, docs: Array.isArray(cite) ? cite[0] : cite, reachable: true };
};

const OTHERS = { inferred: 'docs/accounts.md:156 drops only the removed account, so a removal leaves every other one as it was' };
const EDGE = { inferred: 'no docs line says whether a cooldown still holds at the instant it ends, so this probe is unjudged' };

/** @returns {TransitionRow[]} */
function holdRows() {
  const out = [];
  const refusals = /** @type {const} */ ([['billing', 'bill', 'billed', SENTENCES.billing], ['entitled', 'ent', 'denied1', SENTENCES.denied], ['refused', 'err', 'error', SENTENCES.refused]]);
  for (const [event, tag, to, docs] of refusals) {
    out.push(row(`free-${tag}`, 'hold', 'free', event, { advisor: false }, `goes to ${to}; the request fails over`, docs));
    out.push(row(`free-${tag}-adv`, 'hold', 'free', event, { advisor: true }, 'the failover stays off an account capped on the advisor family', SENTENCES.advisorCap));
  }
  out.push(row('free-ok', 'hold', 'free', 'success', null, 'stays free and in rotation', SENTENCES.stays));
  for (const [state, n] of /** @type {const} */ ([['billed', 0], ['denied1', 1], ['denied2', 2], ['denied3', 3]])) {
    const docs = n ? SENTENCES.denied : SENTENCES.billing;
    const tag = n ? `den${n}` : 'bill';
    out.push(row(`${tag}-end-1`, 'hold', state, 'request@end-1ms', null, 'still held', docs));
    out.push(row(`${tag}-end`, 'hold', state, 'request@end', null, 'unjudged', EDGE));
    out.push(row(`${tag}-end+1`, 'hold', state, 'request@end+1ms', null, n ? `released${n}: back in rotation` : 'free: the account is retried',
      n ? SENTENCES.expires : SENTENCES.retry));
    if (n) out.push(row(`${tag}-late`, 'hold', state, 'entitled-in-flight', null, 'not counted: the cooldown keeps its end', SENTENCES.flight));
  }
  for (const n of [1, 2, 3]) {
    const next = Math.min(n + 1, 3);
    out.push(row(`rel${n}-ent`, 'hold', `released${n}`, 'entitled', null, `denied${next}: held ${['', '5 min', '15 min', '1 h'][next]}`, SENTENCES.expires));
    out.push(row(`rel${n}-ok`, 'hold', `released${n}`, 'success', null, 'free: the next denial holds 5 min', SENTENCES.clears));
  }
  out.push(row('err-req', 'hold', 'error', 'request', null, 'kept out of rotation', SENTENCES.error));
  for (const [state, tag, stays] of /** @type {const} */ ([['free', 'free', 'stays free'], ['billed', 'bill', 'held to the same end'],
    ['denied1', 'den1', 'held to the same end'], ['released1', 'rel1', 'in rotation, its denials still counted'],
    ['released2', 'rel2', 'in rotation, its denials still counted'], ['released3', 'rel3', 'in rotation, its denials still counted'],
    ['error', 'err', 'stays in error']])) {
    out.push(row(`${tag}-rmo`, 'hold', state, 'remove-other', null, stays, OTHERS));
    out.push(row(`${tag}-rms`, 'hold', state, 'remove-self', null, 'no request goes to it again', SENTENCES.dropped));
  }
  return out;
}

/** @returns {TransitionRow[]} */
function removalRows() {
  const out = [];
  const stays = (/** @type {string} */ what) => ({ inferred: `no docs line covers renumbering; the ${what} names the same account, as docs/routing.md:19 keeps the current one` });
  /** @type {Array<[string, string, string, Cite, Cite]>} */
  const pointers = [
    ['cursor', 'cursor', 'moves to an account still in the fleet', stays('cursor'), SENTENCES.dropped],
    ['route-cursor', 'rcur', 'names no removed account', stays('route cursor'), SENTENCES.dropped],
    ['provider-cursor', 'pcur', 'names no removed account', stays('provider cursor'), SENTENCES.dropped],
    ['route-pin', 'rpin', 'cleared, not handed to the account in its slot',
      { inferred: 'no docs line covers renumbering; a TUI route pin (docs/routing.md:228) stays on the account picked' },
      { inferred: 'a pin on an account dropped from the fleet (docs/accounts.md:156) pins nothing' }],
    ['session-pin', 'spin', 'deleted', stays('conversation pin'), SENTENCES.pinsDeleted],
    ['quota-reading', 'quota', "the in-flight response's reading lands on no account",
      { inferred: 'readings come off the responses each account serves (docs/quota.md:7), so they stay with it' },
      { inferred: 'readings come off the responses each account serves (docs/quota.md:7), so no other account takes one' }],
    ['rollover-reading', 'roll', 'unjudged', SENTENCES.roll,
      { inferred: 'docs/routing.md:417 lists the first placements whose roll goes undetected and does not name a cursor a removal moved' }],
  ];
  for (const [state, tag, atExpect, otherDocs, atDocs] of pointers) {
    const other = state === 'rollover-reading' ? 'a roll of its account still moves the cursor off it'
      : state === 'quota-reading' ? 'its readings stay with it' : 'names the same account';
    out.push(row(`${tag}-below`, 'removal', state, 'remove-below', null, other, otherDocs));
    out.push(row(`${tag}-at`, 'removal', state, 'remove-at', null, atExpect, atDocs));
    out.push(row(`${tag}-above`, 'removal', state, 'remove-above', null, other, otherDocs));
  }
  // A reading resting on a preemption's destination, holding the roll it left,
  // as the cursor's and as a conversation's.
  const back = 'traffic that returns to the rolled account is moved off it again';
  out.push(row('held-at', 'removal', 'held-roll', 'remove-at', null, back, SENTENCES.returns));
  out.push(row('pheld-at', 'removal', 'pin-held-roll', 'remove-at', null, back, SENTENCES.returns));
  return out;
}

/** Every row of both machines. @type {TransitionRow[]} */
export const TRANSITIONS = [...holdRows(), ...removalRows()];

/** Whether the play keys `taken` include a step of `r`. @param {Set<string>} taken @param {TransitionRow} r */
export function takes(taken, r) {
  const key = `${r.machine}|${r.state}|${r.event}|`;
  return [...taken].some(k => k.startsWith(key) && (r.shape == null || k.endsWith(r.shape.advisor ? 'advisor' : 'plain')));
}

/**
 * The histories that take every reachable row, each by a short path from a
 * fresh pool. Where a path probes a deadline, no account but the held one can
 * serve, so a request there is served only if that hold has ended.
 * @param {number} start @returns {Array<import('./routing-model.js').History & { name: string }>}
 */
export function transitionPaths(start) {
  const acct = (/** @type {string} */ id, /** @type {number} */ r7d, /** @type {object} */ more = {}) => ({
    id, priority: 0, org: 'org-1', maxUsage: /** @type {any} */ (null), endsAt: null, hidden7d: false, clockless7d: false, clocklessF: false,
    u5h: 0.1, r5h: start + 4 * H, u7d: 0.2, r7d: start + r7d, F: 0.1, FR: start + 150 * H, ...more,
  });
  /** @param {string} name @param {any[]} accounts @param {Array<[number, string, object?]>} steps */
  const path = (name, accounts, steps) => ({
    name, seed: 0, start, fableRoute: null, accounts, routeTables: { first: [], next: [] },
    steps: steps.map(([at, op, more], k) => ({ at: start + at, op, c: `c${k % 3}`, model: OPUS, ...more })),
  });
  const refuse = (/** @type {string} */ kind, more = {}) => /** @type {[string, object]} */ (['fault', { kind, ...more }]);
  const out = [];
  const [bill, d1, d2, d3] = [DEADLINES.billed, DEADLINES.denied1, DEADLINES.denied2, DEADLINES.denied3];
  // A request 1 ms before `end` and `last` 1 ms after; the instant `end` is
  // probed by a path of its own.
  const probes = (/** @type {number} */ end, last = /** @type {[string, object?]} */ (['request'])) =>
    /** @type {Array<[number, string, object?]>} */ ([[end - 1, 'request'], [end + 1, ...last]]);
  out.push(path('billing', [acct('a', 50 * H)], [[MIN, ...refuse('billing')], ...probes(MIN + bill)]));
  // Two billing holds a minute apart, each to its own end: the first account
  // is refused once its hold ends, so only the second could take the rest.
  out.push(path('billing-two', [acct('a', 50 * H), acct('b', 60 * H)], [
    [MIN, ...refuse('billing')], [2 * MIN, ...refuse('billing')], ...probes(MIN + bill, refuse('refused')), ...probes(2 * MIN + bill),
  ]));
  // A failover that meets the other account inside its entitlement or error hold.
  for (const kind of ['entitled', 'refused']) {
    out.push(path(`failover-meets-${kind}`, [acct('a', 50 * H), acct('b', 60 * H)], [[MIN, ...refuse(kind)], [2 * MIN, ...refuse('billing')]]));
  }
  // Each denial past a cooldown's end lengthens the next, and a request in
  // flight before it is not counted; a completion then restarts the ladder.
  const e1 = MIN + d1 + 1; const e2 = e1 + d2 + 1; const e3 = e2 + d3 + 1; const e4 = e3 + d3 + 1;
  const ent = refuse('entitled');
  const late = (/** @type {number} */ at) => /** @type {[number, string, object]} */ ([at, 'late', { who: 'denied' }]);
  out.push(path('entitlement', [acct('a', 50 * H)], [
    [MIN, ...ent], late(2 * MIN), ...probes(MIN + d1, ent), late(e1 + MIN), ...probes(e1 + d2, ent), late(e2 + MIN),
    ...probes(e2 + d3, ent), ...probes(e3 + d3), [e4 + MIN, ...ent], ...probes(e4 + MIN + d1),
  ]));
  out.push(path('entitlement-cleared', [acct('a', 50 * H)], [
    [MIN, ...ent], ...probes(MIN + d1, ent), [e1 + d2 + 1, 'request'], [e1 + d2 + MIN, ...ent], ...probes(e1 + d2 + MIN + d1),
  ]));
  // The end of each timed state, probed on its own: a request served there
  // would take the account out of the ladder.
  out.push(path('billing-end', [acct('a', 50 * H)], [[MIN, ...refuse('billing')], [MIN + bill, 'request']]));
  out.push(path('entitlement-end', [acct('a', 50 * H)], [[MIN, ...ent], [MIN + d1, 'request']]));
  out.push(path('entitlement-end2', [acct('a', 50 * H)], [[MIN, ...ent], [e1, ...ent], [e1 + d2, 'request']]));
  out.push(path('entitlement-end3', [acct('a', 50 * H)], [[MIN, ...ent], [e1, ...ent], [e2, ...ent], [e2 + d3, 'request']]));
  out.push(path('error', [acct('a', 50 * H)], [[MIN, ...refuse('refused')], [2 * MIN, 'request'], [8 * MIN, 'request']]));
  // `x` resets soonest and takes the advised request; `c`, next, is at its
  // Fable cap, so the failover goes to `e`. With `x` billed, `e`'s denial
  // fails over to `c`, the only account left.
  const pool3 = () => [acct('x', 20 * H), acct('c', 30 * H, { maxUsage: { unified7dFable: 0.5 }, F: 0.6 }), acct('e', 100 * H)];
  const advised = { advisor: FABLE };
  for (const kind of ['billing', 'entitled', 'refused']) {
    out.push(path(`failover-${kind}`, pool3(), [[MIN, ...refuse(kind, advised)], [2 * MIN, 'request', advised],
      ...(kind === 'billing' ? /** @type {Array<[number, string, object]>} */ ([[3 * MIN, ...refuse('entitled', advised)]]) : [])]));
  }
  // A hold kept, or its account removed, across a removal.
  for (const [kind, state, end] of /** @type {const} */ ([['billing', 'billed', bill], ['entitled', 'denied', d1], ['refused', 'error', 2 * MIN]])) {
    const pool = () => [acct('a', 50 * H), acct('b', 60 * H)];
    out.push(path(`removal-keeps-${kind}`, pool(), [[MIN, ...refuse(kind)], [MIN + 1000, 'remove', { who: 'free' }], ...probes(MIN + end)]));
    out.push(path(`removal-of-${kind}`, pool(), [[MIN, ...refuse(kind)], [MIN + 1000, 'remove', { who: state }], [MIN + end + 1, 'request']]));
  }
  // A removal while `a` is past its n-th cooldown with its denials still
  // counted. `b` ranks below `a`, so each request after a cooldown goes back
  // to `a` and its denial climbs the ladder. Once `b` is removed, a's next
  // denial has no account to fail over to, so nothing clears the count, and
  // its cooldown is the rung after the n-th.
  for (const [n, end, next] of /** @type {const} */ ([[1, MIN + d1, d2], [2, e1 + d2, d3], [3, e2 + d3, d3]])) {
    const ladder = /** @type {Array<[number, string, object]>} */ ([[MIN, ...ent], [e1, ...ent], [e2, ...ent]].slice(0, n));
    const pool = () => [acct('a', 50 * H), acct('b', 60 * H, { priority: 1 })];
    out.push(path(`removal-keeps-released${n}`, pool(), [...ladder, [end + 1000, 'remove', { id: 'b' }], [end + 2000, ...ent], ...probes(end + 2000 + next)]));
    out.push(path(`removal-of-released${n}`, pool(), [...ladder, [end + 1000, 'remove', { id: 'a' }], [end + 2000, 'request']]));
  }
  // `b` resets soonest, so far ahead of the others that it alone is in the
  // band, and a roll puts it outside the band.
  const lead = () => [acct('a', 40 * H), acct('b', 5 * H), acct('c', 25 * H)];
  const c0 = { c: 'c0' };
  // A removal renumbers the reading on `b` before its window rolls.
  out.push(path('removal-under-rolled', lead(), [
    [MIN, 'request', c0], [2 * MIN, 'request', c0], [3 * MIN, 'remove', { id: 'a' }], [4 * MIN, 'roll', { id: 'b' }], [5 * MIN, 'request', c0],
  ]));
  // `b` rolls and its traffic is preempted to `c`, the only other account in
  // service, and rests there before `c` is removed, so the reading there still
  // holds the roll. The traffic goes back to `b` and leaves it once `a` is
  // back in service.
  out.push(path('removal-of-destination', lead(), [
    [1000, 'fault', { kind: 'disable', id: 'a' }], [MIN, 'request', c0], [2 * MIN, 'request', c0], [3 * MIN, 'roll', { id: 'b' }],
    [4 * MIN, 'request', c0], [5 * MIN, 'request', c0], [6 * MIN, 'remove', { id: 'c' }], [7 * MIN, 'request', c0],
    [8 * MIN, 'fault', { kind: 'disable', id: 'a' }], [9 * MIN, 'request', c0],
  ]));
  // `b` resets soonest and takes the traffic, so every pointer names it
  // before one account is removed below it, at it or above it. Its window
  // then rolls.
  for (const where of ['remove-below', 'remove-at', 'remove-above']) {
    const who = { 'remove-below': 'under-cursor', 'remove-at': 'cursor', 'remove-above': 'over-cursor' }[where];
    out.push(path(`removal-${where}`, [acct('a', 60 * H), acct('b', 20 * H), acct('c', 70 * H)], [
      [MIN, 'request'], [2 * MIN, 'request', { model: FABLE }], [3 * MIN, 'request', advised],
      [4 * MIN, 'remove', { who, pin: where }], [5 * MIN, 'request'], [6 * MIN, 'request', { model: FABLE }],
      [7 * MIN, 'roll', { who: 'cursor' }], [8 * MIN, 'request'], [9 * MIN, 'untagged'],
    ]));
  }
  return out;
}
