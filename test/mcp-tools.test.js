import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountManager } from '../src/account-manager.js';
import { createToolSet } from '../src/mcp-tools.js';

// The write tools drive a real AccountManager against a throwaway config file,
// with the hooks a server would wire in replaced by spies. Whether reloading
// applies a written setting live is index.js's job and is covered end to end;
// here the questions are what each tool writes, what it refuses, and that a
// refusal leaves both the file and the fleet untouched.

const accounts = () => [
  { id: 'id-alice', name: 'alice@example.com', type: 'apikey', apiKey: 'k1', priority: 0 },
  { id: 'id-bob', name: 'bob@example.com (Acme)', type: 'apikey', apiKey: 'k2', orgName: 'Acme', priority: 1 },
  { id: 'id-bob2', name: 'bob@example.com (Globex)', type: 'apikey', apiKey: 'k3', orgName: 'Globex', priority: 1 },
];

async function fixture({ mode = 'full', hooks = {}, fleet = accounts, options = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-mcp-tools-'));
  const configPath = join(dir, 'config.json');
  process.env.TEAMCLAUDE_CONFIG = configPath;
  const config = {
    proxy: { apiKey: 'tc-test', mcp: mode },
    switchThreshold: 0.98,
    routes: [],
    accounts: fleet(),
  };
  await writeFile(configPath, JSON.stringify(config));
  const am = new AccountManager(fleet(), 0.98);
  const calls = [];
  const spies = {
    reload: async () => { calls.push('reload'); },
    persistAccounts: async () => { calls.push('persist'); },
    probeQuota: async () => { calls.push('probe'); },
    ...hooks,
  };
  const tools = createToolSet(mode, { accountManager: am, config, hooks: spies, client: 'ci' }, options);
  const disk = async () => JSON.parse(await readFile(configPath, 'utf8'));
  return { tools, am, config, calls, disk };
}

/** Call a tool and hand back its structured result, failing on isError. */
async function ok(tools, name, args = {}) {
  const result = await tools.call(name, args);
  assert.notEqual(result.isError, true, `${name}: ${result.content?.[0]?.text}`);
  return result.structuredContent;
}

/** Call a tool expecting it to run and refuse; hand back the refusal text. */
async function refused(tools, name, args = {}) {
  const result = await tools.call(name, args);
  assert.equal(result.isError, true, `${name} should have refused`);
  return result.content[0].text;
}

test('read mode lists only the read tools and does not run the others', async () => {
  const { tools, am } = await fixture({ mode: 'read' });
  assert.deepEqual(tools.list().map(t => t.name), ['get_status', 'get_quota', 'get_settings']);
  await assert.rejects(tools.call('switch_account', { account: 'alice@example.com' }), /Unknown tool/);
  assert.equal(am.currentIndex, 0);
});

test('full mode lists every tool in a fixed order, annotated', async () => {
  const { tools } = await fixture();
  const listed = tools.list();
  assert.deepEqual(listed.map(t => t.name), [
    'get_status', 'get_quota', 'get_settings',
    'switch_account', 'reload_config', 'probe_quota',
    'set_account_enabled', 'set_account_priority', 'set_account_routing', 'remove_account',
    'set_threshold', 'set_distribution', 'set_probe_interval', 'set_warmup',
    'set_route', 'remove_route', 'set_blocked_models', 'set_client_mode',
  ]);
  const byName = Object.fromEntries(listed.map(t => [t.name, t]));
  assert.equal(byName.get_status.annotations.readOnlyHint, true);
  assert.equal(byName.set_threshold.annotations.readOnlyHint, false);
  // No destructiveHint on a write tool: the protocol's default is true, and a
  // false would promise additive-only updates, which a setter that replaces a
  // value does not keep.
  for (const tool of listed) {
    assert.equal('destructiveHint' in tool.annotations, false, tool.name);
  }
  for (const tool of listed) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.ok(tool.description.length > 20, tool.name);
  }
  assert.deepEqual(byName.set_account_enabled.inputSchema.required, ['account', 'enabled']);
});

