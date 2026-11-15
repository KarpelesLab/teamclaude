import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOrgSpend, ADMIN_API_VERSION } from '../src/anthropic-cost-report.js';
import { CreditMonitor, cycleBounds, MAX_CREDIT_BACKOFF_MS } from '../src/api-credit.js';
import { AccountManager } from '../src/account-manager.js';

// The admin source of accounts[].credit reads the organization's cost report.
// No live admin key exists for the suite, so the upstream is a stub serving the
// shapes the documentation gives: buckets oldest first, `results` rows with a
// decimal-string `amount` in cents, and `has_more` / `next_page` paging.

const KEY = 'sk-ant-admin01-report-test-secret-0123456789abcdef';
const START = Date.parse('2026-11-02T00:00:00Z');
const DAY = 86_400_000;

/** A fetch double: answers from `pages` in order and records each call. */
function stubFetch(/** @type {Array<{ status?: number, body: any }>} */ pages) {
  /** @type {{ url: URL, headers: Record<string, string> }[]} */
  const calls = [];
  const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ opts) => {
    calls.push({ url: new URL(url), headers: opts.headers });
    const page = pages[Math.min(calls.length - 1, pages.length - 1)];
    const status = page.status ?? 200;
    // A response double without a body stream: the bounded reader falls back
    // to json(), as it does for the backend-quota tests' doubles.
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(page.body)) };
  };
  return { fetchImpl, calls };
}

const bucket = (/** @type {number} */ i, /** @type {string[]} */ amounts) => ({
  starting_at: new Date(START + i * DAY).toISOString(),
  ending_at: new Date(START + (i + 1) * DAY).toISOString(),
  results: amounts.map(amount => ({ amount, currency: 'USD', cost_type: 'tokens' })),
});

test('one page: every bucket\'s rows are summed in cents, with the documented query and headers', async () => {
  const { fetchImpl, calls } = stubFetch([{ body: { data: [bucket(0, ['123.45', '0.55']), bucket(1, []), bucket(2, ['1000'])], has_more: false, next_page: null } }]);
  const got = await fetchOrgSpend({ adminKey: KEY, startMs: START, fetchImpl });
  assert.deepEqual(got, { ok: true, spentMinor: 1124, currency: 'USD', buckets: 3, pages: 1 });
  assert.equal(calls.length, 1);
  const { url, headers } = calls[0];
  assert.equal(url.origin + url.pathname, 'https://api.anthropic.com/v1/organizations/cost_report');
  assert.equal(url.searchParams.get('starting_at'), '2026-11-02T00:00:00.000Z');
  assert.equal(url.searchParams.get('bucket_width'), '1d');
  assert.equal(url.searchParams.get('limit'), '31');
  assert.equal(url.searchParams.get('page'), null);
  assert.equal(headers['x-api-key'], KEY);
  assert.equal(headers['anthropic-version'], ADMIN_API_VERSION);
});

test('pagination: next_page is sent back as `page` until has_more is false', async () => {
  const { fetchImpl, calls } = stubFetch([
    { body: { data: [bucket(0, ['100.25'])], has_more: true, next_page: 'page_two' } },
    { body: { data: [bucket(1, ['50.5'])], has_more: true, next_page: 'page_three' } },
    { body: { data: [bucket(2, ['0.25'])], has_more: false, next_page: null } },
  ]);
  const got = await fetchOrgSpend({ adminKey: KEY, startMs: START, fetchImpl });
  assert.equal(got.ok, true);
  assert.equal(got.spentMinor, 151);
  assert.equal(got.pages, 3);
  assert.deepEqual(calls.map(c => c.url.searchParams.get('page')), [null, 'page_two', 'page_three']);
  // Every page asks for the same range.
  assert.ok(calls.every(c => c.url.searchParams.get('starting_at') === '2026-11-02T00:00:00.000Z'));
});

test('a has_more that never advances is an error, not a loop or a partial sum', async () => {
  const { fetchImpl, calls } = stubFetch([
    { body: { data: [bucket(0, ['10'])], has_more: true, next_page: 'same' } },
    { body: { data: [bucket(1, ['10'])], has_more: true, next_page: 'same' } },
  ]);
  const got = await fetchOrgSpend({ adminKey: KEY, startMs: START, fetchImpl });
  assert.equal(got.ok, false);
  assert.equal(got.kind, 'parse');
  assert.equal(calls.length, 2);
});

test('a bucket outside the cycle is left out of the sum', async () => {
  const before = { ...bucket(-1, ['9999']) };
  const after = bucket(31, ['8888']);
  const { fetchImpl } = stubFetch([{ body: { data: [before, bucket(0, ['5']), after], has_more: false } }]);
  const got = await fetchOrgSpend({ adminKey: KEY, startMs: START, endMs: START + 31 * DAY, fetchImpl });
  assert.equal(got.ok && got.spentMinor, 5);
});

