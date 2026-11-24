// A seeded, model-based test of the routing config options.
//
// Each row is one combination of the options in DIMENSIONS
// (test-helpers/routing-model.js). For every seed a random pool and history of
// requests, quota readings, rollovers, idle gaps and faults is generated and
// played through AccountManager in the server's call order, once without a
// restart and once restarting at seeded points. Every routed request is
// checked against the invariants in test-helpers/routing-invariants.js, which
// judge it on an independent model of docs/routing.md rather than on the
// code's own decisions. CI runs a covering array (every documented profile
// below, and every pair of option values in at least one row); the
// differential tests compare rows that docs/routing.md says must route
// identically, or differ only in where they place.
//
// To add an option:
//   1. Add its values to DIMENSIONS in routing-model.js. toRow passes it to the
//      Row under its own name, and into the row's name. A key of expiryRouting
//      goes in EXPIRY_ONLY as well, and into toRow's `expiry` object and name,
//      as tolerance does. Any other option that means something only under
//      another option's value needs that constraint in validCell, allPairs and
//      coveringArray, which EXPIRY_ONLY has.
//   2. Pass `row.<option>` in the object managerOptions returns (a key of
//      expiryRouting reaches the manager in `row.expiry`).
//   3. Give each invariant the option changes a `holds(row)` that reads it and
//      the check it adds, in routing-invariants.js, and model any state the
//      check reads. The test "every invariant holds in a row and is applied
//      there" fails on an invariant that holds in no row, as one whose
//      `holds` misspells the option does.
//   4. A profile that leaves the option out runs on the manager's default. A
//      documented setup that sets it belongs in PROFILES, with its docs line.
//
// Environment, read by this file only:
//   ROUTING_MODEL_SEEDS=<n>        seeds per row (default DEFAULT_SEEDS; above
//                                  32, more restarts and U4 on every seed)
//   ROUTING_MODEL_MATRIX=product   every valid combination instead of the
//                                  covering array
//   ROUTING_MODEL_ROW=<substring>  only the rows whose name contains it
//   ROUTING_MODEL_SEED=<n>         only this seed; prints the step trace
//
// A failure names the invariant, the row, the seed and the step, and prints
// the history shrunk to the steps that still break it, with the command that
// replays it.

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { validateAdaptiveConfig } from '../src/adaptive-distribution.js';
import {
  FABLE, H, LOAD_WINDOW, MIN, OPUS, coveringArray, generate, play, prng, productCells, shrink, toRow,
} from '../test-helpers/routing-model.js';
import { catalog } from '../test-helpers/routing-invariants.js';
import { QUOTES, TRANSITIONS, takes, transitionPaths } from '../test-helpers/routing-transitions.js';
import { ROLLOVER, ROLLOVER_QUOTES, rolloverMarks } from '../test-helpers/routing-rollover.js';

/** @typedef {import('../test-helpers/routing-model.js').Row} Row */
/** @typedef {import('../test-helpers/routing-model.js').History} History */

const base = { dist: 'off', expiry: 'absent', tolerance: null, preempt: null, reclaim: null, soonest: false, sessionReset: true, persist: false, threshold: '0.98' };
const on = (/** @type {number} */ tolerance, /** @type {boolean} */ preempt, /** @type {string} */ reclaim) => ({ expiry: 'on', tolerance, preempt, reclaim });
// The setups docs/routing.md documents, each a row as written.
const PROFILES = {
  defaults: base, // config.example.json
  even: { ...base, dist: 'even' }, // docs/routing.md:237
  'adaptive-persist': { ...base, dist: 'adaptive', persist: true }, // docs/routing.md:263
  'pressure-scoring': { ...base, dist: 'adaptive-pressure', ...on(3, false, '0') }, // docs/routing.md:352
  'expiry-preempt': { ...base, dist: 'even', ...on(1.5, true, '0') }, // docs/routing.md:394
  reclaim: { ...base, dist: 'adaptive', ...on(3, true, '24') }, // docs/routing.md:424
  load: { ...base, dist: 'load' }, // docs/routing.md:380
  'soonest-reset': { ...base, soonest: true }, // docs/routing.md:23
  'no-session-reset-switch': { ...base, sessionReset: false }, // docs/routing.md:25
};

const env = process.env;
// Some broken rules are caught by only one or two of these seeds, so a change
// to the generator is checked with more of them (ROUTING_MODEL_SEEDS=32).
const DEFAULT_SEEDS = 16;
const SEEDS = Number(env.ROUTING_MODEL_SEEDS) > 0 ? Number(env.ROUTING_MODEL_SEEDS) : DEFAULT_SEEDS;
const DEEP = SEEDS > 32;
const RESTART_POINTS = DEEP ? 5 : 2;
// The seed count sets the restart points, so a replay carries it.
const REPLAY_SEEDS = SEEDS !== DEFAULT_SEEDS ? `ROUTING_MODEL_SEEDS=${SEEDS} ` : '';
const ONLY_SEED = env.ROUTING_MODEL_SEED != null && env.ROUTING_MODEL_SEED !== '' ? Number(env.ROUTING_MODEL_SEED) : null;
const ONLY_ROW = env.ROUTING_MODEL_ROW || null;
const seeds = ONLY_SEED != null ? [ONLY_SEED] : Array.from({ length: SEEDS }, (_, i) => i + 1);

// Rows an invariant needs that no pair of option values forces, appended after
// the covering array so that its rows stay as they are. O29 judges the re-rank
// under load only with preemption on and no reclaim window.
const NEEDED = [{ ...base, dist: 'load', ...on(1.5, true, '0') }];

const profileNames = new Map(Object.entries(PROFILES).map(([k, v]) => [JSON.stringify(v), k]));
const cells = env.ROUTING_MODEL_MATRIX === 'product' ? productCells() : [...coveringArray(Object.values(PROFILES)), ...NEEDED];
const rows = cells.map(c => toRow(c, profileNames.get(JSON.stringify(c)))).filter(r => !ONLY_ROW || r.name.includes(ONLY_ROW));