test('switch_account moves the preference and says whether rotation will follow', async () => {
  const { tools, am } = await fixture();
  const result = await ok(tools, 'switch_account', { account: 'bob@example.com', org: 'Globex' });
  assert.equal(result.account, 'bob@example.com (Globex)');
  assert.equal(result.eligible, false);
  assert.match(result.reason, /outranked by higher-priority account "alice@example.com"/);
  assert.equal(am.currentIndex, 2);
});

test('an account token that fits several accounts is refused with the candidates', async () => {
  const { tools, am } = await fixture();
  const text = await refused(tools, 'switch_account', { account: 'bob@example.com' });
  assert.match(text, /matches 2 accounts/);
  assert.match(text, /bob@example.com \(Acme\)/);
  assert.match(text, /bob@example.com \(Globex\)/);
  assert.equal(am.currentIndex, 0);

  assert.match(await refused(tools, 'switch_account', { account: 'nobody@example.com' }), /no account "nobody@example.com"/);
});

test('a name read from get_status is a name the write tools accept', async () => {
  // Org names come from the upstream profile, not from the operator, and a
  // non-breaking or doubled space in one is enough to break a tidied-up copy.
  const fleet = () => [
    { id: 'a', name: 'ops@example.com (Acme\u00a0Labs)', type: 'apikey', apiKey: 'k1', orgName: 'Acme\u00a0Labs' },
    { id: 'b', name: 'ops@example.com (Globex  Inc)', type: 'apikey', apiKey: 'k2', orgName: 'Globex  Inc' },
  ];
  const { tools, am } = await fixture({ fleet });
  const status = await ok(tools, 'get_status');
  assert.equal(status.currentAccount, status.accounts[0].name, 'one account, one spelling');

  for (const [index, listed] of status.accounts.entries()) {
    const byName = await ok(tools, 'switch_account', { account: listed.name });
    assert.equal(byName.account, listed.name);
    assert.equal(am.currentIndex, index);
    const byOrg = await ok(tools, 'switch_account', { account: 'ops@example.com', org: listed.orgName });
    assert.equal(byOrg.account, listed.name);
  }
});

test('arguments that do not fit a tool are a tool error the model can read, and nothing runs', async () => {
  // The protocol keeps its own error for a malformed call; a value the tool's
  // schema refuses is input validation, which a client passes on to the model.
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    const { tools, am, calls } = await fixture();
    assert.match(await refused(tools, 'switch_account', { account: 'bob@example.com (Acme)', force: true }), /takes no argument "force"/);
    assert.match(await refused(tools, 'switch_account', {}), /needs "account"/);
    assert.match(await refused(tools, 'set_account_enabled', { account: 'alice@example.com', enabled: 'no' }), /"enabled" must be of type boolean/);
    assert.equal(am.currentIndex, 0);
    assert.deepEqual(calls, []);
  } finally {
    console.log = original;
  }
  assert.deepEqual(lines.filter(l => l.includes('MCP')), [], 'a refused call is not logged as a write');
  const { tools } = await fixture();
  await assert.rejects(tools.call('no_such_tool', {}), /Unknown tool/);
});

test('reload_config and probe_quota call through to the server hooks', async () => {
  const { tools, calls } = await fixture({ hooks: { reload: async () => { calls.push('reload'); return 2; } } });
  assert.deepEqual(await ok(tools, 'reload_config'), { added: 2 });
  assert.deepEqual(await ok(tools, 'probe_quota'), { ok: true });
  assert.deepEqual(calls, ['reload', 'probe']);
});

test('a server without a prober says so instead of pretending', async () => {
  const { tools } = await fixture({ hooks: { probeQuota: undefined } });
  assert.match(await refused(tools, 'probe_quota'), /not available/);
});

test('set_account_enabled changes the running account and its config entry, then saves', async () => {
  const { tools, am, config, calls } = await fixture();
  assert.deepEqual(await ok(tools, 'set_account_enabled', { account: 'alice@example.com', enabled: false }), { account: 'alice@example.com', enabled: false, persisted: true });
  assert.equal(am.accounts[0].disabled, true);
  assert.equal(config.accounts[0].disabled, true);
  assert.deepEqual(calls, ['persist']);

  await ok(tools, 'set_account_enabled', { account: 'alice@example.com', enabled: true });
  assert.equal(am.accounts[0].disabled, false);
  // An explicit false, not a missing key: the save merges over the on-disk
  // entry, and a missing key would leave a stale `disabled: true` standing.
  assert.equal(config.accounts[0].disabled, false);
});

