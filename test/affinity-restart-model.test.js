// Model-based check of affinity persistence: a generated history run
// uninterrupted, against the same history with a save, a fresh manager over
// the accounts in another order and a restore inserted after each of its
// steps. From the restore on, every routing decision must match the
// uninterrupted run's. Two divergences are accepted, each a named predicate
// below and counted per mode. A roll held for a conversation, which the
// snapshot does not keep, is accepted only where the restored daemon keeps the
// conversation on its pin, that pin equals the uninterrupted one, and the
// uninterrupted daemon moves it. The first accepted divergence ends the
// comparison for that restart, since the two runs have then placed something
// differently and everything after depends on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { LOAD_WINDOW_MS } from '../src/session-tracker.js';

const OPUS = 'claude-opus-5';
const SEC = 1000;
const MIN = 60 * SEC;
const H = 60 * MIN;
const WEEK = 7 * 24 * H;
const ON = { enabled: true, preempt: true };
const MODES = [['load', 'load'], ['even', true], ['adaptive', 'adaptive']];
const FIRST_SEED = 1;
const SEEDS = 40;
// Planted moves per mode in the checker's own test.
const PLANTS = 20;
const STEPS = 40;
const CONVERSATIONS = ['c0', 'c1', 'c2'];

// mulberry32: a deterministic stream per seed.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @typedef {{at: number} & ({op: 'request', conversation: string} | {op: 'usage', id: string, used: number} | {op: 'roll', id: string} | {op: 'idle'})} Step */

function generate(seed) {
  const rand = prng(seed);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const ids = ['a', 'b', 'c'].slice(0, seed % 2 ? 3 : 2);
  const start = Date.UTC(2026, 10, 21, 12) + int(0, MIN - 1);
  // Resets off the hour, so two accounts do not tie on every ranking key: an
  // exact tie is broken by config order, which the restart below changes, and
  // this test does not check that documented limit.
  const initial = ids.map(id => ({ id, used: Math.round(rand() * 90) / 100, reset: start + int(2, 160) * H + int(0, H - 1) }));
  /** @type {Step[]} */
  const steps = [];
  let at = start;
  for (let i = 0; i < STEPS; i++) {
    at += int(1, 30) * SEC;
    const r = rand();
    if (r < 0.6) steps.push({ at, op: 'request', conversation: CONVERSATIONS[int(0, CONVERSATIONS.length - 1)] });
    else if (r < 0.7) steps.push({ at, op: 'usage', id: ids[int(0, ids.length - 1)], used: Math.round(rand() * 97) / 100 });
    else if (r < 0.82) steps.push({ at, op: 'roll', id: ids[int(0, ids.length - 1)] });
    else {
      at += rand() < 0.1 ? int(61, 70) * MIN : int(1, 20) * MIN;
      steps.push({ at, op: 'idle' });
    }
  }
  return { ids, start, initial, steps };
}

const rows = (history) => history.ids.map(id =>
  ({ id, name: id, type: 'oauth', accessToken: `synthetic-${id}`, expiresAt: history.start + 30 * 24 * H }));

// One request in the server's order, including the served-stay confirmation.
// `planted` sends it to another account, for the checker's own test.
function serve(am, sessionId, planted = false) {
  const carried = am.observedGeneration(sessionId, OPUS);
  am.beginSession(sessionId);
  let account = am.getActiveAccount(null, OPUS, null, sessionId);
  if (planted && account) account = am.accounts.find(a => a.id !== account.id) ?? account;
  if (account) am.recordSession(sessionId, account.index, OPUS);
  if (account) am.confirmStay(account, carried, sessionId, 'anthropic');
  am.endSession(sessionId);
  return account?.id ?? '-';
}

const loads = (am, now) => Object.fromEntries([...am.accounts].sort((x, y) => x.id.localeCompare(y.id))
  .map(a => [a.id, am.sessionTracker.recentRequestsFor(a.index, now)]));

// The restarted daemon's config lists the accounts in another order, cycling
// through every order as `k` grows, so state restored by position shows.
function reorder(list, k) {
  const n = k % list.length;
  const rotated = [...list.slice(n), ...list.slice(0, n)];
  return Math.floor(k / list.length) % 2 ? rotated.reverse() : rotated;
}