/** @type {Map<string, number>} */
const applied = new Map();
// Per row: how many histories it played, and in how many of them each
// invariant applied, for the floors that are a share of a row's runs.
/** @type {Map<string, number>} */
const runsOf = new Map();
/** @type {Map<string, number>} */
const appliedRuns = new Map();
/** @type {Map<string, { count: number, first: string|null }>} */
const gaps = new Map([['G1', { count: 0, first: null }], ['G2', { count: 0, first: null }], ['G6', { count: 0, first: null }], ['G7', { count: 0, first: null }], ['G4', { count: 0, first: null }]]);

// The rollover rows the matrix runs take (test-helpers/routing-rollover.js).
/** @type {Set<string>} */
const rolled = new Set();

/** The steps after which a seed's restarts happen, in order. They fall among
 * the random events, since one inside a closing episode only cuts it short.
 * @param {number} seed @param {History} h */
function restartPoints(seed, h) {
  const steps = h.events ?? h.steps.length;
  const rand = prng(seed ^ 0x5bd1e995);
  return Array.from({ length: RESTART_POINTS }, () => Math.floor(rand() * (steps - 2))).sort((a, b) => a - b);
}

class Broken extends Error {
  /** @param {string} id @param {string} doc @param {string} why @param {any} ctx */
  constructor(id, doc, why, ctx) {
    super(`${id} (${doc}) broken: ${why}`);
    this.id = id;
    this.ctx = ctx;
  }
}

/** @param {import('node:test').TestContext} t */
function hermetic(t) {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  // Not t.mock.method: a mock keeps every call until its test ends. The
  // differentials, and U4 on a deep run, play every seed over many rows in
  // one test, so the manager's log calls would grow the heap with the seed
  // count.
  for (const m of /** @type {const} */ (['log', 'info', 'warn', 'error'])) {
    const real = console[m];
    console[m] = () => {};
    t.after(() => { console[m] = real; });
  }
}

/**
 * Plays one history and checks it. Gap breaches are tallied when `tally` is
 * set; any other breach throws Broken. `only` limits the check to one
 * invariant. `perRun` counts the run toward the row's per-run floors.
 * @param {import('node:test').TestContext} t @param {Row} row @param {History} history
 * @param {number[]} restarts @param {{ only?: string, tally?: boolean, perRun?: boolean, label?: string, unchecked?: boolean, taken?: Set<string>, marks?: boolean }} [opts]
 */
function run(t, row, history, restarts, opts = {}) {
  const invariants = opts.unchecked ? [] : catalog().filter(inv => inv.holds(row) && (!opts.only || inv.id === opts.only));
  /** @type {Set<string>} */
  const hit = new Set();
  const mark = opts.marks ? rolloverMarks() : null;
  const check = (/** @type {any} */ ctx) => {
    /** @type {Set<string>} */
    const ok = new Set();
    for (const inv of invariants) {
      const r = inv.check(ctx);
      if (r === undefined) continue;
      if (r === true) {
        if (opts.tally) applied.set(inv.id, (applied.get(inv.id) ?? 0) + 1);
        hit.add(inv.id);
        ok.add(inv.id);
        continue;
      }
      if (inv.gap) {
        if (!opts.tally) continue;
        const g = /** @type {{ count: number, first: string|null }} */ (gaps.get(inv.id));
        g.count++;
        g.first ??= `${r}\nrow: ${row.name}\nseed ${history.seed}, step ${ctx.i}${opts.label ?? ''}`;
        continue;
      }
      throw new Broken(inv.id, inv.doc, r, ctx);
    }
    if (mark) for (const id of mark(ctx, ok)) opts.taken?.add(id);
    return ok;
  };
  const trace = play({ AccountManager, validateAdaptiveConfig, t, history, row, restarts, check, taken: opts.taken });
  if (opts.perRun) {
    runsOf.set(row.name, (runsOf.get(row.name) ?? 0) + 1);
    for (const id of hit) appliedRuns.set(`${id}\t${row.name}`, (appliedRuns.get(`${id}\t${row.name}`) ?? 0) + 1);
  }
  return trace;
}

/** The failure message: the breach, where it happened, the shrunk history and
 * the replay command. @param {import('node:test').TestContext} t */
function explain(t, /** @type {Broken} */ err, /** @type {Row} */ row, /** @type {History} */ h, /** @type {number[]} */ restarts) {
  const marked = { ...h, steps: h.steps.map((s, i) => (restarts.includes(i) ? { ...s, restart: true } : s)) };
  const fails = (/** @type {History} */ x) => {
    try { run(t, row, x, [], { only: err.id }); return false; } catch (e) { return e instanceof Broken; }
  };
  const { history: small, runs } = shrink(marked, fails);
  const ctx = err.ctx;
  const accounts = ctx.fed ? [...ctx.fed.values()] : [];
  return [
    err.message,
    `row: ${row.name}`,
    `seed ${h.seed}, step ${ctx.i} of ${h.steps.length}${restarts.length ? ` (restart after step ${restarts})` : ''}`,
    ctx.tagged ? `request ${ctx.c} ${ctx.model}, pins ${JSON.stringify(Object.fromEntries(ctx.conv?.pins ?? []))} -> ${ctx.d}` : `${ctx.model ?? ''} -> ${ctx.d ?? ''}`,
    `accounts at the step: ${JSON.stringify(accounts)}`,
    `shrunk to ${small.steps.length} of ${h.steps.length} steps in ${runs} runs: ${JSON.stringify(small)}`,
    `replay: ${REPLAY_SEEDS}ROUTING_MODEL_ROW='${row.name}' ROUTING_MODEL_SEED=${h.seed} node --test --import ./test-helpers/isolate-env.js test/routing-config-model.test.js`,
  ].join('\n');
}

/** Both runs of one seed: uninterrupted, then restarting at every point.
 * @param {import('node:test').TestContext} t @param {Row} row @param {number} seed */
function runSeed(t, row, seed) {
  const h = generate(seed);
  for (const restarts of [[], restartPoints(seed, h)]) {
    try {
      const trace = run(t, row, h, restarts, { tally: true, perRun: true, taken: rolled, marks: true, label: restarts.length ? ` (restart after step ${restarts})` : '' });
      if (ONLY_SEED != null) {
        t.diagnostic(`restarts [${restarts}]`);
        for (const d of trace) t.diagnostic(JSON.stringify(d));
      }
    } catch (e) {
      if (e instanceof Broken) assert.fail(explain(t, e, row, h, restarts));
      throw e;
    }
  }
}