test('set_account_priority writes the number to both the account and its entry', async () => {
  const { tools, am, config } = await fixture();
  assert.deepEqual(await ok(tools, 'set_account_priority', { account: 'bob@example.com', org: 'Acme', priority: -3 }), { account: 'bob@example.com (Acme)', priority: -3, persisted: true });
  assert.equal(am.accounts[1].priority, -3);
  assert.equal(config.accounts[1].priority, -3);
  assert.match(await refused(tools, 'set_account_priority', { account: 'alice@example.com', priority: 1.5 }), /integer/);
});

test('set_account_routing sets, masks, and clears the account proxy', async () => {
  const { tools, am, config } = await fixture();
  assert.deepEqual(
    await ok(tools, 'set_account_routing', { account: 'bob@example.com', org: 'Acme', routing: 'socks5h://alice:s3cret@proxy.example.com:1080' }),
    { account: 'bob@example.com (Acme)', routing: 'socks5h://alice:***@proxy.example.com:1080', persisted: true },
  );
  assert.equal(am.accounts[1].routing.protocol, 'socks5h');
  assert.equal(am.accounts[1].routing.password, 's3cret', 'the live account keeps the credential');
  assert.equal(config.accounts[1].routing, 'socks5h://alice:s3cret@proxy.example.com:1080', 'the entry stores it canonical');

  // Clearing writes an explicit null, not a deleted key (the save merges over disk).
  await ok(tools, 'set_account_routing', { account: 'bob@example.com', org: 'Acme', routing: 'none' });
  assert.equal(am.accounts[1].routing, null);
  assert.equal(config.accounts[1].routing, null);

  assert.match(await refused(tools, 'set_account_routing', { account: 'bob@example.com', org: 'Acme', routing: 'https://proxy.example.com' }), /unsupported routing protocol/);
});

test('remove_account takes the account out of rotation and marks its entry removed before saving', async () => {
  const { tools, am, config, calls } = await fixture();
  assert.deepEqual(await ok(tools, 'remove_account', { account: 'bob@example.com', org: 'Acme' }), { account: 'bob@example.com (Acme)', removed: true, persisted: true });
  assert.deepEqual(am.accounts.map(a => a.name), ['alice@example.com', 'bob@example.com (Globex)']);
  assert.deepEqual(config.accounts.map(a => a.name), ['alice@example.com', 'bob@example.com (Globex)']);
  assert.deepEqual(calls, ['persist']);
  assert.match(await refused(tools, 'remove_account', { account: 'bob@example.com', org: 'Acme' }), /no account/);
});

test('account changes are refused outright on a server that cannot save them', async () => {
  const { tools, am } = await fixture({ hooks: { persistAccounts: undefined } });
  assert.match(await refused(tools, 'remove_account', { account: 'alice@example.com' }), /cannot save/);
  assert.equal(am.accounts.length, 3);
});

test('an account change that could not be saved says so, and says the fleet already changed', async () => {
  // The running fleet is changed first and the file second; when the second
  // half fails the caller must hear both halves, or a restart will surprise them.
  const { tools, am } = await fixture({ hooks: { persistAccounts: async () => { throw new Error('config lock busy at /home/op/.config'); } } });
  const text = await refused(tools, 'remove_account', { account: 'bob@example.com', org: 'Acme' });
  assert.match(text, /changed in the running server/);
  assert.match(text, /could not be saved/);
  assert.doesNotMatch(text, /home\/op/);
  assert.deepEqual(am.accounts.map(a => a.name), ['alice@example.com', 'bob@example.com (Globex)']);
});

