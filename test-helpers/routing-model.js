// A seeded model of account routing, for test/routing-config-model.test.js.
//
// A history is a pool of synthetic accounts and a list of timed steps. The
// driver plays it through AccountManager's public API in the order the server
// calls it, and keeps its own record of what the manager has been told (`fed`)
// and of each conversation, so that the invariants can be judged against an
// independent reading of docs/routing.md rather than against the code under
// test.

export const SEC = 1000;
export const MIN = 60 * SEC;
export const H = 60 * MIN;
export const WEEK = 7 * 24 * H;
export const OPUS = 'claude-opus-5';
export const FABLE = 'claude-fable-5';
// session-tracker.js SESSION_KNOWN_TTL_MS, SESSION_ACTIVE_TTL_MS, LOAD_WINDOW_MS.
export const KNOWN_TTL = H;
export const ACTIVE_TTL = 2 * MIN;
export const LOAD_WINDOW = 10 * MIN;
// rollover.js ROLLOVER_MIN_JUMP_MS.
export const ROLL_JUMP = H;
export const SOONER_MARGIN = MIN;
const STEPS = 40;
// More concurrent requests than any ramp in RAMPS admits at a switch.
export const BURST = 8;
// The share of random Opus requests that declare a Fable advisor, in the rows
// that send one.
const ADVISED_RATE = 0.4;
const EPISODE_RATE = 0.35;
const ROLL_EPISODE_RATE = 0.3;
const SERVE_BURN = 0.004;
const SERVE_BURN_5H = 0.02;
// server.js RATE_LIMIT_ABSORB_MAX_SECONDS, which caps a per-minute 429's pause.
const RATE_LIMIT_ABSORB_MAX = 60;
// Past that cap, so a 429 with nowhere to hop goes back to the client at once
// rather than waiting to retry the same account.
const RETRY_AFTER = 90;
// docs/routing.md:70-71.
const BILLING_COOLDOWN = 5 * MIN;
// docs/routing.md:88; the last applies to every later denial.
const ENTITLEMENT_COOLDOWNS = [5 * MIN, 15 * MIN, H];
// The probes of a cooldown's end, by their offset from it in ms.
const PROBE_AT = new Map([[-1, 'end-1ms'], [0, 'end'], [1, 'end+1ms']]);
const DENIAL = 'OAuth authentication is currently not allowed for this organization.';
const LETTERS = 'abcdef';
// An account name a route may list that no account in the pool has.
const GONE = 'gone';

/**
 * @typedef {{ id: string, priority: number, org: string|null, maxUsage: any, endsAt: number|null,
 *   hidden7d: boolean, clockless7d: boolean, clocklessF: boolean,
 *   u5h: number, r5h: number, u7d: number, r7d: number, F: number|null, FR: number|null }} PoolAccount
 * A `throttle` step is a request whose first attempt draws a per-minute 429.
 * A `fault` step that names a conversation instead of an account is a request
 * whose first attempt draws the refusal its `kind` names: `billing`,
 * `entitled` (an OAuth entitlement denial) or `refused` (an account refusal).
 * A `remove` step removes its account from the fleet while a response that
 * account served is still in flight; `pin` places an operator's route pin
 * against it, as a removal machine event names the place. A `late` step is an
 * entitlement denial to a request sent before the account's last one. `who`
 * names a step's account by what the play has made of it: `cursor`, the
 * accounts on either side of it (`under-cursor`, `over-cursor`), or the first
 * account in the hold state it names.
 * @typedef {{ at: number, op: string, c?: string, model?: string, id?: string, u7d?: number,
 *   f?: number|null, u5h?: number, fable?: boolean, kind?: string, restart?: boolean, reload?: boolean,
 *   advisor?: string, who?: string, pin?: string }} Step
 * `events` counts the steps before the closing episodes.
 * @typedef {{ name: string, match: string[], accounts?: string[] }} Route
 * `routeTables` is what the rows with several routes configure: `first` from
 * the start, `next` after the step marked `reload`.
 * @typedef {{ seed: number, start: number, accounts: PoolAccount[], fableRoute: string[]|null, steps: Step[], events?: number,
 *   routeTables?: { first: Route[], next: Route[] } }} History
 * @typedef {{ name: string, dist: string, expiry: any, soonest: boolean, sessionReset: boolean,
 *   persist: boolean, threshold: any, [option: string]: any }} Row
 */

/** mulberry32, so a seed gives the same sequence on every Node version.
 * @param {number} seed */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (/** @type {number} */ x) => Math.round(x * 100) / 100;
const r3 = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;