for (const row of rows) {
  test(`routing model: ${row.name}`, t => {
    hermetic(t);
    for (const seed of seeds) runSeed(t, row, seed);
  });
}

test('U4: the same seed and row give the same decisions twice', t => {
  hermetic(t);
  for (const row of rows) {
    for (const seed of DEEP ? seeds : seeds.slice(0, 1)) {
      const h = generate(seed);
      const [p] = restartPoints(seed, h);
      const a = run(t, row, h, [p], { unchecked: true });
      const b = run(t, row, h, [p], { unchecked: true });
      assert.deepEqual(b, a, `U4 broken: row ${row.name}, seed ${seed}`);
    }
  }
});

/**
 * Two rows on the same seeds. `judge` is called with both traces and returns
 * a breach or null. @param {string} id
 */
function differential(id, /** @type {(row: Row) => Row|null} */ partner, /** @type {(a: any[], b: any[]) => string|null} */ judge) {
  const pairs = rows.flatMap(r => { const p = partner(r); return p ? [[r, p]] : []; });
  test(`${id}: ${pairs.length} row pairs`, t => {
    hermetic(t);
    assert.ok(pairs.length > 0 || ONLY_ROW, `${id} is vacuous: no row has a partner`);
    for (const [a, b] of pairs) {
      for (const seed of seeds) {
        const h = generate(seed);
        const restarts = restartPoints(seed, h).slice(0, 1);
        const why = judge(run(t, a, h, restarts, { unchecked: true }), run(t, b, h, restarts, { unchecked: true }));
        if (why) {
          assert.fail(`${id} broken: ${why}\nrows: ${a.name} | ${b.name}\nseed ${seed} (restart after step ${restarts})\n`
            + `replay: ${REPLAY_SEEDS}ROUTING_MODEL_ROW='${a.name}' ROUTING_MODEL_SEED=${seed}`);
        }
      }
    }
  });
}

const firstDiff = (/** @type {any[]} */ a, /** @type {any[]} */ b) => a.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(b[i]));
const identical = (/** @type {any[]} */ a, /** @type {any[]} */ b) => {
  const i = firstDiff(a, b);
  return i < 0 ? null : `step ${a[i].i}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`;
};
/** @param {Row} r @param {Partial<Row>} change @param {string} label */
const variant = (r, change, label) => ({ ...r, ...change, name: `${r.name} ${label}` });

// O4 (docs/routing.md:450): a knob written but off routes byte-identically.
differential('O4 expiry written but off equals absent',
  r => (r.expiry === undefined ? variant(r, { expiry: { enabled: false, tolerance: 3, preempt: false, reclaimHours: 24 } }, '(written-off)') : null),
  identical);
differential('O4 reclaimHours 0 equals unset',
  r => {
    if (!r.expiry?.enabled || r.expiry.reclaimHours !== 0) return null;
    const rest = { ...r.expiry };
    delete rest.reclaimHours;
    return variant(r, { expiry: rest }, '(reclaim unset)');
  },
  identical);
// O9 (docs/routing.md:365): pressure scoring changes where a conversation is
// placed, never whether a pinned one moves. Up to the first difference the two
// managers hold the same state, so that step must be a placement or the
// destination of a move both made.
differential('O9 pressure scoring never decides a move',
  r => (r.dist === 'adaptive' ? variant(r, { dist: 'adaptive-pressure' }, '(pressure)') : null),
  (a, b) => {
    const i = firstDiff(a, b);
    if (i < 0) return null;
    const x = a[i]; const y = b[i];
    if (x.op !== 'untagged' && (x.pin == null || (x.d !== x.pin && y.d !== y.pin))) return null;
    // Both hopped off the same account after a 429, or failed over off the
    // same refused one; the destination is the difference.
    if ((x.op === 'throttle' || x.op === 'fault') && x.d === y.d && x.to != null && y.to != null) return null;
    return `step ${x.i}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`;
  });

// A session-reset switch built by hand, so that one is played whatever seeds
// run; its checks count toward the floor below.
test('O13b: a 5h reset moves traffic to the account that reset (three accounts)', t => {
  hermetic(t);
  const start = Date.UTC(2030, 2, 10, 12);
  const acct = (/** @type {string} */ id, /** @type {number} */ r7d, /** @type {number} */ r5h) => ({
    id, priority: 0, org: 'org-1', maxUsage: null, endsAt: null, hidden7d: false, clockless7d: false, clocklessF: false,
    u5h: 0.1, r5h: start + r5h, u7d: 0.2, r7d: start + r7d, F: null, FR: null,
  });
  // `a` serves as the cursor, hits its 5h wall and hands the traffic to `b`.
  // Each serves a request as the cursor first, since that spends the re-rank
  // flag a first weekly reading sets, and an account the switch moves to with
  // the flag still set re-ranks the request. `c`, whose week ends soonest, is
  // disabled until the traffic rests on `b`. When `a`'s 5h window resets, `a`
  // ends sooner than `b` and takes the traffic; `c` ends sooner still, but its
  // window did not reset.
  const history = {
    seed: 0, start, fableRoute: null,
    accounts: [acct('a', 50 * H, 30 * MIN), acct('b', 100 * H, 4 * H), acct('c', 20 * H, 4 * H)],
    steps: [
      { at: start + MIN, op: 'fault', id: 'c', kind: 'disable' },
      { at: start + 2 * MIN, op: 'request', c: 'c0', model: OPUS },
      { at: start + 3 * MIN, op: 'five', id: 'a', u5h: 0.99 },
      { at: start + 4 * MIN, op: 'request', c: 'c0', model: OPUS },
      { at: start + 5 * MIN, op: 'request', c: 'c0', model: OPUS },
      { at: start + 6 * MIN, op: 'fault', id: 'c', kind: 'disable' },
      { at: start + 31 * MIN, op: 'request', c: 'c0', model: OPUS },
    ],
  };
  const row = toRow(base, 'defaults');
  const before = applied.get('O13b') ?? 0;
  /** @type {any[]} */
  let trace = [];
  try { trace = run(t, row, history, [], { tally: true }); } catch (e) {
    if (e instanceof Broken) assert.fail(explain(t, e, row, history, []));
    throw e;
  }
  assert.deepEqual(trace.map(d => d.d), ['a', 'b', 'b', 'a'], 'the scenario did not route as built');
  assert.equal((applied.get('O13b') ?? 0) - before, 1, 'O13b did not judge the switch');
});