// A roll held for the conversation, or a reading on an account it is not
// pinned to: the snapshot keeps neither, by design.
function holdsUnsaved(am, conversation) {
  const s = am.sessionTracker.sessions.get(conversation);
  if (!s) return false;
  for (const [bucket, ref] of s.refs) {
    if (ref.unescaped != null) return true;
    if (s.pins.get(bucket)?.idx !== ref.idx) return true;
  }
  return false;
}

// Read without pinnedAccount's delete-on-expiry, so recording it before a
// request leaves the run unchanged.
function pinnedId(am, conversation, now) {
  const s = am.sessionTracker.sessions.get(conversation);
  if (!s || am.sessionTracker._isExpired(s, now)) return null;
  const idx = s.pins.get(am._weeklyBucketFor(OPUS))?.idx;
  return am.accounts.find(a => a.index === idx)?.id ?? null;
}

/**
 * @param {ReturnType<typeof generate>} history
 * @param {any} mode
 * @param {number} restoreAfter step index after which to restart, -1 for none
 * @param {(ms: number) => void} setTime
 * @param {{at?: number, window?: Array<[number, string]>, planted?: number}} [replay] at step
 *   `at`, the request window replaced by `window` and the run stopped after it;
 *   at step `planted`, a planted move
 */
function run(history, mode, restoreAfter, setTime, replay = {}) {
  const opts = { distributeSessions: mode, expiryRouting: ON };
  setTime(history.start);
  let am = new AccountManager(rows(history), 0.98, opts);
  for (const { id, used, reset } of history.initial) {
    const account = am.accounts.find(a => a.id === id);
    Object.assign(account.quota, { unified7d: used, unified7dReset: reset });
    account.probing = false;
  }
  const out = { decisions: new Map(), pins: new Map(), loads: new Map(), holds: new Map(), windows: new Map(), routed: /** @type {Array<[number, string]>} */ ([]) };
  for (let i = 0; i < history.steps.length; i++) {
    const step = history.steps[i];
    setTime(step.at);
    const quota = step.op === 'usage' || step.op === 'roll' ? am.accounts.find(a => a.id === step.id).quota : null;
    switch (step.op) {
      case 'request': {
        const tracker = am.sessionTracker;
        if (replay.at === i && replay.window) {
          const indexOf = new Map(am.accounts.map(a => [a.id, a.index]));
          tracker._routed = replay.window.map(([at, id]) => [at, indexOf.get(id)]);
          tracker._routedCounts = new Map();
          for (const [, idx] of tracker._routed) tracker._routedCounts.set(idx, (tracker._routedCounts.get(idx) || 0) + 1);
        }
        out.loads.set(i, loads(am, step.at));
        out.pins.set(i, pinnedId(am, step.conversation, step.at));
        const idOf = new Map(am.accounts.map(a => [a.index, a.id]));
        out.windows.set(i, tracker._routed.map(([at, idx]) => [at, idOf.get(idx)]));
        const id = serve(am, step.conversation, replay.planted === i);
        out.decisions.set(i, id);
        if (id !== '-') out.routed.push([step.at, id]);
        break;
      }
      case 'usage': quota.unified7d = step.used; break;
      case 'roll': quota.unified7d = 0; quota.unified7dReset += WEEK; break;
      case 'idle': break;
      default: throw new Error(`unknown step ${JSON.stringify(step)}`);
    }
    if (restoreAfter < 0) out.holds.set(i, new Set(CONVERSATIONS.filter(c => holdsUnsaved(am, c))));
    if (i === restoreAfter) {
      const saved = JSON.parse(JSON.stringify({ quota: am.exportQuotaState(), affinity: am.exportAffinityState() }));
      am = new AccountManager(reorder(rows(history), restoreAfter), 0.98, opts);
      am.restoreQuotaState(saved.quota);
      am.restoreAffinityState(saved.affinity);
    }
    if (replay.at === i) break;
  }
  return out;
}