test('set_threshold writes the file and reloads; a bad value writes nothing', async () => {
  const { tools, calls, disk } = await fixture();
  assert.deepEqual(await ok(tools, 'set_threshold', { percent: 85 }), { switchThreshold: 0.85, dropped: [] });
  assert.equal((await disk()).switchThreshold, 0.85);
  assert.deepEqual(calls, ['reload']);

  assert.deepEqual(await ok(tools, 'set_threshold', { buckets: { unified7d: 90 } }), { switchThreshold: { default: 0.85, unified7d: 0.9 } });
  assert.deepEqual((await disk()).switchThreshold, { default: 0.85, unified7d: 0.9 });

  assert.match(await refused(tools, 'set_threshold', { percent: 0 }), /1 to 100/);
  assert.match(await refused(tools, 'set_threshold', { buckets: { weekly: 50 } }), /Unknown quota bucket/);
  // A value that is not a number must not be coerced into one: `true` would
  // become a 1% threshold and take the account out of rotation almost at once.
  assert.match(await refused(tools, 'set_threshold', { buckets: { unified7d: true } }), /1 to 100/);
  assert.match(await refused(tools, 'set_threshold', { buckets: { unified7d: [95] } }), /1 to 100/);
  assert.match(await refused(tools, 'set_threshold', {}), /either percent or buckets/);
  assert.match(await refused(tools, 'set_threshold', { percent: 50, buckets: {} }), /either percent or buckets/);
  // An empty table is not a change; without this it rewrote the stored form and reloaded for nothing.
  assert.match(await refused(tools, 'set_threshold', { buckets: {} }), /at least one bucket/);
  assert.deepEqual((await disk()).switchThreshold, { default: 0.85, unified7d: 0.9 });
  assert.deepEqual(calls, ['reload', 'reload']);
});

test('the remaining settings tools write what the CLI would', async () => {
  const { tools, disk } = await fixture();
  assert.deepEqual(await ok(tools, 'set_distribution', { mode: 'adaptive' }), { distribution: 'adaptive', changed: true });
  assert.equal((await disk()).distributeSessions, 'adaptive');

  assert.deepEqual(await ok(tools, 'set_probe_interval', { seconds: 300 }), { quotaProbeSeconds: 300 });
  assert.equal((await disk()).quotaProbeSeconds, 300);
  assert.match(await refused(tools, 'set_probe_interval', { seconds: 5 }), /Minimum probe interval/);

  assert.deepEqual(await ok(tools, 'set_warmup', { mode: 'reset', time: '15:30', timezone: 'Europe/Moscow' }), { warmupSeconds: 0, warmupSchedule: { resetTime: '15:30', timezone: 'Europe/Moscow' } });
  assert.deepEqual(await ok(tools, 'set_warmup', { seconds: 600 }), { warmupSeconds: 600, warmupSchedule: null });
  assert.equal('warmupSchedule' in (await disk()), false);
  assert.match(await refused(tools, 'set_warmup', {}), /either seconds or a schedule/);
  assert.match(await refused(tools, 'set_warmup', { mode: 'reset' }), /time and timezone/);
  // A schedule field next to an interval is a contradiction, not something to drop quietly.
  assert.match(await refused(tools, 'set_warmup', { seconds: 600, time: '15:30' }), /either seconds or a schedule/);
  assert.match(await refused(tools, 'set_warmup', { seconds: 600, timezone: 'Europe/Moscow' }), /either seconds or a schedule/);

  assert.deepEqual(await ok(tools, 'set_route', { name: ' opus ', match: ['claude-opus-*'], accounts: ['alice@example.com', 'ghost'] }), {
    route: { name: 'opus', match: ['claude-opus-*'], accounts: ['alice@example.com', 'ghost'] }, updated: false, unknownAccounts: ['ghost'],
  });
  assert.deepEqual((await disk()).routes, [{ name: 'opus', match: ['claude-opus-*'], accounts: ['alice@example.com', 'ghost'] }]);
  assert.match(await refused(tools, 'set_route', { name: 'typo', match: ['x'], bucket: 'weekly' }), /"bucket" must be one of: .*unified7d/);
  assert.deepEqual(await ok(tools, 'remove_route', { name: 'opus' }), { removed: 'opus' });
  assert.deepEqual((await disk()).routes, []);
  assert.match(await refused(tools, 'remove_route', { name: 'opus' }), /not found/);

  assert.deepEqual(await ok(tools, 'set_blocked_models', { patterns: ['claude-opus-*'] }), { blockedModels: ['claude-opus-*'] });
  assert.deepEqual((await disk()).blockedModels, ['claude-opus-*']);

  assert.deepEqual(await ok(tools, 'set_client_mode', { mode: 'base-url' }), { defaultClientMode: 'base-url' });
  assert.equal((await disk()).defaultClientMode, 'base-url');
  assert.match(await refused(tools, 'set_client_mode', { mode: 'socks' }), /one of: mitm, base-url/);
});