// Built by hand: at the default seed count no restart starts on the
// constructor's account and then sees that account roll before the next request.
test('O2: a roll between a restart and the next request is read on the account startup picked', t => {
  hermetic(t);
  const start = Date.UTC(2030, 2, 10, 12);
  const acct = (/** @type {string} */ id, /** @type {number} */ r7d) => ({
    id, priority: 0, org: 'org-1', maxUsage: /** @type {any} */ (null), endsAt: null, hidden7d: false, clockless7d: false, clocklessF: false,
    u5h: 0.1, r5h: start + 4 * H, u7d: 0.3, r7d: start + r7d, F: 0.1, FR: start + 150 * H,
  });
  // The restart takes the accounts in reverse, so it starts on `d`, the
  // constructor's own account. `d` then rolls. The advised request cannot be
  // preempted off it, since `a` is at its Fable cap, and the next one is.
  const history = {
    seed: 0, start, fableRoute: null,
    accounts: [{ ...acct('a', 100 * H), maxUsage: { unified7dFable: 0.5 }, F: 0.6 }, acct('d', 20 * H)],
    steps: [
      { at: start + MIN, op: 'request', c: 'c0', model: OPUS, restart: true },
      { at: start + 2 * MIN, op: 'roll', id: 'd', fable: false },
      { at: start + 3 * MIN, op: 'request', c: 'c1', model: OPUS, advisor: FABLE },
      { at: start + 4 * MIN, op: 'request', c: 'c2', model: OPUS },
    ],
  };
  const row = toRow({ ...base, ...on(1, true, '0'), advisorEligibility: 'strict' });
  /** @type {any[]} */
  let trace = [];
  try { trace = run(t, row, history, [], { only: 'O2' }); } catch (e) {
    if (e instanceof Broken) assert.fail(explain(t, e, row, history, []));
    throw e;
  }
  assert.deepEqual(trace.map(d => d.d), ['d', 'd', 'a'], 'the scenario did not route as built');
});

// Built by hand to catch a manager that drops the bucket's reading with its
// pin: no matrix history removes an account, and no removal path removes a
// pin's account while that reading holds an unsettled roll on another of the
// conversation's pins.
test('a removal keeps the roll its bucket\'s reading holds for the conversation\'s other pin', t => {
  hermetic(t);
  const start = Date.UTC(2030, 2, 10, 12);
  const acct = (/** @type {string} */ id, /** @type {number} */ r7d, /** @type {number} */ u7d) => ({
    id, priority: 0, org: 'org-1', maxUsage: /** @type {any} */ (null), endsAt: null, hidden7d: false, clockless7d: false, clocklessF: false,
    u5h: 0.1, r5h: start + 4 * H, u7d, r7d: start + r7d, F: null, FR: null,
  });
  // c0 is placed on `a` for both buckets, and `a` rolls. With `b` and `c`
  // disabled and `x` outside the band, the rolled `a` keeps the next request,
  // which a billing refusal fails over to `x`. That writes nothing while the
  // roll is unsettled, and the Opus bucket's reading still names `a` before
  // its roll. Removing `x` drops the Opus pin and keeps that reading. Once `b` is
  // back and the billing hold is over, the roll the reading holds still moves
  // the Opus request off `a`, which keeps only the Fable pin.
  const history = {
    seed: 0, start, fableRoute: null,
    accounts: [acct('a', 30 * H, 0.2), acct('b', 40 * H, 0.2), acct('c', 45 * H, 0.2), acct('x', 160 * H, 0.9)],
    steps: [
      { at: start + MIN, op: 'request', c: 'c0', model: OPUS },
      { at: start + 2 * MIN, op: 'request', c: 'c0', model: FABLE },
      { at: start + 3 * MIN, op: 'fault', id: 'b', kind: 'disable' },
      { at: start + 4 * MIN, op: 'fault', id: 'c', kind: 'disable' },
      { at: start + 5 * MIN, op: 'roll', id: 'a', fable: false },
      { at: start + 6 * MIN, op: 'fault', kind: 'billing', c: 'c0', model: OPUS },
      { at: start + 7 * MIN, op: 'remove', id: 'x', model: OPUS },
      { at: start + 8 * MIN, op: 'fault', id: 'b', kind: 'disable' },
      { at: start + 20 * MIN, op: 'request', c: 'c0', model: OPUS },
    ],
  };
  const row = toRow(PROFILES['expiry-preempt'], 'expiry-preempt');
  /** @type {any[]} */
  let trace = [];
  try { trace = run(t, row, history, []); } catch (e) {
    if (e instanceof Broken) assert.fail(explain(t, e, row, history, []));
    throw e;
  }
  assert.deepEqual(trace.slice(0, 3).map(d => [d.d, d.to]), [['a', undefined], ['a', undefined], ['a', 'x']], 'the scenario did not route as built');
  // docs/routing.md:411 holds the roll until a stay is served at the
  // destination, and :417 moves traffic that returns before then off the
  // rolled account as soon as anywhere better is available.
  assert.notEqual(trace[3].d, 'a', 'the request returned to a, whose unsettled roll the reading holds');
});

