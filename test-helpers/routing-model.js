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
const EPISODE_RATE = 0.35;
const ROLL_EPISODE_RATE = 0.3;
const SERVE_BURN = 0.004;
const SERVE_BURN_5H = 0.02;
const LETTERS = 'abcdef';

/**
 * @typedef {{ id: string, priority: number, org: string|null, maxUsage: any, endsAt: number|null,
 *   hidden7d: boolean, clockless7d: boolean, clocklessF: boolean,
 *   u5h: number, r5h: number, u7d: number, r7d: number, F: number|null, FR: number|null }} PoolAccount
 * @typedef {{ at: number, op: string, c?: string, model?: string, id?: string, u7d?: number,
 *   f?: number|null, u5h?: number, fable?: boolean, kind?: string, restart?: boolean }} Step
 * @typedef {{ seed: number, start: number, accounts: PoolAccount[], fableRoute: string[]|null, steps: Step[] }} History
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
  const rollAt = extra2() < ROLL_EPISODE_RATE ? 0 : -1;
  for (let i = 0; i < STEPS; i++) {
    if (i === episodeAt) at = priorityEpisode(steps, accounts, convs, at, extra);
    if (i === rollAt) at = rollEpisode(steps, accounts, convs, at, extra2);
    at += int(1, 30) * SEC;
    const r = rand();
    if (r < 0.5) steps.push({ at, op: 'request', c: convs[int(0, convs.length - 1)], model: model() });
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
  return { seed, start, accounts, fableRoute, steps };
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

/**
 * What the manager has been told about one account, plus the pool facts it was
 * configured with. Readings go null when their reset passes, as
 * _clearExpiredQuotas does.
 * @typedef {{ id: string, priority: number, org: string|null, maxUsage: any, endsAt: number|null,
 *   fableRouted: boolean, disabled: boolean, cordoned: boolean,
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
  if (a.u5h != null && a.u5h >= thresholdOf(threshold, 'unified5h')) return 'quota';
  const weekly = model === FABLE && a.f != null ? Math.max(a.f, a.u7d ?? -Infinity) : a.u7d;
  if (weekly != null && weekly >= thresholdOf(threshold, bucketOf(model))) return 'quota';
  if (model === FABLE && !a.fableRouted) return 'route';
  if (a.cordoned) return 'cordoned';
  return null;
}

/** @param {Fed} a @param {string} model */
export function atCap(a, model) {
  const hit = (/** @type {number|null} */ cap, /** @type {number|null} */ used) => cap != null && (cap <= 0 || (used != null && used >= cap));
  if (a.maxUsage == null) return false;
  if (hit(capOf(a.maxUsage, 'unified5h'), a.u5h)) return true;
  if (hit(capOf(a.maxUsage, 'unified7d'), a.u7d)) return true;
  return model === FABLE && hit(capOf(a.maxUsage, 'unified7dFable'), a.f);
}

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
 * the account traffic was last found resting on. Hand-backs are not modeled:
 * `escaped` holds the accounts left while rolled, and a reading moved onto one
 * of them is `uncertain`, since the manager may restore an older reading there.
 * That older reading has rolled, so it refuses a first sight onto the next
 * account, and the doubt moves with the reading.
 * @typedef {{ on: string|null, windows: Map<string, number>, escaped: Set<string>, uncertain: boolean }} Obs
 */

/** @returns {Obs} */
export const newObs = () => ({ on: null, windows: new Map(), escaped: new Set(), uncertain: false });

/** Whether any window `a` presents jumped past the reading (_anyJumped).
 * @param {Obs} obs @param {Fed} a */
function anyRolled(obs, a) {
  for (const [w, r] of windowsOf(a)) {
    const seen = obs.windows.get(w);
    if (seen != null && r - seen > ROLL_JUMP) return true;
  }
  return false;
}

/** Moves the reading onto `a`, noting a roll left behind.
 * @param {Obs} obs @param {Fed} a @param {Map<string, Fed>} fed */
function moveObs(obs, a, fed) {
  const leaving = obs.on == null ? null : fed.get(obs.on);
  if (leaving && anyRolled(obs, leaving)) obs.escaped.add(leaving.id);
  obs.on = a.id;
  obs.windows = windowsOf(a);
  obs.uncertain = obs.escaped.has(a.id);
}

/** The reading recordSession takes of a pin's new account (_firstSightOn):
 * none while the account left behind has an unsettled roll.
 * @param {Obs} obs @param {Fed} a @param {Map<string, Fed>} fed */
export function firstSight(obs, a, fed) {
  if (obs.on === a.id) return;
  const leaving = obs.on == null ? null : fed.get(obs.on);
  if (leaving && anyRolled(obs, leaving)) { obs.escaped.add(leaving.id); return; }
  const doubt = obs.uncertain;
  moveObs(obs, a, fed);
  obs.uncertain ||= doubt;
}