// Restored requests are stamped at the end of their minute, so at a decision
// the restored daemon may still count, on each account, exactly the requests
// routed before the restart that the uninterrupted window has let go of but
// whose minute has not ended inside it. That excess explains a different
// decision only if the restored run, replayed with the uninterrupted window
// put in just before the request, gives the uninterrupted decision: a
// comparison of counts alone also accepts a move the window did not cause.
function windowExplains(history, mode, k, i, u, setTime, planted) {
  return run(history, mode, k, setTime, { at: i, window: u.windows.get(i), planted }).decisions.get(i) === u.decisions.get(i);
}

function minuteEdge(routed, restoredAt, now, uLoads, rLoads) {
  const cutoff = now - LOAD_WINDOW_MS;
  let differs = false;
  for (const id of Object.keys(uLoads)) {
    const edge = routed.filter(([at, to]) => to === id && at <= restoredAt && at >= restoredAt - LOAD_WINDOW_MS
      && at < cutoff && Math.min(Math.floor(at / MIN) * MIN + MIN - 1, restoredAt) >= cutoff).length;
    const diff = rLoads[id] - uLoads[id];
    if (diff !== 0 && diff !== edge) return false;
    if (diff !== 0) differs = true;
  }
  return differs;
}

/**
 * Compares one restarted run with the uninterrupted one up to the first
 * decision that differs, and names what explains it, if anything.
 * @param {number} [planted] the step a move was planted at in `r`, which its replay plants too
 * @returns {{kind: 'match'|'minuteEdge'|'unsavedHold'|'unexplained', detail?: string, windowOnly?: string}}
 */
function compare(history, mode, name, seed, k, u, r, setTime, count, planted) {
  const restoredAt = history.steps[k].at;
  let windowOnly;
  for (let i = k + 1; i < history.steps.length; i++) {
    if (!u.decisions.has(i)) continue;
    const step = history.steps[i];
    const uLoads = u.loads.get(i);
    const rLoads = r.loads.get(i);
    const loadsMatch = JSON.stringify(uLoads) === JSON.stringify(rLoads);
    const decisionMatch = u.decisions.get(i) === r.decisions.get(i);
    if (loadsMatch && decisionMatch) { count.decisions++; continue; }
    const where = `${name} seed ${seed} restore after step ${k}, step ${i} (${step.conversation})`;
    const detail = `${where}: uninterrupted ${u.decisions.get(i)} loads ${JSON.stringify(uLoads)}, restored ${r.decisions.get(i)} loads ${JSON.stringify(rLoads)}`;
    const edge = !loadsMatch && minuteEdge(u.routed, restoredAt, step.at, uLoads, rLoads);
    if (!decisionMatch) {
      const pin = r.pins.get(i);
      if (edge && windowExplains(history, mode, k, i, u, setTime, planted)) {
        count.minuteEdge++;
        return { kind: 'minuteEdge', windowOnly };
      }
      // A hold explains a decision whether the windows match or differ only by
      // the minute edge, and still only one that keeps the restored pin.
      if ((loadsMatch || edge) && u.holds.get(k).has(step.conversation)) {
        if (pin != null && pin === u.pins.get(i) && r.decisions.get(i) === pin && u.decisions.get(i) !== '-') {
          count.unsavedHold++;
          return { kind: 'unsavedHold', windowOnly };
        }
        return { kind: 'unexplained', windowOnly, detail: `${detail}: an unsaved hold that does not keep the restored conversation on its pin (restored pin ${pin ?? 'none'}, uninterrupted pin ${u.pins.get(i) ?? 'none'})` };
      }
      return { kind: 'unexplained', windowOnly, detail: edge ? `${detail}: a minute-edge divergence the uninterrupted window does not undo` : detail };
    }
    count.decisions++;
    // A window the minute bucket explains, at a decision it did not change.
    if (edge) count.minuteEdgeWindows++;
    if (!loadsMatch && !edge && !windowOnly) windowOnly = detail;
  }
  return { kind: 'match', windowOnly };
}