// Built by hand to catch a manager whose serve in one bucket releases a roll
// held in another: no matrix history serves the conversation's other bucket
// between a move off a roll and the return to it.
test('a serve in one bucket keeps the roll held in the conversation\'s other bucket', t => {
  hermetic(t);
  const start = Date.UTC(2030, 2, 10, 12);
  const acct = (/** @type {string} */ id, /** @type {number} */ r7d, /** @type {number} */ u7d) => ({
    id, priority: 0, org: 'org-1', maxUsage: /** @type {any} */ (null), endsAt: null, hidden7d: false, clockless7d: false, clocklessF: false,
    u5h: 0.1, r5h: start + 4 * H, u7d, r7d: start + r7d, F: null, FR: null,
  });
  // c0 rests on `a` in both buckets and `a` rolls. The Opus request moves
  // off it to `x`, and the next one rests there, which holds the roll. The
  // Fable request follows, and `x` serves it before any Opus request is
  // served under the move's stamp. With `x` full, the Opus request returns to
  // `a` and gets the held reading back, so once `x` recovers O15 judges the
  // next one.
  const history = {
    seed: 0, start, fableRoute: null,
    accounts: [acct('a', 30 * H, 0.2), acct('x', 40 * H, 0.2), acct('z', 160 * H, 0.99)],
    steps: [
      { at: start + MIN, op: 'fault', id: 'x', kind: 'disable' },
      { at: start + 2 * MIN, op: 'request', c: 'c0', model: OPUS },
      { at: start + 3 * MIN, op: 'request', c: 'c0', model: FABLE },
      { at: start + 4 * MIN, op: 'roll', id: 'a', fable: false },
      { at: start + 5 * MIN, op: 'fault', id: 'x', kind: 'disable' },
      { at: start + 6 * MIN, op: 'request', c: 'c0', model: OPUS },
      { at: start + 7 * MIN, op: 'request', c: 'c0', model: OPUS },
      { at: start + 8 * MIN, op: 'request', c: 'c0', model: FABLE },
      { at: start + 9 * MIN, op: 'usage', id: 'x', u7d: 0.99, f: null },
      { at: start + 10 * MIN, op: 'request', c: 'c0', model: OPUS },
      { at: start + 11 * MIN, op: 'usage', id: 'x', u7d: 0.2, f: null },
      { at: start + 12 * MIN, op: 'request', c: 'c0', model: OPUS },
    ],
  };
  const row = toRow({ ...base, dist: 'adaptive-pressure', ...on(1.5, true, '0') });
  const judged = () => applied.get('O15') ?? 0;
  const before = judged();
  /** @type {any[]} */
  let trace = [];
  try { trace = run(t, row, history, [], { tally: true }); } catch (e) {
    if (e instanceof Broken) assert.fail(explain(t, e, row, history, []));
    throw e;
  }
  assert.deepEqual(trace.slice(0, 6).map(d => d.d), ['a', 'a', 'x', 'x', 'x', 'a'], 'the scenario did not route as built');
  const all = judged() - before;
  const mid = judged();
  run(t, row, { ...history, steps: history.steps.slice(0, -1) }, [], { tally: true });
  assert.equal(all - (judged() - mid), 1, 'O15 did not judge the last request');
});

// Built by hand: no matrix history re-ranks a rolled pin under load while a
// contender's request is about LOAD_WINDOW old.
test('the load re-rank counts a request inside LOAD_WINDOW and none past it', t => {
  hermetic(t);
  const start = Date.UTC(2030, 2, 10, 12);
  const acct = (/** @type {string} */ id, /** @type {number} */ r7d) => ({
    id, priority: 0, org: 'org-1', maxUsage: /** @type {any} */ (null), endsAt: null, hidden7d: false, clockless7d: false, clocklessF: false,
    u5h: 0.1, r5h: start + 4 * H, u7d: 0.2, r7d: start + r7d, F: null, FR: null,
  });
  // c0 is placed on `a` and c1 on `x`, then `a` rolls. While c1's request
  // counts, `x` has more requests and the re-rank keeps c0 on `a`; once
  // it is past LOAD_WINDOW, the two tie on load and the even keys pick `x`.
  // The docs' "last ten minutes" leaves a request exactly LOAD_WINDOW old
  // undecided, so that case is not played.
  for (const [late, to] of [[-1, 'a'], [1, 'x']]) {
    const history = {
      seed: 0, start, fableRoute: null,
      accounts: [acct('a', 30 * H), acct('x', 190 * H)],
      steps: [
        { at: start + MIN, op: 'fault', id: 'x', kind: 'disable' },
        { at: start + 2 * MIN, op: 'request', c: 'c0', model: OPUS },
        { at: start + 3 * MIN, op: 'fault', id: 'x', kind: 'disable' },
        { at: start + 3 * MIN, op: 'fault', id: 'a', kind: 'disable' },
        { at: start + 4 * MIN, op: 'request', c: 'c1', model: OPUS },
        { at: start + 5 * MIN, op: 'fault', id: 'a', kind: 'disable' },
        { at: start + 5 * MIN, op: 'roll', id: 'a', fable: false },
        { at: start + 4 * MIN + LOAD_WINDOW + late, op: 'request', c: 'c0', model: OPUS },
      ],
    };
    const row = toRow({ ...base, dist: 'load', ...on(1.5, true, '0') });
    /** @type {any[]} */
    let trace = [];
    try { trace = run(t, row, history, []); } catch (e) {
      if (e instanceof Broken) assert.fail(explain(t, e, row, history, []));
      throw e;
    }
    assert.deepEqual(trace.map(d => d.d), ['a', 'x', to], `c1's request ${LOAD_WINDOW + late} ms old: the scenario did not route as built`);
  }
});