/** Whether the governing window of `a` jumped past the reading (_jumped).
 * @param {Obs} obs @param {Fed} a @param {string} model */
export function rolledSince(obs, a, model) {
  if (obs.on !== a.id) return false;
  const g = governing(a, model);
  const seen = obs.windows.get(g.window);
  return seen != null && g.reset != null && g.reset - seen > ROLL_JUMP;
}

/** Takes the reading at the start of a request, as _restOn does when nothing
 * is handed back. Returns whether the governing window had rolled.
 * @param {Obs} obs @param {Fed} a @param {string} model @param {Map<string, Fed>} fed */
export function restOn(obs, a, model, fed) {
  if (obs.on !== a.id) { moveObs(obs, a, fed); return false; }
  const g = governing(a, model);
  if (g.reset == null) return false;
  if (rolledSince(obs, a, model)) return true;
  obs.windows.set(g.window, g.reset);
  for (const [w, r] of windowsOf(a)) if (!obs.windows.has(w)) obs.windows.set(w, r);
  // A doubt carried in by a first sight settles at a rest that finds no window
  // moved: whichever reading the manager held, it is on this account now.
  if (obs.uncertain && !obs.escaped.has(a.id) && !anyRolled(obs, a)) obs.uncertain = false;
  return false;
}

/**
 * @typedef {{ pins: Map<string, string>, pinAt: Map<string, number>, lastSeen: number,
 *   obs: Map<string, Obs> }} Conv
 * @typedef {{ i: number, op: string, c?: string, model?: string, d: string, pin?: string|null, kind?: string }} Decision
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
 * @param {(ctx: any) => void} [p.check]
 * @param {{ restoreAlways?: boolean }} [p.driver]
 * @returns {Decision[]}
 */
