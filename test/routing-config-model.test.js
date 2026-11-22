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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { validateAdaptiveConfig } from '../src/adaptive-distribution.js';
import {
  H, MIN, OPUS, coveringArray, generate, play, prng, productCells, shrink, toRow,
} from '../test-helpers/routing-model.js';
import { catalog } from '../test-helpers/routing-invariants.js';

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

const profileNames = new Map(Object.entries(PROFILES).map(([k, v]) => [JSON.stringify(v), k]));
const cells = env.ROUTING_MODEL_MATRIX === 'product' ? productCells() : coveringArray(Object.values(PROFILES));
const rows = cells.map(c => toRow(c, profileNames.get(JSON.stringify(c)))).filter(r => !ONLY_ROW || r.name.includes(ONLY_ROW));

/** @type {Map<string, number>} */
const applied = new Map();
/** @type {Map<string, { count: number, first: string|null }>} */
const gaps = new Map([['G1', { count: 0, first: null }], ['G2', { count: 0, first: null }]]);

/** The steps after which a seed's restarts happen, in order.
 * @param {number} seed @param {number} steps */
function restartPoints(seed, steps) {
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
 * invariant.
 * @param {import('node:test').TestContext} t @param {Row} row @param {History} history
 * @param {number[]} restarts @param {{ only?: string, tally?: boolean, label?: string, unchecked?: boolean }} [opts]
 */
function run(t, row, history, restarts, opts = {}) {
  const invariants = opts.unchecked ? [] : catalog().filter(inv => inv.holds(row) && (!opts.only || inv.id === opts.only));
  const check = (/** @type {any} */ ctx) => {
    for (const inv of invariants) {
      const r = inv.check(ctx);
      if (r === undefined) continue;
      if (r === true) { if (opts.tally) applied.set(inv.id, (applied.get(inv.id) ?? 0) + 1); continue; }
      if (inv.gap) {
        if (!opts.tally) continue;
        const g = /** @type {{ count: number, first: string|null }} */ (gaps.get(inv.id));
        g.count++;
        g.first ??= `${r}\nrow: ${row.name}\nseed ${history.seed}, step ${ctx.i}${opts.label ?? ''}`;
        continue;
      }
      throw new Broken(inv.id, inv.doc, r, ctx);
    }
  };
  return play({ AccountManager, validateAdaptiveConfig, t, history, row, restarts, check });
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
  for (const restarts of [[], restartPoints(seed, h.steps.length)]) {
    try {
      const trace = run(t, row, h, restarts, { tally: true, label: restarts.length ? ` (restart after step ${restarts})` : '' });
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
      const [p] = restartPoints(seed, h.steps.length);
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
        const restarts = restartPoints(seed, h.steps.length).slice(0, 1);
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
    if (x.op === 'request' && (x.pin == null || (x.d !== x.pin && y.d !== y.pin))) return null;
    return `step ${x.i}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`;
  });

// The generated histories rarely reach a session-reset switch that moves
// traffic, so one is built by hand here; its checks count toward the floor
// below.
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

test('every invariant holds in a row and is applied there', { skip: ONLY_ROW || ONLY_SEED != null ? 'filtered run' : false }, t => {
  t.diagnostic(`${rows.length} rows, ${seeds.length} seeds each, ${RESTART_POINTS} restart points per seed`);
  t.diagnostic(`checks applied: ${[...applied].map(([k, n]) => `${k}=${n}`).join(' ')}`);
  const dead = catalog().filter(inv => !inv.gap && !rows.some(r => inv.holds(r))).map(inv => inv.id);
  assert.deepEqual(dead, [], `hold in no row: ${dead}; each holds(row) must read an option that some row sets`);
  const vacuous = catalog().filter(inv => !inv.gap && rows.some(r => inv.holds(r)) && !(applied.get(inv.id) > 0)).map(inv => inv.id);
  assert.deepEqual(vacuous, [], `vacuous: ${vacuous} (applied: ${JSON.stringify(Object.fromEntries(applied))})`);
});

// The behaviors below contradict docs/routing.md on the current code. Each is
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