// Built by hand: at the default seed count no request is diverted off a
// cursor whose Fable bucket alone is spent, as its own bucket or its
// advisor's. A reload that bars the cursor from Fable at that point leaves a
// route bar, which is not judged.
test('O27: a request diverted off a cursor that serves other models ramps its destination', t => {
  hermetic(t);
  const start = Date.UTC(2030, 2, 10, 12);
  const acct = (/** @type {string} */ id, /** @type {number} */ r7d) => ({
    id, priority: 0, org: 'org-1', maxUsage: /** @type {any} */ (null), endsAt: null, hidden7d: false, clockless7d: false, clocklessF: false,
    u5h: 0.1, r5h: start + 4 * H, u7d: 0.2, r7d: start + r7d, F: 0.1, FR: start + 150 * H,
  });
  const fable = (/** @type {string[]} */ accounts) => [{ name: 'fable', match: ['*fable*'], accounts }];
  // c1 is served on the cursor `a` until `a`'s Fable bucket is spent. Its
  // next request goes to `b` while the cursor stays on `a`, which still
  // serves Opus.
  const cases = [
    { name: 'own bucket', cell: base, req: { model: FABLE }, judged: 1 },
    { name: 'advisor bucket', cell: { ...base, advisorEligibility: 'strict' }, req: { model: OPUS, advisor: FABLE }, judged: 1 },
    { name: 'reload', cell: { ...base, routes: 'layered' }, req: { model: FABLE }, routeTables: { first: fable(['a', 'b']), next: fable(['b']) }, judged: 0 },
  ];
  for (const k of cases) {
    const history = {
      seed: 0, start, fableRoute: null, routeTables: k.routeTables,
      accounts: [acct('a', 50 * H), acct('b', 100 * H)],
      steps: [
        { at: start + MIN, op: 'request', c: 'c0', model: OPUS },
        { at: start + 2 * MIN, op: 'request', c: 'c1', ...k.req },
        { at: start + 3 * MIN, op: 'usage', id: 'a', u7d: 0.2, f: 0.99, reload: k.routeTables != null },
        { at: start + 4 * MIN, op: 'request', c: 'c1', ...k.req },
        { at: start + 5 * MIN, op: 'request', c: 'c0', model: OPUS },
      ],
    };
    const row = toRow(k.cell);
    const before = applied.get('O27') ?? 0;
    /** @type {any[]} */
    let trace = [];
    try { trace = run(t, row, history, [], { tally: true }); } catch (e) {
      if (e instanceof Broken) assert.fail(explain(t, e, row, history, []));
      throw e;
    }
    assert.deepEqual(trace.map(d => d.d), ['a', 'a', 'b', 'a'], `${k.name}: the scenario did not route as built`);
    assert.equal((applied.get('O27') ?? 0) - before, k.judged, `${k.name}: O27 judged the diversion ${(applied.get('O27') ?? 0) - before} times`);
  }
});

// Built by hand to catch a manager that skips the ramp when the diversion's
// destination is the conversation's own pin: with distribution off that pin
// does not keep the conversation, so the move is a switch.
test('O27: a request diverted onto its conversation\'s pin ramps the destination', t => {
  hermetic(t);
  const start = Date.UTC(2030, 2, 10, 12);
  const acct = (/** @type {string} */ id, /** @type {number} */ r7d) => ({
    id, priority: 0, org: 'org-1', maxUsage: /** @type {any} */ (null), endsAt: null, hidden7d: false, clockless7d: false, clocklessF: false,
    u5h: 0.1, r5h: start + 4 * H, u7d: 0.2, r7d: start + r7d, F: 0.1, FR: start + 150 * H,
  });
  // c1's first Fable request is diverted to `b`, which pins it there. Once
  // `a` serves Fable again and c2 brings the family back to it, `a`'s Fable
  // bucket is spent and c1's next Fable request is diverted to `b` again.
  const history = {
    seed: 0, start, fableRoute: null,
    accounts: [acct('a', 50 * H), acct('b', 100 * H)],
    steps: [
      { at: start + MIN, op: 'request', c: 'c0', model: OPUS },
      { at: start + 2 * MIN, op: 'usage', id: 'a', u7d: 0.2, f: 0.99 },
      { at: start + 3 * MIN, op: 'request', c: 'c1', model: FABLE },
      { at: start + 4 * MIN, op: 'usage', id: 'a', u7d: 0.2, f: 0.1 },
      { at: start + 5 * MIN, op: 'request', c: 'c2', model: FABLE },
      { at: start + 6 * MIN, op: 'usage', id: 'a', u7d: 0.2, f: 0.99 },
      { at: start + 7 * MIN, op: 'request', c: 'c1', model: FABLE },
      { at: start + 8 * MIN, op: 'request', c: 'c0', model: OPUS },
    ],
  };
  const row = toRow(base, 'defaults');
  const before = applied.get('O27') ?? 0;
  /** @type {any[]} */
  let trace = [];
  try { trace = run(t, row, history, [], { tally: true }); } catch (e) {
    if (e instanceof Broken) assert.fail(explain(t, e, row, history, []));
    throw e;
  }
  assert.deepEqual(trace.map(d => d.d), ['a', 'b', 'a', 'b', 'a'], 'the scenario did not route as built');
  assert.equal((applied.get('O27') ?? 0) - before, 1, 'O27 did not judge the diversion onto the pin');
});

// Built by hand: a cordoned account keeps a conversation through its pin in
// another bucket, and no matrix history plays that keep with distribution off.
test('O27: a request kept on a cordoned account through another bucket\'s pin is no switch', t => {
  hermetic(t);
  const start = Date.UTC(2030, 2, 10, 12);
  const acct = (/** @type {string} */ id, /** @type {number} */ r7d) => ({
    id, priority: 0, org: 'org-1', maxUsage: /** @type {any} */ (null), endsAt: null, hidden7d: false, clockless7d: false, clocklessF: false,
    u5h: 0.1, r5h: start + 4 * H, u7d: 0.2, r7d: start + r7d, F: 0.1, FR: start + 150 * H,
  });
  // c's only pin is its Opus pin on `d`, which is then cordoned, so the
  // cursor moves to `a`. Once `a`'s Fable bucket is spent, c's first Fable
  // request stays on `d`.
  const history = {
    seed: 0, start, fableRoute: null,
    accounts: [acct('d', 30 * H), acct('a', 50 * H), acct('b', 100 * H), acct('e', 160 * H)],
    steps: [
      { at: start + MIN, op: 'request', c: 'c', model: OPUS },
      { at: start + 2 * MIN, op: 'fault', id: 'd', kind: 'cordon' },
      { at: start + 3 * MIN, op: 'request', c: 'c2', model: OPUS },
      { at: start + 4 * MIN, op: 'request', c: 'c3', model: FABLE },
      { at: start + 5 * MIN, op: 'usage', id: 'a', u7d: 0.2, f: 0.99 },
      { at: start + 6 * MIN, op: 'request', c: 'c3', model: FABLE },
      { at: start + 7 * MIN, op: 'request', c: 'c', model: FABLE },
    ],
  };
  const row = toRow(base, 'defaults');
  /** @type {any[]} */
  let trace = [];
  try { trace = run(t, row, history, []); } catch (e) {
    if (e instanceof Broken) assert.fail(explain(t, e, row, history, []));
    throw e;
  }
  assert.deepEqual(trace.map(d => d.d), ['d', 'a', 'a', 'b', 'd'], 'the scenario did not route as built');
});