export function play({ AccountManager, validateAdaptiveConfig, t, history: h, row, restarts = [], check = () => {}, driver = {} }) {
  const ex = expiryOf(row);
  t.mock.timers.setTime(h.start);
  /** @type {Map<string, PoolAccount>} */
  const truth = new Map(h.accounts.map(a => [a.id, { ...a }]));
  /** @type {Map<string, Fed>} */
  const fed = new Map(h.accounts.map(a => [a.id, {
    id: a.id, priority: a.priority, org: a.org, maxUsage: a.maxUsage, endsAt: a.endsAt,
    fableRouted: !h.fableRoute || h.fableRoute.includes(a.id), disabled: false, cordoned: false,
    u5h: null, r5h: null, u7d: null, r7d: null, f: null, fr: null,
  }]));
  const configRows = () => h.accounts.map(a => ({
    id: a.id, name: a.id, type: 'oauth', accessToken: `synthetic-${a.id}`, refreshToken: `synthetic-r-${a.id}`,
    expiresAt: h.start + 30 * 24 * H, accountUuid: `uuid-${a.id}`,
    ...(a.org ? { orgUuid: a.org } : {}),
    priority: a.priority,
    ...(a.maxUsage != null ? { maxUsage: a.maxUsage } : {}),
    ...(a.endsAt != null ? { endsAt: a.endsAt } : {}),
    ...(fed.get(a.id)?.disabled ? { disabled: true } : {}),
    ...(fed.get(a.id)?.cordoned ? { cordoned: true } : {}),
  }));
  const options = () => ({
    ...managerOptions(row, validateAdaptiveConfig),
    ...(h.fableRoute ? { routes: [{ name: 'fable', match: ['*fable*'], accounts: h.fableRoute }] } : {}),
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
      f.u7d = x.u7d; if (!x.clockless7d) f.r7d = x.r7d;
    }
    if (what.fable && x.F != null) {
      usage.sevenDayFable = { utilization: x.F, ...(x.clocklessF ? {} : { resetAt: x.FR }) };
      // A family reading replaces its reset, with none when it names none.
      f.f = x.F; f.fr = x.clocklessF ? null : x.FR;
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
  /** @type {string|null} */
  let cur = null;
  // Accounts whose 5h reset the manager has noticed and not yet acted on. It
  // notices only when it reads the quota, so a reading that replaces an
  // expired one first raises nothing.
  /** @type {Set<string>} */
  let sessionResets = new Set();
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
  // Where each model was last routed. The manager keeps a family diverted off
  // a cursor that cannot serve it on that account (_divertedFor); this is the
  // same record, taken from the decisions rather than from the manager's
  // private state, and like the manager's it is not saved across a restart.
  /** @type {Map<string, string>} */
  let lastRouted = new Map();

  const serve = (/** @type {any} */ acc, /** @type {string} */ model, /** @type {boolean} */ burn) => {
    const x = /** @type {PoolAccount} */ (truth.get(acc.id));
    if (burn) {
      x.u7d = r3(x.u7d + SERVE_BURN);
      x.u5h = r3(x.u5h + SERVE_BURN_5H);
      if (model === FABLE && x.F != null) x.F = r3(x.F + SERVE_BURN);
    }
    am.updateQuota(acc.index, headersOf(x, model), model, 200);
    noteReading(acc.id);
  };

  h.steps.forEach((s, i) => {
    t.mock.timers.setTime(s.at);
    const now = s.at;
    for (const x of truth.values()) {
      let weekly = false; let fable = false;
      while (x.r7d <= now) { x.r7d += WEEK; x.u7d = 0; weekly = true; }
      while (x.FR != null && x.FR <= now) { x.FR += WEEK; x.F = 0; fable = true; }
      while (x.r5h <= now) { x.r5h += 5 * H; x.u5h = 0; }
      const f = /** @type {Fed} */ (fed.get(x.id));
      if (f.r7d != null && now >= f.r7d) { f.u7d = null; f.r7d = null; }
      if (f.fr != null && now >= f.fr) { f.f = null; f.fr = null; }
      // A reading the manager holds is refreshed when its window rolls; one it
      // has never been told stays unknown until a response reveals it.
      if ((weekly && (f.u7d != null || !x.hidden7d)) || (fable && f.f != null)) {
        feedUsage(x, { weekly: weekly && (f.u7d != null || !x.hidden7d), fable: fable && f.f != null });
      }
    }
    const x = s.id ? /** @type {PoolAccount} */ (truth.get(s.id)) : null;
    const f = s.id ? /** @type {Fed} */ (fed.get(s.id)) : null;
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
    } else if (s.op === 'untagged' || s.op === 'request') {
      const model = /** @type {string} */ (s.model);
      const tagged = s.op === 'request';
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
      // The readings _pickActiveAccount takes before it decides.
      let curRolled = false;
      let pinRolled = false;
      if (preempting && cur != null) curRolled = restOn(curObs, /** @type {Fed} */ (fed.get(cur)), model, fed);
      const pinNow = conv?.pins.get(bucket);
      let pinUncertain = false;
      if (preempting && conv && pinNow != null) {
        let o = conv.obs.get(bucket);
        if (!o) { o = newObs(); conv.obs.set(bucket, o); }
        pinRolled = restOn(o, /** @type {Fed} */ (fed.get(pinNow)), model, fed);
        pinUncertain = o.uncertain;
      }
      const ctx = {
        i, now, row, ex, model, bucket, tagged, c, revived, cur, life, curRolled, pinRolled, pinUncertain,
        curUncertain: curObs.uncertain || (row.sessionReset && sessionResets.size > 0),
        curObsUncertain: curObs.uncertain,
        // With distribution off a family stays where it was last routed while
        // the cursor cannot serve it.
        famCur: lastRouted.get(model) ?? null,
        // Live: the check runs before the decision is served.
        fed,
        conv: conv ? { pins: new Map(conv.pins), pinAt: new Map(conv.pinAt), lastSeen: conv.lastSeen } : null,
        convs, routed, sessionResets: new Set(sessionResets), requalify: new Set(requalify), history: h, d: '-',
      };
      const carried = tagged ? am.observedGeneration(c, model) : null;
      const acc = am.getActiveAccount(null, model, null, tagged ? c : null);
      const d = acc?.id ?? '-';
      ctx.d = d;
      check(ctx);
      if (acc) lastRouted.set(model, d);
      cur = cursor();
      // Moving the cursor takes a first reading of its new account (_setCurrent).
      // A session-reset switch earlier in the same walk may have taken one too,
      // which curUncertain allows for.
      if (preempting && cur != null && cur !== ctx.cur) firstSight(curObs, /** @type {Fed} */ (fed.get(cur)), fed);
      // With expiry routing on, a reset stays pending while the request could
      // not be sent to the account, or not to the cursor (refreshExpiredQuotas).
      if (!ex.enabled) sessionResets = new Set();
      else {
        const usable = (/** @type {string|null} */ id) => id != null && unavailable(/** @type {Fed} */ (ctx.fed.get(id)), model, row.threshold) == null;
        if (usable(ctx.cur)) for (const id of [...sessionResets]) if (usable(id)) sessionResets.delete(id);
      }
      /** @type {Obs|null} */
      let sighted = null;
      if (acc) {
        if (tagged) am.recordSession(c, acc.index, model);
        const kept = tagged && conv && [...conv.pins.values()].includes(acc.id) && fed.get(acc.id)?.cordoned;
        if (row.dist === 'off' && !kept) {
          // The walk consumes the cursor's flag, and a move re-arms probing on
          // an account whose weekly reset is still unknown (_selectNext).
          // A session-reset switch can move the cursor before the walk reads the
          // flag, which then stays. Which of the two happened is not observable,
          // so the flag is kept: the invariants read it only to excuse a move.
          const switched = row.sessionReset && ctx.sessionResets.size > 0 && acc.id !== ctx.cur;
          if (ctx.cur != null && !switched) requalify.delete(ctx.cur);
          if (acc.id !== ctx.cur) {
            if (/** @type {Fed} */ (fed.get(acc.id)).r7d == null) probing.add(acc.id); else probing.delete(acc.id);
          }
        }
        if (tagged && preempting) {
          sighted = conv?.obs.get(bucket) ?? newObs();
          firstSight(sighted, /** @type {Fed} */ (fed.get(d)), fed);
        }
        serve(acc, model, tagged);
        if (tagged) am.confirmStay(acc, carried, c, 'anthropic');
      }
      if (tagged) am.endSession(c);
      /** @type {Decision} */
      const rec = { i, op: s.op, model, d };
      if (tagged) {
        rec.c = c;
        rec.pin = conv?.pins.get(bucket) ?? null;
        if (!conv) { conv = { pins: new Map(), pinAt: new Map(), lastSeen: now, obs: new Map() }; convs.set(c, conv); }
        if (acc) {
          conv.pins.set(bucket, d);
          conv.pinAt.set(bucket, now);
          if (sighted) conv.obs.set(bucket, sighted);
          /** @type {number[]} */ (routed.get(d)).push(now);
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
    if (s.restart || restarts.includes(i)) {
      const saved = JSON.parse(JSON.stringify({ quota: am.exportQuotaState(), affinity: am.exportAffinityState() }));
      const rows = configRows().reverse();
      const next = new AccountManager(rows, row.threshold, options());
      next.restoreQuotaState(saved.quota);
      noticeResets();
      if (!ex.enabled) sessionResets = new Set();
      if (row.persist || driver.restoreAlways) next.restoreAffinityState(saved.affinity);
      next.selectActiveAccount();
      // The constructor reads its first account before any quota is restored;
      // startup's own pick reads restored quota.
      const first = next.accounts[next.currentIndex]?.id ?? null;
      curObs = newObs();
      if (first != null) {
        curObs.on = first;
        if (first !== next.accounts[0].id) curObs.windows = windowsOf(/** @type {Fed} */ (fed.get(first)));
      }
      check({ restart: true, i, now, row, before: saved.affinity, after: next.exportAffinityState(), convs });
      am = next;
      life++;
      cur = cursor();
      lastRouted = new Map();
      requalify = new Set();
      probing = new Set(h.accounts.map(a => a.id));
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

/** Every pair of dimension values a valid row can hold, as keys. */
function allPairs() {
  const dims = Object.keys(DIMENSIONS);
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

/** @param {Cell} cell */
function pairsOf(cell) {
  const dims = Object.keys(DIMENSIONS).filter(d => cell[d] != null);
  /** @type {string[]} */
  const out = [];
  dims.forEach((a, i) => dims.slice(i + 1).forEach(b => out.push(`${a}=${cell[a]}|${b}=${cell[b]}`)));
  return out;
}

/**
 * A covering array over DIMENSIONS: the given rows first, then rows added
 * greedily until every pair of values of any two dimensions is in one. Each
 * candidate row starts from one pair still missing and takes, dimension by
 * dimension, the value that covers the most missing pairs; of the candidates
 * started from the first few missing pairs the one covering most is kept.
 * Ties go to the first, so the array is the same on every run.
 * @param {Cell[]} seeds @returns {Cell[]}
 */
export function coveringArray(seeds) {
  const dims = Object.keys(DIMENSIONS);
  const missing = new Set(allPairs());
  const rows = [...seeds];
  for (const r of rows) for (const k of pairsOf(r)) missing.delete(k);
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
        const gain = pairsOf({ ...cell, [d]: v }).filter(k => missing.has(k)).length;
        if (gain > bestGain) { best = v; bestGain = gain; }
      }
      cell[d] = best;
    }
    return cell;
  };
  while (missing.size) {
    let best = null; let bestGain = -1;
    for (const first of [...missing].slice(0, 24)) {
      const cell = build(first);
      const gain = pairsOf(cell).filter(k => missing.has(k)).length;
      if (gain > bestGain) { best = cell; bestGain = gain; }
    }
    for (const k of pairsOf(/** @type {Cell} */ (best))) missing.delete(k);
    rows.push(/** @type {Cell} */ (best));
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
