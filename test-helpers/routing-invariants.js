// The invariants test/routing-config-model.test.js holds every row to, each
// judged against the independent model in routing-model.js and never against
// a decision function of the code under test.
//
// An invariant is `{ id, doc, holds(row), gap?, runFloor?, check(ctx) }`.
// `check` returns undefined where it does not apply, true where it applied and
// held, and a string saying what broke otherwise. The count of `true` results
// is the vacuity floor: an invariant that never applied in a row where it holds
// proves nothing. `runFloor`, where set, is the share of each such row's runs
// in which it must apply at least once. A `gap` invariant states what
// docs/routing.md says where the code does otherwise; its breaches are tallied
// for a todo test instead of failing the row.

import {
  FABLE, SOONER_MARGIN, band, bucketOf, capOf, deadline, governing, heldOff,
  pressure, recentOn, activeOn, thresholdOf, unavailable, atCap, routeOf, globMatches,
  familyCapped, servesAdvisor, held, advisorMode, rampOf, BURST, startable,
} from './routing-model.js';

const ADAPTIVE_MAX_BURN_BOOST = 4;
const ADAPTIVE_MAX_RESERVE = 0.20;
const SOFT_MARGIN = 0.15;
// Readings within this relative distance of a band edge are left undecided:
// the model and the code compute the same quotient in a different order.
const EPS = 1e-9;

const distOn = (/** @type {any} */ row) => row.dist !== 'off';
const pressureScoring = (/** @type {any} */ row) => row.dist.startsWith('adaptive-pressure');
const layered = (/** @type {any} */ row) => row.routes === 'layered';
const advising = (/** @type {any} */ row) => advisorMode(row) != null;

/**
 * Everything the invariants derive from one request's state, computed once.
 * @param {any} ctx
 */
export function view(ctx) {
  if (ctx.view) return ctx.view;
  const { row, model, now, ex, fed } = ctx;
  /** @type {any[]} */
  const all = [...fed.values()];
  // An advisor's family cap keeps selection off an account as the request's
  // own reasons do (_withoutAdvisorCapped), in every judged path.
  const reason = (/** @type {any} */ a) => unavailable(a, model, row.threshold) ?? (ctx.adv?.excluded.has(a.id) ? 'advisor-capped' : null);
  const av = all.filter(a => reason(a) == null);
  const top = av.length ? Math.min(...av.map(a => a.priority)) : null;
  const B = band(av, model, now, ex);
  const soft = softOf(av, ctx);
  const avSoft = av.filter(a => !soft.has(a.id));
  const Bsoft = soft.size ? band(avSoft, model, now, ex) : B;
  const outranked = (/** @type {any} */ a) => av.some(b => b.priority < a.priority);
  const pins = ctx.conv ? [...ctx.conv.pins.values()] : [];
  const p = ctx.conv?.pins.get(ctx.bucket) ?? null;
  const v = { all, av, top, B, soft, avSoft, Bsoft, reason, outranked, pins, p, kind: classify(ctx, { av, reason, outranked, p }) };
  ctx.view = v;
  return v;
}

/**
 * The accounts fiveHourSoftMargin keeps new conversations off among `av`:
 * those of the top tier near their 5h wall, unless every one of them is
 * (_withoutFiveHourSoft).
 * @param {any[]} av @param {any} ctx @returns {Set<string>}
 */
function softOf(av, ctx) {
  if (ctx.row.dist !== 'adaptive-pressure-soft' || !av.length) return new Set();
  const top = Math.min(...av.map(a => a.priority));
  const tier = av.filter(a => a.priority === top);
  const over = tier.filter(a => {
    const use = a.u5h != null && a.r5h != null && a.r5h > ctx.now ? a.u5h : null;
    return use != null && use >= Math.min(capOf(a.maxUsage, 'unified5h') ?? 1, 1) - SOFT_MARGIN;
  });
  return over.length && over.length < tier.length ? new Set(over.map(a => a.id)) : new Set();
}

/**
 * Which path a tagged request under distribution takes, by the order
 * _pickActiveAccount and _selectForSession ask: a cordon keeps what is on it;
 * the bucket's pin, then the conversation's other pins, are kept when
 * available and not outranked, a pin the bucket's reading finds rolled is
 * re-decided, and with no usable pin the request is a placement.
 * @param {any} ctx @param {any} v
 * @returns {{ kind: 'untagged'|'cordon'|'rolled'|'pin'|'placement'|'none', q?: string }}
 */
function classify(ctx, { av, reason, outranked, p }) {
  if (!distOn(ctx.row)) return { kind: 'none' };
  if (!ctx.tagged) return { kind: 'untagged' };
  const conv = ctx.conv;
  if (!conv) return { kind: 'placement' };
  const fed = ctx.fed;
  const others = [...new Set(conv.pins.values())].filter(id => id !== p);
  if ([...fed.values()].some(a => a.cordoned)) {
    const keeps = p != null ? [p]
      : others.some(id => !fed.get(id).cordoned) ? [] : others;
    for (const id of keeps) {
      const a = fed.get(id);
      if (!a.cordoned || reason(a) !== 'cordoned') continue;
      if (ctx.ex.enabled && ctx.ex.preempt && id === ctx.readOn && ctx.readRolled) return { kind: 'none' };
      if (!av.some((/** @type {any} */ b) => b.priority < a.priority)) return { kind: 'cordon', q: id };
    }
  }
  for (const id of p != null ? [p, ...others] : others) {
    const a = fed.get(id);
    if (reason(a) != null) continue;
    // An uncertain reading may be the older one restored on an account left
    // while rolled, which refuses a first sight elsewhere and stays there.
    if (ctx.ex.enabled && ctx.ex.preempt && ctx.pinUncertain && ctx.readEscaped?.has(id)) return { kind: 'none' };
    if (ctx.ex.enabled && ctx.ex.preempt && id === ctx.readOn && (ctx.readRolled || ctx.pinUncertain)) {
      return ctx.pinUncertain ? { kind: 'none' } : { kind: 'rolled', q: id };
    }
    if (outranked(a)) continue;
    return { kind: 'pin', q: id };
  }
  return { kind: 'placement' };
}

/** The deadline ranking and the soonest-reset rule compare (_rankingReset).
 * @param {any} a @param {string} model @param {number} now @param {any} ex */
export function rankingDeadline(a, model, now, ex) {
  const weekly = ex.enabled ? governing(a, model).reset
    : (model === FABLE ? (a.fr || a.r7d) : a.r7d) || null;
  return deadline(a, weekly ?? null, now);
}

/** The accounts the session-reset switch may move the cursor's traffic to
 * with expiry routing off: its 5h window reset, it is available without regard
 * to the request's model, it is not of a lower priority, and its deadline is
 * known and sooner than the cursor's. None when the cursor's deadline is
 * unknown.
 * @param {any} ctx @param {any} c the cursor's account */
function switchTakers(ctx, c) {
  const mine = rankingDeadline(c, null, ctx.now, ctx.ex);
  if (mine == null) return [];
  return [...ctx.sessionResets].map(id => ctx.fed.get(id)).filter(a => a.id !== c.id
    && unavailable(a, null, ctx.row.threshold) == null && a.priority <= c.priority
    && (rankingDeadline(a, null, ctx.now, ctx.ex) ?? Infinity) < mine);
}

/** Whether `a` is in band `b`, or too close to its floor to say.
 * @returns {boolean|null} */
export function inBand(/** @type {any} */ b, /** @type {any} */ a, /** @type {string} */ model, /** @type {number} */ now) {
  if (b.ids.has(a.id)) {
    if (b.floor == null) return true;
    const pr = pressure(a, model, now);
    if (pr.kind !== 'known' || pr.value >= b.floor * (1 + EPS)) return true;
    // At tolerance 1 the floor is the best pressure itself (docs/routing.md:407):
    // the account with it is in the band unless another is within EPS of it.
    return pr.value === b.max && b.known.filter((/** @type {number} */ x) => x > b.max * (1 - EPS)).length === 1 ? true : null;
  }
  if (b.floor == null) return false;
  const pr = pressure(a, model, now);
  return pr.kind === 'known' && pr.value > b.floor * (1 - EPS) ? null : false;
}