// The hold and removal tables' paths play under every row and are judged by
// the same invariants as the matrix.
/** @type {Set<string>} */
const taken = new Set();
const reachable = TRANSITIONS.filter(r => r.reachable === true);
// No matrix row sends an advisor with the setting left out, as Claude Code
// with config.example.json does, so the paths also run that way.
const pathRows = [...rows, toRow({ ...base, advisorEligibility: 'default' }, 'defaults')].filter(r => !ONLY_ROW || r.name.includes(ONLY_ROW));
test('transitions: every reachable row of the hold and removal tables is taken', t => {
  hermetic(t);
  for (const row of pathRows) {
    for (const h of transitionPaths(Date.UTC(2030, 2, 10, 12))) {
      try { run(t, row, h, [], { tally: true, taken }); } catch (e) {
        if (e instanceof Broken) assert.fail(`${explain(t, e, row, h, [])}\npath: ${h.name}`);
        throw e;
      }
    }
  }
  if (ONLY_ROW) return;
  assert.deepEqual(reachable.filter(r => !takes(taken, r)).map(r => r.id), [], 'rows no path took');
});

test('transitions covered', t => {
  t.diagnostic(`transitions covered ${reachable.filter(r => takes(taken, r)).length}/${reachable.length}`);
});

// The rollover rows the episodes do not take yet, each with why. They stay
// reachable, so the covered line below counts them as missed.
const UNTAKEN = [
  // No episode plays the event in the row's state.
  'RO-unread', 'RO-body-fail', 'RO-retry-same', 'RO-retry-confirms', 'RO-inflight', 'RO-scoped-family', 'RO-knob-off',
  'RO-knob-on', 'RO-route-pin', 'RO-extra-usage', 'PIN-remove-held', 'PIN-release', 'DR-keep', 'DR-roll-preempt',
  'DR-roll-nopreempt', 'CU-borrow', 'RC-sooner', 'RC-several', 'RC-third-move',
  // Not credited from random events. RC-fivehour: a conversation idle past
  // an hour, which the docs say is forgotten and the code keeps (G1), passes
  // for one reclaimed onto A that waited out A's 5-hour window.
  // PIN-restart-persist: U5 compares only the restored pins, not the held roll
  // a restart drops.
  'RC-fivehour', 'PIN-restart-persist',
  // Driven, but no invariant judges the outcome.
  'RO-pressure-dest', 'RO-two-preempts', 'RO-left-by-handback', 'RO-stay-on-owed', 'RO-first-arrival', 'PIN-restart-idle', 'RA-window',
  // Driven, but at 16 seeds the invariant that judges the outcome never
  // returns true there: G6 counts the docs' outcome as a gap, O1 does not
  // judge the stay after a second move, and G1 never sees a revived
  // conversation without its pins.
  'RO-other-window', 'RO-handback-once', 'PIN-idle',
];
const rolloverReachable = ROLLOVER.filter(r => r.reachable === true);
test('transitions: every reachable rollover row but the listed ones is taken', { skip: ONLY_ROW || ONLY_SEED != null ? 'filtered run' : false }, () => {
  assert.deepEqual(rolloverReachable.filter(r => !rolled.has(r.id) && !UNTAKEN.includes(r.id)).map(r => r.id), [], 'rollover rows no episode took');
});

test('rollover transitions covered', t => {
  t.diagnostic(`rollover transitions covered ${rolloverReachable.filter(r => rolled.has(r.id)).length}/${rolloverReachable.length}`);
});

test('rollover rows no episode takes yet', { todo: UNTAKEN.join(', ') || false }, () => {
  assert.deepEqual(UNTAKEN, []);
});

// A row's citation ties its outcome to the docs. A docs edit that moves the
// sentence must move the citation too.
test('every quoted docs sentence starts on the line its row cites', () => {
  const norm = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim();
  const quotes = { ...QUOTES, ...ROLLOVER_QUOTES };
  const missed = [...TRANSITIONS, ...ROLLOVER].filter(r => typeof r.docs === 'string').filter(r => {
    const [file, n] = /** @type {string} */ (r.docs).split(':');
    const lines = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n');
    // The sentence may start late on its line and wrap onto the next ones.
    const at = norm(lines.slice(Number(n) - 1, Number(n) + 5).join(' ')).indexOf(norm(quotes[r.id]));
    return !(at >= 0 && at < norm(lines[Number(n) - 1]).length);
  }).map(r => r.id);
  assert.deepEqual(missed, [], 'rows whose sentence is not on the cited line');
});

test('every invariant holds in a row and is applied there', { skip: ONLY_ROW || ONLY_SEED != null ? 'filtered run' : false }, t => {
  t.diagnostic(`${rows.length} rows, ${seeds.length} seeds each, ${RESTART_POINTS} restart points per seed`);
  t.diagnostic(`checks applied: ${[...applied].map(([k, n]) => `${k}=${n}`).join(' ')}`);
  const dead = catalog().filter(inv => !inv.gap && !rows.some(r => inv.holds(r))).map(inv => inv.id);
  assert.deepEqual(dead, [], `hold in no row: ${dead}; each holds(row) must read an option that some row sets`);
  const vacuous = catalog().filter(inv => !inv.gap && rows.some(r => inv.holds(r)) && !(applied.get(inv.id) > 0)).map(inv => inv.id);
  assert.deepEqual(vacuous, [], `vacuous: ${vacuous} (applied: ${JSON.stringify(Object.fromEntries(applied))})`);
  // A share of a few seeds says nothing, so fewer seeds than CI runs skip it.
  const thin = SEEDS < DEFAULT_SEEDS ? [] : catalog().filter(inv => inv.runFloor != null).flatMap(inv => rows.filter(r => inv.holds(r)).flatMap(r => {
    const runs = runsOf.get(r.name) ?? 0;
    const hits = appliedRuns.get(`${inv.id}\t${r.name}`) ?? 0;
    return hits < /** @type {number} */ (inv.runFloor) * runs ? [`${inv.id} applied in ${hits} of ${runs} runs (floor ${inv.runFloor}): ${r.name}`] : [];
  }));
  assert.deepEqual(thin, [], `below the per-run floor:\n${thin.join('\n')}`);
});

