// The Insights page's arithmetic (dashboard.js): number formats, axis tops,
// the series each "split by" stacks, the legend's statistics, the cache hit
// rate, model grouping, the two headlines and their pace, the calendar, the
// months and the "Where it went" list. The page script only draws what these
// return; its fetching is covered with the rest of the page in
// dashboard.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderDashboardHtml, fmtTokens, niceCeil, insightsRangeText, insightsChange, insightsBucketLabel,
  insightsSeries, stackSeries, topModels, fmtUsd, fmtUsdShort, fleetMissingText,
  seriesStats, cacheHitRate, peakBucket, providerRows,
  recordedFrom, insightsDayKey, bucketAt, labelStep, pricedRequests,
  insightsTotals, runningTotals, rollingAverage, insightsTrend, insightsHeadline, insightsPace, monthTotals, calendarGrid, breakdownRows,
} from '../src/dashboard.js';

test('the page ships every Insights helper it is tested against', () => {
  const html = renderDashboardHtml();
  for (const fn of [fmtTokens, niceCeil, insightsRangeText, insightsChange, insightsBucketLabel, insightsSeries, stackSeries, topModels, fmtUsd, fmtUsdShort, fleetMissingText,
    seriesStats, cacheHitRate, peakBucket, providerRows,
    recordedFrom, insightsDayKey, bucketAt, labelStep, pricedRequests,
    insightsTotals, runningTotals, rollingAverage, insightsTrend, insightsHeadline, insightsPace, monthTotals, calendarGrid, breakdownRows]) {
    assert.ok(html.includes(fn.toString()), `${fn.name} not serialized into the page`);
  }
  assert.ok(html.includes('id="page-insights"'), 'the page section');
  assert.ok(html.includes("{ key: 'insights', label: 'Insights', section: 'Overview' }"), 'the sidebar entry');
});

test('token counts read at a glance', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(12345), '12.3k');
  assert.equal(fmtTokens(123456), '123k');
  assert.equal(fmtTokens(4_480_000), '4.48M');
  assert.equal(fmtTokens(48_900_000), '48.9M');
  assert.equal(fmtTokens(368_000_000), '368M');
  assert.equal(fmtTokens(4_480_000_000), '4.48B');
  assert.equal(fmtTokens(2.5e12), '2.50T');
  assert.equal(fmtTokens(undefined), '0');
});

test('axis tops land on round numbers', () => {
  assert.equal(niceCeil(0), 1);
  assert.equal(niceCeil(0.7), 1);
  assert.equal(niceCeil(17), 20);
  assert.equal(niceCeil(230), 250);
  assert.equal(niceCeil(4100), 5000);
  assert.equal(niceCeil(9100), 10000);
});

test('the range reads as a phrase, and a change against the period before as a pill and its words', () => {
  assert.equal(insightsRangeText('24h'), 'last 24 hours');
  assert.equal(insightsRangeText('30d'), 'last 30 days');
  assert.equal(insightsRangeText('all'), 'all time');
  assert.deepEqual(insightsChange(115, 100, '30d'), { pill: '▲ 15%', vs: 'vs the previous 30 days' });
  assert.deepEqual(insightsChange(91, 100, '24h'), { pill: '▼ 9%', vs: 'vs the previous 24 hours' });
  assert.deepEqual(insightsChange(100, 100, '7d'), { pill: '0%', vs: 'vs the previous 7 days' });
  assert.equal(insightsChange(100, null, '7d'), null, 'nothing on record to compare with');
  assert.equal(insightsChange(100, 0, '7d'), null, 'a percentage of nothing is not a number');
});

test('buckets read as days or hours', () => {
  assert.match(insightsBucketLabel('2026-03-07', 'day', false), /7/);
  assert.match(insightsBucketLabel('2026-03-07', 'day', true), /7/);
  const ms = new Date(2026, 2, 7, 9).getTime();
  assert.equal(insightsBucketLabel(ms, 'hour', false), '09:00');
  assert.match(insightsBucketLabel(ms, 'hour', true), /09:00$/);
  assert.equal(insightsBucketLabel('junk', 'day', false), 'junk');
});