/** The band's top-priority accounts, and which accounts _belowBandFloor
 * ranks behind the rest.
 * @param {any[]} cands @param {any} ctx */
function rankedTier(cands, ctx) {
  const { model, now, ex } = ctx;
  const top = Math.min(...cands.map(a => a.priority));
  const spent = heldOff(cands, model, now, ex);
  const ranked = cands.filter(a => a.priority === top);
  return { ranked, spent };
}

/** Whether `d` minimizes `key` over the band's top tier, the way
 * _pickLeastLoadedEven ranks it.
 * @param {any} ctx @param {any[]} cands @param {(a: any) => number[]} key */
function argminOK(ctx, cands, key) {
  // With nothing available the request falls through to a probe.
  if (!cands.length) return undefined;
  const { ranked, spent } = rankedTier(cands, ctx);
  const k = (/** @type {any} */ a) => [spent.get(a.id) ? 1 : 0, ...key(a)];
  const keys = ranked.map(a => ({ id: a.id, k: k(a) }));
  keys.sort((x, y) => cmp(x.k, y.k));
  const best = keys[0].k;
  const mine = keys.find(x => x.id === ctx.d);
  if (!mine) return `${ctx.d} is not in the band's top tier [${ranked.map(a => a.id)}]`;
  if (cmp(mine.k, best) !== 0) return `${ctx.d} has key [${mine.k}], best is [${best}] (${keys.map(x => `${x.id}:[${x.k}]`).join(' ')})`;
  return true;
}
const cmp = (/** @type {number[]} */ a, /** @type {number[]} */ b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** The adaptive tier _pickAdaptive scores: the band's top priority, without
 * the spent ones unless every one is. Spent is judged within that priority:
 * the band's bar is the best pressure of the top tier (docs/routing.md:407).
 * @param {any} ctx @param {any[]} cands */
function adaptiveTier(ctx, cands) {
  const { ranked } = rankedTier(cands, ctx);
  const spent = heldOff(ranked, ctx.model, ctx.now, ctx.ex);
  const above = ranked.filter(a => !spent.get(a.id));
  return above.length ? above : ranked;
}

/** The pressure a placement is priced on (_placementPressure).
 * @param {any} a @param {any} ctx */
function placementPressure(a, ctx) {
  const { model, now } = ctx;
  const WEEK_MS = 7 * 24 * 3600_000;
  const fresh = () => Math.max(0, Math.min(1, capOf(a.maxUsage, 'unified7d') ?? 1, capOf(a.maxUsage, bucketOf(model)) ?? 1))
    / ((/** @type {number} */ (deadline(a, now + WEEK_MS, now)) - now) / 1000);
  const pr = pressure(a, model, now);
  if (pr.kind === 'known') {
    const dl = deadline(a, governing(a, model).reset ?? null, now);
    return pr.value > 0 || (dl != null && dl > now) ? pr.value : fresh();
  }
  return pr.bound == null ? fresh() : pr.bound;
}

/** @param {any} a @param {any} ctx */
function fiveHourFactor(a, ctx) {
  const use = a.u5h != null && a.r5h != null && a.r5h > ctx.now ? a.u5h : null;
  if (use == null) return 1;
  const limit = Math.min(capOf(a.maxUsage, 'unified5h') ?? Infinity, thresholdOf(ctx.row.threshold, 'unified5h'));
  return limit > 0 ? Math.min(1, Math.max(0, (limit - use) / limit)) : 0;
}

/** The reclaim conditions of docs/routing.md:427-436 for moving a pin on `q`
 * to `a`, or why not. Null when a reading sits on an edge.
 * @param {any} ctx @param {any} v @param {any} q @param {any} a */
export function reclaimable(ctx, v, q, a) {
  const { model, now, ex } = ctx;
  const inB = inBand(v.B, a, model, now);
  if (inB === null) return null;
  if (!inB) return 'not in the band';
  if (pressure(a, model, now).kind !== 'known') return 'no measured pressure';
  if (a.priority !== q.priority) return 'another priority';
  if (v.soft.has(a.id)) return 'held off by fiveHourSoftMargin';
  const dl = rankingDeadline(a, model, now, ex);
  const windowMs = ex.reclaimHours * 3600_000;
  if (!dl || dl <= now) return 'no deadline ahead';
  if (dl - now > windowMs) return 'deadline outside the window';
  const own = rankingDeadline(q, model, now, ex);
  if (own && own > now && own <= dl) return 'deadline not sooner than the pin\'s';
  if (!ex.across && !(a.org != null && q.org != null && a.org === q.org)) return 'not known to share an organization';
  return '';
}

/**
 * A fresh catalog for one played history: O26 counts across steps.
 * @returns {Array<{ id: string, doc: string, gap?: string, runFloor?: number, holds: (row: any) => boolean, check: (ctx: any) => true|string|undefined }>}
 */
export function catalog() {
  /** @type {Map<string, number>} */
  const handBacksPerRoll = new Map();
  /** @type {Map<string, number>} */
  const reheldPerRoll = new Map();
  /** @type {Map<string, number>} */
  const reclaimedPerRoll = new Map();
  // The resets of the pin's other windows at the first move off each roll.
  // Only O26 writes it, so G6 and G7 must follow O26 in the catalog.
  /** @type {Map<string, string>} */
  const othersAtFirst = new Map();
  const otherResets = (/** @type {any} */ a, /** @type {string} */ model) => {
    const g = governing(a, model).window;
    return [['unified7d', a.r7d], ['unified7dFable', a.fr]].filter(([w]) => w !== g).map(([w, r]) => `${w}=${r}`).join(',');
  };
  // The moves off an available pin, with no available account of a better
  // priority, whose reading saw it roll, each keyed by the roll it answers.
  // Only a `request` step counts: a throttle or refusal step is judged on its
  // first attempt, and its hop or failover can land back on the pin.
  const rollMove = (/** @type {any} */ ctx, /** @type {any} */ v) => {
    const p = v.p;
    if (ctx.op !== 'request' || p == null || ctx.d === p || ctx.d === '-') return null;
    const a = ctx.fed.get(p);
    if (v.reason(a) != null || v.outranked(a)) return null;
    if (!(ctx.pinRolled || ctx.pinUncertain)) return null;
    return { p, a, key: `${ctx.life}|${ctx.c}|${ctx.bucket}|${p}|${governing(a, ctx.model).reset}` };
  };
  // A move off a roll that a reclaim (docs/routing.md:427-436) could have
  // made, which no reading in the model separates from a hand-back.
  const reclaimShaped = (/** @type {any} */ ctx, /** @type {any} */ v, /** @type {any} */ m) =>
    ctx.ex.reclaimHours > 0 && !ctx.pinRolled && inBand(v.B, m.a, ctx.model, ctx.now) === false
      && reclaimable(ctx, v, m.a, ctx.fed.get(ctx.d)) === '';
  // A failover is a selection too, so what bars an account from every
  // selection judges it as well.
  const anySelection = (/** @type {(ctx: any, v: any) => true|string|undefined} */ f) =>
    (/** @type {any} */ ctx) => (ctx.restart || ctx.removal || ctx.hop ? undefined : f(ctx, view(ctx)));
  // Only the advisor invariants judge a request whose advisor narrows its
  // candidates, since every other one reads the candidates as the request's
  // model alone leaves them.
  const anyRequest = (/** @type {(ctx: any, v: any) => true|string|undefined} */ f) =>
    (/** @type {any} */ ctx) => (ctx.failover ? undefined : anySelection(f)(ctx));
  const request = (/** @type {(ctx: any, v: any) => true|string|undefined} */ f) =>
    (/** @type {any} */ ctx) => (ctx.adv && !ctx.adv.plain ? undefined : anyRequest(f)(ctx));
  const advised = (/** @type {(ctx: any, v: any, adv: any) => true|string|undefined} */ f, failover = false) =>
    (failover ? anySelection : anyRequest)((ctx, v) => (ctx.adv ? f(ctx, v, ctx.adv) : undefined));
  const ids = (/** @type {any[]} */ xs) => `[${xs.map(a => a.id)}]`;
  // Where a request went, as the advisor invariants read it: a candidate, or
  // a cordoned account holding one of the conversation's pins, which keeps
  // what is on it (docs/routing.md:21).
  const tookOneOf = (/** @type {any} */ ctx, /** @type {any} */ v, /** @type {any[]} */ set, needsAdvisor = false) => {
    if (set.some(a => a.id === ctx.d)) return true;
    const a = ctx.fed.get(ctx.d);
    return !!a && v.pins.includes(ctx.d) && v.reason(a) === 'cordoned'
      && (!needsAdvisor || servesAdvisor(a, ctx.adv.advisor, ctx.row.threshold));
  };
  // Every attempt keeps off an account the hold `kind` holds, a failover
  // included; applied only while some account is so held.
  const keepsOff = (/** @type {string} */ kind) => (/** @type {any} */ ctx) => {
    if (ctx.restart || ctx.removal || ctx.hop) return undefined;
    const holding = [...ctx.fed.values()].filter(a => held(a) === kind);
    if (!holding.length) return undefined;
    if (ctx.d !== '-' && held(ctx.fed.get(ctx.d)) === kind) {
      return `${ctx.failover ? `the failover from ${ctx.from}` : 'the request'} went to ${ctx.d}, inside its ${kind} hold`;
    }
    return true;
  };
  // "The next request after the cooldown retries the account"
  // (docs/routing.md:81) means the account is back in rotation, not that the
  // request goes to it: where it goes is still the ordinary choice
  // (docs/routing.md:19). So this checks only that the request after a hold
  // of `kind` ends is served while the released account can take it.
  const returns = (/** @type {string} */ kind) => (/** @type {any} */ ctx) => {
    if (ctx.restart || ctx.removal || ctx.hop || ctx.failover || !ctx.released?.size) return undefined;
    const back = [...ctx.released].filter(([id, k]) => k === kind && unavailable(ctx.fed.get(id), ctx.model, ctx.row.threshold) == null);
    if (!back.length) return undefined;
    return ctx.d === '-' ? `nothing served after the ${kind} hold of [${back.map(([id]) => id)}] ended` : true;
  };
  /** @type {Set<string>} */
  const removed = new Set();
  return [
    {
      // "a running account whose entry is gone from the file is dropped from
      // the fleet", and a removal from the TUI "takes effect at once".
      id: 'R1', doc: 'docs/accounts.md:156',
      holds: () => true,
      check: ctx => {
        if (ctx.removal) { removed.add(ctx.removed); return undefined; }
        if (ctx.restart || !removed.size) return undefined;
        const to = ctx.hop ? ctx.to : ctx.d;
        return removed.has(to) ? `${ctx.failover ? 'the failover' : 'the request'} went to ${to}, removed from the fleet` : true;
      },
    },
    {
      // No docs line says where the reading of a response goes when its
      // account was removed while the response was in flight. Readings come
      // "off the responses that flow through" the proxy (docs/quota.md:7), so
      // R2 holds that reading to no account: it changes no other account's
      // readings.
      id: 'R2', doc: 'docs/quota.md:7, inferred',
      holds: () => true,
      check: ctx => {
        if (!ctx.removal) return undefined;
        const moved = [...ctx.after].filter(([id, q]) => ctx.kept.get(id) !== q).map(([id]) => id);
        return moved.length ? `a response ${ctx.removed} served before its removal changed the readings of [${moved}]` : true;
      },
    },
    {
      // The current account stays where it is (docs/routing.md:19), and the
      // removal of another account gives rotation no reason to move it. No
      // docs line covers a removal's renumbering, so this holds the cursor,
      // every route and provider cursor, a route pin and every conversation's
      // pin to the account each named, wherever that account now sits. A pin
      // on the removed account goes with it (docs/routing.md:409), and a
      // cursor on it moves to an account still in the fleet.
      id: 'R3', doc: 'docs/routing.md:19, inferred',
      holds: () => true,
      check: ctx => {
        if (!ctx.removal) return undefined;
        const gone = `removing ${ctx.removed}`;
        if (ctx.cursorBefore != null && ctx.cursorBefore !== ctx.removed && ctx.cursorAfter !== ctx.cursorBefore) {
          return `${gone} moved the cursor from ${ctx.cursorBefore} to ${ctx.cursorAfter}`;
        }
        if (ctx.left && (ctx.cursorAfter == null || ctx.cursorAfter === ctx.removed)) return `${gone} left the cursor on ${ctx.cursorAfter}`;
        for (const [what, before, after] of [['route', ctx.routeCursors, ctx.routeCursorsAfter], ['provider', ctx.providerCursors, ctx.providerCursorsAfter]]) {
          for (const [k, id] of before) {
            if (id === ctx.removed) continue;
            const now = after.get(k) ?? null;
            if (now !== id) return `${gone} moved the ${k} ${what} cursor from ${id} to ${now}`;
          }
        }
        const pin = ctx.pinned === ctx.removed ? null : ctx.pinned;
        if (ctx.pinned != null && ctx.pinAfter !== pin) return `${gone} moved the fable route pin from ${ctx.pinned} to ${ctx.pinAfter}`;
        const pins = (/** @type {any} */ state) => new Map(state.sessions.flatMap((/** @type {any} */ x) => x.pins.map((/** @type {any} */ p) => [`${x.key} ${p.bucket}`, p.account.id])));
        const after = pins(ctx.pinsAfter);
        for (const [k, id] of pins(ctx.pinsBefore)) {
          const now = after.get(k) ?? null;
          if (now !== (id === ctx.removed ? null : id)) return `${gone} moved the pin of ${k} from ${id} to ${now}`;
        }
        return true;
      },
    },
    { id: 'H1', doc: 'docs/routing.md:70-71', holds: () => true, check: keepsOff('billing') },
    { id: 'H2', doc: 'docs/routing.md:88', holds: () => true, check: keepsOff('entitlement') },
    { id: 'H3', doc: 'docs/routing.md:108', holds: () => true, check: keepsOff('error') },
    { id: 'H4', doc: 'docs/routing.md:81', holds: () => true, check: returns('billing') },
    { id: 'H5', doc: 'docs/routing.md:88', holds: () => true, check: returns('entitlement') },
    {
      id: 'U1', doc: 'docs/routing.md:21',
      holds: () => true,
      check: anySelection((ctx, v) => {
        if (ctx.d === '-') return undefined;
        const a = ctx.fed.get(ctx.d);
        if (a.disabled) return `${ctx.d} is disabled`;
        if (atCap(a, ctx.model)) return `${ctx.d} is at a maxUsage cap`;
        if (a.barred.has(ctx.model)) return `${ctx.d} is excluded by a route`;
        if (a.cordoned && !v.pins.includes(ctx.d)) return `${ctx.d} is cordoned and holds none of this conversation's pins`;
        return true;
      }),
    },
    {
      // The deciding route is the first whose globs match, so every account
      // it lists, or every account when it lists none, stays a candidate, and
      // the routes after it bar nothing.
      id: 'O19', doc: 'docs/routing.md:210',
      holds: layered,
      check: request((ctx, v) => {
        const matching = ctx.routes.filter((/** @type {any} */ r) => r.match.some((/** @type {string} */ g) => globMatches(g, ctx.model)));
        if (matching.length < 2) return undefined;
        const first = matching[0];
        const allows = (/** @type {string} */ id) => !first.accounts?.length || first.accounts.includes(id);
        if (ctx.d !== '-' && !allows(ctx.d)) return `${ctx.model} went to ${ctx.d}, which its first matching route ${first.name} does not list`;
        if (ctx.d === '-' && v.av.length) return `${ctx.model} routed nowhere; its first matching route ${first.name} admits [${v.av.map((/** @type {any} */ a) => a.id)}]`;
        return true;
      }),
    },
    {
      // A route restricts only the models it matches: a model none matches
      // may go to any account, and a route matching no request model changes
      // nothing.
      id: 'O20', doc: 'docs/routing.md:201',
      holds: layered,
      check: request((ctx, v) => {
        if (routeOf(ctx.routes, ctx.model)) return undefined;
        if (ctx.d === '-' && v.av.length) return `${ctx.model} matches no route, yet routed nowhere while [${v.av.map((/** @type {any} */ a) => a.id)}] are available`;
        return true;
      }),
    },
    {
      // A reloaded table routes the next request.
      id: 'O21', doc: 'docs/routing.md:215',
      holds: layered,
      check: request((ctx, v) => {
        if (!ctx.reloaded) return undefined;
        if (ctx.d !== '-' && ctx.fed.get(ctx.d).barred.has(ctx.model)) return `after the reload ${ctx.model} went to ${ctx.d}, which the reloaded table bars`;
        if (ctx.d === '-' && v.av.length) return `after the reload ${ctx.model} routed nowhere while the reloaded table admits [${v.av.map((/** @type {any} */ a) => a.id)}]`;
        return true;
      }),
    },
    {
      // "strict": an account that can serve both models takes the request
      // whenever one is available; one whose advisor bucket is spent, capped
      // or barred by a route does not.
      id: 'O22', doc: 'docs/routing.md:190',
      holds: row => advisorMode(row) === 'strict',
      check: advised((ctx, v, adv) => {
        if (!adv.both.length) return undefined;
        if (ctx.d === '-') return `nothing routed while ${ids(adv.both)} can serve ${ctx.model} and its advisor`;
        if (tookOneOf(ctx, v, adv.both, true)) return true;
        return `${ctx.d} cannot serve the advisor ${adv.advisor}, yet ${ids(adv.both)} can serve both`;
      }),
    },
    {
      // With no account able to serve the advisor, the request is routed by
      // its main model, in either mode.
      id: 'O23', doc: 'docs/routing.md:193',
      holds: advising,
      check: advised((ctx, v, adv) => {
        if (adv.both.length || !adv.cands.length) return undefined;
        if (ctx.d === '-') return `nothing routed while ${ids(adv.cands)} can serve ${ctx.model}`;
        return tookOneOf(ctx, v, adv.cands) ? true : `${ctx.d} took the request; ${ids(adv.cands)} can serve ${ctx.model}`;
      }),
    },
    {
      // Judged on selection, the path its doc line names
      // (_withoutAdvisorCapped), in both modes. docs/quota.md:276 says the cap
      // does not apply under "prefer"; that sentence is about the paths that
      // skip selection (capBars: a pin, the exhausted-fleet probe, the paid
      // fallback), which a G3 test in routing-config-model.test.js judges on
      // the probe.
      id: 'O24', doc: 'docs/routing.md:195',
      holds: advising,
      check: advised((ctx, v, adv) => {
        if (!adv.cands.length) return undefined;
        if (ctx.d === '-') return `nothing routed while ${ids(adv.cands)} can serve ${ctx.model}`;
        if (!familyCapped(ctx.fed.get(ctx.d), adv.advisor)) return true;
        if (!adv.excluded.size) return true;
        return `${ctx.failover ? `the failover from ${ctx.from}: ` : ''}${ctx.d} is at its ${adv.advisor} cap while ${ids(adv.cands)} can serve the request`;
      }, true),
    },
    {
      // A refusal fails the request over (docs/routing.md:71, :88, :108), so
      // the failover is judged as the request is.
      id: 'U2', doc: 'docs/routing.md:19',
      holds: () => true,
      check: ctx => (ctx.failover ? anySelection : request)((ctx, v) => {
        if (!v.av.length) return undefined;
        const what = ctx.failover ? `the failover from ${ctx.from}: ` : '';
        if (ctx.d === '-') return `${what}nothing routed while [${v.av.map((/** @type {any} */ a) => a.id)}] are available`;
        const r = v.reason(ctx.fed.get(ctx.d));
        if (r == null || (r === 'cordoned' && v.pins.includes(ctx.d))) return true;
        return `${what}${ctx.d} is unavailable (${r}) while [${v.av.map((/** @type {any} */ a) => a.id)}] are available`;
      })(ctx),
    },
    {
      id: 'O14', doc: 'docs/routing.md:240',
      holds: distOn,
      check: request((ctx, v) => {
        if (v.kind.kind !== 'untagged' || !v.av.length) return undefined;
        const a = ctx.fed.get(ctx.d);
        if (!a) return `nothing routed while [${v.av.map((/** @type {any} */ x) => x.id)}] are available`;
        if (a.priority !== v.top) return `untagged request went to ${ctx.d} at priority ${a.priority}; ${v.top} is available`;
        const inB = inBand(v.B, a, ctx.model, ctx.now);
        return inB === false ? `untagged request went to ${ctx.d}, outside the band [${[...v.B.ids]}]` : true;
      }),
    },
    {
      id: 'U3', doc: 'docs/routing.md:240',
      holds: () => true,
      check: request((ctx, v) => {
        if (!v.av.length || ctx.d === '-') return undefined;
        const pr = ctx.fed.get(ctx.d).priority;
        return pr <= v.top ? true : `${ctx.d} has priority ${pr}; ${v.top} is available`;
      }),
    },
    {
      id: 'U5', doc: 'docs/routing.md:267',
      holds: row => row.persist,
      check: ctx => {
        if (!ctx.restart) return undefined;
        const pinsOf = (/** @type {any} */ snap) => new Map((snap?.sessions ?? []).map((/** @type {any} */ s) =>
          [s.key, s.pins.map((/** @type {any} */ x) => `${x.bucket}=${x.account.id}`).sort().join(',')]));
        const before = pinsOf(ctx.before);
        const after = pinsOf(ctx.after);
        for (const [k, pins] of before) {
          if (!pins) continue;
          if (after.get(k) !== pins) return `conversation ${k} had pins ${pins}, after the restart ${after.get(k) ?? 'none'}`;
        }
        return before.size ? true : undefined;
      },
    },
    {
      id: 'U6', doc: 'docs/routing.md:269',
      holds: row => !row.persist,
      check: ctx => {
        if (!ctx.restart) return undefined;
        const kept = (ctx.after?.sessions ?? []).filter((/** @type {any} */ s) => s.pins.length);
        if (kept.length) return `${kept.length} conversation(s) kept pins across a restart: ${kept.map((/** @type {any} */ s) => s.key)}`;
        return (ctx.before?.sessions ?? []).length ? true : undefined;
      },
    },
    {
      id: 'O1', doc: 'docs/routing.md:409',
      holds: distOn,
      check: request((ctx, v) => {
        if (v.kind.kind !== 'pin') return undefined;
        const q = v.kind.q;
        if (ctx.d === q) return true;
        if (ctx.ex.enabled && ctx.ex.reclaimHours > 0 && inBand(v.B, ctx.fed.get(q), ctx.model, ctx.now) !== true) return undefined;
        return `pin ${q} is available and not outranked, yet the request went to ${ctx.d}`;
      }),
    },
    {
      // A pin the reading returned to keeps the request once the move off its
      // roll was served at the destination: "Traffic that returns after a serve
      // finds the roll released and reads the origin whole" (docs/routing.md:417).
      // Served only under a later stamp, "the roll stays held" (:411): the
      // reading restored on the return has rolled, and the pin is re-ranked as
      // O29 judges a rolled pin.
      id: 'O28', doc: 'docs/routing.md:411 and :417',
      holds: row => distOn(row) && row.expiry?.enabled === true && row.expiry.preempt !== false,
      check: request((ctx, v) => {
        if (ctx.pinHeld) {
          if (!placementRanked(ctx) || v.p == null || bandEdge(ctx, v)) return undefined;
          const a = ctx.fed.get(v.p);
          if (v.reason(a) != null || v.outranked(a) || [...ctx.fed.values()].some((/** @type {any} */ x) => x.cordoned)) return undefined;
          const r = argminOK(ctx, [...v.av].filter(x => v.B.ids.has(x.id)), placementKey(ctx));
          return typeof r === 'string' ? `pin ${v.p} was returned to while its roll was held, and the re-rank sent the request to ${ctx.d}: ${r}` : r;
        }
        if (!ctx.pinReturned || v.kind.kind !== 'pin' || v.kind.q !== v.p) return undefined;
        const q = v.kind.q;
        if (ctx.d === q) return true;
        if (ctx.ex.reclaimHours > 0 && inBand(v.B, ctx.fed.get(q), ctx.model, ctx.now) !== true) return undefined;
        return `pin ${q} was returned to after its roll was settled, yet the request went to ${ctx.d}`;
      }),
    },
    {
      id: 'O15', doc: 'docs/routing.md:409',
      holds: row => distOn(row) && row.expiry?.enabled === true && row.expiry.preempt !== false,
      check: request((ctx, v) => {
        if (v.kind.kind !== 'rolled') return undefined;
        const q = ctx.fed.get(v.kind.q);
        if (inBand(v.B, q, ctx.model, ctx.now) !== false) return undefined;
        return ctx.d !== v.kind.q ? true
          : `pin ${v.kind.q} rolled and is outside the band [${[...v.B.ids]}], yet it kept the request`;
      }),
    },
    {
      // O15 for the sticky current account, which the same sentence names.
      id: 'O25', doc: 'docs/routing.md:409',
      holds: row => row.dist === 'off' && row.expiry?.enabled === true && row.expiry.preempt !== false,
      check: request((ctx, v) => {
        const cur = ctx.cur;
        if (cur == null || !ctx.curRolled || ctx.curUncertain) return undefined;
        const c = ctx.fed.get(cur);
        if (v.reason(c) != null || v.outranked(c)) return undefined;
        if (inBand(v.B, c, ctx.model, ctx.now) !== false) return undefined;
        return ctx.d !== cur ? true
          : `current account ${cur} rolled and is outside the band [${[...v.B.ids]}], yet it kept the request`;
      }),
    },
    {
      id: 'O13', doc: 'docs/routing.md:25',
      holds: row => row.dist === 'off',
      check: request((ctx, v) => {
        const cur = ctx.cur;
        if (cur == null || !ctx.sessionResets.size) return undefined;
        const c = ctx.fed.get(cur);
        // curUncertain also counts the pending reset itself, which is what is judged here.
        if (v.reason(c) != null || v.outranked(c) || ctx.curRolled || ctx.curObsUncertain || ctx.requalify.has(cur)) return undefined;
        if (!ctx.row.sessionReset) {
          if (ctx.d === cur) return true;
          if (ctx.row.soonest || (ctx.tagged && v.pins.includes(ctx.d) && ctx.fed.get(ctx.d).cordoned)) return undefined;
          return `a 5h reset on [${[...ctx.sessionResets]}] moved the current account ${cur} to ${ctx.d} with switchOnSessionReset off`;
        }
        // The switch weighs deadlines and availability for no model when expiry
        // routing is off (refreshExpiredQuotas), and is judged only then. With
        // preferSoonestWeeklyReset the walk then ranks the request's own
        // deadlines, which O12 judges.
        if (ctx.ex.enabled || ctx.row.soonest || ctx.d !== cur) return undefined;
        if (rankingDeadline(c, null, ctx.now, ctx.ex) == null) return undefined;
        const takers = switchTakers(ctx, c);
        // A taker the request's own model cannot use, or one flagged to be
        // re-ranked, hands the request on, possibly back to the cursor.
        if (takers.some(a => v.reason(a) != null || ctx.requalify.has(a.id))) return undefined;
        return takers.length ? `[${takers.map(a => a.id)}] reset their 5h window with a sooner deadline, yet ${cur} kept the request` : true;
      }),
    },
    {
      id: 'O13b', doc: 'docs/routing.md:25',
      holds: row => row.dist === 'off' && row.sessionReset && !row.soonest && row.expiry?.enabled !== true,
      // The generator's session-reset episode reaches a switch in most runs.
      runFloor: 0.5,
      check: request((ctx, v) => {
        const cur = ctx.cur;
        if (cur == null || !ctx.sessionResets.size || ctx.d === cur || ctx.d === '-') return undefined;
        const c = ctx.fed.get(cur);
        // Only the switch moves traffic off a cursor that can serve the request.
        if (v.reason(c) != null || v.outranked(c) || ctx.requalify.has(cur)) return undefined;
        if (ctx.tagged && v.pins.includes(ctx.d) && ctx.fed.get(ctx.d).cordoned) return undefined;
        const takers = switchTakers(ctx, c);
        if (takers.some(a => v.reason(a) != null || ctx.requalify.has(a.id))) return undefined;
        return takers.some(a => a.id === ctx.d) ? true
          : `a 5h reset on [${[...ctx.sessionResets]}] moved the current account ${cur} to ${ctx.d}, which is not one of them with a sooner deadline`;
      }),
    },
    {
      id: 'O2', doc: 'docs/routing.md:19',
      holds: row => row.dist === 'off',
      check: request((ctx, v) => {
        const cur = ctx.cur;
        if (cur == null || ctx.d === cur) return cur == null ? undefined : true;
        const c = ctx.fed.get(cur);
        if (v.reason(c) != null || v.outranked(c)) return undefined;
        if (ctx.curRolled || ctx.curUncertain || ctx.requalify.has(cur)) return undefined;
        if (ctx.row.sessionReset && ctx.sessionResets.size) return undefined;
        if (ctx.tagged && v.pins.includes(ctx.d) && ctx.fed.get(ctx.d).cordoned) return undefined;
        if (ctx.row.soonest) {
          const mine = rankingDeadline(c, ctx.model, ctx.now, ctx.ex);
          if (mine && v.av.some((/** @type {any} */ a) => {
            const r = rankingDeadline(a, ctx.model, ctx.now, ctx.ex);
            return a.priority === c.priority && r && r > ctx.now && r < mine - SOONER_MARGIN;
          })) return undefined;
        }
        return `current account ${cur} is available, not outranked and not rolled, yet the request went to ${ctx.d}`;
      }),
    },
    {
      id: 'O3', doc: 'docs/routing.md:403',
      holds: row => row.expiry?.enabled === true,
      check: request((ctx, v) => {
        if (ctx.d === '-' || !v.av.length || v.reason(ctx.fed.get(ctx.d)) != null) return undefined;
        if (v.pins.includes(ctx.d)) return undefined;
        if (ctx.row.dist === 'off' && ctx.d === ctx.cur) return undefined;
        // A family diverted off a cursor that cannot serve it stays where it went.
        if (ctx.row.dist === 'off' && ctx.d === ctx.famCur && ctx.cur != null && v.reason(ctx.fed.get(ctx.cur)) != null) return undefined;
        if (v.kind.kind === 'none' && ctx.row.dist !== 'off') return undefined;
        const a = ctx.fed.get(ctx.d);
        const ok = [v.B, v.Bsoft];
        if (v.kind.kind === 'rolled') {
          // The destination of a rolled pin is a placement among the other
          // accounts, held off and banded without the pin.
          const rest = v.av.filter((/** @type {any} */ x) => x.id !== v.kind.q);
          const held = softOf(rest, ctx);
          ok.push(band(rest, ctx.model, ctx.now, ctx.ex), band(rest.filter((/** @type {any} */ x) => !held.has(x.id)), ctx.model, ctx.now, ctx.ex));
        }
        const verdicts = ok.map(b => inBand(b, a, ctx.model, ctx.now));
        if (verdicts.includes(true)) return true;
        if (verdicts.includes(null)) return undefined;
        return `${ctx.d} is outside the top pressure band [${[...v.B.ids]}] (floor ${v.B.floor})`;
      }),
    },
    {
      id: 'O5', doc: 'docs/routing.md:240',
      holds: row => row.dist === 'even',
      check: request((ctx, v) => {
        const k = v.kind.kind;
        if (k !== 'placement' && !(k === 'rolled' && ctx.d !== v.kind.q && !(ctx.ex.reclaimHours > 0))) return undefined;
        if (bandEdge(ctx, v)) return undefined;
        return argminOK(ctx, [...v.av].filter(a => v.B.ids.has(a.id)), a => [activeOn(ctx.convs, a.id, ctx.now, ctx.tagged ? ctx.c : null)]);
      }),
    },
    {
      id: 'O6', doc: 'docs/routing.md:383',
      holds: row => row.dist === 'load',
      check: request((ctx, v) => {
        const k = v.kind.kind;
        if (k !== 'placement' && !(k === 'rolled' && ctx.d !== v.kind.q && !(ctx.ex.reclaimHours > 0))) return undefined;
        if (bandEdge(ctx, v)) return undefined;
        return argminOK(ctx, [...v.av].filter(a => v.B.ids.has(a.id)), a => [
          recentOn(ctx.routed, a.id, ctx.now), activeOn(ctx.convs, a.id, ctx.now, ctx.tagged ? ctx.c : null)]);
      }),
    },
    {
      // A rolled pin is re-ranked, and stays only where "the re-rank ran and
      // the account it was on still ranked best" (docs/routing.md:417): under
      // even and load that re-rank is the placement pick over the band with the
      // pin in it. The adaptive modes decide the move on a burndown score this
      // model does not compute, and a reclaim window can move the pin on its own
      // terms, so neither is judged here.
      id: 'O29', doc: 'docs/routing.md:417',
      holds: row => (row.dist === 'even' || row.dist === 'load') && row.expiry?.enabled === true && row.expiry.preempt !== false
        && !(row.expiry.reclaimHours > 0),
      // Random rolls leave a rolled pin in place in about a third of the runs.
      runFloor: 0.2,
      check: request((ctx, v) => {
        if (v.kind.kind !== 'rolled' || ctx.d !== v.kind.q || bandEdge(ctx, v)) return undefined;
        const r = argminOK(ctx, [...v.av].filter(a => v.B.ids.has(a.id)), placementKey(ctx));
        return typeof r === 'string' ? `rolled pin ${v.kind.q} kept the request: ${r}` : r;
      }),
    },
    {
      // Requests "onto a just-switched-to account are paced: concurrency
      // starts at" startConc, and storm control off sends "the full burst
      // immediately" (docs/routing.md:155, :166). A switch here is a cursor
      // move with distribution off, a request diverted off a cursor whose
      // family bucket or cap, or its advisor's, bars only this request (:174,
      // :178), and a pin's move off its roll or into a reclaim window, which
      // :436 paces "as after any other move". Other moves, the cursor move a
      // cordon or a disable makes between requests, a move off a cursor a
      // route bars for the request or its advisor, a family's first
      // diversion since start, restart or removal, and the ramp a pause arms,
      // are not judged: the docs do not say they ramp, and the first
      // diversion moves no traffic of the family off an account.
      // A request routed to a cordoned account is not a switch, since a
      // cordoned account takes no new work (:21).
      id: 'O27', doc: 'docs/routing.md:155',
      holds: () => true,
      check: anyRequest((ctx, v) => {
        if (ctx.d === '-') return undefined;
        // A request whose advisor narrows the candidates is judged only with
        // distribution off, and not on a cursor move.
        const narrowed = ctx.adv != null && !ctx.adv.plain;
        if (narrowed && ctx.row.dist !== 'off') return undefined;
        const ramp = rampOf(ctx.row);
        if (!ramp.enabled) {
          const n = ctx.admits(BURST);
          if (n == null) return undefined;
          return n >= BURST ? true : `storm control is off, yet ${ctx.d} admitted ${n} of ${BURST} requests at once`;
        }
        const k = v.kind.kind;
        const was = ctx.curBefore == null ? null : ctx.fed.get(ctx.curBefore);
        // A request held to its advisor is barred by the advisor's spent
        // family bucket too, which v.reason does not read.
        const adv = ctx.adv?.routed != null && ctx.adv.both.length > 0 ? ctx.adv.advisor : null;
        const advSpent = adv != null && was != null && !familyCapped(was, adv) && !was.barred.has(adv) && !servesAdvisor(was, adv, ctx.row.threshold);
        // A spent bucket is reported ahead of a route bar, so the bar is read
        // on its own.
        const moved = ctx.row.dist === 'off'
          ? (!narrowed && ctx.curAfter === ctx.d && ctx.curBefore !== ctx.d && ctx.cur !== ctx.d && ctx.famCur !== ctx.d && !was?.barred.has(ctx.model))
            || (ctx.curAfter === ctx.curBefore && was != null && ctx.d !== was.id && ctx.famCur != null && ctx.d !== ctx.famCur
              && !ctx.fed.get(ctx.d)?.cordoned && !was.barred.has(ctx.model)
              && startable(was, ctx.row.threshold) && (['quota', 'capped', 'advisor-capped'].includes(v.reason(was)) || (v.reason(was) == null && advSpent)))
          : ctx.tagged && (k === 'rolled' || k === 'pin') && ctx.d !== v.kind.q
            && (k === 'rolled' || (ctx.ex.reclaimHours > 0 && inBand(v.B, ctx.fed.get(v.kind.q), ctx.model, ctx.now) === false));
        if (!moved) return undefined;
        // One request past startConc is asked for, so a cap above it shows.
        const n = ctx.admits(ramp.startConc + 1);
        if (n == null) return undefined;
        if (n < ramp.startConc) return `traffic switched to ${ctx.d}, which admitted ${n} requests at once; the ramp starts at ${ramp.startConc}`;
        if (ctx.rampFrom() !== ctx.now) return `traffic switched to ${ctx.d}, whose ramp does not start at the switch`;
        return n === ramp.startConc ? true : `traffic switched to ${ctx.d}, which admitted ${n} requests at once; the ramp starts at ${ramp.startConc}`;
      }),
    },
    {
      id: 'O7', doc: 'docs/routing.md:341',
      holds: row => row.dist === 'adaptive',
      check: request((ctx, v) => {
        if (v.kind.kind !== 'placement' || bandEdge(ctx, v)) return undefined;
        const tier = adaptiveTier(ctx, v.av.filter((/** @type {any} */ a) => v.B.ids.has(a.id)));
        if (tier.length < 2) return undefined;
        const bucket = bucketOf(ctx.model);
        const rows = tier.map(a => {
          const us = [a.u7d, ctx.model === FABLE ? a.f : null].filter(x => x != null);
          const u = us.length ? Math.max(...us) : 0;
          const head = Math.max(0, thresholdOf(ctx.row.threshold, bucket) - u);
          return { id: a.id, head, load: activeOn(ctx.convs, a.id, ctx.now, ctx.tagged ? ctx.c : null) };
        });
        // Decidable only where the reserve taper and the load discount are both
        // 1, since the learned reserve is not modeled.
        if (rows.some(r => r.load > 0 || r.head <= ADAPTIVE_MAX_RESERVE)) return undefined;
        const maxRem = Math.max(...rows.map(r => r.head));
        const score = (/** @type {any} */ r) => Math.min(ADAPTIVE_MAX_BURN_BOOST, maxRem / r.head);
        const best = Math.max(...rows.map(score));
        const mine = rows.find(r => r.id === ctx.d);
        if (!mine) return `${ctx.d} is not in the adaptive tier [${rows.map(r => r.id)}]`;
        return score(mine) >= best * (1 - EPS) ? true
          : `${ctx.d} scores ${score(mine)}, best is ${best} (${rows.map(r => `${r.id}:${score(r)}`).join(' ')})`;
      }),
    },
    {
      id: 'O8', doc: 'docs/routing.md:360',
      holds: pressureScoring,
      check: request((ctx, v) => {
        if (v.kind.kind !== 'placement' || bandEdge(ctx, v)) return undefined;
        const cands = v.avSoft.filter((/** @type {any} */ a) => v.Bsoft.ids.has(a.id));
        if (!cands.length) return undefined;
        const tier = adaptiveTier(ctx, cands);
        if (tier.length < 2) return tier[0].id === ctx.d ? true : `${ctx.d} routed, the only candidate is ${tier[0].id}`;
        const fiveHour = ctx.row.dist === 'adaptive-pressure-5h';
        const scores = tier.map(a => {
          const raw = placementPressure(a, ctx);
          const p = raw > 0 && Number.isFinite(raw) ? raw : 0;
          const load = activeOn(ctx.convs, a.id, ctx.now, ctx.tagged ? ctx.c : null);
          return { id: a.id, s: p * (fiveHour ? fiveHourFactor(a, ctx) : 1) * (1 / (1 + load)) };
        });
        const best = Math.max(...scores.map(x => x.s));
        if (best <= 0) {
          return argminOK(ctx, cands, a => [activeOn(ctx.convs, a.id, ctx.now, ctx.tagged ? ctx.c : null)]);
        }
        const mine = scores.find(x => x.id === ctx.d);
        if (!mine) return `${ctx.d} is not in the adaptive tier [${scores.map(x => x.id)}]`;
        return mine.s >= best * (1 - EPS) ? true
          : `${ctx.d} scores ${mine.s}, best is ${best} (${scores.map(x => `${x.id}:${x.s}`).join(' ')})`;
      }),
    },
    {
      id: 'O10', doc: 'docs/routing.md:375',
      holds: row => row.dist === 'adaptive-pressure-soft',
      check: request((ctx, v) => {
        const k = v.kind.kind;
        if (!v.soft.size || !(k === 'placement' || (k === 'pin' && ctx.d !== v.kind.q))) return undefined;
        return v.soft.has(ctx.d)
          ? `${ctx.d} is within fiveHourSoftMargin of its 5h wall; [${v.avSoft.map((/** @type {any} */ a) => a.id)}] are not` : true;
      }),
    },
    {
      id: 'O11', doc: 'docs/routing.md:427',
      holds: row => row.expiry?.enabled === true && row.expiry.reclaimHours > 0,
      check: request((ctx, v) => {
        if (v.kind.kind !== 'pin') return undefined;
        const q = ctx.fed.get(v.kind.q);
        const qIn = inBand(v.B, q, ctx.model, ctx.now);
        if (ctx.d !== v.kind.q) {
          if (qIn === true) return `pin ${v.kind.q} is in the band, yet it was moved to ${ctx.d}`;
          if (qIn === null) return undefined;
          const why = reclaimable(ctx, v, q, ctx.fed.get(ctx.d));
          if (why === null) return undefined;
          return why === '' ? true : `pin ${v.kind.q} reclaimed to ${ctx.d}, which is ${why}`;
        }
        if (qIn !== false) return undefined;
        const verdicts = v.av.filter((/** @type {any} */ a) => a.id !== q.id).map((/** @type {any} */ a) => ({ id: a.id, why: reclaimable(ctx, v, q, a) }));
        if (verdicts.some((/** @type {any} */ x) => x.why === null)) return undefined;
        const movable = verdicts.filter((/** @type {any} */ x) => x.why === '');
        return movable.length ? `pin ${v.kind.q} is outside the band and [${movable.map((/** @type {any} */ x) => x.id)}] meet the reclaim conditions, yet it stayed` : true;
      }),
    },
    {
      id: 'O12', doc: 'docs/routing.md:23',
      holds: row => row.dist === 'off' && row.soonest,
      check: request((ctx, v) => {
        if (ctx.d === '-' || ctx.d !== ctx.cur) return undefined;
        const c = ctx.fed.get(ctx.d);
        if (v.reason(c) != null || ctx.curRolled || ctx.curUncertain) return undefined;
        if (ctx.tagged && c.cordoned) return undefined;
        const mine = rankingDeadline(c, ctx.model, ctx.now, ctx.ex);
        if (!mine) return undefined;
        // With expiry routing on, the walk ranks deadlines within the band only.
        const sooner = v.av.filter((/** @type {any} */ a) => {
          const r = rankingDeadline(a, ctx.model, ctx.now, ctx.ex);
          return (!ctx.ex.enabled || inBand(v.B, a, ctx.model, ctx.now) !== false) && a.id !== c.id && a.priority === c.priority && r && r > ctx.now && r < mine - SOONER_MARGIN;
        });
        return sooner.length ? `stayed on ${ctx.d} while [${sooner.map((/** @type {any} */ a) => a.id)}] reset more than a minute sooner` : true;
      }),
    },
    {
      id: 'O16', doc: 'docs/routing.md:23',
      // With expiry routing on, pressure ranks ahead of the deadline (O3).
      holds: row => row.dist === 'off' && !row.soonest && row.expiry?.enabled !== true,
      check: request((ctx, v) => {
        if (ctx.d === '-' || ctx.d === ctx.cur || !v.av.length) return undefined;
        const a = ctx.fed.get(ctx.d);
        if (v.reason(a) != null || a.priority !== v.top) return undefined;
        // The session-reset switch moves by its own rule (O13b).
        if (ctx.row.sessionReset && ctx.sessionResets.size) return undefined;
        if (ctx.d === ctx.famCur && ctx.cur != null && v.reason(ctx.fed.get(ctx.cur)) != null) return undefined;
        // An unknown deadline ranks first, so that it gets read (the probe bias
        // of docs/routing.md:403).
        const key = (/** @type {any} */ x) => rankingDeadline(x, ctx.model, ctx.now, ctx.ex) ?? -Infinity;
        const sooner = v.av.filter((/** @type {any} */ x) => x.priority === v.top && key(x) < key(a));
        return sooner.length ? `rotated to ${ctx.d} while [${sooner.map((/** @type {any} */ x) => x.id)}] reset sooner` : true;
      }),
    },
    {
      id: 'O17', doc: 'docs/routing.md:126',
      holds: () => true,
      check: ctx => {
        if (!ctx.hop) return undefined;
        const { idle, paused } = hopCandidates(ctx);
        // A rate-limit 429 "does not switch" (docs/routing.md:57): the hop
        // detours one request.
        if (ctx.cursorAfter !== ctx.cursorBefore) return `the hop moved the cursor from ${ctx.cursorBefore} to ${ctx.cursorAfter}`;
        if (ctx.to == null) {
          // A paused best pick leaves the 429 unhopped; G4 counts those.
          if (idle.length && !idle.some(a => paused(a.id))) return `a 429 on ${ctx.from} took no hop while [${idle.map(a => a.id)}] were idle and none paused`;
          return true;
        }
        const a = idle.find(x => x.id === ctx.to);
        if (!a) return `the hop went to ${ctx.to}, which is the 429's account, rolled off or unavailable`;
        if (paused(a.id)) return `the hop went to ${ctx.to}, inside its own 429 pause`;
        const top = Math.min(...idle.filter(x => !paused(x.id)).map(x => x.priority));
        return a.priority === top ? true : `the hop went to ${ctx.to} at priority ${a.priority}; ${top} is idle and unpaused`;
      },
    },
    {
      id: 'O18', doc: 'docs/routing.md:240 and :409, inferred',
      // No docs line states this rule. It is inferred from docs/routing.md:240,
      // where a new conversation is pinned to the account it is routed to, and
      // :409, where a pin stops being honored once its account has failed in
      // the same request, and which names the four writers of a pin map.
      // A pin decides routing only under distribution.
      holds: distOn,
      check: ctx => {
        if (!ctx.hop) return undefined;
        const pinsOf = (/** @type {any} */ snap) => new Map((snap?.sessions ?? []).map((/** @type {any} */ x) =>
          [x.key, x.pins.map((/** @type {any} */ p) => `${p.bucket}=${p.account.id}`).sort().join(',')]));
        const before = pinsOf(ctx.pinsBefore);
        const after = pinsOf(ctx.pinsAfter);
        for (const [k, pins] of before) {
          if (k !== ctx.c && after.get(k) !== pins) return `the 429 on ${ctx.from} moved conversation ${k} from ${pins} to ${after.get(k) ?? 'none'}`;
        }
        // The account the request was tried on and refused is no longer the
        // pin's: the pin is where the request went.
        const own = (ctx.pinsAfter?.sessions ?? []).find((/** @type {any} */ x) => x.key === ctx.c);
        const pin = own?.pins.find((/** @type {any} */ p) => p.bucket === ctx.bucket)?.account.id ?? null;
        const want = ctx.to ?? ctx.from;
        return pin === want ? true : `conversation ${ctx.c} is pinned to ${pin} after the 429 on ${ctx.from}, not to ${want}, where it went`;
      },
    },
    {
      id: 'G1', doc: 'docs/routing.md:240',
      gap: 'docs/routing.md:240 says a conversation is forgotten after an hour idle, with its pins',
      // Pins decide routing only under distribution.
      holds: distOn,
      check: request((ctx, v) => {
        if (!ctx.tagged || !ctx.conv) return undefined;
        if (!ctx.revived || !v.pins.length) return true;
        return `conversation ${ctx.c} idle ${Math.round((ctx.now - ctx.conv.lastSeen) / 60000)} min came back on its old pins [${v.pins}] and went to ${ctx.d}`;
      }),
    },
    {
      // "A roll is handed back once, so two is the most": a second move is the
      // hand-back, and no third move answers the same roll.
      id: 'O26', doc: 'docs/routing.md:455',
      holds: row => distOn(row) && row.expiry?.enabled === true && row.expiry.preempt !== false,
      check: request((ctx, v) => {
        const m = rollMove(ctx, v);
        if (!m) return undefined;
        const n = (handBacksPerRoll.get(m.key) ?? 0) + 1;
        handBacksPerRoll.set(m.key, n);
        if (n === 1) othersAtFirst.set(m.key, otherResets(m.a, ctx.model));
        // Held again for another window that rolled since the hand-back, the
        // reading still holds this window's old reset; G6 counts those.
        if (n > 2 && othersAtFirst.get(m.key) !== otherResets(m.a, ctx.model)) return undefined;
        // A third move shaped like a reclaim may be one; G7 counts those.
        if (n > 2 && reclaimShaped(ctx, v, m)) return undefined;
        return n <= 2 ? true : `pin ${m.p} of ${ctx.c} moved ${n} times on one roll of its ${governing(m.a, ctx.model).window} window, though a roll is handed back once`;
      }),
    },
    {
      id: 'G6', doc: 'docs/routing.md:411',
      gap: 'docs/routing.md:411 says a roll is handed back once, and a reading restored from a hold is held again only for a window that has rolled since; held again for another window, it hands this window\'s roll back a second time',
      holds: row => distOn(row) && row.expiry?.enabled === true && row.expiry.preempt !== false,
      check: request((ctx, v) => {
        const m = rollMove(ctx, v);
        if (!m) return undefined;
        const n = (reheldPerRoll.get(m.key) ?? 0) + 1;
        reheldPerRoll.set(m.key, n);
        if (n <= 2) return true;
        return othersAtFirst.get(m.key) === otherResets(m.a, ctx.model) ? true
          : `pin ${m.p} of ${ctx.c} moved ${n} times on one roll of its ${governing(m.a, ctx.model).window} window after another window rolled`;
      }),
    },
    {
      id: 'G7', doc: 'docs/routing.md:411',
      gap: 'docs/routing.md:411 says a roll is handed back once; with a reclaim window a pin moves a third time on one roll, by reclaim or by a hand-back, which no reading in the model separates',
      holds: row => distOn(row) && row.expiry?.enabled === true && row.expiry.preempt !== false && row.expiry.reclaimHours > 0,
      check: request((ctx, v) => {
        const m = rollMove(ctx, v);
        if (!m) return undefined;
        const n = (reclaimedPerRoll.get(m.key) ?? 0) + 1;
        reclaimedPerRoll.set(m.key, n);
        if (n <= 2) return true;
        if (othersAtFirst.get(m.key) !== otherResets(m.a, ctx.model) || !reclaimShaped(ctx, v, m)) return undefined;
        return `pin ${m.p} of ${ctx.c} moved ${n} times on one roll of its ${governing(m.a, ctx.model).window} window, by a move a reclaim could have made`;
      }),
    },
    {
      id: 'G4', doc: 'docs/routing.md:126',
      gap: 'docs/routing.md:126 says a rate-limit 429 takes "**one** failover hop, onto an account that is not already tried and not inside its own 429 pause"; the hop takes only the best pick, and none when that pick is paused',
      holds: () => true,
      check: ctx => {
        if (!ctx.hop || ctx.to != null) return undefined;
        const { idle, paused } = hopCandidates(ctx);
        const open = idle.filter(a => !paused(a.id));
        return open.length ? `a 429 on ${ctx.from} took no hop while [${open.map(a => a.id)}] were idle and unpaused` : true;
      },
    },
  ];
}

/** The accounts a hop could go to: neither the 429's nor rolled off, and
 * available for the request's model. @param {any} ctx */
function hopCandidates(ctx) {
  const { fed, model, now } = ctx;
  const paused = (/** @type {string} */ id) => (ctx.pausedUntil.get(id) ?? -Infinity) > now;
  const idle = [...fed.values()].filter((/** @type {any} */ a) => a.id !== ctx.from && !ctx.rolledOff.includes(a.id)
    && unavailable(a, model, ctx.row.threshold) == null);
  return { idle: /** @type {any[]} */ (idle), paused };
}

/** Whether a rolled pin's re-rank is the placement pick, which O29 and O28
 * judge. @param {any} ctx */
function placementRanked(ctx) {
  return (ctx.row.dist === 'even' || ctx.row.dist === 'load') && !(ctx.ex.reclaimHours > 0);
}

/** The placement key under even or load. @param {any} ctx */
function placementKey(ctx) {
  const load = (/** @type {any} */ a) => activeOn(ctx.convs, a.id, ctx.now, ctx.tagged ? ctx.c : null);
  return ctx.row.dist === 'even' ? (/** @type {any} */ a) => [load(a)] : (/** @type {any} */ a) => [recentOn(ctx.routed, a.id, ctx.now), load(a)];
}

/** Whether a placement oracle cannot be judged here because a reading sits on
 * a band edge. @param {any} ctx @param {any} v */
function bandEdge(ctx, v) {
  return v.av.some((/** @type {any} */ a) => inBand(v.B, a, ctx.model, ctx.now) === null);
}