// The behaviors below contradict the docs on the current code. Each is
// a todo test that asserts what the docs say; once the code matches, dropping
// `todo` turns it into a regular invariant.

test('G1: a conversation idle past the known window is forgotten (matrix)',
  { todo: 'docs/routing.md:232 says a conversation is forgotten after an hour idle; its own next request revives its pins' }, () => {
    const g = /** @type {{ count: number, first: string|null }} */ (gaps.get('G1'));
    assert.equal(g.count, 0, `${g.count} revivals; first:\n${g.first}`);
  });

test('G1: a conversation idle past the known window is forgotten (two accounts)',
  { todo: 'docs/routing.md:409 says a conversation idle past the known window is forgotten' }, t => {
    hermetic(t);
    const start = Date.UTC(2030, 2, 10, 12);
    const acct = (/** @type {string} */ id, /** @type {number} */ u7d) => ({
      id, priority: 0, org: 'org-1', maxUsage: null, endsAt: null, hidden7d: false, clockless7d: false, clocklessF: false,
      u5h: 0.1, r5h: start + 4 * H, u7d, r7d: start + 100 * H, F: null, FR: null,
    });
    // `c` is placed on `a`, whose week resets first, and `a` is then cordoned.
    // After 61 quiet minutes `c` is a new conversation by the docs, and a
    // cordoned account takes no new conversation; only its own request comes
    // in, so nothing has swept the record first.
    const history = {
      seed: 0, start, fableRoute: null, accounts: [{ ...acct('a', 0.2), r7d: start + 50 * H }, acct('b', 0.2)],
      steps: [
        { at: start + MIN, op: 'request', c: 'c', model: OPUS },
        { at: start + 2 * MIN, op: 'fault', id: 'a', kind: 'cordon' },
        { at: start + 62 * MIN, op: 'request', c: 'c', model: OPUS },
      ],
    };
    const row = toRow({ ...base, dist: 'even' });
    const [first, second] = play({ AccountManager, validateAdaptiveConfig, t, history, row });
    assert.equal(first.d, 'a', 'c is placed on a');
    assert.equal(second.d, 'b', `c came back on its cordoned old pin ${second.d}`);
  });

test('G2: a pin moves at most once per rollover (matrix)',
  { todo: 'docs/routing.md:409 says at most one cache-miss turn per pin per rollover; a hand-back can move a pin twice on one roll' }, () => {
    const g = /** @type {{ count: number, first: string|null }} */ (gaps.get('G2'));
    assert.equal(g.count, 0, `${g.count} second moves; first:\n${g.first}`);
  });

test('G6: a roll is handed back once, also after another window rolls (matrix)',
  { todo: 'docs/routing.md:411 says a roll is handed back once, and a reading restored from a hold is held again only for a window that has rolled since; held again for another window, it hands this window\'s roll back a second time' }, () => {
    const g = /** @type {{ count: number, first: string|null }} */ (gaps.get('G6'));
    assert.equal(g.count, 0, `${g.count} third moves; first:\n${g.first}`);
  });

test('G7: a roll is handed back once, also with a reclaim window (matrix)',
  { todo: 'docs/routing.md:411 says a roll is handed back once; with a reclaim window a pin moves a third time on one roll, by reclaim or by a hand-back, which no reading in the model separates' }, () => {
    const g = /** @type {{ count: number, first: string|null }} */ (gaps.get('G7'));
    assert.equal(g.count, 0, `${g.count} third moves; first:\n${g.first}`);
  });

test('G4: a 429 hops to an untried, unpaused idle account (matrix)',
  { todo: 'docs/routing.md:126 says a rate-limit 429 takes "**one** failover hop, onto an account that is not already tried and not inside its own 429 pause"; the hop takes only the best pick, and none when that pick is paused' }, () => {
    const g = /** @type {{ count: number, first: string|null }} */ (gaps.get('G4'));
    assert.equal(g.count, 0, `${g.count} 429s took no hop while an untried, unpaused account was idle; first:\n${g.first}`);
  });

// Built by hand: at the default seed count no history reaches the probe with
// an account at its advisor cap, so a matrix check would judge nothing.
test('G3: the probe skips an account at its advisor-family cap under "strict"',
  { todo: 'docs/quota.md:276 says an advisor request checks the advisor family cap on the exhausted-fleet probe; under "strict" the probe runs in the pass that has dropped the advisor' }, t => {
    hermetic(t);
    const start = Date.UTC(2030, 2, 10, 12);
    const acct = (/** @type {string} */ id, /** @type {number} */ u7d) => ({
      id, priority: 0, org: 'org-1', maxUsage: /** @type {any} */ (null), endsAt: null, hidden7d: false, clockless7d: false, clocklessF: false,
      u5h: 0.1, r5h: start + 4 * H, u7d, r7d: start + 100 * H, F: 0.1, FR: start + 90 * H,
    });
    // Both read past the threshold, so the request goes to the probe, which
    // takes the less used account; that is `a`, whose Fable cap is spent.
    const history = {
      seed: 0, start, fableRoute: null,
      accounts: [{ ...acct('a', 0.985), maxUsage: { unified7dFable: 0.5 }, F: 0.6 }, acct('b', 0.995)],
      steps: [{ at: start + MIN, op: 'request', c: 'c', model: OPUS, advisor: FABLE }],
    };
    const row = toRow({ ...base, advisorEligibility: 'strict' });
    const [only] = play({ AccountManager, validateAdaptiveConfig, t, history, row });
    assert.equal(only.d, 'b', `the probe went to ${only.d}, at its Fable cap`);
  });