for (const status of [401, 403]) {
  test(`HTTP ${status} is a credential failure, never zero spend, and does not repeat the key`, async () => {
    const { fetchImpl } = stubFetch([{ status, body: { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } } }]);
    const got = await fetchOrgSpend({ adminKey: KEY, startMs: START, fetchImpl });
    assert.equal(got.ok, false);
    assert.equal(got.kind, 'credential');
    assert.equal(got.status, status);
    assert.ok(!('spentMinor' in got));
    assert.ok(!got.message.includes(KEY), got.message);
    assert.match(got.message, /\[admin key\]/);
  });
}

test('other failures say what failed and carry no sum', async () => {
  const row = (/** @type {any} */ r) => ({ body: { data: [{ starting_at: new Date(START).toISOString(), results: [r] }], has_more: false } });
  const cases = [
    [{ status: 500, body: { error: { message: 'overloaded' } } }, 'http', /HTTP 500: overloaded/],
    [row({ amount: 'n/a', currency: 'USD' }), 'parse', /unreadable amount/],
    [row({ amount: null, currency: 'USD' }), 'parse', /unreadable amount/],
    [row({ amount: '10', currency: 'EUR' }), 'parse', /EUR, not USD/],
    [{ body: { nothing: true } }, 'parse', /no data list/],
    // A bucket whose results are missing or not a list is no reading - never an empty day
    [{ body: { data: [{ starting_at: new Date(START).toISOString() }], has_more: false } }, 'parse', /without a results list/],
    [{ body: { data: [{ starting_at: new Date(START).toISOString(), results: { amount: '10' } }], has_more: false } }, 'parse', /without a results list/],
  ];
  for (const [page, kind, message] of cases) {
    const { fetchImpl } = stubFetch([page]);
    const got = await fetchOrgSpend({ adminKey: KEY, startMs: START, fetchImpl });
    assert.equal(got.ok, false, JSON.stringify(page));
    assert.equal(got.kind, kind);
    assert.match(got.message, message);
  }
  const thrown = await fetchOrgSpend({ adminKey: KEY, startMs: START, fetchImpl: async () => { throw new Error(`connect ECONNREFUSED (${KEY})`); } });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.kind, 'network');
  assert.ok(!thrown.message.includes(KEY));
});

// ----- the monitor that schedules the read -----

const anchorDate = () => new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10);
function manager(/** @type {Record<string, any>} */ extra = {}, credit = {}) {
  const log = console.log;
  console.log = () => {};
  try {
    return new AccountManager([{
      name: 'credit-key', type: 'apikey', apiKey: 'sk-ant-api03-k', ...extra,
      credit: { amount: 200, cycleStart: anchorDate(), adminKey: KEY, ...credit },
    }], 0.98);
  } finally { console.log = log; }
}

test('a DISABLED account still gets its admin read: it spends nothing', async () => {
  const am = manager({ disabled: true });
  assert.equal(am.accounts[0].disabled, true);
  const calls = [];
  const monitor = new CreditMonitor(am, {
    log: () => {},
    fetchSpend: async (opts) => { calls.push(opts); return { ok: true, spentMinor: 4321.6, currency: 'USD', buckets: 5, pages: 1 }; },
  });
  await monitor.tick();
  assert.equal(calls.length, 1, 'the disabled account was not read');
  assert.equal(calls[0].adminKey, KEY);
  const { start, end } = cycleBounds(am.accounts[0].creditConfig.anchorDay, Date.now());
  assert.equal(calls[0].startMs, start);
  assert.equal(calls[0].endMs, end);
  const credit = am.creditStatus(am.accounts[0]);
  assert.equal(credit.source, 'admin');
  assert.equal(credit.spentMinor, 4322);
  assert.equal(credit.remainingMinor, 20000 - 4322);
  assert.ok(credit.asOf);
  // Read once per interval, not once per tick.
  await monitor.tick();
  assert.equal(calls.length, 1);
});

test('an account without an admin key is never read by the monitor', async () => {
  const log = console.log;
  console.log = () => {};
  const am = new AccountManager([{ name: 'local', type: 'apikey', apiKey: 'k', credit: { amount: 100, cycleStart: anchorDate() } }], 0.98);
  console.log = log;
  let calls = 0;
  const monitor = new CreditMonitor(am, { log: () => {}, fetchSpend: async () => { calls++; return { ok: true, spentMinor: 0, currency: 'USD', buckets: 0, pages: 1 }; } });
  await monitor.tick();
  assert.equal(calls, 0);
  assert.equal(am.creditStatus(am.accounts[0]).source, 'local');
});

test('a rejected admin key shows as a credential error with no spend, and backs off doubling', async () => {
  const am = manager({}, { refreshMinutes: 10 });
  const lines = [];
  let calls = 0;
  const monitor = new CreditMonitor(am, {
    log: (l) => lines.push(l),
    fetchSpend: async () => { calls++; return { ok: false, kind: 'credential', status: 401, message: `Admin API key rejected (HTTP 401): ${KEY}` }; },
  });
  const a = am.accounts[0];
  const waits = [];
  for (let i = 0; i < 7; i++) {
    a.creditState.admin && (a.creditState.admin.nextAt = 0); // due now, whatever the backoff said
    const before = Date.now();
    await monitor.poll(a);
    waits.push(Math.round((a.creditState.admin.nextAt - before) / 60_000));
  }
  assert.equal(calls, 7);
  assert.deepEqual(waits, [10, 20, 40, 80, 160, 320, MAX_CREDIT_BACKOFF_MS / 60_000]);
  const credit = am.creditStatus(a);
  assert.equal(credit.spentMinor, null, 'a rejected key read as a spend');
  assert.equal(credit.remainingMinor, null);
  assert.equal(credit.error.kind, 'credential');
  assert.equal(credit.error.status, 401);
  assert.ok(!credit.error.message.includes(KEY));
  // One line for the streak, not one per failure, and never the key.
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(KEY));
});