test('every decision after a restore matches the uninterrupted daemon, in load, even and adaptive mode', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const setTime = ms => t.mock.timers.setTime(ms);
  const failures = [];
  // A window that differs where no decision did is still wrong: the next
  // decision that reads it can differ.
  const loadOnly = [];
  /** @type {Record<string, {restarts: number, decisions: number, moves: number, minuteEdge: number, minuteEdgeWindows: number, unsavedHold: number}>} */
  const tally = {};
  for (const [name, mode] of MODES) {
    const count = tally[name] = { restarts: 0, decisions: 0, moves: 0, minuteEdge: 0, minuteEdgeWindows: 0, unsavedHold: 0 };
    for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
      const history = generate(seed);
      const u = run(history, mode, -1, setTime);
      // How often the uninterrupted run moves a conversation it had placed, so
      // a history that never moves anything shows as such.
      const last = new Map();
      for (const [i, id] of u.decisions) {
        const c = history.steps[i].conversation;
        if (last.has(c) && last.get(c) !== id) count.moves++;
        last.set(c, id);
      }
      for (let k = 0; k < history.steps.length - 1; k++) {
        const r = run(history, mode, k, setTime);
        count.restarts++;
        const result = compare(history, mode, name, seed, k, u, r, setTime, count);
        if (result.kind === 'unexplained') failures.push(result.detail);
        if (result.windowOnly) loadOnly.push(result.windowOnly);
      }
    }
  }
  t.diagnostic(`allowed divergences per mode: ${JSON.stringify(tally)}`);
  const perMode = list => Object.fromEntries(MODES.map(([name]) => [name, list.filter(f => f.startsWith(`${name} `)).length]));
  t.diagnostic(`unexplained: decisions ${JSON.stringify(perMode(failures))}, windows only ${JSON.stringify(perMode(loadOnly))}`);
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} decisions diverge unexplained`);
  assert.deepEqual(loadOnly.slice(0, 5), [], `${loadOnly.length} restored windows diverge unexplained`);
  for (const [name] of MODES) assert.ok(tally[name].moves > 0, `${name}: no history moved a conversation`);
});

// The checker's own test: a move planted inside the restored daemon, at a
// request whose window differs from the uninterrupted one only by the minute
// edge and where the uninterrupted daemon keeps the conversation on its pin,
// is never accepted as either allowed divergence.
test('a wrong-way move planted at a minute-edge window is reported as unexplained, in every mode', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const setTime = ms => t.mock.timers.setTime(ms);
  const scratch = { decisions: 0, minuteEdge: 0, minuteEdgeWindows: 0, unsavedHold: 0 };
  const accepted = [];
  /** @type {Record<string, {planted: number, accepted: number}>} */
  const tally = {};
  for (const [name, mode] of MODES) {
    const count = tally[name] = { planted: 0, accepted: 0 };
    for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS && count.planted < PLANTS; seed++) {
      const history = generate(seed);
      const u = run(history, mode, -1, setTime);
      for (let k = 0; k < history.steps.length - 1 && count.planted < PLANTS; k++) {
        const r = run(history, mode, k, setTime);
        const restoredAt = history.steps[k].at;
        const at = [...u.decisions.keys()].find(i => i > k && u.decisions.get(i) !== '-'
          && u.pins.get(i) === u.decisions.get(i) && r.pins.get(i) === u.decisions.get(i) && r.decisions.get(i) === u.decisions.get(i)
          && minuteEdge(u.routed, restoredAt, history.steps[i].at, u.loads.get(i), r.loads.get(i)));
        if (at == null || [...u.decisions.keys()].some(i => i > k && i < at && r.decisions.get(i) !== u.decisions.get(i))) continue;
        count.planted++;
        const moved = run(history, mode, k, setTime, { planted: at });
        const result = compare(history, mode, name, seed, k, u, moved, setTime, scratch, at);
        if (result.kind !== 'unexplained') {
          count.accepted++;
          accepted.push(`${name} seed ${seed} restore after step ${k}: a move planted at step ${at} was accepted as ${result.kind}`);
        }
      }
    }
  }
  t.diagnostic(`planted wrong-way moves per mode: ${JSON.stringify(tally)}`);
  assert.deepEqual(accepted.slice(0, 10), [], `${accepted.length} planted moves accepted`);
  for (const [name] of MODES) assert.ok(tally[name].planted > 0, `${name}: no minute-edge window to plant a move at`);
});