test('an hour bucket says the minute it starts at, in a zone with a fractional offset', () => {
  const saved = process.env.TZ;
  try {
    // UTC+5:30 the year round: an epoch hour starts at :30 local time.
    process.env.TZ = 'Asia/Kolkata';
    const bucket = Math.floor(Date.UTC(2026, 2, 7, 1, 10) / 3600000) * 3600000;
    assert.equal(insightsBucketLabel(bucket, 'hour', false), '06:30');
    assert.match(insightsBucketLabel(bucket, 'hour', true), /06:30$/);
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

const data = {
  range: '7d', unit: 'day', buckets: ['a', 'b'], since: 1,
  totals: { requests: 3, input: 10, output: 20, cacheRead: 900, cacheWrite: 70 },
  previous: { requests: 2, input: 5, output: 5, cacheRead: 400, cacheWrite: 90 },
  requests: [1, 2],
  kinds: { cacheRead: [400, 500], cacheWrite: [30, 40], input: [5, 5], output: [10, 10] },
  providers: [
    { provider: 'anthropic', tokens: 700, values: [300, 400] },
    { provider: 'backend:api.deepseek.com', tokens: 100, values: [50, 50] },
    { provider: 'codex', tokens: 150, values: [100, 50] },
    { provider: 'backend:api.z.ai', tokens: 50, values: [0, 50] },
  ],
  accounts: [
    { provider: 'anthropic', account: 'b', tokens: 400, requests: 1, values: [100, 300] },
    { provider: 'anthropic', account: 'a', tokens: 300, requests: 1, values: [200, 100] },
    { provider: 'codex', account: 'gone', tokens: 150, requests: 1, values: [100, 50] },
  ],
  models: [
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', tokens: 30, requests: 1 },
    { provider: 'anthropic', model: 'claude-opus-5-5', tokens: 500, requests: 2 },
    { provider: 'anthropic', model: 'claude-haiku-4-5', tokens: 40, requests: 1 },
    { provider: 'codex', model: '(unknown)', tokens: 5, requests: 1 },
  ],
};

test('split by provider: Claude, Codex and the backends as one series, in that order', () => {
  const s = insightsSeries(data, 'provider', []);
  assert.deepEqual(s.map(x => x.label), ['Claude', 'Codex', 'Backends']);
  assert.deepEqual(s.map(x => x.color), ['var(--ip-claude)', 'var(--ip-codex)', 'var(--ip-backend)']);
  assert.deepEqual(s[2].values, [50, 100], 'both backends summed');
  assert.equal(s[2].total, 150);
  const one = insightsSeries({ ...data, providers: data.providers.slice(0, 2) }, 'provider', []);
  assert.deepEqual(one.map(x => x.label), ['Claude', 'DeepSeek'], 'a lone backend keeps its own name');
});

test('split by account: colour follows the account\'s place in the config, never its rank', () => {
  const accounts = [{ name: 'a', provider: 'anthropic' }, { name: 'b', provider: 'anthropic' }];
  const s = insightsSeries(data, 'account', accounts);
  assert.deepEqual(s.map(x => [x.label, x.color]), [['a', 'var(--is1)'], ['b', 'var(--is2)'], ['Other', 'var(--dim)']]);
  assert.deepEqual(s[2].values, [100, 50], 'an account no longer configured is summed into Other');
  // Another range ranks b first; the colours stay put.
  const flipped = insightsSeries({ ...data, accounts: [data.accounts[1], data.accounts[0]] }, 'account', accounts);
  assert.deepEqual(flipped.map(x => x.color), ['var(--is1)', 'var(--is2)']);
  // Past the palette's eight, accounts fold into Other too.
  const many = Array.from({ length: 10 }, (_, i) => ({ name: `n${i}`, provider: 'anthropic' }));
  const big = insightsSeries({ ...data, accounts: many.map((a, i) => ({ provider: 'anthropic', account: a.name, tokens: 1, requests: 1, values: [i, 0] })) }, 'account', many);
  assert.equal(big.length, 9);
  assert.equal(big[8].label, 'Other');
  assert.deepEqual(big[8].values, [8 + 9, 0]);
});

test('split by token type: four fixed series', () => {
  const s = insightsSeries(data, 'kind', []);
  assert.deepEqual(s.map(x => x.label), ['Cache read', 'Cache write', 'Input', 'Output']);
  assert.equal(s[0].total, 900);
  assert.deepEqual(insightsSeries(null, 'kind', []), []);
});

test('stacking puts each series on top of the ones before it', () => {
  const cols = stackSeries([{ values: [1, 2] }, { values: [3, 0] }], 2);
  assert.deepEqual(cols, [[[0, 1], [1, 4]], [[0, 2], [2, 2]]]);
});

test('models are ranked by the name a person reads, dated snapshots together', () => {
  const top = topModels(data.models, 6);
  assert.deepEqual(top.map(m => [m.label, m.tokens, m.requests]), [['Opus 5.5', 500, 2], ['Haiku 4.5', 70, 2], ['(unknown)', 5, 1]]);
  assert.equal(topModels(data.models, 1).length, 1);
  assert.deepEqual(topModels(null), []);
});

test('legend statistics: total, average bucket, peak and the bucket still filling', () => {
  assert.deepEqual(seriesStats([2, 6, 1]), { total: 9, avg: 3, max: 6, last: 1 });
  assert.deepEqual(seriesStats([]), { total: 0, avg: 0, max: 0, last: 0 });
  assert.deepEqual(seriesStats(null), { total: 0, avg: 0, max: 0, last: 0 });
});

test('the cache hit rate counts prompt tokens only, and none without prompt tokens', () => {
  assert.equal(cacheHitRate({ input: 10, cacheRead: 80, cacheWrite: 10 }), 0.8);
  assert.equal(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(cacheHitRate(null), null);
});

test('the busiest bucket, and how many average buckets it is', () => {
  assert.deepEqual(peakBucket([1, 4, 4, 3]), { index: 1, value: 4, ratio: 4 / 3 });
  assert.equal(peakBucket([0, 0]), null);
  assert.equal(peakBucket([]), null);
});

test('dollars read at a glance', () => {
  assert.equal(fmtUsd(0), '$0');
  assert.equal(fmtUsd(0.004), '<$0.01');
  assert.equal(fmtUsd(0.42), '$0.42');
  assert.equal(fmtUsd(12.345), '$12.35');
  assert.equal(fmtUsd(999.994), '$999.99');
  assert.equal(fmtUsd(12345.6), '$12,346');
  assert.equal(fmtUsd(null), '$0');
});

const fleet = {
  ...data,
  scope: 'all',
  accounts: [...data.accounts, { provider: 'anthropic', account: 'z', tokens: 9, requests: 1, values: [9, 0] }, { provider: 'anthropic', account: 'm', tokens: 8, requests: 1, values: [0, 8] }],
  instances: [
    { name: 'desk', self: true, state: 'ok', tokens: 700, requests: 2, cost: 5, values: [300, 400] },
    { name: 'laptop', self: false, state: 'unreachable', error: 'timed out', tokens: 0, requests: 0, cost: 0, values: [0, 0] },
    { name: 'server', self: false, state: 'ok', tokens: 300, requests: 1, cost: 2, values: [200, 100] },
  ],
};

test('every machine at once: the machines not counted are named', () => {
  assert.equal(fleetMissingText(fleet), 'Not counted: laptop (unreachable).');
  const all = { ...fleet, instances: [fleet.instances[0], fleet.instances[2]] };
  assert.equal(fleetMissingText(all), null);
  assert.equal(fleetMissingText(data), null);
});

test('split by machine: one series per machine counted, coloured by its place in the list', () => {
  const s = insightsSeries(fleet, 'instance', []);
  assert.deepEqual(s.map(x => [x.label, x.color, x.total]), [['desk', 'var(--is1)', 700], ['server', 'var(--is3)', 300]]);
  assert.deepEqual(s[1].values, [200, 100]);
  assert.deepEqual(insightsSeries(data, 'instance', []), [], 'one machine has no machines to split');
});

test('split by account on every machine: a linked machine\'s accounts follow this one\'s, by name', () => {
  const s = insightsSeries(fleet, 'account', [{ name: 'a', provider: 'anthropic' }, { name: 'b', provider: 'anthropic' }]);
  // a and b from this config, then codex/gone, anthropic/m, anthropic/z sorted.
  assert.deepEqual(s.map(x => [x.label, x.color]), [['a', 'var(--is1)'], ['b', 'var(--is2)'], ['m', 'var(--is3)'], ['z', 'var(--is4)'], ['gone', 'var(--is5)']]);
});

test('models carry their cost, null only while no snapshot of them is priced', () => {
  const top = topModels([
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', tokens: 30, requests: 1, input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
    { provider: 'anthropic', model: 'claude-haiku-4-5', tokens: 40, requests: 1, input: 40, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.25 },
    { provider: 'codex', model: '(unknown)', tokens: 5, requests: 1, cost: null },
  ], 6);
  assert.deepEqual(top.map(m => [m.label, m.cost, m.input]), [['Haiku 4.5', 0.75, 50], ['(unknown)', null, 0]]);
});

// Requests and cost per bucket, by provider and by account, as the server
// sends them since the redesign (usage-history.js Series).
const detailed = {
  ...data,
  providers: [
    { provider: 'anthropic', tokens: 700, requests: 2, cost: 3, input: 5, output: 15, cacheRead: 650, cacheWrite: 30, values: [300, 400], requestValues: [1, 1], costValues: [1, 2] },
    { provider: 'grok', tokens: 300, requests: 1, cost: 0.5, input: 5, output: 5, cacheRead: 250, cacheWrite: 40, values: [100, 200], requestValues: [0, 1], costValues: [0, 0.5] },
  ],
  accounts: [
    { provider: 'anthropic', account: 'a', tokens: 700, requests: 2, cost: 3, values: [300, 400], requestValues: [1, 1], costValues: [1, 2] },
    { provider: 'grok', account: 'g', tokens: 300, requests: 1, cost: 0.5, values: [100, 200], requestValues: [0, 1], costValues: [0, 0.5] },
  ],
  models: [
    { provider: 'grok', model: 'grok-4.7', tokens: 250, requests: 1, input: 5, output: 5, cacheRead: 200, cacheWrite: 40, cost: 0.4 },
    { provider: 'anthropic', model: 'claude-opus-5-5', tokens: 700, requests: 2, cost: 3 },
  ],
};

test('requests and cost stack by provider or account, and fall back to one total when they cannot', () => {
  const req = insightsSeries(detailed, 'provider', [], 'requests');
  assert.deepEqual(req.map(x => [x.label, x.values, x.total]), [['Claude', [1, 1], 2], ['Grok', [0, 1], 1]]);
  const cost = insightsSeries(detailed, 'account', [{ name: 'a', provider: 'anthropic' }, { name: 'g', provider: 'grok' }], 'cost');
  assert.deepEqual(cost.map(x => [x.label, x.values, x.total]), [['a', [1, 2], 3], ['g', [0, 0.5], 0.5]]);
  assert.deepEqual(insightsSeries(detailed, 'kind', [], 'requests'), [], 'token types have no requests of their own');
  assert.deepEqual(insightsSeries(data, 'provider', [], 'requests'), [], 'a proxy too old to send them');
  assert.deepEqual(insightsSeries({ ...detailed, splitDetail: false }, 'provider', [], 'cost'), [], 'a fleet sum missing a machine\'s');
});

test('the providers table: share, cost per request and cache hit rate', () => {
  const rows = providerRows(detailed);
  assert.deepEqual(rows.map(r => [r.label, r.accounts, r.requests, r.share]), [['Claude', 1, 2, 0.7], ['Grok', 1, 1, 0.3]]);
  assert.equal(rows[0].perRequest, 1.5);
  assert.equal(rows[1].hit, 250 / 295);
  assert.deepEqual(providerRows(null), []);
});

test('averages and peaks count from the first bucket recorded', () => {
  // A 7-day range on a history that began on the 6th day.
  const since = new Date(2026, 9, 6, 15, 0).getTime();
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];
  assert.equal(recordedFrom({ unit: 'day', buckets: days, since }), 5);
  assert.equal(recordedFrom({ unit: 'day', buckets: days, since: null }), 7);
  assert.equal(insightsDayKey(since), '2026-10-06');
  assert.deepEqual(seriesStats([0, 0, 0, 0, 0, 4, 6], 5), { total: 10, avg: 5, max: 6, last: 6 });
  assert.equal(peakBucket([0, 0, 0, 0, 0, 4, 6], 5)?.ratio, 1.2);
  // Hours: the bucket holding `since` is the first.
  const h0 = Math.floor(since / 3600000) * 3600000;
  assert.equal(recordedFrom({ unit: 'hour', buckets: [h0 - 3600000, h0, h0 + 3600000], since }), 1);
});

test('one x is one bucket on every panel, and labels never touch', () => {
  // 24 hourly buckets across 480px: 20px each.
  assert.equal(bucketAt(0, 20, 24), 0);
  assert.equal(bucketAt(39.9, 20, 24), 1);
  assert.equal(bucketAt(479, 20, 24), 23);
  assert.equal(bucketAt(-5, 20, 24), 0, 'left of the plot is the first bucket');
  assert.equal(bucketAt(9999, 20, 24), 23, 'right of it, the last');
  assert.equal(bucketAt(100, 900, 1), 0, 'one bucket');
  // A year on a phone: 366 buckets across 240px.
  assert.equal(bucketAt(239, 240 / 366, 366), 364);
  // "Nov 13" (6 characters) needs 57px: every bucket at 60px, every 3rd at 20px.
  assert.equal(labelStep(6, 60), 1);
  assert.equal(labelStep(6, 20), 3);
  assert.equal(labelStep(6, 240 / 366), 87);
});

test('cost per request divides by requests to priced models only', () => {
  const models = [
    { provider: 'grok', model: 'grok-4.7', requests: 2, cost: 1 },
    { provider: 'grok', model: 'grok-mystery', requests: 8, cost: null },
    { provider: 'anthropic', model: 'claude-opus-5-5', requests: 1, cost: 2 },
  ];
  assert.deepEqual(pricedRequests(models), { all: 3, grok: 2, claude: 1 });
  const rows = providerRows({ ...detailed, models });
  assert.equal(rows.find(r => r.key === 'grok')?.perRequest, 0.5 / 2);
  // Nothing priced: no figure rather than $0.
  assert.equal(providerRows({ ...detailed, models: [{ provider: 'grok', model: 'x', requests: 3, cost: null }] }).find(r => r.key === 'grok')?.perRequest, null);
});

test('day boundaries are the proxy\'s, not the browser\'s', () => {
  // The proxy says recording began on the 6th; the browser's clock would say otherwise.
  const days = ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];
  assert.equal(recordedFrom({ unit: 'day', buckets: days, since: 1, sinceDay: '2026-10-06' }), 2);
});

test('a fleet sum prices only the requests a machine could price', () => {
  // This machine priced 2 of the model's requests; the peer, too old to, sent 8.
  assert.deepEqual(pricedRequests([{ provider: 'grok', model: 'x', requests: 10, cost: 1, pricedRequests: 2 }]), { all: 2, grok: 2 });
});

test('a reply from the previous version, read on its own, takes provider counts from its models', () => {
  const old = {
    ...detailed,
    providers: detailed.providers.map(p => ({ provider: p.provider, tokens: p.tokens, cost: p.cost, values: p.values })),
    models: [
      { provider: 'grok', model: 'grok-4.7', tokens: 300, requests: 1, input: 5, output: 5, cacheRead: 250, cacheWrite: 40, cost: 0.5 },
      { provider: 'anthropic', model: 'claude-opus-5-5', tokens: 700, requests: 2, input: 5, output: 15, cacheRead: 650, cacheWrite: 30, cost: 3 },
    ],
  };
  const rows = providerRows(old);
  assert.deepEqual(rows.map(r => [r.label, r.requests, r.cacheRead]), [['Claude', 2, 650], ['Grok', 1, 250]]);
  assert.equal(rows[1].hit, 250 / 295);
});

test('an older machine in another time zone cannot push the average above the peak', () => {
  // Merged or read on its own, an old reply without sinceDay: its first spend
  // lands on a day this clock calls the day before the one it computes.
  const zeros = [0, 0, 0, 0, 0, 0, 0];
  const input = [0, 50, 80, 80, 80, 80, 80];
  const reply = {
    unit: 'day', since: Date.UTC(2026, 10, 6, 7), sinceDay: '2026-11-06',
    buckets: ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'],
    kinds: { input, output: zeros, cacheRead: zeros, cacheWrite: zeros },
  };
  const from = recordedFrom(reply);
  assert.equal(from, 1, 'the day with the first spend');
  const st = seriesStats(input, from);
  assert.ok(st.avg <= st.max, `avg ${st.avg} <= peak ${st.max}`);
  assert.equal(peakBucket(input, from)?.ratio, 80 / st.avg);
  // A reply with nothing in it starts nowhere.
  assert.equal(recordedFrom({ unit: 'day', since: null, buckets: ['a', 'b'], kinds: { input: [0, 0] } }), 2);
});

// ---- The redesign: two headlines, their pace, the calendar, the months and
// "Where it went".

/** @param {string} first @param {number} n */
const dayRun = (first, n) => {
  const [y, m, d] = first.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => insightsDayKey(new Date(y, m - 1, d + i).getTime()));
};
/** @param {number[]} cost */
const costReply = (cost, extra = {}) => {
  const buckets = dayRun('2026-10-28', cost.length);
  const zeros = cost.map(() => 0);
  return {
    range: '30d', unit: 'day', buckets, since: 1, sinceDay: '2026-01-01',
    kinds: { input: cost.map(c => c * 1000), output: zeros, cacheRead: zeros, cacheWrite: zeros },
    cost: { total: cost.reduce((x, y) => x + y, 0), values: cost, previous: null, unpricedTokens: 0 },
    ...extra,
  };
};
const monthName = (/** @type {number} */ m) => new Date(2026, m, 1).toLocaleDateString([], { month: 'long' });

test('dollars on an axis or a bar: whole from $100, cents below unless the figure is whole', () => {
  assert.equal(fmtUsdShort(0), '$0');
  assert.equal(fmtUsdShort(0.5), '$0.50');
  assert.equal(fmtUsdShort(9.99), '$9.99');
  // Axis steps of $6.25 must not read as $13 and $19.
  assert.equal(fmtUsdShort(12.5), '$12.50');
  assert.equal(fmtUsdShort(18.75), '$18.75');
  assert.equal(fmtUsdShort(25), '$25');
  assert.equal(fmtUsdShort(193.4), '$193');
  assert.equal(fmtUsdShort(1500), '$1.5k');
  assert.equal(fmtUsdShort(null), '$0');
});

test('the two metrics per bucket: every token, or the estimated cost, and no cost from a proxy too old to estimate it', () => {
  assert.deepEqual(insightsTotals(data, 'tokens'), [445, 555]);
  assert.equal(insightsTotals(data, 'cost'), null, 'no estimate is not $0');
  assert.deepEqual(insightsTotals({ ...data, cost: { total: 3, values: [1, 2], previous: null, unpricedTokens: 0 } }, 'cost'), [1, 2]);
  assert.deepEqual(insightsTotals(null, 'tokens'), []);
  assert.deepEqual(runningTotals([1, 2, null, 4]), [1, 3, 3, 7]);
  assert.deepEqual(runningTotals(null), []);
});

test('the headlines: cost and tokens against the period before, and what the cost left out', () => {
  const tokens = insightsHeadline(data, 'tokens');
  assert.deepEqual([tokens.label, tokens.text, tokens.change, tokens.vs, tokens.note], ['Tokens', '1.0k', '▲ 100%', 'vs the previous 7 days', '3 requests']);
  const priced = insightsHeadline({ ...data, cost: { total: 30, values: [10, 20], previous: 20, unpricedTokens: 150 } }, 'cost');
  assert.deepEqual([priced.label, priced.value, priced.text, priced.change, priced.note], ['Est. API cost', 30, '$30.00', '▲ 50%', '150 tokens not priced']);
  assert.equal(insightsHeadline({ ...data, cost: { total: 30, values: [10, 20], previous: 20, unpricedTokens: 0 } }, 'cost').note, 'at API list prices');
  // A linked instance on a proxy older than the estimate sends no cost at all.
  const old = insightsHeadline(data, 'cost');
  assert.deepEqual([old.value, old.text, old.vs], [null, '—', 'this proxy is too old to estimate it']);
  assert.equal(insightsHeadline({ ...data, previous: null }, 'tokens').vs, 'no earlier period on record');
  assert.equal(insightsHeadline({ ...data, previous: null, range: 'all', sinceDay: '2026-10-06' }, 'tokens').vs, 'since ' + insightsBucketLabel('2026-10-06', 'day', true));
  assert.equal(insightsHeadline({ ...data, since: null, previous: null }, 'tokens').vs, 'nothing recorded yet');
});

test('the pace: the month so far plus the last seven full days\' average for each day after today', () => {
  // Oct 28 to Nov 10: $10 every full day, $4 so far today.
  const reply = costReply([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 4]);
  const pace = /** @type {any} */ (insightsPace(reply, 'cost'));
  assert.equal(pace.kind, 'month');
  assert.equal(pace.label, 'On pace for');
  // Nov 1 to 10 is $94; 20 days of November follow the 10th.
  assert.deepEqual([pace.soFar, pace.rate, pace.left, pace.value], [94, 10, 20, 294]);
  assert.equal(pace.text, '$294.00');
  assert.equal(pace.sub, monthName(10) + ': $94.00 so far + $10.00/day × 20 days');
  assert.match(pace.how, /^Projected: /);
  // Today is never a full day: a quiet morning does not drag the rate down.
  assert.equal(/** @type {any} */ (insightsPace(costReply([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 0]), 'cost')).rate, 10);
  // Tokens follow the same arithmetic.
  assert.equal(/** @type {any} */ (insightsPace(reply, 'tokens')).value, 294000);
});

test('the pace: recording that began this month counts the month from that day', () => {
  // Recording began on Nov 5, with the 1st inside the range: Nov 5 to 10 is
  // the month so far, and the days before it are not counted as quiet ones.
  const reply = costReply([0, 0, 0, 0, 0, 0, 0, 0, 10, 10, 10, 10, 10, 4], { sinceDay: '2026-11-05' });
  const pace = /** @type {any} */ (insightsPace(reply, 'cost'));
  assert.equal(pace.kind, 'month');
  assert.equal(pace.soFar, 54);
  // Five full days on record, not the seven asked for.
  assert.equal(pace.rate, 10);
  assert.match(pace.how, /the last 5 full days/);
  assert.match(pace.how, /recorded from /);
  // The same, with the range starting after the 1st: still the whole month recorded.
  const week = { ...reply, buckets: reply.buckets.map((_, i) => dayRun('2026-11-03', 14)[i]), sinceDay: '2026-11-05' };
  week.kinds = { ...reply.kinds, input: [0, 0, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 4].map(c => c * 1000) };
  week.cost = { ...reply.cost, values: [0, 0, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 4] };
  assert.equal(/** @type {any} */ (insightsPace(week, 'cost')).kind, 'month');
  // A history older than the range, with the 1st outside it: no month to project.
  assert.equal(/** @type {any} */ (insightsPace({ ...week, sinceDay: '2026-01-01', kinds: { ...week.kinds, input: week.kinds.input.map(() => 1) } }, 'cost')).kind, 'run');
});

test('the pace: a range that misses the 1st is a 30-day run rate, hours are the busiest hour, and nothing is no pace', () => {
  const week = costReply([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 1]);
  week.buckets = dayRun('2026-11-03', 14);
  const run = /** @type {any} */ (insightsPace(week, 'cost'));
  assert.deepEqual([run.kind, run.label, run.value, run.text], ['run', '30-day pace', 150, '$150.00']);
  assert.equal(run.sub, '$5.00/day, the average of the last 7 full days');
  const hours = { ...week, unit: 'hour', buckets: week.buckets.map((_, i) => i * 3600000) };
  const peak = /** @type {any} */ (insightsPace(hours, 'cost'));
  assert.equal(peak.kind, 'peak');
  assert.equal(peak.label, 'Busiest hour');
  assert.equal(peak.value, 5);
  assert.equal(insightsPace({ ...week, since: null }, 'cost'), null, 'nothing recorded');
  assert.equal(insightsPace(costReply([4]), 'cost'), null, 'no full day yet');
  assert.equal(insightsPace(data, 'cost'), null, 'no estimate to project');
});

test('months: each calendar month in the range, the first counted from where it starts, the last with its projection', () => {
  const reply = costReply([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 4]);
  const months = monthTotals(reply, 'cost');
  assert.deepEqual(months.map(m => [m.key, m.total, m.days, m.from, m.current, m.projected]), [
    ['2026-10', 40, 4, '2026-10-28', false, null],
    ['2026-11', 94, 10, null, true, 294],
  ]);
  assert.equal(months[1].long, new Date(2026, 10, 1).toLocaleDateString([], { month: 'long', year: 'numeric' }));
  // Days before recording began are not a quiet start to the month.
  const late = monthTotals(costReply([0, 0, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 4], { sinceDay: '2026-10-30' }), 'cost');
  assert.deepEqual(late.map(m => [m.key, m.total, m.from]), [['2026-10', 20, '2026-10-30'], ['2026-11', 94, null]]);
  assert.deepEqual(monthTotals({ ...reply, unit: 'hour' }, 'cost'), [], 'hours have no months');
  assert.deepEqual(monthTotals(data, 'cost'), [], 'no estimate');
});

test('the calendar: weeks from Monday, shaded by quarter of active days, with each weekday\'s average full day', () => {
  // Nov 2, 2026 is a Monday; two whole weeks, the last day (a Sunday) still filling.
  const values = [1, 2, 3, 4, 0, 0, 0, 5, 6, 7, 8, 0, 0, 9];
  const reply = { unit: 'day', buckets: dayRun('2026-11-02', 14), since: 1, sinceDay: '2026-01-01' };
  const cal = calendarGrid(reply, values);
  assert.equal(cal.weeks.length, 2);
  assert.deepEqual(cal.cuts, [3, 5, 7]);
  assert.deepEqual(cal.weeks[0].map(c => c && c.level), [1, 1, 1, 2, 0, 0, 0]);
  assert.deepEqual(cal.weeks[1].map(c => c && c.level), [2, 3, 3, 4, 0, 0, 4]);
  assert.equal(cal.weeks[1][6]?.today, true);
  // Mondays: 1 and 5. Sunday's only full day was idle; today is not one.
  assert.equal(cal.weekdays[0].avg, 3);
  assert.equal(cal.weekdays[6].avg, 0);
  assert.equal(cal.weekdays[6].days, 1);
  assert.equal(cal.weekdays[0].label, new Date(2024, 0, 1).toLocaleDateString([], { weekday: 'short' }));
  // Days before recording began are not recorded rather than idle.
  const late = calendarGrid({ ...reply, sinceDay: '2026-11-04' }, values);
  assert.deepEqual(late.weeks[0].slice(0, 3).map(c => c && c.level), [-1, -1, 1]);
  assert.equal(late.weekdays[0].avg, 5, 'only the Monday on record');
  // A range that starts mid-week leaves the days before it empty.
  const mid = calendarGrid({ ...reply, buckets: dayRun('2026-11-04', 3) }, [1, 1, 1]);
  assert.deepEqual(mid.weeks[0].map(c => (c ? c.key : null)), [null, null, '2026-11-04', '2026-11-05', '2026-11-06', null, null]);
  assert.deepEqual(calendarGrid({ ...reply, unit: 'hour' }, values).weeks, [], 'hours have no calendar');
});

test('where it went: ranked by the metric, unpriced rows after the priced ones, with the cost of a million tokens', () => {
  const reply = {
    ...detailed,
    models: [...detailed.models, { provider: 'backend:api.deepseek.com', model: 'deepseek-chat', tokens: 5000, requests: 1, cost: null }],
    accounts: [...detailed.accounts, { provider: 'backend:api.deepseek.com', account: 'ds', tokens: 5000, requests: 1, cost: 0, values: [0, 5000] }],
  };
  const byCost = breakdownRows(reply, 'model', 'cost');
  assert.deepEqual(byCost.map(r => [r.label, r.group, r.cost]), [['Opus 5.5', 'Claude', 3], ['Grok 4.7', 'Grok', 0.4], ['deepseek-chat', 'DeepSeek', null]]);
  assert.equal(byCost[0].perMillion, 3 / 700 * 1e6);
  assert.equal(byCost[0].share, 3 / 3.4);
  assert.equal(byCost[2].share, null, 'no share of a cost it has none of');
  assert.equal(byCost[2].perMillion, null);
  assert.equal(byCost[1].hit, 200 / 245);
  assert.deepEqual(breakdownRows(reply, 'model', 'tokens').map(r => [r.label, r.share]), [['deepseek-chat', 5000 / 5950], ['Opus 5.5', 700 / 5950], ['Grok 4.7', 250 / 5950]]);
  // A backend account's $0 is no price, not a free account.
  assert.deepEqual(breakdownRows(reply, 'account', 'cost').map(r => [r.label, r.cost, r.color]), [['a', 3, 'var(--ip-claude)'], ['g', 0.5, 'var(--ip-grok)'], ['ds', null, 'var(--ip-backend)']]);
  assert.deepEqual(breakdownRows(detailed, 'provider', 'cost').map(r => [r.label, r.group, r.cost]), [['Claude', '1 account', 3], ['Grok', '1 account', 0.5]]);
  assert.deepEqual(breakdownRows(fleet, 'machine', 'cost').map(r => [r.label, r.cost, r.color]), [['desk (this one)', 5, 'var(--is1)'], ['server', 2, 'var(--is3)']]);
  assert.deepEqual(breakdownRows(null, 'model', 'cost'), []);
});

test('where it went: a Grok account or provider whose every model is unpriced is not priced, not $0', () => {
  // The server sums an account's cost from its rows, so an account with only
  // unpriced models arrives as 0, like Grok on a model xAI no longer lists.
  const reply = {
    ...detailed,
    providers: [detailed.providers[0], { ...detailed.providers[1], cost: 0, costValues: [0, 0] }],
    accounts: [detailed.accounts[0], { ...detailed.accounts[1], cost: 0, costValues: [0, 0] }],
    models: [{ provider: 'grok', model: 'grok-4', tokens: 300, requests: 1, cost: null }, detailed.models[1]],
  };
  const accounts = breakdownRows(reply, 'account', 'cost');
  assert.deepEqual(accounts.map(r => [r.label, r.cost, r.perMillion, r.share]), [['a', 3, 3 / 700 * 1e6, 1], ['g', null, null, null]]);
  const providers = breakdownRows(reply, 'provider', 'cost');
  assert.deepEqual(providers.map(r => [r.label, r.cost, r.share]), [['Claude', 3, 1], ['Grok', null, null]]);
  // An account with no tokens is not "unpriced": it spent nothing.
  const idle = breakdownRows({ ...reply, accounts: [{ provider: 'anthropic', account: 'z', tokens: 0, requests: 0, cost: 0, values: [0, 0], costValues: [0, 0] }] }, 'account', 'cost');
  assert.equal(idle[0].cost, 0);
  // Even when its total came to a number, no priced model on its provider means no price.
  const summed = breakdownRows({ ...reply, accounts: [{ ...detailed.accounts[1], cost: 0.01 }] }, 'account', 'cost');
  assert.equal(summed[0].cost, null);
});

test('where it went: an account row carries its own values per bucket, in the metric drawn', () => {
  assert.deepEqual(breakdownRows(detailed, 'account', 'tokens').map(r => [r.label, r.values]), [['a', [300, 400]], ['g', [100, 200]]]);
  assert.deepEqual(breakdownRows(detailed, 'account', 'cost').map(r => [r.label, r.values]), [['a', [1, 2]], ['g', [0, 0.5]]]);
  assert.deepEqual(breakdownRows({ ...detailed, splitDetail: false }, 'account', 'cost').map(r => r.values), [null, null], 'a fleet sum missing a machine\'s per-bucket cost');
  assert.equal(breakdownRows(detailed, 'model', 'cost')[0].values, null, 'only accounts have them');
});

test('a rolling average over full, recorded buckets only', () => {
  assert.deepEqual(rollingAverage([2, 4, 6, 8], 2), [2, 3, 5, 7]);
  // Before recording began and the bucket still filling are left out, and the
  // window starts no earlier than the history does.
  assert.deepEqual(rollingAverage([9, 9, 2, 4, 6, 1], 3, 2, 5), [null, null, 2, 3, 4, null]);
  assert.deepEqual(rollingAverage(null, 7), []);
});

test('the trend: a 7-day rolling average on days, one flat average of full hours on hours', () => {
  const days = insightsTrend([7, 7, 7, 7, 7, 7, 14, 14, 1], 'day', 0);
  assert.deepEqual(days?.values, [7, 7, 7, 7, 7, 7, 8, 9, null]);
  assert.equal(days?.label, '7-day average');
  assert.equal(days?.last, 9);
  const hours = insightsTrend([0, 0, 4, 8, 3], 'hour', 2);
  assert.deepEqual(hours?.values, [null, null, 6, 6, null], 'the hour still filling is not one of them');
  assert.equal(hours?.label, 'average full hour');
  assert.equal(insightsTrend([5], 'day', 0), null, 'no full day yet');
  assert.equal(insightsTrend([0, 0, 5], 'day', 2), null, 'nothing recorded but today');
});

test('the pace: against last month by the same day, only when all of last month is on record', () => {
  // Oct 1 to Nov 10: $5 every October day, $10 every full November day, $4 so far today.
  const values = [...Array(31).fill(5), ...Array(9).fill(10), 4];
  const reply = costReply(values);
  reply.buckets = dayRun('2026-10-01', values.length);
  const pace = /** @type {any} */ (insightsPace(reply, 'cost'));
  // November so far is $94; October by its day 10 was $50.
  assert.equal(pace.against, '▲ 88% against ' + monthName(9) + ' by its day 10 ($50.00)');
  // A range that starts on Oct 2 does not have all of October.
  const cut = (/** @type {number[]} */ a) => a.slice(1);
  const short = { ...reply, buckets: dayRun('2026-10-02', values.length - 1), cost: { ...reply.cost, values: cut(values) },
    kinds: { input: cut(reply.kinds.input), output: cut(reply.kinds.output), cacheRead: cut(reply.kinds.cacheRead), cacheWrite: cut(reply.kinds.cacheWrite) } };
  assert.equal(/** @type {any} */ (insightsPace(short, 'cost')).against, null);
  // Nor does a history that began part-way through it.
  const late = costReply([...Array(4).fill(0), ...values.slice(4)], { sinceDay: '2026-10-05' });
  late.buckets = reply.buckets;
  assert.equal(/** @type {any} */ (insightsPace(late, 'cost')).against, null);
});