test('a setting that was written but failed to reload says both', async () => {
  const { tools, disk } = await fixture({ hooks: { reload: async () => { throw new Error('warmer: bad schedule at /etc/private'); } } });
  const text = await refused(tools, 'set_probe_interval', { seconds: 120 });
  assert.match(text, /saved/);
  assert.match(text, /reload failed/);
  assert.doesNotMatch(text, /etc\/private/);
  assert.equal((await disk()).quotaProbeSeconds, 120);
});

test('a tool that blows up reports a generic failure, never the exception', async () => {
  const { tools } = await fixture({ hooks: { reload: async () => { throw new TypeError('x is not a function at /home/op/.config'); } } });
  const text = await refused(tools, 'reload_config');
  assert.match(text, /see the proxy log/);
  assert.doesNotMatch(text, /home\/op/);
});

test('write tools run one at a time, so a removal cannot race a reload', async () => {
  const order = [];
  let releaseReload;
  const reload = () => new Promise(resolve => { order.push('reload:start'); releaseReload = () => { order.push('reload:end'); resolve(0); }; });
  const persistAccounts = async () => { order.push('persist'); };
  const { tools } = await fixture({ hooks: { reload, persistAccounts } });

  const first = tools.call('set_threshold', { percent: 70 });
  const second = tools.call('remove_account', { account: 'alice@example.com' });
  try {
    // Wait for the first call to reach its reload — not for a duration — before
    // judging what the second has done meanwhile.
    const deadline = Date.now() + 5000;
    while (!releaseReload) {
      if (Date.now() > deadline) throw new Error('the first write never reached its reload');
      await new Promise(r => setTimeout(r, 5));
    }
    assert.deepEqual(order, ['reload:start'], 'the removal must wait for the running write to finish');
  } finally {
    // Released whatever the verdict: the queue is shared by every write tool
    // in the process, and a reload left hanging would stall the tests after this one.
    releaseReload?.();
  }
  await Promise.all([first, second]);
  assert.deepEqual(order, ['reload:start', 'reload:end', 'persist']);
});

test('a write that never settles is answered, and the queue moves on without it', async () => {
  // A reload can hang on an upstream that accepts the connection and then says
  // nothing. One caller waiting is that caller's problem; every later write
  // waiting behind it until a restart is not.
  const { tools, am } = await fixture({ hooks: { reload: () => new Promise(() => {}) }, options: { writeTimeoutMs: 50 } });
  const text = await refused(tools, 'set_probe_interval', { seconds: 120 });
  assert.match(text, /did not finish/);
  const next = await ok(tools, 'set_account_priority', { account: 'alice@example.com', priority: 2 });
  assert.equal(next.priority, 2);
  assert.equal(am.accounts[0].priority, 2);
});

test('every write is logged with the tool, the caller and what changed', async () => {
  const lines = [];
  let tools2;
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    const { tools } = await fixture();
    await ok(tools, 'set_threshold', { percent: 75 });
    await ok(tools, 'switch_account', { account: 'alice@example.com' });
    // A client name is operator-written, but a newline in it would still forge a log line.
    tools2 = createToolSet('full', { accountManager: (await fixture()).am, config: {}, hooks: {}, client: 'ci\nforged' });
    await tools2.call('switch_account', { account: 'alice@example.com' });
  } finally {
    console.log = original;
  }
  assert.ok(lines.some(l => /\[TeamClaude\] MCP set_threshold .*ci.*75/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => /\[TeamClaude\] MCP switch_account .*ci.*alice@example\.com/.test(l)), lines.join('\n'));
  assert.equal(lines.some(l => l.startsWith('forged')), false, 'a client name cannot start a line of its own');
  assert.ok(lines.some(l => l.includes('ci forged')), lines.join('\n'));
});
