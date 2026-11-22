// The invariants test/routing-config-model.test.js holds every row to, each
// judged against the independent model in routing-model.js and never against
// a decision function of the code under test.
//
// An invariant is `{ id, doc, holds(row), gap?, check(ctx) }`. `check` returns
// undefined where it does not apply, true where it applied and held, and a
// string saying what broke otherwise. The count of `true` results is the
// vacuity floor: an invariant that never applied in a row where it holds
// proves nothing. A `gap` invariant states what docs/routing.md says where
// the code does otherwise; its breaches are tallied for a todo test instead of
// failing the row.

import {
  FABLE, SOONER_MARGIN, band, bucketOf, capOf, deadline, governing, heldOff,
  pressure, recentOn, activeOn, thresholdOf, unavailable, atCap,
} from './routing-model.js';

const ADAPTIVE_MAX_BURN_BOOST = 4;
const ADAPTIVE_MAX_RESERVE = 0.20;
const SOFT_MARGIN = 0.15;
// Readings within this relative distance of a band edge are left undecided:
// the model and the code compute the same quotient in a different order.
const EPS = 1e-9;

const distOn = (/** @type {any} */ row) => row.dist !== 'off';
const pressureScoring = (/** @type {any} */ row) => row.dist.startsWith('adaptive-pressure');

/**
 * Everything the invariants derive from one request's state, computed once.
 * @param {any} ctx
 */
export function view(ctx) {
  if (ctx.view) return ctx.view;
  const { row, model, now, ex, fed } = ctx;
  /** @type {any[]} */
  const all = [...fed.values()];
  const reason = (/** @type {any} */ a) => unavailable(a, model, row.threshold);
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
 * available and not outranked, a rolled bucket pin is re-decided, and with no
 * usable pin the request is a placement.
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
      if (ctx.ex.enabled && ctx.ex.preempt && id === p && ctx.pinRolled) return { kind: 'none' };
      if (!av.some((/** @type {any} */ b) => b.priority < a.priority)) return { kind: 'cordon', q: id };
    }
  }
  for (const id of p != null ? [p, ...others] : others) {
    const a = fed.get(id);
    if (reason(a) != null) continue;
    if (ctx.ex.enabled && ctx.ex.preempt && id === p && (ctx.pinRolled || ctx.pinUncertain)) {
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
function inBand(/** @type {any} */ b, /** @type {any} */ a, /** @type {string} */ model, /** @type {number} */ now) {
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
 * the spent ones unless every one is.
 * @param {any} ctx @param {any[]} cands */
function adaptiveTier(ctx, cands) {
  const { ranked, spent } = rankedTier(cands, ctx);
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
function reclaimable(ctx, v, q, a) {
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
 * A fresh catalog for one played history: G2 counts across steps.
 * @returns {Array<{ id: string, doc: string, gap?: string, holds: (row: any) => boolean, check: (ctx: any) => true|string|undefined }>}
 */
export function catalog() {
  /** @type {Map<string, number>} */
  const movesPerRoll = new Map();
  const request = (/** @type {(ctx: any, v: any) => true|string|undefined} */ f) =>
    (/** @type {any} */ ctx) => (ctx.restart ? undefined : f(ctx, view(ctx)));
  return [
    {
      id: 'U1', doc: 'docs/routing.md:21',
      holds: () => true,
      check: request((ctx, v) => {
        if (ctx.d === '-') return undefined;
        const a = ctx.fed.get(ctx.d);
        if (a.disabled) return `${ctx.d} is disabled`;
        if (atCap(a, ctx.model)) return `${ctx.d} is at a maxUsage cap`;
        if (ctx.model === FABLE && !a.fableRouted) return `${ctx.d} is excluded by a route`;
        if (a.cordoned && !v.pins.includes(ctx.d)) return `${ctx.d} is cordoned and holds none of this conversation's pins`;
        return true;
      }),
    },
    {
      id: 'U2', doc: 'docs/routing.md:19',
      holds: () => true,
      check: request((ctx, v) => {
        if (!v.av.length) return undefined;
        if (ctx.d === '-') return `nothing routed while [${v.av.map((/** @type {any} */ a) => a.id)}] are available`;
        const r = v.reason(ctx.fed.get(ctx.d));
        if (r == null || (r === 'cordoned' && v.pins.includes(ctx.d))) return true;
        return `${ctx.d} is unavailable (${r}) while [${v.av.map((/** @type {any} */ a) => a.id)}] are available`;
      }),
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
      id: 'G1', doc: 'docs/routing.md:232',
      gap: 'docs/routing.md:232 says a conversation is forgotten after an hour idle; its own next request revives its pins',
      // Pins decide routing only under distribution.
      holds: distOn,
      check: request((ctx, v) => {
        if (!ctx.tagged || !ctx.conv) return undefined;
        if (!ctx.revived || !v.pins.length) return true;
        return `conversation ${ctx.c} idle ${Math.round((ctx.now - ctx.conv.lastSeen) / 60000)} min came back on its old pins [${v.pins}] and went to ${ctx.d}`;
      }),
    },
    {
      id: 'G2', doc: 'docs/routing.md:409',
      gap: 'docs/routing.md:409 says at most one cache-miss turn per pin per rollover; a hand-back can move a pin twice on one roll',
      holds: row => distOn(row) && row.expiry?.enabled === true && row.expiry.preempt !== false,
      check: request((ctx, v) => {
        const p = v.p;
        if (!ctx.tagged || p == null || ctx.d === p || ctx.d === '-') return undefined;
        const a = ctx.fed.get(p);
        if (v.reason(a) != null || v.outranked(a)) return undefined;
        if (!(ctx.pinRolled || ctx.pinUncertain)) return undefined;
        const key = `${ctx.life}|${ctx.c}|${ctx.bucket}|${p}|${governing(a, ctx.model).reset}`;
        const n = (movesPerRoll.get(key) ?? 0) + 1;
        movesPerRoll.set(key, n);
        return n === 1 ? true : `pin ${p} of ${ctx.c} moved ${n} times on one roll of its ${governing(a, ctx.model).window} window`;
      }),
    },
  ];
}

/** Whether a placement oracle cannot be judged here because a reading sits on
 * a band edge. @param {any} ctx @param {any} v */
function bandEdge(ctx, v) {
  return v.av.some((/** @type {any} */ a) => inBand(v.B, a, ctx.model, ctx.now) === null);
}