/** @param {number} seed @returns {History} */
export function generate(seed) {
  const rand = prng(seed);
  const int = (/** @type {number} */ lo, /** @type {number} */ hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const n = int(2, 6);
  // Whole seconds, as a reset header carries them.
  const start = Date.UTC(2030, 2, 10, 12) + int(0, 59) * SEC;
  const lowerTier = n > 2 && rand() < 0.3;
  const orgShape = int(0, 2); // one org, two orgs, one org with an account of unknown org
  /** @type {PoolAccount[]} */
  const accounts = [];
  for (let i = 0; i < n; i++) {
    let maxUsage = null;
    if (rand() < 0.3) {
      const form = int(0, 3);
      const c = r2(0.4 + rand() * 0.5);
      maxUsage = form === 0 ? c
        : form === 1 ? { unified7d: c }
          : form === 2 ? { unified7d: c, unified7dFable: r2(0.4 + rand() * 0.5) }
            : { unified5h: r2(0.5 + rand() * 0.4) };
    }
    const hasFable = rand() < 0.5;
    accounts.push({
      id: LETTERS[i],
      priority: lowerTier && i === n - 1 ? 10 : 0,
      org: orgShape === 0 ? 'org-1' : orgShape === 1 ? (i % 2 ? 'org-2' : 'org-1') : (i === 0 ? null : 'org-1'),
      maxUsage,
      endsAt: rand() < 0.15 ? start + int(1, 100) * H : null,
      hidden7d: rand() < 0.15,
      clockless7d: rand() < 0.12,
      clocklessF: rand() < 0.15,
      u5h: r2(rand() * 0.9), r5h: start + int(0, 240) * MIN + int(0, 59) * SEC,
      u7d: r2(rand() * 0.9), r7d: start + int(2, 160) * H + int(0, 3599) * SEC,
      F: hasFable ? r2(rand() * 0.9) : null, FR: hasFable ? start + int(2, 160) * H + int(0, 3599) * SEC : null,
    });
  }
  const fableRoute = rand() < 0.25 ? accounts.filter((_, i) => i === 0 || rand() < 0.5).map(a => a.id) : null;
  const convs = ['c0', 'c1', 'c2', 'c3', 'c4'].slice(0, int(3, 5));
  /** @type {Step[]} */
  const steps = [];
  let at = start;
  const pick = () => LETTERS[int(0, n - 1)];
  const model = () => (rand() < 0.7 ? OPUS : FABLE);
  // A higher tier coming back while work sits on a lower one is what priority
  // preemption is for, and random readings almost never produce it. Some
  // histories get that episode inserted, drawn from a stream of its own so
  // that it takes no draws from the other events.
  const extra = prng(seed ^ 0x2545f491);
  const episodeAt = n > 2 && extra() < EPISODE_RATE ? Math.floor(extra() * STEPS) : -1;
  if (episodeAt >= 0) accounts[n - 1].priority = 10;
  // Likewise a pin whose window rolls while pressure and burndown disagree
  // about whether it should move. It opens the history, because the
  // differential that judges it can only read a decision taken before the two
  // scorings first place a conversation apart.
  const extra2 = prng(seed ^ 0x6c8e9cf5);
  // Which requests declare an advisor, from a stream of its own, so that the
  // rows that send none play the same history.
  const advised = prng(seed ^ 0x2f2b8a17);
  const rollAt = extra2() < ROLL_EPISODE_RATE ? 0 : -1;
  for (let i = 0; i < STEPS; i++) {
    if (i === episodeAt) at = priorityEpisode(steps, accounts, convs, at, extra);
    if (i === rollAt) at = rollEpisode(steps, accounts, convs, at, extra2);
    at += int(1, 30) * SEC;
    const r = rand();
    if (r < 0.5) {
      /** @type {Step} */
      const s = { at, op: 'request', c: convs[int(0, convs.length - 1)], model: model() };
      if (s.model === OPUS && advised() < ADVISED_RATE) s.advisor = FABLE;
      steps.push(s);
    }
    else if (r < 0.56) steps.push({ at, op: 'untagged', model: model() });
    else if (r < 0.66) steps.push({ at, op: 'usage', id: pick(), u7d: r2(rand() * 0.99), f: rand() < 0.5 ? r2(rand() * 0.99) : null });
    else if (r < 0.72) steps.push({ at, op: 'five', id: pick(), u5h: r2(0.6 + rand() * 0.39) });
    else if (r < 0.8) steps.push({ at, op: 'roll', id: pick(), fable: rand() < 0.35 });
    else if (r < 0.93) {
      // Long enough sometimes to cross a 5-hour reset or the one-hour known window.
      const u = rand();
      at += u < 0.12 ? int(61, 70) * MIN : u < 0.2 ? int(100, 300) * MIN : int(1, 20) * MIN;
      steps.push({ at, op: 'idle' });
    } else steps.push({ at, op: 'fault', id: pick(), kind: rand() < 0.6 ? 'disable' : 'cordon' });
  }
  // The closing episodes follow the random events, so that they change none
  // of them. A session-reset switch needs an account whose 5h window resets
  // while another is the cursor, both cleared of the re-rank flag, and
  // random events almost never line that up.
  const events = steps.length;
  throttleEpisode(steps, convs, prng(seed ^ 0x7feb352d));
  sessionResetEpisode(steps, accounts, convs, prng(seed ^ 0x1b873593));
  advisorCapEpisode(steps, accounts, convs, prng(seed ^ 0x4cf5ad43));
  returnEpisode(steps, accounts, convs, prng(seed ^ 0x1d872b41));
  const extra3 = prng(seed ^ 0x3c6ef372);
  const shape = Math.floor(extra3() * 3);
  const routeTables = { first: routeTable(accounts, extra3, shape), next: routeTable(accounts, extra3, (shape + 1 + Math.floor(extra3() * 2)) % 3) };
  steps[Math.floor(extra3() * (events - 1))].reload = true;
  return { seed, start, accounts, fableRoute, steps, events, routeTables };
}

/** One route table of several routes over the pool, in one of three shapes
 * docs/routing.md 'Model routes' describes: a Fable route ahead of a broader
 * route that matches Fable as well, so the first one decides; a first route
 * that lists no accounts ahead of a route that would restrict the same model;
 * and a Fable route ahead of one that matches no request model. No
 * route matches the Opus model, so the bulk of the traffic is unrestricted and
 * judged as in the other rows. The listed sets are disjoint, and a route that
 * must decide nothing lists only an account the pool does not have, so a
 * request held to the wrong route's list lands where the deciding route bars
 * it, or nowhere.
 * @param {PoolAccount[]} accounts @param {() => number} rand @param {number} shape
 * @returns {Route[]} */
function routeTable(accounts, rand, shape) {
  const ids = accounts.map(a => a.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const cut = 1 + Math.floor(rand() * (ids.length - 1));
  const one = ids.slice(0, cut); const two = ids.slice(cut);
  // Matching each glob against the request's model on every availability
  // check is most of these rows' cost, so the tables hold no more globs
  // than the rules need. A route matching nothing leads two of the shapes,
  // so that the deciding route is not the first.
  const idle = { name: 'idle', match: ['*sonnet*'], accounts: [GONE] };
  if (shape === 0) return [idle, { name: 'fable', match: ['claude-fable-*'], accounts: one }, { name: 'claude', match: ['*fable*'], accounts: two }];
  if (shape === 1) return [idle, { name: 'open', match: ['*fable*'] }, { name: 'fable', match: ['claude-fable-5'], accounts: [GONE] }];
  return [{ name: 'fable', match: ['*fable*'], accounts: one }, { name: 'old', match: ['claude-opus-4*'], accounts: [GONE] }];
}

/** Appends the throttle episode: two conversations take turns, each drawing a
 * per-minute 429 twice and coming back in between, closer together than a
 * pause lasts, so that a hop meets accounts inside their pause.
 * @param {Step[]} steps @param {string[]} convs @param {() => number} rand */
function throttleEpisode(steps, convs, rand) {
  let at = steps.length ? steps[steps.length - 1].at : 0;
  const x = convs[Math.floor(rand() * convs.length)];
  const others = convs.filter(k => k !== x);
  const y = others[Math.floor(rand() * others.length)];
  for (const [op, c] of /** @type {const} */ ([['throttle', x], ['request', y], ['request', x], ['throttle', y], ['throttle', x], ['request', y], ['request', x]])) {
    at += (2 + Math.floor(rand() * 19)) * SEC;
    steps.push({ at, op, c, model: rand() < 0.7 ? OPUS : FABLE });
  }
}

/** Appends the return episode: a conversation rests on `p` while every other
 * account reads past any threshold, `p`'s weekly window rolls, `x` recovers
 * and takes the conversation off the roll, serves it twice, the second time
 * under the move's stamp, then reads past the threshold itself, the
 * conversation returns to `p`, and `x` recovers while it comes back. Further
 * rolls of `p` are left and returned to before such a serve, so that each is
 * handed back. Random events almost never serve a move's stay and then
 * return, or return twice to one roll. Nothing is appended without two
 * top-priority accounts that have no usage cap and a weekly clock.
 * @param {Step[]} steps @param {PoolAccount[]} accounts @param {string[]} convs
 * @param {() => number} rand */
function returnEpisode(steps, accounts, convs, rand) {
  const top = Math.min(...accounts.map(a => a.priority));
  const pool = accounts.filter(a => a.priority === top && a.maxUsage == null && !a.clockless7d);
  if (pool.length < 2) return;
  const facts = replayFacts(steps, accounts);
  const p = pool[Math.floor(rand() * pool.length)];
  const rest = pool.filter(a => a !== p);
  const x = rest[Math.floor(rand() * rest.length)];
  const c = convs[Math.floor(rand() * convs.length)];
  let at = (steps.length ? steps[steps.length - 1].at : 0) + 20 * MIN;
  steps.push({ at, op: 'idle' });
  const push = (/** @type {Omit<Step, 'at'>} */ s) => { at += (2 + Math.floor(rand() * 9)) * SEC; steps.push({ at, ...s }); };
  for (const a of [p, x]) {
    if (facts.disabled.has(a.id)) push({ op: 'fault', id: a.id, kind: 'disable' });
    if (facts.cordoned.has(a.id)) push({ op: 'fault', id: a.id, kind: 'cordon' });
  }
  for (const a of accounts) if (a !== p) push({ op: 'usage', id: a.id, u7d: 0.99, f: null });
  push({ op: 'usage', id: p.id, u7d: 0.1, f: null });
  push({ op: 'five', id: p.id, u5h: 0.1 });
  push({ op: 'request', c, model: OPUS });
  push({ op: 'request', c, model: OPUS });
  push({ op: 'roll', id: p.id, fable: false });
  push({ op: 'usage', id: x.id, u7d: r2(0.05 + rand() * 0.2), f: null });
  push({ op: 'five', id: x.id, u5h: 0.1 });
  for (let k = 0; k < 3; k++) push({ op: 'request', c, model: OPUS });
  push({ op: 'usage', id: x.id, u7d: 0.99, f: null });
  for (let k = 0; k < 2; k++) push({ op: 'request', c, model: OPUS });
  // With `x` back there is somewhere to go, which a roll still held on `p`
  // would take the conversation to.
  push({ op: 'usage', id: x.id, u7d: r2(0.05 + rand() * 0.2), f: null });
  for (let k = 0; k < 2; k++) push({ op: 'request', c, model: OPUS });
  // A second roll, which the conversation leaves and comes back to before a
  // stay is served under the move's stamp, so the roll is handed back and the
  // conversation moves off it again. A roll is handed back once, so once
  // that second move is served and the conversation returns, it stays.
  push({ op: 'usage', id: x.id, u7d: 0.99, f: null });
  for (let k = 0; k < 2; k++) push({ op: 'request', c, model: OPUS });
  push({ op: 'roll', id: p.id, fable: false });
  push({ op: 'usage', id: x.id, u7d: r2(0.05 + rand() * 0.2), f: null });
  for (let k = 0; k < 2; k++) push({ op: 'request', c, model: OPUS });
  // The conversation moves away to `y` and back, and `x` then serves under a
  // later stamp than the move's, which settles nothing. `x` rolls before the
  // move away, and the reading stays on it under the move's stamp while `y`
  // serves.
  const others = accounts.filter(a => a !== p && a !== x);
  if (others.length) {
    const y = others[Math.floor(rand() * others.length)];
    if (facts.disabled.has(y.id)) push({ op: 'fault', id: y.id, kind: 'disable' });
    if (facts.cordoned.has(y.id)) push({ op: 'fault', id: y.id, kind: 'cordon' });
    push({ op: 'five', id: p.id, u5h: 0.99 });
    push({ op: 'roll', id: x.id, fable: false });
    push({ op: 'usage', id: x.id, u7d: 0.99, f: null });
    push({ op: 'usage', id: y.id, u7d: 0.1, f: null });
    push({ op: 'five', id: y.id, u5h: 0.1 });
    push({ op: 'request', c, model: OPUS });
    push({ op: 'usage', id: x.id, u7d: r2(0.05 + rand() * 0.2), f: null });
    push({ op: 'usage', id: y.id, u7d: 0.99, f: null });
    for (let k = 0; k < 2; k++) push({ op: 'request', c, model: OPUS });
    push({ op: 'five', id: p.id, u5h: 0.1 });
  }
  push({ op: 'usage', id: x.id, u7d: 0.99, f: null });
  push({ op: 'request', c, model: OPUS });
  // Past the load window, so that under load as under even the conversation
  // in flight is all that tells `p` from `x`, and `x` ranks first.
  at += LOAD_WINDOW;
  steps.push({ at, op: 'idle' });
  push({ op: 'usage', id: x.id, u7d: r2(0.05 + rand() * 0.2), f: null });
  for (let k = 0; k < 2; k++) push({ op: 'request', c, model: OPUS });
  push({ op: 'usage', id: x.id, u7d: 0.99, f: null });
  push({ op: 'request', c, model: OPUS });
  push({ op: 'usage', id: x.id, u7d: r2(0.05 + rand() * 0.2), f: null });
  for (let k = 0; k < 2; k++) push({ op: 'request', c, model: OPUS });
  // A third roll, handed back as the second was, after which `p`'s Fable
  // window rolls too. Leaving `p` then holds that new roll in a reading that
  // still has the weekly one. The next return hands the weekly roll back a
  // second time, which G6 counts.
  if (p.F == null || p.clocklessF) return;
  push({ op: 'usage', id: x.id, u7d: 0.99, f: null });
  push({ op: 'usage', id: p.id, u7d: 0.1, f: 0.1 });
  for (let k = 0; k < 2; k++) push({ op: 'request', c, model: OPUS });
  push({ op: 'roll', id: p.id, fable: false });
  for (const fable of [false, true]) {
    push({ op: 'usage', id: x.id, u7d: r2(0.05 + rand() * 0.2), f: null });
    for (let k = 0; k < 2; k++) push({ op: 'request', c, model: OPUS });
    push({ op: 'usage', id: x.id, u7d: 0.99, f: null });
    push({ op: 'request', c, model: OPUS });
    if (fable) break;
    push({ op: 'roll', id: p.id, fable: true });
  }
  push({ op: 'usage', id: x.id, u7d: r2(0.05 + rand() * 0.2), f: null });
  for (let k = 0; k < 2; k++) push({ op: 'request', c, model: OPUS });
}

/** What a played history leaves of the facts the episodes steer by: each
 * account's weekly reset as of the last step, and which accounts the fault
 * steps left disabled or cordoned, by play's rule for a fault.
 * @param {Step[]} steps @param {PoolAccount[]} accounts */
function replayFacts(steps, accounts) {
  const r7d = new Map(accounts.map(a => [a.id, a.r7d]));
  const disabled = new Set(); const cordoned = new Set();
  for (const s of steps) {
    for (const a of accounts) {
      let r = /** @type {number} */ (r7d.get(a.id));
      while (r <= s.at) r += WEEK;
      r7d.set(a.id, r);
    }
    const a = accounts.find(x => x.id === s.id);
    if (!a) continue;
    if (s.op === 'roll' && !(s.fable && a.F != null)) r7d.set(a.id, /** @type {number} */ (r7d.get(a.id)) + WEEK);
    if (s.op === 'fault') {
      const down = accounts.filter(x => disabled.has(x.id) || cordoned.has(x.id)).length;
      const room = down < Math.floor(accounts.length / 2);
      if (s.kind === 'disable' && (disabled.has(a.id) || room)) { if (!disabled.delete(a.id)) disabled.add(a.id); }
      else if (s.kind === 'cordon' && (cordoned.has(a.id) || room)) { if (!cordoned.delete(a.id)) cordoned.add(a.id); }
    }
  }
  return { r7d, disabled, cordoned };
}

/** Appends the advisor-cap episode: a top-tier account with a Fable cap
 * takes the traffic while every other reads past any threshold, its Fable
 * bucket then reaches the cap, the others recover, and advised requests
 * follow. Only that cap keeps them off it, and random readings almost never
 * line it up. Nothing is appended without a top-tier account that has a Fable
 * cap and reading.
 * @param {Step[]} steps @param {PoolAccount[]} accounts @param {string[]} convs
 * @param {() => number} rand */
function advisorCapEpisode(steps, accounts, convs, rand) {
  const top = Math.min(...accounts.map(a => a.priority));
  const pool = accounts.filter(a => a.priority === top && a.F != null && capOf(a.maxUsage, 'unified7dFable') != null);
  if (!pool.length) return;
  const p = pool[Math.floor(rand() * pool.length)];
  const facts = replayFacts(steps, accounts);
  const cap = /** @type {number} */ (capOf(p.maxUsage, 'unified7dFable'));
  const [c, k] = [convs[Math.floor(rand() * convs.length)], convs[Math.floor(rand() * convs.length)]];
  let at = steps.length ? steps[steps.length - 1].at : 0;
  const push = (/** @type {Omit<Step, 'at'>} */ s) => { at += (1 + Math.floor(rand() * 10)) * SEC; steps.push({ at, ...s }); };
  if (facts.disabled.has(p.id)) push({ op: 'fault', id: p.id, kind: 'disable' });
  if (facts.cordoned.has(p.id)) push({ op: 'fault', id: p.id, kind: 'cordon' });
  push({ op: 'usage', id: p.id, u7d: 0.1, f: Math.max(0, r2(cap - 0.2)) });
  push({ op: 'five', id: p.id, u5h: 0.1 });
  for (const a of accounts) if (a !== p) push({ op: 'usage', id: a.id, u7d: 0.99, f: null });
  push({ op: 'request', c, model: OPUS });
  push({ op: 'usage', id: p.id, u7d: 0.1, f: Math.min(0.99, r2(cap + 0.05)) });
  for (const a of accounts) if (a !== p) push({ op: 'usage', id: a.id, u7d: r2(rand() * 0.35), f: null });
  for (const x of [c, k, c]) push({ op: 'request', c: x, model: OPUS, advisor: FABLE });
}

/** The first reset of a window of `period` after `t`, from one at `r`.
 * @param {number} r @param {number} t @param {number} period */
const nextReset = (r, t, period) => (r > t ? r : r + period * (Math.floor((t - r) / period) + 1));

/** Appends the session-reset episode: `p` takes the traffic and serves, `q`
 * takes it from `p` at `p`'s 5h wall and serves, `p`'s 5h window resets, and
 * one more request comes. Three histories in four have `p`'s deadline sooner than
 * `q`'s, so the switch moves the traffic back, and the rest have it later, so the
 * traffic stays. A third account `r`, read only after the reset so that it
 * has none pending, holds a deadline sooner than `q`'s where the pool allows:
 * the switch must not take it. Every other account reads past any threshold
 * throughout. Nothing is appended without two top-tier accounts whose weekly
 * reset is known.
 * @param {Step[]} steps @param {PoolAccount[]} accounts @param {string[]} convs
 * @param {() => number} rand */
function sessionResetEpisode(steps, accounts, convs, rand) {
  const facts = replayFacts(steps, accounts);
  const top = Math.min(...accounts.map(a => a.priority));
  const pool = accounts.filter(a => a.priority === top && !a.clockless7d);
  if (pool.length < 2) return;
  const sooner = rand() < 0.75;
  const c = convs[Math.floor(rand() * convs.length)];
  const t0 = steps.length ? steps[steps.length - 1].at : 0;
  const deadlineAt = (/** @type {PoolAccount} */ a, /** @type {number} */ t) => {
    const r = nextReset(/** @type {number} */ (facts.r7d.get(a.id)), t, WEEK);
    return a.endsAt != null && a.endsAt > t ? Math.min(r, a.endsAt) : r;
  };
  /** @param {PoolAccount} p @param {PoolAccount} q @param {PoolAccount|undefined} r */
  const build = (p, q, r) => {
    /** @type {Step[]} */
    const out = [];
    let at = t0;
    const push = (/** @type {Omit<Step, 'at'>} */ s, gap = 5 * SEC) => { at += gap; out.push({ at, ...s }); };
    const ask = () => push({ op: 'request', c, model: OPUS });
    const recover = (/** @type {PoolAccount} */ a) => {
      push({ op: 'usage', id: a.id, u7d: 0.1, f: null });
      push({ op: 'five', id: a.id, u5h: 0.1 });
    };
    for (const a of [p, q, r]) {
      if (!a) continue;
      if (facts.disabled.has(a.id)) push({ op: 'fault', id: a.id, kind: 'disable' });
      if (facts.cordoned.has(a.id)) push({ op: 'fault', id: a.id, kind: 'cordon' });
    }
    recover(p);
    for (const a of accounts) if (a !== p) push({ op: 'usage', id: a.id, u7d: 0.99, f: null });
    // The first request moves the cursor to `p`, the second spends the re-rank
    // flag its first weekly reading set; the same again for `q`.
    ask(); ask();
    recover(q);
    // Clear of a reset that would land between the wall and the move to `q`.
    if (nextReset(p.r5h, at, 5 * H) - at < 2 * MIN) push({ op: 'idle' }, nextReset(p.r5h, at, 5 * H) - at + SEC);
    push({ op: 'five', id: p.id, u5h: 0.99 });
    const wall = nextReset(p.r5h, at, 5 * H);
    ask(); ask();
    push({ op: 'idle' }, Math.max(SEC, wall - at + 10 * SEC));
    if (r) recover(r);
    ask();
    return { out, end: at };
  };
  // Candidate pairs in a seeded order; the first whose deadlines fall the way
  // `sooner` says is played, else the first.
  const pairs = pool.flatMap(p => pool.filter(q => q !== p).map(q => [p, q]));
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  let chosen = null;
  for (const [p, q] of pairs) {
    const trial = build(p, q, undefined);
    const dp = deadlineAt(p, trial.end); const dq = deadlineAt(q, trial.end);
    if (sooner ? dp < dq : dp > dq) { chosen = [p, q]; break; }
  }
  const [p, q] = chosen ?? pairs[0];
  const { end } = build(p, q, undefined);
  const r = pool.filter(a => a !== p && a !== q).sort((x, y) => deadlineAt(x, end) - deadlineAt(y, end))[0];
  steps.push(...build(p, q, r).out);
}

/** Appends the priority episode: every top-tier account reads past any
 * threshold, a conversation lands on the lower tier, the top tier recovers,
 * and that conversation comes back. Returns the new time.
 * @param {Step[]} steps @param {PoolAccount[]} accounts @param {string[]} convs
 * @param {number} at @param {() => number} rand */
function priorityEpisode(steps, accounts, convs, at, rand) {
  const tick = () => { at += (1 + Math.floor(rand() * 10)) * SEC; return at; };
  const top = accounts.filter(a => a.priority === 0);
  const c = convs[Math.floor(rand() * convs.length)];
  for (const a of top) steps.push({ at: tick(), op: 'usage', id: a.id, u7d: 0.99, f: null });
  steps.push({ at: tick(), op: 'request', c, model: OPUS });
  // All of them recover, since a fault may hold any one of them out.
  for (const a of top) {
    if (rand() < 0.5) steps.push({ at: tick(), op: 'roll', id: a.id, fable: false });
    else steps.push({ at: tick(), op: 'usage', id: a.id, u7d: r2(rand() * 0.35), f: null });
  }
  steps.push({ at: tick(), op: 'request', c, model: OPUS });
  return at;
}

/** Appends the roll episode: every account but one top-tier account reads past
 * any threshold, a conversation lands on that one, its weekly window rolls,
 * the others recover with a little spent, and the conversation comes back.
 * Burndown then prefers any account with spend on it. The pin's subscription
 * ends at under half the soonest other deadline, so its pressure still wins
 * after its own conversation's load halves its score, and that other account
 * stays inside a tolerance-3 band. Returns the new time.
 * @param {Step[]} steps @param {PoolAccount[]} accounts @param {string[]} convs
 * @param {number} at @param {() => number} rand */
function rollEpisode(steps, accounts, convs, at, rand) {
  const tick = () => { at += (1 + Math.floor(rand() * 10)) * SEC; return at; };
  const top = accounts.filter(a => a.priority === 0);
  const plain = top.filter(a => a.maxUsage == null && a.endsAt == null && !a.clockless7d);
  const from = plain.length ? plain : top;
  const pin = from[Math.floor(rand() * from.length)];
  const others = accounts.filter(a => a !== pin);
  const c = convs[Math.floor(rand() * convs.length)];
  for (const a of others) steps.push({ at: tick(), op: 'usage', id: a.id, u7d: 0.99, f: null });
  steps.push({ at: tick(), op: 'request', c, model: OPUS });
  steps.push({ at: tick(), op: 'roll', id: pin.id, fable: false });
  let soonest = Infinity;
  for (const a of others) {
    const u = r2(0.05 + rand() * 0.2);
    if (u >= (capOf(a.maxUsage, 'unified7d') ?? 1)) continue;
    steps.push({ at: tick(), op: 'usage', id: a.id, u7d: u, f: null });
    if (a.priority === 0) soonest = Math.min(soonest, a.endsAt != null && a.endsAt > at ? Math.min(a.r7d, a.endsAt) : a.r7d);
  }
  steps.push({ at: tick(), op: 'request', c, model: OPUS });
  if (soonest < Infinity) pin.endsAt = at + Math.round(0.45 * (soonest - at) / MIN) * MIN;
  return at;
}

// ---- configuration -----------------------------------------------------------

/** The `stormRamp` block each row value writes. `malformed` holds a 0 and a
 * quoted number, which docs/routing.md:168 says are ignored field by field. */
export const RAMPS = /** @type {Record<string, any>} */ ({
  default: undefined,
  off: { enabled: false },
  tuned: { startConc: 2, stepConc: 1, stepMs: 1000, windowMs: 60000 },
  malformed: { startConc: 0, stepMs: '250' },
});

/** The ramp a row runs under, as docs/routing.md:153-168 describe it: on, with
 * one request at once at a switch, unless the block says otherwise in a value
 * it accepts. @param {Row} row */
export function rampOf(row) {
  const raw = RAMPS[row.stormRamp ?? 'default'] ?? {};
  const ok = (/** @type {any} */ x) => typeof x === 'number' && Number.isFinite(x) && x > 0;
  return { enabled: raw.enabled !== false, startConc: ok(raw.startConc) ? raw.startConc : 1 };
}

/** The AccountManager options a row stands for, as src/index.js passes config.
 * The staleness timers are pinned past a history's span so that no environment
 * variable reaches selection and no revalidation the fed view does not model
 * fires; their own tests cover them.
 * @param {Row} row @param {(raw: any) => any} validateAdaptiveConfig */
export function managerOptions(row, validateAdaptiveConfig) {
  const adaptive = row.dist === 'adaptive-pressure' ? { scoring: 'pressure' }
    : row.dist === 'adaptive-pressure-5h' ? { scoring: 'pressure', pressureFiveHour: true }
      : row.dist === 'adaptive-pressure-soft' ? { scoring: 'pressure', fiveHourSoftMargin: 0.15 }
        : undefined;
  const distributeSessions = row.dist === 'off' ? false : row.dist === 'even' ? true
    : row.dist === 'load' ? 'load' : 'adaptive';
  return {
    distributeSessions,
    adaptive: validateAdaptiveConfig(adaptive),
    ...(row.expiry === undefined ? {} : { expiryRouting: row.expiry }),
    preferSoonestWeeklyReset: row.soonest,
    switchOnSessionReset: row.sessionReset,
    routes: undefined,
    ...(row.advisorEligibility === 'strict' || row.advisorEligibility === 'prefer' ? { advisorEligibility: row.advisorEligibility } : {}),
    ...(RAMPS[row.stormRamp] ? { ramp: RAMPS[row.stormRamp] } : {}),
    familyStaleMs: 365 * 24 * H,
    statusStaleMs: 365 * 24 * H,
    throttleProbeFloorMs: 60_000,
  };
}

/** The resolved expiry settings, as setExpiryRouting normalizes them.
 * @param {Row} row */
export function expiryOf(row) {
  const e = row.expiry ?? {};
  return {
    enabled: e.enabled === true,
    tolerance: typeof e.tolerance === 'number' ? Math.max(1, e.tolerance) : 1.5,
    preempt: typeof e.preempt === 'boolean' ? e.preempt : true,
    reclaimHours: typeof e.reclaimHours === 'number' && e.reclaimHours > 0 ? e.reclaimHours : 0,
    across: e.reclaimAcrossOrganizations === true,
  };
}

// ---- the independent model ---------------------------------------------------

/** @param {any} maxUsage @param {string} bucket @returns {number|null} */
export function capOf(maxUsage, bucket) {
  if (typeof maxUsage === 'number') return maxUsage;
  if (maxUsage && typeof maxUsage === 'object') return maxUsage[bucket] ?? maxUsage.default ?? null;
  return null;
}
/** @param {any} threshold @param {string} bucket @returns {number} */
export function thresholdOf(threshold, bucket) {
  if (typeof threshold === 'number') return threshold;
  return threshold[bucket] ?? threshold.default;
}
export const bucketOf = (/** @type {string} */ model) => (model === FABLE ? 'unified7dFable' : 'unified7d');

/** Whether a shell-style glob, `*` its only wildcard, matches all of `s`.
 * @param {string} glob @param {string} s */
export function globMatches(glob, s) {
  const parts = glob.split('*');
  if (parts.length === 1) return glob === s;
  const head = parts[0]; const tail = parts[parts.length - 1];
  if (!s.startsWith(head) || s.length < head.length + tail.length || !s.endsWith(tail)) return false;
  let at = head.length;
  for (const p of parts.slice(1, -1)) {
    const k = s.indexOf(p, at);
    if (k < 0 || k + p.length > s.length - tail.length) return false;
    at = k + p.length;
  }
  return true;
}

/** The first route whose globs match `model`, which alone decides it.
 * @param {Route[]} table @param {string} model */
export function routeOf(table, model) {
  return table.find(r => r.match.some(g => globMatches(g, model))) ?? null;
}

/** Whether the table keeps `id` off `model`: its first matching route lists
 * accounts and `id` is not one of them.
 * @param {Route[]} table @param {string} id @param {string} model */
export function routeBars(table, id, model) {
  const r = routeOf(table, model);
  return !!(r?.accounts?.length && !r.accounts.includes(id));
}

/** The route table a row configures for a history.
 * @param {Row} row @param {History} h @returns {Route[]} */
export function routesFor(row, h) {
  if (row.routes === 'layered') return /** @type {{ first: Route[] }} */ (h.routeTables).first;
  return h.fableRoute ? [{ name: 'fable', match: ['*fable*'], accounts: h.fableRoute }] : [];
}

/**
 * What the manager has been told about one account, plus the pool facts it was
 * configured with. Readings go null when their reset passes, as
 * _clearExpiredQuotas does. `billedUntil` and `deniedUntil` are the ends of
 * the billing and entitlement cooldowns, `denials` the entitlement denials
 * since the last completion the account served, and `refused` an account
 * refusal, which nothing in a history lifts.
 * @typedef {{ id: string, priority: number, org: string|null, maxUsage: any, endsAt: number|null,
 *   barred: Set<string>, disabled: boolean, cordoned: boolean,
 *   billedUntil: number|null, deniedUntil: number|null, denials: number, refused: boolean,
 *   u5h: number|null, r5h: number|null, u7d: number|null, r7d: number|null, f: number|null, fr: number|null }} Fed
 */

/** @param {Fed} a @param {string} model */
export function governing(a, model) {
  if (model === FABLE && a.f != null) return { window: 'unified7dFable', used: a.f, reset: a.fr };
  return { window: 'unified7d', used: a.u7d, reset: a.r7d };
}

/** The deadline pressure and the soonest-reset rules price on (_deadline).
 * @param {Fed} a @param {number|null} reset @param {number} now */
export function deadline(a, reset, now) {
  if (a.endsAt == null || !(a.endsAt > now)) return reset ?? null;
  if (reset) return Math.min(reset, a.endsAt);
  return a.endsAt < now + WEEK ? a.endsAt : null;
}

/** Why `a` cannot take `model` now, or null. Only the reasons this pool can
 * produce, in unavailableReason's order.
 * @param {Fed} a @param {string} model @param {any} threshold */
export function unavailable(a, model, threshold) {
  if (a.disabled) return 'disabled';
  if (atCap(a, model)) return 'capped';
  const hold = held(a);
  if (hold) return hold;
  if (a.u5h != null && a.u5h >= thresholdOf(threshold, 'unified5h')) return 'quota';
  const weekly = model === FABLE && a.f != null ? Math.max(a.f, a.u7d ?? -Infinity) : a.u7d;
  if (weekly != null && weekly >= thresholdOf(threshold, bucketOf(model))) return 'quota';
  if (a.barred.has(model)) return 'route';
  if (a.cordoned) return 'cordoned';
  return null;
}

/** The hold keeping `a` out of rotation, or null. The driver ends a cooldown
 * at its exact end, as the manager's lazy expiry does on its next read.
 * @param {Fed} a */
export function held(a) {
  if (a.deniedUntil != null) return 'entitlement';
  if (a.billedUntil != null) return 'billing';
  if (a.refused) return 'error';
  return null;
}

/** Whether startup's pick, which names no model, can take `a`: no route or
 * family bucket applies to it.
 * @param {Fed} a @param {any} threshold */
export function startable(a, threshold) {
  if (a.disabled || a.cordoned || held(a) || atCap(a, OPUS)) return false;
  if (a.u5h != null && a.u5h >= thresholdOf(threshold, 'unified5h')) return false;
  return !(a.u7d != null && a.u7d >= thresholdOf(threshold, 'unified7d'));
}

const hit = (/** @type {number|null} */ cap, /** @type {number|null} */ used) => cap != null && (cap <= 0 || (used != null && used >= cap));

/** @param {Fed} a @param {string} model */
export function atCap(a, model) {
  if (a.maxUsage == null) return false;
  if (hit(capOf(a.maxUsage, 'unified5h'), a.u5h)) return true;
  if (hit(capOf(a.maxUsage, 'unified7d'), a.u7d)) return true;
  return model === FABLE && hit(capOf(a.maxUsage, 'unified7dFable'), a.f);
}

/** Whether a maxUsage cap on `model`'s own family bucket bars `a`; the
 * shared buckets are not this check's, as the executor's caps cover them.
 * @param {Fed} a @param {string} model */
export function familyCapped(a, model) {
  return a.maxUsage != null && model === FABLE && hit(capOf(a.maxUsage, 'unified7dFable'), a.f);
}

/** Whether `a` can also serve an advisor on `advisor` (docs/routing.md:180):
 * its bucket for that family is not spent or capped, and no route bars it.
 * @param {Fed} a @param {string} advisor @param {any} threshold */
export function servesAdvisor(a, advisor, threshold) {
  if (familyCapped(a, advisor) || a.barred.has(advisor)) return false;
  return !(advisor === FABLE && a.f != null && a.f >= thresholdOf(threshold, 'unified7dFable'));
}

/**
 * How docs/routing.md:178-195 routes a request on `model` that declares an
 * advisor on `advisor`. `excluded` holds the accounts whose advisor-family cap
 * keeps selection off them, which is all such accounts while another can serve
 * the request, else none; `cands` the accounts that can serve the request
 * outside it, and `both` those of them that can serve the advisor too.
 * `routed` is the advisor that selection is held to: none where 'prefer' sets a
 * narrowing advisor aside. `plain` is where the advisor changes no decision,
 * so the request is judged as one that declared none: set aside, or every
 * account a request could be sent to, a cordoned one holding it included,
 * serves the advisor as well.
 * @param {Map<string, Fed>} fed @param {string} model @param {string} advisor @param {Row} row
 */
export function advisorRouting(fed, model, advisor, row) {
  const all = [...fed.values()];
  const reason = (/** @type {Fed} */ a) => unavailable(a, model, row.threshold);
  const capped = all.filter(a => familyCapped(a, advisor)).map(a => a.id);
  const excluded = new Set(all.some(a => reason(a) == null && !capped.includes(a.id)) ? capped : []);
  const cands = all.filter(a => reason(a) == null && !excluded.has(a.id));
  const both = cands.filter(a => servesAdvisor(a, advisor, row.threshold));
  const narrows = both.length > 0 && both.length < cands.length;
  const routed = row.advisorEligibility === 'prefer' && narrows ? null : advisor;
  const plain = routed == null || all.every(a => excluded.has(a.id) || (reason(a) != null && reason(a) !== 'cordoned')
    || servesAdvisor(a, advisor, row.threshold));
  return { advisor, excluded, cands, both, narrows, routed, plain };
}

/** The mode a row's advised requests are routed under, or null where they
 * send no advisor. `default` sends the advisor with the setting left out,
 * which docs/configuration.md:76 makes "strict".
 * @param {Row} row @returns {'strict'|'prefer'|null} */
export const advisorMode = row => (row.advisorEligibility === 'default' ? 'strict'
  : row.advisorEligibility === 'strict' || row.advisorEligibility === 'prefer' ? row.advisorEligibility : null);

/** The key the manager keeps a model's diversion under (_cursorKey): an
 * advisor that selection was held to keys it apart from requests that name
 * none.
 * @param {string} model @param {string|null} advisor */
export const cursorKeyOf = (model, advisor) => (advisor && advisor !== model ? `${model}+${advisor}` : model);

/** The room under the caps on the governing window (_spendLimit), 1 with none.
 * @param {Fed} a @param {string} model */
function limitOf(a, model) {
  if (a.maxUsage == null) return 1;
  const g = governing(a, model);
  let limit = capOf(a.maxUsage, g.window);
  if (g.window !== 'unified7d' && g.used != null) {
    const capWeekly = capOf(a.maxUsage, 'unified7d');
    if (capWeekly != null && a.u7d != null) limit = Math.min(limit ?? 1, g.used + Math.max(0, capWeekly - a.u7d));
  }
  return limit ?? 1;
}

const clamp01 = (/** @type {number} */ x) => Math.min(1, Math.max(0, x));

/**
 * Pressure as docs/routing.md:397-405 defines it: room per second to the
 * deadline; `absent` with a lower bound over a full week when the reset is not
 * known, and with none when the utilization is not.
 * @param {Fed} a @param {string} model @param {number} now
 * @returns {{ kind: 'known', value: number } | { kind: 'absent', bound: number|null }}
 */
export function pressure(a, model, now) {
  const g = governing(a, model);
  if (g.used == null) return { kind: 'absent', bound: null };
  const room = Math.max(0, clamp01(limitOf(a, model)) - clamp01(g.used));
  const d = deadline(a, g.reset ?? null, now);
  if (!d) return { kind: 'absent', bound: room / (WEEK / SEC) };
  const seconds = (d - now) / SEC;
  return { kind: 'known', value: seconds <= 0 ? 0 : room / seconds };
}

/**
 * The top pressure band (docs/routing.md:403-407) over `cands`: every account
 * outside the top priority tier, and inside it every account within
 * `tolerance` of the best known pressure or without one. All of them when the
 * knob is off, when there are fewer than two, or when none is known. `floor` is
 * null in those cases. `known` holds the tier's known pressures and `max` the
 * best of them.
 * @param {Fed[]} cands @param {string} model @param {number} now @param {ReturnType<typeof expiryOf>} ex
 * @returns {{ ids: Set<string>, floor: number|null, max: number|null, known: number[] }}
 */
export function band(cands, model, now, ex) {
  const all = () => ({ ids: new Set(cands.map(a => a.id)), floor: null, max: null, known: [] });
  if (!ex.enabled || cands.length <= 1) return all();
  const top = Math.min(...cands.map(a => a.priority));
  const tier = cands.filter(a => a.priority === top);
  const ps = tier.map(a => pressure(a, model, now));
  const known = ps.flatMap(p => (p.kind === 'known' ? [p.value] : []));
  if (!known.length) return all();
  const max = Math.max(...known);
  const floor = Math.min(max, max / ex.tolerance);
  const ids = new Set(cands.filter(a => a.priority !== top).map(a => a.id));
  tier.forEach((a, i) => { const p = ps[i]; if (p.kind === 'absent' || p.value >= floor) ids.add(a.id); });
  return { ids, floor, max, known };
}

/** Whether `a` is ranked behind the rest for a bound below the band's floor
 * (_belowBandFloor): a utilization with no reset whose best case is still short.
 * @param {Fed[]} banded @param {string} model @param {number} now @param {ReturnType<typeof expiryOf>} ex */
export function heldOff(banded, model, now, ex) {
  /** @type {Map<string, boolean>} */
  const out = new Map(banded.map(a => [a.id, false]));
  if (!ex.enabled) return out;
  const b = band(banded, model, now, ex);
  const bounds = banded.map(a => { const p = pressure(a, model, now); return p.kind === 'absent' ? p.bound : null; });
  const floor = b.floor ?? Math.max(...bounds.filter(x => x != null), -Infinity);
  if (!Number.isFinite(floor)) return out;
  banded.forEach((a, i) => { const x = bounds[i]; if (x != null && x < floor) out.set(a.id, true); });
  return out;
}

// ---- the driver ----------------------------------------------------------------

/** The windows an account presents, as _accountWindows lists them.
 * @param {Fed} a @returns {Map<string, number>} */
export function windowsOf(a) {
  /** @type {Map<string, number>} */
  const out = new Map();
  if (a.r7d != null) out.set('unified7d', a.r7d);
  if (a.f != null && a.fr != null) out.set('unified7dFable', a.fr);
  return out;
}

/**
 * A rollover reading (an Observation in account-manager.js): the windows of
 * the account traffic was last found resting on. `escaped` holds the accounts
 * left while rolled, and a reading moved onto one of them without a hand-back
 * is `uncertain`, since the manager may still hold an older reading there.
 * That older reading has rolled, so it refuses a first sight onto the next
 * account, and the doubt moves with the reading. `stale` holds the windows the
 * reading took past their reset, which the manager still held when it read.
 * `owed` maps each account a rest or a hand-back left while rolled to the
 * windows read there, when the reading was in no doubt. Only a served
 * request can end that hold (docs/routing.md:411). An entry lasts until a
 * later request selecting under this reading is served, and a return before
 * then is handed that reading back. `handed` holds, for a
 * reading restored that way, the windows its account showed at the hand-back:
 * the roll handed back is not held again, and one past them is.
 * `gen` counts the reading's moves. `stamps` holds, for an escaped account, the
 * move that left it (docs/routing.md:411), or null where that move was a
 * return onto an account left while rolled, which no stay settles. An escape
 * whose move's stay was served is dropped and its account put in `settled`, so
 * a return there reads it whole (:417), and `returned` says the reading was
 * moved onto such an account. `held` keeps the reading an escape left behind,
 * for an escape whose roll the manager is known to hold: stamped, taken from a
 * reading with no doubt or stale window, and touched since by no hop or
 * failover. A return onto that account restores it as `restored`.
 * @typedef {{ on: string|null, windows: Map<string, number>, escaped: Set<string>, uncertain: boolean, stale: Set<string>,
 *   owed: Map<string, { windows: Map<string, number>, step: number }>, handed: Map<string, number>|null,
 *   gen: number, stamps: Map<string, number|null>, settled: Set<string>, returned: boolean,
 *   held: Map<string, Map<string, number>>, restored: Map<string, number>|null }} Obs
 */

/** @returns {Obs} */
export const newObs = () => ({
  on: null, windows: new Map(), escaped: new Set(), uncertain: false, stale: new Set(), owed: new Map(), handed: null,
  gen: 0, stamps: new Map(), settled: new Set(), returned: false, held: new Map(), restored: null,
});

/** Settles the escapes stamped `gen`, on a stay served under that stamp where
 * the reading still rests (confirmStay).
 * @param {Obs} obs @param {number} gen */
export function settleMove(obs, gen) {
  for (const [id, st] of [...obs.stamps]) {
    if (st !== gen) continue;
    obs.escaped.delete(id); obs.stamps.delete(id); obs.held.delete(id); obs.settled.add(id);
  }
}

/** Drops what the model knows of the rolls held on a reading: a hop, a
 * failover, a removal or a restart may settle or rebuild them in the manager.
 * @param {Obs} obs */
function unsure(obs) {
  obs.held.clear();
  obs.restored = null;
}

/** Whether any window `a` presents jumped past the reading (_anyJumped).
 * @param {Obs} obs @param {Fed} a */
function anyRolled(obs, a) {
  for (const [w, r] of windowsOf(a)) {
    const seen = obs.windows.get(w);
    if (seen != null && r - seen > ROLL_JUMP) return true;
  }
  return false;
}

/** Whether a window of `a` rolled past the reading other than the roll a
 * hand-back restored it from (_newRoll).
 * @param {Obs} obs @param {Fed} a */
function newRoll(obs, a) {
  if (!obs.handed) return anyRolled(obs, a);
  for (const [w, r] of windowsOf(a)) {
    const seen = obs.windows.get(w);
    if (seen == null || r - seen <= ROLL_JUMP) continue;
    const at = obs.handed.get(w);
    if (at == null || r - at > ROLL_JUMP) return true;
  }
  return false;
}

/** Moves the reading onto `a`, noting a roll left behind. A move made at a
 * rest, in request `step`, holds that roll.
 * @param {Obs} obs @param {Fed} a @param {Map<string, Fed>} fed @param {number|null} [step] */
function moveObs(obs, a, fed, step = null) {
  const leaving = obs.on == null ? null : fed.get(obs.on);
  const back = obs.escaped.has(a.id);
  obs.gen++;
  if (leaving && anyRolled(obs, leaving)) {
    obs.escaped.add(leaving.id);
    const fresh = newRoll(obs, leaving);
    // A reading in doubt may not be the one the manager holds, so a return
    // there is not handed it back.
    if (step != null && fresh && !obs.uncertain) obs.owed.set(leaving.id, { windows: new Map(obs.windows), step });
    obs.stamps.set(leaving.id, back ? null : obs.gen);
    obs.settled.delete(leaving.id);
    if (!back && fresh && !obs.uncertain && !obs.stale.size) obs.held.set(leaving.id, new Map(obs.windows));
    else obs.held.delete(leaving.id);
  }
  // Arriving without a hand-back leaves the manager's hold in place, and
  // whether a later return restores it is no longer known.
  obs.owed.delete(a.id);
  obs.returned = !back && obs.settled.delete(a.id);
  obs.restored = back ? obs.held.get(a.id) ?? null : null;
  obs.held.delete(a.id);
  obs.on = a.id;
  obs.windows = windowsOf(a);
  obs.stale = new Set();
  obs.uncertain = obs.escaped.has(a.id);
  obs.handed = null;
}

/** Restores the reading held for `a` when traffic returns to it before a
 * request was served (docs/routing.md:417), as _firstSightOn does. Returns
 * whether it did. The roll of the account it leaves is held from request
 * `step` under no stamp.
 * @param {Obs} obs @param {Fed} a @param {Map<string, Fed>} fed @param {number|null} step */
function handBack(obs, a, fed, step) {
  const owed = obs.owed.get(a.id);
  if (!owed || obs.uncertain || obs.on === a.id) return false;
  const leaving = obs.on == null ? null : fed.get(obs.on);
  obs.gen++;
  // The roll a hand-back leaves takes no stamp: the move is a return.
  if (leaving && anyRolled(obs, leaving)) {
    obs.escaped.add(leaving.id); obs.stamps.set(leaving.id, null); obs.held.delete(leaving.id);
    if (step != null && newRoll(obs, leaving)) obs.owed.set(leaving.id, { windows: new Map(obs.windows), step });
  }
  obs.on = a.id;
  obs.windows = new Map(owed.windows);
  obs.stale = new Set();
  obs.escaped.delete(a.id);
  obs.stamps.delete(a.id); obs.held.delete(a.id);
  obs.returned = false; obs.restored = null;
  obs.owed.delete(a.id);
  obs.handed = windowsOf(a);
  return true;
}

/** The reading recordSession takes of a pin's new account (_firstSightOn):
 * none while the account left behind has an unsettled roll. `step` is the
 * request being played.
 * @param {Obs} obs @param {Fed} a @param {Map<string, Fed>} fed @param {number|null} step */
export function firstSight(obs, a, fed, step) {
  if (obs.on === a.id || handBack(obs, a, fed, step)) return;
  const leaving = obs.on == null ? null : fed.get(obs.on);
  if (leaving && anyRolled(obs, leaving)) { obs.escaped.add(leaving.id); return; }
  const doubt = obs.uncertain;
  moveObs(obs, a, fed);
  obs.uncertain ||= doubt;
}

/** Whether the reading a return onto `a` restored has rolled in its
 * governing window, so that the pin is re-ranked (_pinRolledOver).
 * @param {Obs} obs @param {Fed} a @param {string} model */
function restoredRolled(obs, a, model) {
  if (obs.on !== a.id || !obs.restored) return false;
  const g = governing(a, model);
  const seen = obs.restored.get(g.window);
  return seen != null && g.reset != null && g.reset - seen > ROLL_JUMP;
}

/** Whether the governing window of `a` jumped past the reading (_jumped).
 * @param {Obs} obs @param {Fed} a @param {string} model */
export function rolledSince(obs, a, model) {
  if (obs.on !== a.id) return false;
  const g = governing(a, model);
  const seen = obs.windows.get(g.window);
  return seen != null && g.reset != null && g.reset - seen > ROLL_JUMP;
}

/** Takes the reading at the start of request `step`, as _restOn does.
 * Returns whether the governing window had rolled.
 * @param {Obs} obs @param {Fed} a @param {string} model @param {Map<string, Fed>} fed
 * @param {Map<string, number>|undefined} lapsed windows of `a` past their reset that the manager still holds
 * @param {number} step */
export function restOn(obs, a, model, fed, lapsed, step) {
  if (obs.on !== a.id) {
    // A reading naming no account was offered nothing by a cursor move, so
    // the rest is where a removal's leftover hands a roll back.
    if (obs.on == null && handBack(obs, a, fed, step)) return false;
    moveObs(obs, a, fed, step);
    takeLapsed(obs, lapsed);
    return false;
  }
  const g = governing(a, model);
  if (g.reset == null) { takeLapsed(obs, lapsed); return false; }
  if (rolledSince(obs, a, model)) {
    // docs/routing.md:411 and :417 do not say whether a window already past
    // its reset counts as read, so a jump from one is neither a roll nor not one.
    if (!obs.stale.has(g.window)) return true;
    obs.uncertain = true;
    return false;
  }
  obs.windows.set(g.window, g.reset);
  obs.stale.delete(g.window);
  for (const [w, r] of windowsOf(a)) if (!obs.windows.has(w)) obs.windows.set(w, r);
  takeLapsed(obs, lapsed);
  // A doubt carried in by a first sight settles at a rest that finds no window
  // moved: whichever reading the manager held, it is on this account now.
  if (obs.uncertain && !obs.escaped.has(a.id) && !anyRolled(obs, a)) obs.uncertain = false;
  return false;
}

/** The manager reads before it clears expired windows, so its reading keeps
 * the old reset of a window that lapsed unread.
 * @param {Obs} obs @param {Map<string, number>} [lapsed] */
function takeLapsed(obs, lapsed) {
  for (const [w, r] of lapsed ?? []) if (!obs.windows.has(w)) { obs.windows.set(w, r); obs.stale.add(w); }
}

/**
 * @typedef {{ pins: Map<string, string>, pinAt: Map<string, number>, lastSeen: number,
 *   obs: Map<string, Obs> }} Conv
 * @typedef {{ i: number, op: string, c?: string, model?: string, d: string, pin?: string|null, kind?: string, to?: string }} Decision
 */

/** Conversations counted as load on `id` (activeCountFor): one whose pin on
 * `id` was touched within the active window, or the one in flight.
 * @param {Map<string, Conv>} convs @param {string} id @param {number} now @param {string|null} inFlight */
export function activeOn(convs, id, now, inFlight) {
  let n = 0;
  for (const [k, x] of convs) {
    for (const [bucket, acc] of x.pins) {
      if (acc === id && (k === inFlight || now - /** @type {number} */ (x.pinAt.get(bucket)) <= ACTIVE_TTL)) { n++; break; }
    }
  }
  return n;
}

/** Tagged requests routed to `id` within the load window (recentRequestsFor).
 * @param {Map<string, number[]>} routed @param {string} id @param {number} now */
export function recentOn(routed, id, now) {
  return (routed.get(id) ?? []).filter(at => now - at <= LOAD_WINDOW).length;
}

/**
 * Plays one history. `check(ctx)` is called for every routed request, with
 * the state before the decision and the decision, and after every restart.
 * Returns the decision trace.
 * @param {object} p
 * @param {any} p.AccountManager
 * @param {any} p.validateAdaptiveConfig
 * @param {import('node:test').TestContext} p.t
 * @param {History} p.history
 * @param {Row} p.row
 * @param {number[]} [p.restarts]  step indices after which the daemon restarts,
 *   besides the steps marked `restart`
 * @param {(ctx: any) => Set<string>|void} [p.check]  returns the invariants that judged the step
 * @param {{ restoreAlways?: boolean }} [p.driver]
 * @param {Set<string>} [p.taken]  collects the transition-table keys the play takes, and the rollover rows it waits on
 * @returns {Decision[]}
 */
export function play({ AccountManager, validateAdaptiveConfig, t, history: h, row, restarts = [], check = () => {}, driver = {}, taken }) {
  const ex = expiryOf(row);
  t.mock.timers.setTime(h.start);
  /** @type {Map<string, PoolAccount>} */
  const truth = new Map(h.accounts.map(a => [a.id, { ...a }]));
  /** @type {Map<string, Fed>} */
  const fed = new Map(h.accounts.map(a => [a.id, {
    id: a.id, priority: a.priority, org: a.org, maxUsage: a.maxUsage, endsAt: a.endsAt,
    barred: new Set(), disabled: false, cordoned: false,
    billedUntil: null, deniedUntil: null, denials: 0, refused: false,
    u5h: null, r5h: null, u7d: null, r7d: null, f: null, fr: null,
  }]));
  // Windows past their reset that the manager has not cleared: a request's
  // walk clears every account, and a fresh reading replaces its own windows.
  /** @type {Map<string, Map<string, number>>} */
  const lapsed = new Map(h.accounts.map(a => [a.id, new Map()]));
  // Accounts removed from the fleet; the config holds no row for them.
  /** @type {Set<string>} */
  const gone = new Set();
  const configRows = () => h.accounts.filter(a => !gone.has(a.id)).map(a => ({
    id: a.id, name: a.id, type: 'oauth', accessToken: `synthetic-${a.id}`, refreshToken: `synthetic-r-${a.id}`,
    expiresAt: h.start + 30 * 24 * H, accountUuid: `uuid-${a.id}`,
    ...(a.org ? { orgUuid: a.org } : {}),
    priority: a.priority,
    ...(a.maxUsage != null ? { maxUsage: a.maxUsage } : {}),
    ...(a.endsAt != null ? { endsAt: a.endsAt } : {}),
    ...(fed.get(a.id)?.disabled ? { disabled: true } : {}),
    ...(fed.get(a.id)?.cordoned ? { cordoned: true } : {}),
  }));
  let routes = routesFor(row, h);
  const bar = () => {
    for (const f of fed.values()) f.barred = new Set([OPUS, FABLE].filter(m => routeBars(routes, f.id, m)));
  };
  bar();
  const options = () => ({
    ...managerOptions(row, validateAdaptiveConfig),
    ...(routes.length ? { routes } : {}),
  });
  let am = new AccountManager(configRows(), row.threshold, options());
  const byId = (/** @type {string} */ id) => am.accounts.find((/** @type {any} */ a) => a.id === id);

  /** A usage reading. It always lists the 5h window, as the usage endpoint
   * does: a weekly reading without one tells the manager there is none.
   * @param {PoolAccount} x @param {{ weekly?: boolean, fable?: boolean }} what */
  const feedUsage = (x, what) => {
    const f = /** @type {Fed} */ (fed.get(x.id));
    const usage = /** @type {Record<string, any>} */ ({});
    usage.fiveHour = { utilization: x.u5h, resetAt: x.r5h };
    f.u5h = x.u5h; f.r5h = x.r5h;
    if (what.weekly) {
      usage.sevenDay = { utilization: x.u7d, ...(x.clockless7d ? {} : { resetAt: x.r7d }) };
      f.u7d = x.u7d; if (!x.clockless7d) { f.r7d = x.r7d; lapsed.get(x.id)?.delete('unified7d'); }
    }
    if (what.fable && x.F != null) {
      usage.sevenDayFable = { utilization: x.F, ...(x.clocklessF ? {} : { resetAt: x.FR }) };
      // A family reading replaces its reset, with none when it names none.
      f.f = x.F; f.fr = x.clocklessF ? null : x.FR;
      lapsed.get(x.id)?.delete('unified7dFable');
    }
    am.applyUsageData(byId(x.id).index, usage);
    noteReading(x.id);
  };
  /** @param {PoolAccount} x @param {string} model */
  const headersOf = (x, model) => {
    const f = /** @type {Fed} */ (fed.get(x.id));
    /** @type {Record<string, string>} */
    const out = {
      'anthropic-ratelimit-unified-5h-utilization': String(x.u5h),
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(x.r5h / SEC)),
      'anthropic-ratelimit-unified-7d-utilization': String(x.u7d),
    };
    f.u5h = x.u5h; f.r5h = Math.floor(x.r5h / SEC) * SEC; f.u7d = x.u7d;
    if (!x.clockless7d) { out['anthropic-ratelimit-unified-7d-reset'] = String(Math.floor(x.r7d / SEC)); f.r7d = Math.floor(x.r7d / SEC) * SEC; }
    if (model === FABLE && x.F != null) {
      out['anthropic-ratelimit-unified-7d_oi-utilization'] = String(x.F);
      f.f = x.F;
      if (!x.clocklessF && x.FR != null) { out['anthropic-ratelimit-unified-7d_oi-reset'] = String(Math.floor(x.FR / SEC)); f.fr = Math.floor(x.FR / SEC) * SEC; }
    }
    return out;
  };

  /** @type {Map<string, Conv>} */
  let convs = new Map();
  /** @type {Map<string, number[]>} */
  const routed = new Map(h.accounts.map(a => [a.id, []]));
  /** @type {Decision[]} */
  const out = [];
  let life = 0;
  let reloaded = false;
  /** @type {string|null} */
  let cur = null;
  // Accounts whose 5h reset the manager has noticed and not yet acted on. It
  // notices only when it reads the quota, so a reading that replaces an
  // expired one first raises nothing.
  /** @type {Set<string>} */
  let sessionResets = new Set();
  // The accounts whose hold ended since the last request, and which hold.
  /** @type {Map<string, string>} */
  const released = new Map();
  // When each account's per-minute pause ends, which the manager does not save.
  /** @type {Map<string, number>} */
  let pausedUntil = new Map();
  const noticeResets = () => {
    for (const f of fed.values()) {
      if (f.r5h != null && Date.now() >= f.r5h) {
        if (f.u5h != null) sessionResets.add(f.id);
        f.u5h = null; f.r5h = null;
      }
    }
  };
  // Every account starts probing; the first weekly reset learned on a
  // probing account flags it to be re-ranked when it is current.
  /** @type {Set<string>} */
  let requalify = new Set();
  let probing = new Set(h.accounts.map(a => a.id));
  const noteReading = (/** @type {string} */ id) => {
    if (probing.has(id) && /** @type {Fed} */ (fed.get(id)).r7d != null) { probing.delete(id); requalify.add(id); }
  };
  for (const x of truth.values()) if (!x.hidden7d) feedUsage(x, { weekly: true, fable: true });
  let curObs = newObs();
  const preempting = ex.enabled && ex.preempt;
  // The cursor is read from the manager rather than modeled: a request barred
  // only for its model is diverted without moving it.
  const cursor = () => am.accounts[am.currentIndex]?.id ?? null;
  cur = cursor();
  // Where each model was last routed, under the manager's key for it. The
  // manager keeps a family diverted off a cursor that cannot serve it on that
  // account (_divertedFor); this is the same record, taken from the decisions
  // rather than from the manager's private state, and like the manager's it is
  // not saved across a restart.
  /** @type {Map<string, string>} */
  let lastRouted = new Map();
  const advising = advisorMode(row) != null;
  // The transition-table keys (routing-transitions.js), with each state read
  // off the model's record, never off the manager.
  const stateOf = (/** @type {Fed} */ f) => (f.refused ? 'error' : f.deniedUntil != null ? `denied${Math.min(f.denials, 3)}`
    : f.billedUntil != null ? 'billed' : f.denials > 0 ? `released${Math.min(f.denials, 3)}` : 'free');
  const note = (/** @type {string} */ machine, /** @type {string} */ state, /** @type {string} */ event, /** @type {boolean|null} */ adv = null) => {
    taken?.add(`${machine}|${state}|${event}|${adv == null ? '' : adv ? 'advisor' : 'plain'}`);
  };
  // A removal's outcome shows only on a later request. Its keys wait for the
  // request whose judgment `done` names: noted at the removal, a step dropped
  // from a path would leave the row counted and its outcome unjudged.
  /** @type {Array<{ key: [string, string, string]|string, done: (ctx: any, ok: Set<string>, probed: Map<string, string>) => boolean }>} */
  let pending = [];
  const judged = (/** @type {any} */ ctx, /** @type {Set<string>|void} */ ok, /** @type {Map<string, string>} */ probed) => {
    pending = pending.filter(p => {
      if (!ok || !p.done(ctx, ok, probed)) return true;
      if (typeof p.key === 'string') taken?.add(p.key); else note(...p.key);
      return false;
    });
  };
  // The epoch each account's last entitlement denial was sent under.
  /** @type {Map<string, number>} */
  const sentUnder = new Map();
  /** The account a `who` names, or null. @param {string} who */
  const whoIs = who => {
    const k = am.currentIndex;
    if (who === 'cursor' || who === 'under-cursor' || who === 'over-cursor') {
      return am.accounts[who === 'cursor' ? k : who === 'under-cursor' ? k - 1 : k + 1]?.id ?? null;
    }
    return [...fed.values()].find(f => stateOf(f).startsWith(who))?.id ?? null;
  };
  /** How many of `limit` requests `acc` admits at once: admit() takes a slot
   * synchronously while one is free. Each slot is given back unanswered, so
   * nothing is learned from it. A call that finds no slot waits on a timer
   * until the test yields, which a row's test never does, so the probe stops
   * at the first such call and never asks past what it judges.
   * @param {any} acc @param {number} limit */
  const admitted = (acc, limit) => {
    let done = false;
    let n = 0;
    while (n < limit) {
      const before = acc.inFlight;
      am.admit(acc.index, () => done);
      if (acc.inFlight === before) break;
      n++;
    }
    done = true;
    for (let k = 0; k < n; k++) am.release(acc.index, { successful: false });
    return n;
  };

  // The request being played. A request served after the one whose rest held
  // a roll may be the stay that releases it, so the hold is no longer known.
  // A serve is a stay only for the readings it selected under: the current
  // account's and its own conversation's pin in the request's bucket.
  let step = -1;
  const settle = (/** @type {string|null} */ c, /** @type {string} */ bucket) => {
    const conv = c == null ? undefined : convs.get(c);
    for (const o of [curObs, conv?.obs.get(bucket)]) {
      if (o) for (const [id, e] of o.owed) if (e.step !== step) o.owed.delete(id);
    }
  };
  const serve = (/** @type {any} */ acc, /** @type {string} */ model, /** @type {boolean} */ burn, /** @type {string|null} */ c) => {
    settle(c, bucketOf(model));
    const x = /** @type {PoolAccount} */ (truth.get(acc.id));
    note('hold', stateOf(/** @type {Fed} */ (fed.get(acc.id))), 'success');
    if (burn) {
      x.u7d = r3(x.u7d + SERVE_BURN);
      x.u5h = r3(x.u5h + SERVE_BURN_5H);
      if (model === FABLE && x.F != null) x.F = r3(x.F + SERVE_BURN);
    }
    am.updateQuota(acc.index, headersOf(x, model), model, 200);
    noteReading(acc.id);
    // A completion to a request sent after the last entitlement denial clears
    // the count that lengthens the next cooldown (docs/routing.md:90). It
    // clears a billing cooldown too, which no docs line covers.
    am.clearBillingRejected(acc.index);
    am.clearEntitlementDenied(acc, acc.entitlementEpoch);
    const f = /** @type {Fed} */ (fed.get(acc.id));
    f.billedUntil = null; f.denials = 0;
  };

  /** The rest of a refusing fault step once its first attempt is sent to
   * `acc`, in the server's order: the hold the refusal arms, then the failover
   * that excludes the refused account, which is sent the request and serves
   * it. @param {any} acc @param {string} kind @param {any} ctx @param {Obs|null} sighted */
  const refuse = (acc, kind, ctx, sighted) => {
    const { model, c, now } = ctx;
    const f = /** @type {Fed} */ (fed.get(acc.id));
    note('hold', stateOf(f), kind, !!ctx.adv);
    // Read before the request is sent. A denial to a request sent before the
    // last one does not count (docs/routing.md:88).
    const epoch = acc.entitlementEpoch;
    if (kind === 'billing') {
      am.markBillingRejected(acc.index);
      f.billedUntil = now + BILLING_COOLDOWN;
    } else if (kind === 'entitled') {
      am.markEntitlementDenied(acc.index, { detail: DENIAL, epoch });
      sentUnder.set(acc.id, epoch);
      f.denials++;
      const until = now + ENTITLEMENT_COOLDOWNS[Math.min(f.denials, ENTITLEMENT_COOLDOWNS.length) - 1];
      f.deniedUntil = Math.max(f.deniedUntil ?? 0, until);
    } else {
      am.markRefused(acc, { code: 'verification_required', message: 'Identity verification is required.', link: null });
      f.refused = true;
    }
    /** @type {{ rolledOff?: Set<number> }} */
    const selection = {};
    // Every attempt re-reads the stamp before it selects (docs/routing.md:415),
    // the failover included.
    const carried = am.observedGeneration(c, model);
    // The retry passes the request's advisor (docs/routing.md:195), read
    // again now that the refused account is held.
    const adv = ctx.adv ? advisorRouting(fed, model, ctx.adv.advisor, row) : null;
    const alt = am.getActiveAccount(new Set([acc.index]), model, adv?.advisor ?? null, c, undefined, selection);
    if (!ctx.edge) check({ ...ctx, failover: true, kind, from: acc.id, d: alt?.id ?? '-', adv, view: undefined });
    // A walk that moves the cursor takes its first reading and arms probing
    // there before the failover is sent, so before its response is read.
    const was = cur;
    cur = cursor();
    if (cur != null && cur !== was) {
      if (preempting) firstSight(curObs, /** @type {Fed} */ (fed.get(cur)), fed, step);
      if (row.dist === 'off') {
        if (was != null) requalify.delete(was);
        if (/** @type {Fed} */ (fed.get(cur)).r7d == null) probing.add(cur); else probing.delete(cur);
      }
    }
    if (sighted) unsure(sighted);
    if (alt) {
      am.recordSession(c, alt.index, model);
      if (sighted) firstSight(sighted, /** @type {Fed} */ (fed.get(alt.id)), fed, step);
      serve(alt, model, true, ctx.tagged ? c : null);
      am.confirmStay(alt, carried, c, 'anthropic');
    }
    return alt;
  };

  /** The rest of a throttle step once its first attempt is sent to `acc`, in
   * the server's order: the 429's readings, the pause, at most one hop to an
   * account outside its own pause, which is sent the request and serves it,
   * and the request's end. Checks the hop, and returns the account it went to.
   * @param {any} acc @param {{ rolledOff?: Set<number> }} selection @param {any} ctx @param {Obs|null} sighted */
  const throttle = (acc, selection, ctx, sighted) => {
    const { model, c, now } = ctx;
    am.updateQuota(acc.index, headersOf(/** @type {PoolAccount} */ (truth.get(acc.id)), model), model, 429);
    noteReading(acc.id);
    // A load of 0 teaches the concurrency learner nothing: the load the server
    // passes comes from admission, which is not played.
    am.pauseAccount(acc.index, Math.min(RETRY_AFTER, RATE_LIMIT_ABSORB_MAX), 0);
    pausedUntil.set(acc.id, now + Math.min(RETRY_AFTER, RATE_LIMIT_ABSORB_MAX) * SEC);
    const pinsBefore = am.exportAffinityState();
    const cursorBefore = cursor();
    const alt = am.pickAlternate(new Set([acc.index, ...(selection.rolledOff ?? [])]), model, null);
    const to = alt && !am.isPaused(alt.index) ? alt : null;
    if (sighted) unsure(sighted);
    if (to) {
      am.recordSession(c, to.index, model);
      if (sighted) firstSight(sighted, /** @type {Fed} */ (fed.get(to.id)), fed, step);
    }
    if (!ctx.edge) check({
      ...ctx, hop: true, from: acc.id, to: to?.id ?? null, pausedUntil: new Map(pausedUntil),
      rolledOff: [...(selection.rolledOff ?? [])].map(k => am.accounts[k].id),
      cursorBefore, cursorAfter: cursor(), pinsBefore, pinsAfter: am.exportAffinityState(), view: undefined,
    });
    if (to) {
      serve(to, model, true, ctx.tagged ? c : null);
      am.confirmStay(to, null, c, 'anthropic');
    }
    return to;
  };

  h.steps.forEach((s, i) => {
    step = i;
    t.mock.timers.setTime(s.at);
    const now = s.at;
    const id = s.who ? whoIs(s.who) : s.id;
    // A request at the instant a cooldown ends is not judged: no docs line
    // says whether the cooldown still holds then.
    let edge = false;
    /** @type {Map<string, string>} */
    const probed = new Map();
    if (s.op === 'request' || s.op === 'untagged' || s.op === 'throttle' || s.op === 'fault') {
      for (const f of fed.values()) {
        const end = f.deniedUntil ?? f.billedUntil;
        const probe = end == null ? null : PROBE_AT.get(now - end);
        if (probe) { note('hold', stateOf(f), `request@${probe}`); probed.set(f.id, probe); }
        if (end === now) edge = true;
        if (f.refused) note('hold', 'error', 'request');
      }
    }
    for (const x of truth.values()) {
      let weekly = false; let fable = false;
      while (x.r7d <= now) { x.r7d += WEEK; x.u7d = 0; weekly = true; }
      while (x.FR != null && x.FR <= now) { x.FR += WEEK; x.F = 0; fable = true; }
      while (x.r5h <= now) { x.r5h += 5 * H; x.u5h = 0; }
      const f = /** @type {Fed} */ (fed.get(x.id));
      if (f.billedUntil != null && now >= f.billedUntil) { f.billedUntil = null; released.set(f.id, 'billing'); }
      if (f.deniedUntil != null && now >= f.deniedUntil) { f.deniedUntil = null; released.set(f.id, 'entitlement'); }
      if (f.r7d != null && now >= f.r7d) { lapsed.get(f.id)?.set('unified7d', f.r7d); f.u7d = null; f.r7d = null; }
      if (f.fr != null && now >= f.fr) { lapsed.get(f.id)?.set('unified7dFable', f.fr); f.f = null; f.fr = null; }
      // A reading the manager holds is refreshed when its window rolls; one it
      // has never been told stays unknown until a response reveals it.
      if ((weekly && (f.u7d != null || !x.hidden7d)) || (fable && f.f != null)) {
        feedUsage(x, { weekly: weekly && (f.u7d != null || !x.hidden7d), fable: fable && f.f != null });
      }
    }
    const x = id ? /** @type {PoolAccount} */ (truth.get(id)) : null;
    const f = id ? /** @type {Fed} */ (fed.get(id)) : null;
    if (s.op === 'usage' && x && f) {
      x.u7d = /** @type {number} */ (s.u7d);
      if (s.f != null && x.F != null) x.F = s.f;
      feedUsage(x, { weekly: true, fable: f.f != null || s.f != null });
    } else if (s.op === 'five' && x) {
      x.u5h = /** @type {number} */ (s.u5h);
      feedUsage(x, {});
    } else if (s.op === 'roll' && x && f) {
      if (s.fable && x.F != null) { x.FR = /** @type {number} */ (x.FR) + WEEK; x.F = 0; } else { x.r7d += WEEK; x.u7d = 0; }
      if (f.u7d != null || f.f != null) feedUsage(x, { weekly: f.u7d != null, fable: f.f != null });
    } else if (s.op === 'fault' && f) {
      const down = [...fed.values()].filter(a => a.disabled || a.cordoned).length;
      if (s.kind === 'disable' && (f.disabled || down < Math.floor(fed.size / 2))) {
        f.disabled = !f.disabled; am.setDisabled(byId(f.id).index, f.disabled);
      } else if (s.kind === 'cordon' && (f.cordoned || down < Math.floor(fed.size / 2))) {
        f.cordoned = !f.cordoned; am.setCordoned(byId(f.id).index, f.cordoned);
      }
    } else if (s.op === 'late' && f) {
      // docs/routing.md:88: it does not count as another denial.
      note('hold', stateOf(f), 'entitled-in-flight');
      am.markEntitlementDenied(byId(f.id).index, { detail: DENIAL, epoch: sentUnder.get(f.id) });
    } else if (s.op === 'remove' && x && f) {
      const acc = byId(x.id);
      const before = cur;
      const quotas = () => new Map(am.accounts.map((/** @type {any} */ a) => [a.id, JSON.stringify(a.quota)]));
      // Taken before the removal, as the in-flight request read its account.
      const headers = headersOf(x, /** @type {string} */ (s.model));
      // An operator's route pin, above the removed account unless the step
      // places it, so that the removal has a pin to renumber. Nothing else in a
      // history pins a route, so it is cleared once the removal is judged.
      const pinOn = s.pin === 'remove-at' ? [acc]
        : am.accounts.filter((/** @type {any} */ a) => (s.pin === 'remove-above' ? a.index < acc.index : a.index > acc.index));
      const pinned = pinOn.find((/** @type {any} */ a) => am.setRoutePin('fable', a.index).ok)?.id ?? null;
      // The manager keys its route cursors by route, which the model does not
      // track. The accounts they name are taken as the removal finds them.
      const named = (/** @type {Map<string, number>} */ m) => new Map([...m].map(([k, idx]) => [k, am.accounts[idx]?.id ?? null]));
      const routeCursors = named(am.routeCursors);
      const providerCursors = named(am.providerCursors);
      const pinsBefore = am.exportAffinityState();
      const where = (/** @type {number} */ k) => (acc.index < k ? 'remove-below' : acc.index === k ? 'remove-at' : 'remove-above');
      const indexOf = (/** @type {string|null} */ k) => (k == null ? -1 : byId(k)?.index ?? -1);
      // A removed account is judged on the next request (R1); a kept one at the
      // request that shows it kept its state: the next request for one in
      // rotation or in error, the probe 1 ms before its cooldown ends for one
      // held, and for one with denials counted, that probe of the cooldown its
      // next denial arms, whose length the count sets (docs/routing.md:88).
      for (const g of fed.values()) {
        const st = stateOf(g);
        const by = g.id === x.id || st === 'free' ? 'R1' : st === 'error' ? 'H3' : st === 'billed' ? 'H1' : 'H2';
        const atProbe = by === 'H1' || by === 'H2';
        pending.push({
          key: ['hold', st, g.id === x.id ? 'remove-self' : 'remove-other'],
          done: (ctx, ok, probed) => ok.has(by) && (!atProbe || probed.get(g.id) === 'end-1ms'),
        });
      }
      note('removal', 'cursor', where(am.currentIndex));
      for (const k of am.routeCursors.values()) note('removal', 'route-cursor', where(k));
      for (const k of am.providerCursors.values()) note('removal', 'provider-cursor', where(k));
      if (pinned != null) note('removal', 'route-pin', where(indexOf(pinned)));
      for (const conv of convs.values()) for (const k of conv.pins.values()) note('removal', 'session-pin', where(indexOf(k)));
      for (const g of fed.values()) if (g.u7d != null || g.u5h != null || g.f != null || g.id === x.id) note('removal', 'quota-reading', where(indexOf(g.id)));
      // A kept reading is judged when its account's roll is read on a request
      // O25 judges; a held roll, when traffic returns to the rolled account.
      if (preempting && curObs.on != null) {
        const on = curObs.on;
        const at = where(indexOf(on));
        if (at === 'remove-at') note('removal', 'rollover-reading', at);
        else pending.push({ key: ['removal', 'rollover-reading', at], done: (ctx, ok) => ok.has('O25') && ctx.cur === on && ctx.curRolled });
      }
      if (curObs.on === x.id && curObs.owed.size) {
        const owed = [...curObs.owed.keys()];
        pending.push({ key: ['removal', 'held-roll', 'remove-at'], done: (ctx, ok) => ok.has('O25') && owed.includes(ctx.cur) });
      }
      for (const [c, conv] of convs) {
        for (const [b, o] of conv.obs) {
          if (o.on === x.id && o.owed.size) {
            pending.push({ key: ['removal', 'pin-held-roll', 'remove-at'], done: (ctx, ok) => ok.has('O15') && ctx.c === c && ctx.bucket === b });
          }
        }
      }
      am.removeAccount(acc.index);
      const kept = quotas();
      am.updateQuota(acc.index, headers, s.model, 200);
      gone.add(x.id);
      for (const m of [truth, fed, lapsed, pausedUntil, released]) m.delete(x.id);
      for (const set of [sessionResets, requalify, probing]) set.delete(x.id);
      for (const [k, id] of [...lastRouted]) if (id === x.id) lastRouted.delete(k);
      bar();
      // A reading naming the removed account goes nameless if it holds rolls
      // owed to others, and away if not; every reading drops the roll it owed
      // the removed account. A doubt about which reading the manager holds
      // stays after the account the model's reading named is removed, so a
      // doubtful one is kept, nameless, whatever it holds.
      /** @param {Obs} o @returns {Obs|null} */
      const unname = o => {
        unsure(o);
        o.escaped.delete(x.id);
        o.owed.delete(x.id);
        o.stamps.delete(x.id);
        if (o.on !== x.id) return o;
        // The new reading keeps the count of moves, so no later move takes a
        // stamp an escape kept from before the removal.
        return o.escaped.size || o.uncertain
          ? { ...newObs(), escaped: o.escaped, uncertain: o.uncertain, owed: o.owed, stamps: o.stamps, gen: o.gen } : null;
      };
      for (const conv of convs.values()) {
        for (const [b, id] of [...conv.pins]) if (id === x.id) { conv.pins.delete(b); conv.pinAt.delete(b); }
        for (const [b, o] of [...conv.obs]) {
          const left = unname(o);
          if (left) conv.obs.set(b, left); else conv.obs.delete(b);
        }
      }
      const held = unname(curObs);
      curObs = held ?? newObs();
      // No docs line says where a cursor on the removed account goes, and there
      // the model follows the manager. Any other cursor stays on its account
      // (docs/routing.md:19).
      cur = before === x.id ? cursor() : before;
      // A roll moves the sticky current account only with preempt on
      // (docs/routing.md:409); without it the moved cursor is plain
      // stickiness (docs/routing.md:19), judged as any other.
      if (preempting && before === x.id) {
        // A cursor moved by the removal is offered the reading its account's
        // removal left. docs/routing.md:417 lists the first placements whose
        // roll is not detected and does not name this one, and no other docs
        // line covers it, so its first roll is left unjudged.
        // A reading handed back there is the one read before its roll.
        const back = held != null && held.on == null && cur != null && handBack(curObs, /** @type {Fed} */ (fed.get(cur)), fed, step);
        if (!back) {
          if (held && held.on == null && cur != null) firstSight(curObs, /** @type {Fed} */ (fed.get(cur)), fed, step);
          curObs.uncertain = true;
        }
      }
      const pinAfter = pinned == null ? null : am.getRoutePin('fable')?.id ?? null;
      check({
        removal: true, i, now, row, removed: x.id, cursorBefore: before, cursorAfter: cursor(), kept, after: quotas(),
        routeCursors, routeCursorsAfter: named(am.routeCursors), providerCursors, providerCursorsAfter: named(am.providerCursors),
        pinned, pinAfter, pinsBefore, pinsAfter: am.exportAffinityState(), left: am.accounts.length,
      });
      if (pinned != null) am.clearRoutePin('fable');
    } else if (s.op === 'untagged' || s.op === 'request' || s.op === 'throttle' || s.op === 'fault') {
      const model = /** @type {string} */ (s.model);
      const tagged = s.op !== 'untagged';
      const c = /** @type {string} */ (s.c);
      /** @type {Conv|undefined} */
      let conv = tagged ? convs.get(c) : undefined;
      if (tagged) am.beginSession(c);
      let revived = false;
      if (conv && now - conv.lastSeen > KNOWN_TTL) {
        // Forgotten per the docs. The manager drops the record only once
        // something sweeps or reads it, so its own next request can bring the
        // old pins back; the model follows the manager so that later steps are
        // judged on the state that is really there.
        if (am.sessionTracker.pinnedAccounts(c).length) revived = true;
        else { convs.delete(c); conv = undefined; }
      }
      const bucket = bucketOf(model);
      noticeResets();
      // Throttle steps declare no advisor, so a hop is judged on the request model.
      const adv = s.advisor && (s.op === 'request' || s.op === 'fault') && advising ? advisorRouting(fed, model, s.advisor, row) : null;
      const key = cursorKeyOf(model, adv?.routed ?? null);
      // The readings _pickActiveAccount takes before it decides.
      let curRolled = false;
      let pinRolled = false;
      if (preempting && cur != null) curRolled = restOn(curObs, /** @type {Fed} */ (fed.get(cur)), model, fed, lapsed.get(cur), i);
      const pinNow = conv?.pins.get(bucket);
      let pinUncertain = false;
      // The account the bucket's reading names, and whether its governing
      // window rolled since: the walk checks it for every pin it tries
      // (_pinRolledOver).
      /** @type {string|null} */
      let readOn = null;
      let readRolled = false;
      /** @type {Set<string>} */
      let readEscaped = new Set();
      let pinReturned = false;
      let pinHeld = false;
      // The stamp the request selects under, read before its walk.
      const carriedGen = conv?.obs.get(bucket)?.gen ?? null;
      if (preempting && conv) {
        let o = conv.obs.get(bucket);
        if (pinNow != null) {
          if (!o) { o = newObs(); conv.obs.set(bucket, o); }
          // A pin the request may not be sent to is not read (_restOnPin), so the
          // reading can still name another of the conversation's pins.
          if (!adv?.excluded.has(pinNow)) pinRolled = restOn(o, /** @type {Fed} */ (fed.get(pinNow)), model, fed, lapsed.get(pinNow), i);
          pinReturned = o.returned && o.on === pinNow;
          pinHeld = restoredRolled(o, /** @type {Fed} */ (fed.get(pinNow)), model);
        }
        // A bucket whose pin a removal dropped keeps its reading unread, and
        // the walk still checks it against the conversation's other pins.
        if (o) {
          pinUncertain = o.uncertain;
          readOn = o.on;
          readEscaped = new Set(o.escaped);
          if (o.on != null) {
            const r = /** @type {Fed} */ (fed.get(o.on));
            if (rolledSince(o, r, model)) {
              if (o.stale.has(governing(r, model).window)) pinUncertain = true;
              else readRolled = true;
            }
          }
        }
      }
      const ctx = {
        i, op: s.op, now, row, ex, model, bucket, tagged, c, revived, cur, life, curRolled, pinRolled, pinUncertain, pinReturned, pinHeld, readOn, readRolled, readEscaped,
        curUncertain: curObs.uncertain || (row.sessionReset && sessionResets.size > 0),
        curObsUncertain: curObs.uncertain,
        // With distribution off a family stays where it was last routed while
        // the cursor cannot serve it.
        famCur: lastRouted.get(key) ?? null,
        adv,
        // Live: the check runs before the decision is served.
        fed,
        conv: conv ? { pins: new Map(conv.pins), pinAt: new Map(conv.pinAt), lastSeen: conv.lastSeen } : null,
        convs, routed, sessionResets: new Set(sessionResets), requalify: new Set(requalify), history: h, routes, reloaded, d: '-',
        released: new Map(released), edge,
      };
      if (!edge) released.clear();
      const carried = tagged ? am.observedGeneration(c, model) : null;
      // A cordon or a disable moves the cursor between requests; that move is
      // not this request's.
      ctx.curBefore = cursor();
      /** @type {{ rolledOff?: Set<number> }} */
      const selection = {};
      const acc = am.getActiveAccount(null, model, adv?.advisor ?? null, tagged ? c : null, undefined, selection);
      for (const l of lapsed.values()) l.clear();
      const d = acc?.id ?? '-';
      ctx.d = d;
      // Probed before anything is served, at the instant of the decision, and
      // only when an invariant asks. An account inside its 429 pause holds
      // every request, so it is not probed. `rampFrom` is when the account's
      // ramp counts from, which sets its cap past the slots probed.
      ctx.curAfter = cursor();
      ctx.admits = (/** @type {number} */ limit) => (acc && !((pausedUntil.get(d) ?? -Infinity) > now) ? admitted(acc, limit) : null);
      ctx.rampFrom = () => acc?.rampStartedAt ?? null;
      if (!edge) judged(ctx, check(ctx), probed);
      if (acc) lastRouted.set(key, d);
      cur = cursor();
      // Moving the cursor takes a first reading of its new account (_setCurrent).
      // A session-reset switch earlier in the same walk may have taken one too,
      // which curUncertain allows for.
      if (preempting && cur != null && cur !== ctx.cur) firstSight(curObs, /** @type {Fed} */ (fed.get(cur)), fed, step);
      // With expiry routing on, a reset stays pending while the request could
      // not be sent to the account, or not to the cursor (refreshExpiredQuotas).
      if (!ex.enabled) sessionResets = new Set();
      else {
        // An advised request settles the event on both its models, outside the
        // advisor-capped accounts, while some account can serve both.
        const both = adv?.routed != null && adv.both.length > 0;
        const usable = (/** @type {string|null} */ id) => id != null && unavailable(/** @type {Fed} */ (ctx.fed.get(id)), model, row.threshold) == null
          && !adv?.excluded.has(id) && (!both || servesAdvisor(/** @type {Fed} */ (ctx.fed.get(id)), /** @type {any} */ (adv).advisor, row.threshold));
        if (usable(ctx.cur)) for (const id of [...sessionResets]) if (usable(id)) sessionResets.delete(id);
      }
      /** @type {Obs|null} */
      let sighted = null;
      /** @type {any} */
      let hop = null;
      if (acc) {
        if (tagged) am.recordSession(c, acc.index, model);
        const kept = tagged && conv && [...conv.pins.values()].includes(acc.id) && fed.get(acc.id)?.cordoned;
        if (row.dist === 'off' && !kept) {
          // The walk consumes the cursor's flag, and a move re-arms probing on
          // an account whose weekly reset is still unknown (_selectNext).
          // A session-reset switch can move the cursor before the walk reads the
          // flag, which then stays, also when the walk then picks the cursor's
          // account again. Which of the two happened is not observable, so the
          // flag is kept: the invariants read it only to excuse a move.
          const mayHaveSwitched = row.sessionReset && [...ctx.sessionResets].some(id => id !== ctx.cur);
          if (ctx.cur != null && !mayHaveSwitched) requalify.delete(ctx.cur);
          // The re-rank a flagged cursor runs (_selectNext) re-arms probing on
          // whatever it picks, the cursor's own account included.
          if (acc.id !== ctx.cur || ctx.requalify.has(acc.id)) {
            if (/** @type {Fed} */ (fed.get(acc.id)).r7d == null) probing.add(acc.id); else probing.delete(acc.id);
          }
        }
        if (tagged && preempting) {
          sighted = conv?.obs.get(bucket) ?? newObs();
          firstSight(sighted, /** @type {Fed} */ (fed.get(d)), fed, step);
        }
        if (s.op === 'throttle') {
          hop = throttle(acc, selection, ctx, sighted);
        } else if (s.op === 'fault') {
          hop = refuse(acc, /** @type {string} */ (s.kind), ctx, sighted);
          // The failover is a selection of its own, and the manager records
          // the family's diversion on the account it goes to.
          if (hop) lastRouted.set(key, hop.id);
        } else {
          serve(acc, model, tagged, tagged ? c : null);
          if (tagged) am.confirmStay(acc, carried, c, 'anthropic');
          // Only a plain request is settled here: a hop or failover may settle
          // in the manager too, so throttle() and refuse() call unsure() instead.
          if (sighted && carriedGen != null && sighted.on === d && sighted.gen === carriedGen) {
            // The rollover table's settle and later-stamp rows show only when
            // the conversation returns to the account the move left.
            const stamps = [...sighted.stamps.values()];
            const back = (/** @type {string} */ id, /** @type {string} */ seen) =>
              pending.push({ key: id, done: (x, ok) => ok.has('O28') && x[seen] && x.c === c && x.bucket === bucket });
            if (stamps.includes(carriedGen)) back('RO-settle', 'pinReturned');
            if (stamps.some(g => g != null && g < carriedGen)) back('RO-later-stamp', 'pinHeld');
            settleMove(sighted, carriedGen);
          }
        }
      }
      if (tagged) am.endSession(c);
      /** @type {Decision} */
      const rec = { i, op: s.op, model, d };
      if (hop) rec.to = hop.id;
      if (tagged) {
        rec.c = c;
        rec.pin = conv?.pins.get(bucket) ?? null;
        if (!conv) { conv = { pins: new Map(), pinAt: new Map(), lastSeen: now, obs: new Map() }; convs.set(c, conv); }
        if (acc) {
          conv.pins.set(bucket, d);
          conv.pinAt.set(bucket, now);
          if (sighted) conv.obs.set(bucket, sighted);
          /** @type {number[]} */ (routed.get(d)).push(now);
          if (hop) {
            conv.pins.set(bucket, hop.id);
            /** @type {number[]} */ (routed.get(hop.id)).push(now);
          }
        } else {
          // endRequest ages the newest pin to now whether or not it was served.
          let newest = null;
          for (const [b, at] of conv.pinAt) if (newest == null || at > /** @type {number} */ (conv.pinAt.get(newest))) newest = b;
          if (newest != null) conv.pinAt.set(newest, now);
        }
        conv.lastSeen = now;
      }
      out.push(rec);
    }
    if (s.reload && row.routes === 'layered') {
      // The server's reload re-applies every setting; only the table differs
      // here, so only it is set.
      routes = /** @type {{ next: Route[] }} */ (h.routeTables).next;
      reloaded = true;
      am.setRoutes(routes);
      bar();
    }
    if (s.restart || restarts.includes(i)) {
      const saved = JSON.parse(JSON.stringify({ quota: am.exportQuotaState(), affinity: am.exportAffinityState() }));
      const rows = configRows().reverse();
      const next = new AccountManager(rows, row.threshold, options());
      next.restoreQuotaState(saved.quota);
      noticeResets();
      if (!ex.enabled) sessionResets = new Set();
      if (row.persist || driver.restoreAlways) next.restoreAffinityState(saved.affinity);
      next.selectActiveAccount();
      for (const l of lapsed.values()) l.clear();
      // The constructor's own reading is dropped once its settings are
      // applied, so the reading is startup's pick, of restored quota, even when
      // the pick stays on the constructor's account. A pick that finds nothing
      // available moves nothing and leaves no reading; the first request takes it.
      const first = next.accounts[next.currentIndex]?.id ?? null;
      curObs = newObs();
      if (first != null) {
        curObs.on = first;
        if ([...fed.values()].some(a => startable(a, row.threshold))) curObs.windows = windowsOf(/** @type {Fed} */ (fed.get(first)));
      }
      check({ restart: true, i, now, row, before: saved.affinity, after: next.exportAffinityState(), convs });
      am = next;
      life++;
      // A restart rebuilds the readings a wait may name.
      pending = [];
      cur = cursor();
      lastRouted = new Map();
      pausedUntil = new Map();
      requalify = new Set();
      probing = new Set(h.accounts.filter(a => !gone.has(a.id)).map(a => a.id));
      // The load ring is not saved.
      for (const v of routed.values()) v.length = 0;
      if (!row.persist && !driver.restoreAlways) convs = new Map();
      else {
        for (const [k, v] of convs) {
          if (now - v.lastSeen > KNOWN_TTL) convs.delete(k);
          else v.obs = new Map();
        }
      }
    }
  });
  return out;
}

// ---- the matrix ------------------------------------------------------------------

/** The option values a row picks from. `tolerance`, `preempt` and `reclaim`
 * mean something only with expiry routing on, so they are null otherwise. */
export const DIMENSIONS = {
  dist: ['off', 'even', 'load', 'adaptive', 'adaptive-pressure', 'adaptive-pressure-5h', 'adaptive-pressure-soft'],
  expiry: ['absent', 'written-off', 'on'],
  tolerance: [1, 1.5, 3],
  preempt: [true, false],
  reclaim: ['0', '24', '24-across'],
  soonest: [false, true],
  sessionReset: [true, false],
  persist: [false, true],
  threshold: ['0.98', 'per-bucket'],
  // `fable`: the history's own single Fable route, or none; `layered`: its
  // tables of several routes, swapped by a reload.
  routes: ['fable', 'layered'],
  // `none`: no request declares an advisor; otherwise a share of the Opus
  // requests declare a Fable one, routed under that setting.
  advisorEligibility: ['none', 'strict', 'prefer'],
  // The config's `stormRamp` block, one of RAMPS.
  stormRamp: ['default', 'off', 'tuned', 'malformed'],
};
const EXPIRY_ONLY = ['tolerance', 'preempt', 'reclaim'];
// The dimensions toRow reshapes or names by hand. Any other passes to the Row
// under its own name, and into the row's name when the cell sets it.
const SHAPED = ['dist', 'expiry', ...EXPIRY_ONLY, 'soonest', 'sessionReset', 'persist', 'threshold'];

/** @typedef {Record<string, any>} Cell  one value per dimension */

/** The Row a cell stands for, named so that a failure can be replayed by name.
 * @param {Cell} cell @param {string} [profile] @returns {Row} */
export function toRow(cell, profile) {
  const expiry = cell.expiry === 'absent' ? undefined
    : cell.expiry === 'written-off' ? { enabled: false, tolerance: 3, preempt: false, reclaimHours: 24 }
      : {
        enabled: true, tolerance: cell.tolerance, preempt: cell.preempt,
        ...(cell.reclaim === 'unset' ? {} : { reclaimHours: cell.reclaim === '0' ? 0 : 24 }),
        ...(cell.reclaim === '24-across' ? { reclaimAcrossOrganizations: true } : {}),
      };
  const ex = cell.expiry === 'on' ? `on/t${cell.tolerance}/${cell.preempt ? 'preempt' : 'nopreempt'}/r${cell.reclaim}` : cell.expiry;
  const rest = Object.keys(DIMENSIONS).filter(d => !SHAPED.includes(d));
  const name = `${profile ? `[${profile}] ` : ''}dist=${cell.dist} expiry=${ex} soonest=${+cell.soonest} `
    + `sessionReset=${+cell.sessionReset} persist=${+cell.persist} thr=${cell.threshold}`
    + rest.filter(d => cell[d] != null).map(d => ` ${d}=${cell[d]}`).join('');
  return {
    ...Object.fromEntries(rest.map(d => [d, cell[d]])),
    name, dist: cell.dist, expiry, soonest: cell.soonest, sessionReset: cell.sessionReset, persist: cell.persist,
    threshold: cell.threshold === '0.98' ? 0.98 : { default: 0.98, unified7d: 0.85 },
  };
}

/** @param {Cell} cell */
const validCell = cell => EXPIRY_ONLY.every(k => (cell.expiry === 'on') === (cell[k] != null));

/** Every pair of values of `dims` a valid row can hold, as keys.
 * @param {string[]} dims */
function allPairs(dims) {
  /** @type {string[]} */
  const out = [];
  dims.forEach((a, i) => dims.slice(i + 1).forEach(b => {
    for (const va of /** @type {any} */ (DIMENSIONS)[a]) {
      for (const vb of /** @type {any} */ (DIMENSIONS)[b]) {
        const needsOn = EXPIRY_ONLY.includes(a) || EXPIRY_ONLY.includes(b);
        if (needsOn && ((a === 'expiry' && va !== 'on') || (b === 'expiry' && vb !== 'on'))) continue;
        out.push(`${a}=${va}|${b}=${vb}`);
      }
    }
  }));
  return out;
}

/** @param {Cell} cell @param {string[]} dims */
function pairsOf(cell, dims) {
  const set = dims.filter(d => cell[d] != null);
  /** @type {string[]} */
  const out = [];
  set.forEach((a, i) => set.slice(i + 1).forEach(b => out.push(`${a}=${cell[a]}|${b}=${cell[b]}`)));
  return out;
}

// Options grown onto the rows the others make, in this order, rather than
// built into them: adding one leaves the earlier rows, and so the seeds on
// which they catch a broken rule, as they were.
const GROWN = ['advisorEligibility', 'stormRamp'];

/**
 * A covering array over DIMENSIONS: the given rows first, then rows added
 * greedily until every pair of values of any two dimensions is in one. Each
 * candidate row starts from one pair still missing and takes, dimension by
 * dimension, the value that covers the most missing pairs; of the candidates
 * started from the first few missing pairs the one covering most is kept.
 * Ties go to the first, so the array is the same on every run. A GROWN option
 * is then given to each added row, the value covering the most of its missing
 * pairs, and rows are added as before for the pairs still missing; the given
 * rows leave it unset.
 * @param {Cell[]} seeds @returns {Cell[]}
 */
export function coveringArray(seeds) {
  const all = Object.keys(DIMENSIONS);
  let dims = all.filter(d => !GROWN.includes(d));
  let missing = new Set(allPairs(dims));
  const rows = [...seeds];
  for (const r of rows) for (const k of pairsOf(r, dims)) missing.delete(k);
  /** @param {string} first */
  const build = first => {
    /** @type {Cell} */
    const cell = {};
    for (const half of first.split('|')) {
      const [d, v] = half.split('=');
      cell[d] = /** @type {any} */ (DIMENSIONS)[d].find((/** @type {any} */ x) => String(x) === v);
    }
    if (EXPIRY_ONLY.some(k => cell[k] != null)) cell.expiry = 'on';
    for (const d of dims) {
      if (d in cell) continue;
      if (EXPIRY_ONLY.includes(d) && cell.expiry !== 'on') { cell[d] = null; continue; }
      let best = null; let bestGain = -1;
      for (const v of /** @type {any} */ (DIMENSIONS)[d]) {
        const gain = pairsOf({ ...cell, [d]: v }, dims).filter(k => missing.has(k)).length;
        if (gain > bestGain) { best = v; bestGain = gain; }
      }
      cell[d] = best;
    }
    return cell;
  };
  const fill = () => {
    while (missing.size) {
      let best = null; let bestGain = -1;
      for (const first of [...missing].slice(0, 24)) {
        const cell = build(first);
        const gain = pairsOf(cell, dims).filter(k => missing.has(k)).length;
        if (gain > bestGain) { best = cell; bestGain = gain; }
      }
      for (const k of pairsOf(/** @type {Cell} */ (best), dims)) missing.delete(k);
      rows.push(/** @type {Cell} */ (best));
    }
  };
  fill();
  for (const g of GROWN) {
    const covered = new Set(allPairs(dims));
    dims = all.filter(d => d === g || dims.includes(d));
    missing = new Set(allPairs(dims).filter(k => !covered.has(k)));
    for (const r of rows.slice(seeds.length)) {
      let best = null; let bestGain = -1;
      for (const v of /** @type {any} */ (DIMENSIONS)[g]) {
        const gain = pairsOf({ ...r, [g]: v }, dims).filter(k => missing.has(k)).length;
        if (gain > bestGain) { best = v; bestGain = gain; }
      }
      r[g] = best;
      for (const k of pairsOf(r, dims)) missing.delete(k);
    }
    fill();
  }
  return rows;
}

/** Every valid cell: the full constrained product. @returns {Cell[]} */
export function productCells() {
  /** @type {Cell[]} */
  let cells = [{}];
  for (const [d, values] of Object.entries(DIMENSIONS)) {
    cells = cells.flatMap(c => [...values, null].map(v => ({ ...c, [d]: v })));
  }
  return cells.filter(c => validCell(c) && Object.keys(DIMENSIONS).every(d => EXPIRY_ONLY.includes(d) || c[d] != null));
}

// ---- shrinking ---------------------------------------------------------------------

/**
 * Removes steps from a failing history while `fails` still holds: chunks of
 * half the steps, then quarters, down to single steps. Account pools and each
 * step's time are kept, and a restart travels with the step it follows.
 * @param {History} h @param {(h: History) => boolean} fails @param {number} [budget]
 * @returns {{ history: History, runs: number }}
 */
export function shrink(h, fails, budget = 300) {
  let steps = h.steps;
  let runs = 0;
  for (let size = Math.ceil(steps.length / 2); size >= 1 && runs < budget; size = size === 1 ? 0 : Math.ceil(size / 2)) {
    for (let at = 0; at < steps.length && runs < budget;) {
      const candidate = [...steps.slice(0, at), ...steps.slice(at + size)];
      runs++;
      if (candidate.length && fails({ ...h, steps: candidate })) steps = candidate;
      else at += size;
    }
  }
  return { history: { ...h, steps }, runs };
}