test('a failure after a good read keeps the reading and adds the error; recovery clears it', async () => {
  const am = manager();
  const a = am.accounts[0];
  const answers = [
    { ok: true, spentMinor: 1000, currency: 'USD', buckets: 1, pages: 1 },
    { ok: false, kind: 'http', status: 503, message: 'cost report answered HTTP 503' },
    { ok: true, spentMinor: 1500, currency: 'USD', buckets: 1, pages: 1 },
  ];
  const monitor = new CreditMonitor(am, { log: () => {}, fetchSpend: async () => /** @type {any} */ (answers.shift()) });
  await monitor.poll(a);
  await monitor.poll(a);
  let credit = am.creditStatus(a);
  assert.equal(credit.spentMinor, 1000);
  assert.equal(credit.error.kind, 'http');
  await monitor.poll(a);
  credit = am.creditStatus(a);
  assert.equal(credit.spentMinor, 1500);
  assert.equal(credit.error, null);
});

test('spend past the amount shows nothing left and by how much it was exceeded', async () => {
  const am = manager();
  const monitor = new CreditMonitor(am, { log: () => {}, fetchSpend: async () => ({ ok: true, spentMinor: 21230, currency: 'USD', buckets: 3, pages: 1 }) });
  await monitor.tick();
  const credit = am.creditStatus(am.accounts[0]);
  assert.equal(credit.remainingMinor, 0);
  assert.equal(credit.exceededMinor, 1230);
  assert.ok(credit.usedFraction > 1);
});

test('a replaced admin key on reload drops the old reading and is read at once', async () => {
  const am = manager();
  const a = am.accounts[0];
  const monitor = new CreditMonitor(am, { log: () => {}, fetchSpend: async (o) => ({ ok: true, spentMinor: o.adminKey === KEY ? 100 : 700, currency: 'USD', buckets: 1, pages: 1 }) });
  await monitor.tick();
  assert.equal(am.creditStatus(a).spentMinor, 100);
  am.setCreditConfig(a.index, { ...a.creditConfig, adminKey: `${KEY}-other` });
  assert.equal(am.creditStatus(a).spentMinor, null, 'the old organization\'s reading stayed under the new key');
  assert.equal(monitor.due(a, Date.now()), true);
  await monitor.tick();
  assert.equal(am.creditStatus(a).spentMinor, 700);
});

// ----- a config reload -----

test('a reload applies an added, changed or removed credit setting to the running account', async () => {
  const { syncAccountsFromDisk } = await import('../src/sync-accounts.js');
  const { ensureAccountIds } = await import('../src/account-id.js');
  const entry = { name: 'credit-key', type: 'apikey', apiKey: 'sk-ant-api03-k' };
  const disk = { accounts: [{ ...entry }] };
  ensureAccountIds(disk.accounts);
  const mem = { accounts: disk.accounts.map(a => ({ ...a })) };
  const am = new AccountManager([{ ...entry, id: disk.accounts[0].id }], 0.98);
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(am.creditStatus(am.accounts[0]), null);
    disk.accounts[0].credit = { amount: 100, cycleStart: anchorDate(), adminKey: KEY };
    await syncAccountsFromDisk(disk, mem, am);
    const a = am.accounts[0];
    assert.equal(a.creditConfig.amountMinor, 10000);
    assert.equal(a.creditConfig.adminKey, KEY);
    assert.deepEqual(mem.accounts[0].credit, disk.accounts[0].credit, 'the in-memory entry the next save is built from lost the setting');
    // A reading under the first key, then the key is replaced on disk.
    const monitor = new CreditMonitor(am, { log: () => {}, fetchSpend: async () => ({ ok: true, spentMinor: 500, currency: 'USD', buckets: 1, pages: 1 }) });
    await monitor.tick();
    assert.equal(am.creditStatus(a).spentMinor, 500);
    disk.accounts[0].credit = { ...disk.accounts[0].credit, amount: 200, adminKey: `${KEY}-rotated` };
    await syncAccountsFromDisk(disk, mem, am);
    assert.equal(am.creditStatus(a).amountMinor, 20000);
    assert.equal(am.creditStatus(a).spentMinor, null, 'a reading taken with the old key stayed under the new one');
    delete disk.accounts[0].credit;
    await syncAccountsFromDisk(disk, mem, am);
    assert.equal(am.creditStatus(a), null);
    assert.ok(!('credit' in mem.accounts[0]));
    assert.ok(!('credit' in am.getStatus().accounts[0]));
  } finally { console.log = log; }
});
