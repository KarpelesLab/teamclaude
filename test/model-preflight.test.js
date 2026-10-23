import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitRunArgs, scanModelArgs, preflightModel, formatPreflight, lastValueFlag, readFlagSettingsModels,
} from '../src/model-preflight.js';

// Covers src/model-preflight.js: `teamclaude run`'s argument split and the
// fail-loud model check that runs before claude is spawned.
//
// Everything here is pure data in, data out — no config file, no settings file,
// no port, no spawn. That is the point of the module existing separately from
// the command body: the duplicate-flag rule below is exactly the sort of thing
// that goes untested, and therefore wrong, when it lives inside runCommand.
//
// The argv in the "real incident" cases is verbatim from the launch that
// prompted this feature: two --model flags, and the winner an account name.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', priority: 0, ...extra };
}
function apikey(name, extra = {}) {
  return { name, type: 'apikey', apiKey: 'k', priority: 50, ...extra };
}

// Shape of the config that produced the incident: a terminal catch-all listing
// every account EXCEPT the one whose name reads like a model id.
function fixture() {
  return {
    accounts: [
      oauth('primary'),
      apikey('deepseek-v4-pro', {
        priority: 80,
        upstream: 'http://127.0.0.1:8084',
        modelMap: { 'claude-opus-4-8': 'deepseek-v4-pro', 'claude-fable-5': 'deepseek-v4-pro' },
      }),
    ],
    routes: [{ name: 'default', match: ['*'], accounts: ['primary'] }],
  };
}

// ── splitRunArgs ──────────────────────────────────────────────

test('a `--` separator hands everything after it to claude untouched', () => {
  const r = splitRunArgs(['--no-mitm', '--account', 'work', '--', '--model', 'x', '--no-mitm']);
  assert.equal(r.separated, true);
  assert.deepEqual(r.claudeArgs, ['--model', 'x', '--no-mitm'],
    'a flag teamclaude also owns is claude\'s once it is past the separator');
  assert.equal(r.useMitm, false);
  assert.equal(r.account, 'work');
  assert.equal(r.accountRequested, true);
});

test('with no separator teamclaude\'s own flags are filtered out wherever they appear', () => {
  const r = splitRunArgs(['--no-mitm', '-p', 'hello', '--auto-fallback']);
  assert.deepEqual(r.claudeArgs, ['-p', 'hello'], 'pre-existing behaviour is preserved');
  assert.equal(r.useMitm, false);
  assert.equal(r.autoFallback, true);
});

test('--account consumes its value, so the account name never reaches claude', () => {
  const r = splitRunArgs(['--account', 'work (Acme)', '-p', 'hi']);
  assert.deepEqual(r.claudeArgs, ['-p', 'hi']);
  assert.equal(r.account, 'work (Acme)');
});

test('--account with no value is requested-but-unresolved, not silently absent', () => {
  const r = splitRunArgs(['--account', '--no-mitm', '--', '-p', 'hi']);
  assert.equal(r.accountRequested, true, 'the operator asked for a pin');
  assert.equal(r.account, null, 'but gave no name — the caller must error, not launch unpinned');
});

test('--account=<name> is the same flag: the equals spelling can never launch an UNPINNED session in silence', () => {
  // The failure this pins: `--account=fugu` parsed as "no pin requested", so the
  // session launched with normal rotation, exit 0, not one line of output — the
  // operator believes they are on a paid apikey account and quietly spend OAuth
  // quota instead. Exactly the class of silent failure this branch exists for.
  for (const argv of [['--account=work (Acme)', '--', '-p', 'hi'], ['--account', 'work (Acme)', '--', '-p', 'hi']]) {
    const r = splitRunArgs(argv);
    assert.equal(r.accountRequested, true, argv[0]);
    assert.equal(r.account, 'work (Acme)', argv[0]);
    assert.deepEqual(r.claudeArgs, ['-p', 'hi']);
  }
  assert.deepEqual(splitRunArgs(['--account=work', '-p', 'hi']).claudeArgs, ['-p', 'hi'],
    'the unseparated form consumes it too, so the token never reaches claude');
  assert.equal(splitRunArgs(['--account=', '--', '-p', 'hi']).account, null,
    'an empty value is requested-but-unresolved, which the caller must refuse');
  assert.deepEqual(lastValueFlag(['--account', 'a', '--account=b'], '--account'), { present: true, value: 'b' },
    'last wins, across spellings');
});

test('an unrecognized flag before the -- is reported instead of being dropped in silence', () => {
  assert.deepEqual(splitRunArgs(['--acount', 'work', '--', '-p', 'hi']).unknownFlags, ['--acount'],
    'a typo used to vanish, taking the pin with it');
  assert.deepEqual(splitRunArgs(['--no-mitm', '--account', 'x', '--force', '--', '-p']).unknownFlags, []);
  assert.deepEqual(splitRunArgs(['--verbose', '-p', 'hi']).unknownFlags, [],
    'with no separator an unknown flag is claude\'s by construction and must pass through');
});

test('a posture flag after the separator stays claude\'s, and is reported as misplaced', () => {
  // The `--` contract is "everything after is claude's, verbatim". Quietly
  // eating three tokens out of it would make the separator untrustworthy, so the
  // flag is reported rather than consumed — the operator is told where it goes.
  const r = splitRunArgs(['--', '--model', 'x', '--force']);
  assert.equal(r.force, false, 'it is not consumed');
  assert.deepEqual(r.claudeArgs, ['--model', 'x', '--force'], 'the separator contract is intact');
  assert.deepEqual(r.misplacedFlags, ['--force']);
  assert.deepEqual(splitRunArgs(['--force', '--', '--model', 'x']).misplacedFlags, [],
    'in the right position there is nothing to report');
});

test('the posture flags default to safe: preflight on, force off, strict off', () => {
  const r = splitRunArgs(['--', '-p', 'hi']);
  assert.equal(r.preflight, true);
  assert.equal(r.force, false);
  assert.equal(r.strict, false);
  assert.equal(r.accountRequested, false);
  assert.equal(r.account, null);
  assert.deepEqual(splitRunArgs(['--no-preflight', '--force', '--strict']).claudeArgs, []);
});

// ── scanModelArgs: the duplicate-flag rule ────────────────────

test('two --model flags are both reported and the LAST one is the effective model', () => {
  // The real incident argv, verbatim.
  const scan = scanModelArgs(['--model', 'opus', '-n', 'my-session', '--model', 'deepseek-v4-pro']);
  assert.equal(scan.duplicate, true);
  assert.deepEqual(scan.occurrences.map(o => o.value), ['opus', 'deepseek-v4-pro']);
  assert.equal(scan.effective, 'deepseek-v4-pro',
    'last wins — reading the first is the bug this scan exists to prevent');
});

test('--model=<value> is the same flag and counts toward the duplicate', () => {
  const scan = scanModelArgs(['--model=opus', '--model', 'claude-fable-5']);
  assert.equal(scan.duplicate, true);
  assert.deepEqual(scan.occurrences.map(o => o.form), ['equals', 'space']);
  assert.equal(scan.effective, 'claude-fable-5');
});

test('a --model whose value is another flag, or missing entirely, is reported not guessed', () => {
  const trailing = scanModelArgs(['-p', 'hi', '--model']);
  assert.equal(trailing.incomplete, true);
  assert.equal(trailing.effective, null);

  const swallowed = scanModelArgs(['--model', '--verbose', '-p', 'hi']);
  assert.equal(swallowed.incomplete, true);
  assert.equal(swallowed.effective, null, '--verbose is not consumed as a model id');
  assert.deepEqual(scanModelArgs(['--model', '--verbose']).occurrences.length, 1);
});

test('a single well-formed --model is neither duplicate nor incomplete', () => {
  const scan = scanModelArgs(['-p', 'hi', '--model', 'claude-fable-5']);
  assert.equal(scan.duplicate, false);
  assert.equal(scan.incomplete, false);
  assert.equal(scan.effective, 'claude-fable-5');
});

// ── preflightModel: the decision ──────────────────────────────

test('the real incident argv is blocked, and both failures are named', () => {
  const d = preflightModel({
    config: fixture(),
    claudeArgs: ['--model', 'opus', '-n', 'my-session', '--model', 'deepseek-v4-pro'],
    availableModels: ['claude-opus-4-8'],
  });
  assert.equal(d.blocked, true);
  assert.equal(d.exitCode, 1);
  assert.equal(d.requested, 'deepseek-v4-pro');
  const codes = d.findings.map(f => f.code);
  assert.ok(codes.includes('duplicate-model-flag'), 'the two --model flags are reported');
  assert.ok(codes.includes('model-not-routable'), 'the winning value cannot route');
  const routing = d.findings.find(f => f.code === 'model-not-routable');
  assert.ok(routing.remedies.some(r => r.includes('--account deepseek-v4-pro')),
    'the remedy is the pin, because the id is an account name');
  assert.ok(formatPreflight(d).some(l => l.includes('Refusing to launch')));
});

test('a routable, allowlisted model produces no findings and stays silent', () => {
  const d = preflightModel({
    config: fixture(),
    claudeArgs: ['--model', 'claude-opus-4-8', '-p', 'hi'],
    availableModels: ['claude-opus-4-8'],
  });
  assert.deepEqual(d.findings, []);
  assert.equal(d.blocked, false);
  assert.deepEqual(formatPreflight(d), [], 'a clean launch prints nothing at all');
});

test('a routing failure blocks but a client-allowlist veto only warns, and warns TERSELY', () => {
  // The asymmetry the module header argues for: our own config is provable, the
  // client's gate is a model of someone else's build.
  const d = preflightModel({
    config: fixture(),
    claudeArgs: ['--model', 'claude-fable-5'],
    availableModels: ['claude-opus-4-8'],
  });
  assert.equal(d.blocked, false, 'a foreign gate must not be able to refuse a launch by itself');
  const veto = d.findings.find(f => f.code === 'client-allowlist-veto');
  assert.equal(veto.severity, 'warn');
  assert.match(veto.message, /silently fall back/);
  // One line, no remedy block. This fires on every automated revive of a session
  // whose last model is not in availableModels — a path nobody reads — and a
  // multi-line block there trains operators to skim past preflight output, which
  // is the same channel the BLOCKING findings use.
  assert.deepEqual(veto.remedies, []);
  assert.equal(formatPreflight(d).length, 1, 'advisory findings get exactly one line');

  const loud = preflightModel({
    config: fixture(),
    claudeArgs: ['--model', 'claude-fable-5'],
    availableModels: ['claude-opus-4-8'],
    strict: true,
  });
  const strictVeto = loud.findings.find(f => f.code === 'client-allowlist-veto');
  assert.equal(strictVeto.severity, 'error');
  assert.ok(strictVeto.remedies.length >= 2, 'the full remedy list is kept for the posture that actually blocks');
});

test('--strict promotes the client veto to a block; --force clears a routing block', () => {
  const strict = preflightModel({
    config: fixture(),
    claudeArgs: ['--model', 'claude-fable-5'],
    availableModels: ['claude-opus-4-8'],
    strict: true,
  });
  assert.equal(strict.blocked, true);
  assert.equal(strict.findings.find(f => f.code === 'client-allowlist-veto').severity, 'error');

  const forced = preflightModel({
    config: fixture(),
    claudeArgs: ['--model', 'deepseek-v4-pro'],
    force: true,
  });
  assert.equal(forced.blocked, false);
  assert.equal(forced.exitCode, 0);
  assert.ok(forced.findings.some(f => f.code === 'forced'), 'the override is recorded, not hidden');
  assert.ok(forced.findings.some(f => f.code === 'model-not-routable'),
    'the finding itself is still reported — --force silences the exit, not the diagnosis');
});

test('ANTHROPIC_MODEL is checked when no --model is passed, and noted when one is', () => {
  const fromEnv = preflightModel({
    config: fixture(),
    claudeArgs: ['-p', 'hi'],
    envModel: 'deepseek-v4-pro',
  });
  assert.equal(fromEnv.requested, 'deepseek-v4-pro');
  assert.equal(fromEnv.source, 'ANTHROPIC_MODEL');
  assert.equal(fromEnv.blocked, true, 'the client vets the env var with the same gate, so we do too');

  const shadowed = preflightModel({
    config: fixture(),
    claudeArgs: ['--model', 'claude-opus-4-8'],
    envModel: 'claude-fable-5',
  });
  assert.equal(shadowed.requested, 'claude-opus-4-8', '--model wins in the client, so it wins here');
  assert.ok(shadowed.findings.some(f => f.code === 'env-model-shadowed'));
});

test('no model requested at all is not a problem — claude picks its default', () => {
  const d = preflightModel({ config: fixture(), claudeArgs: ['-p', 'hi'] });
  assert.equal(d.requested, null);
  assert.equal(d.source, null);
  assert.deepEqual(d.findings, []);
  assert.equal(d.routing, null);
  assert.equal(d.client, null);
});

test('an absent availableModels allowlist never produces a veto', () => {
  for (const availableModels of [undefined, null]) {
    const d = preflightModel({ config: fixture(), claudeArgs: ['--model', 'claude-fable-5'], availableModels });
    assert.ok(!d.findings.some(f => f.code === 'client-allowlist-veto'),
      'no settings tier defines the key, so the client gate admits everything');
  }
});

test('a blocklisted model is blocked with the pattern named', () => {
  const cfg = fixture();
  cfg.blockedModels = ['*preview*'];
  const d = preflightModel({ config: cfg, claudeArgs: ['--model', 'claude-opus-preview'] });
  assert.equal(d.blocked, true);
  const f = d.findings.find(f => f.code === 'model-blocked');
  assert.match(f.message, /\*preview\*/);
});

// ── the fleet-launcher regression: a duplicate --model may NEVER block ────────

test('a wrapper template\'s two-flag argv shape launches — a duplicate --model warns, never blocks', () => {
  // A real wrapper template appends `--model opus` to EVERY new session and
  // documents that caller args land after it ("CLI takes the last flag, so
  // the caller's --model wins"), so a routine model override legitimately emits
  // two --model flags. Blocking on that shape failed every model switch on every
  // session on that host — and such sessions respawn automatically, so it
  // failed them over and over. The duplicate is a fact about the argv, not a
  // proof about the launch: report it loudly, decide on the WINNER.
  const d = preflightModel({
    config: fixture(),
    claudeArgs: ['--dangerously-skip-permissions', '--model', 'opus', '-n', 'my-session',
      '--model', 'claude-opus-4-8'],
    availableModels: ['claude-opus-4-8', 'opus'],
  });
  assert.equal(d.blocked, false, 'a wrapper-appended second --model must never take a session down');
  assert.equal(d.exitCode, 0);
  const dup = d.findings.find(f => f.code === 'duplicate-model-flag');
  assert.equal(dup.severity, 'warn');
  assert.match(dup.message, /keeps the LAST one/);
  assert.match(dup.message, /"opus", "claude-opus-4-8"/, 'both values are named');
  assert.ok(!d.findings.some(f => f.severity === 'error'));
});

test('two IDENTICAL --model values say so and do not pretend a value was lost', () => {
  const d = preflightModel({
    config: fixture(),
    claudeArgs: ['--model', 'claude-opus-4-8', '--model', 'claude-opus-4-8'],
    availableModels: ['claude-opus-4-8'],
  });
  assert.equal(d.blocked, false);
  const dup = d.findings.find(f => f.code === 'duplicate-model-flag');
  assert.equal(dup.severity, 'warn');
  assert.match(dup.message, /identical/);
  assert.match(dup.message, /which is what was asked for either way/);
});

test('the incident still blocks — on the winner being unroutable, which is the part that is provable', () => {
  const d = preflightModel({
    config: fixture(),
    claudeArgs: ['--model', 'opus', '-n', 'my-session', '--model', 'deepseek-v4-pro'],
    availableModels: ['claude-opus-4-8'],
  });
  assert.equal(d.blocked, true);
  assert.equal(d.findings.filter(f => f.severity === 'error').map(f => f.code).join(), 'model-not-routable',
    'exactly one blocking finding, and it is the one carrying a proof');
});

// ── which rules govern the launch ────────────────────────────────────────────

test('a pinned launch is judged against the PINNED account, not the routing table it bypasses', () => {
  // The pin indexes accounts directly and never calls getActiveAccount, so
  // routes and models[] decide nothing. `disabled` on the PINNED account is
  // still a refusal; this test disables a different account (the unpinned
  // route's only candidate). Judging a pinned launch with the unpinned oracle
  // refused launches the proxy provably serves.
  const config = fixture();
  config.accounts[0].disabled = true;                    // the only account the route allows
  const d = preflightModel({
    config,
    claudeArgs: ['--model', 'claude-fable-5'],
    accountPin: { token: 'deepseek-v4-pro', name: 'deepseek-v4-pro', index: 1 },
    availableModels: ['claude-fable-5'],
  });
  assert.equal(d.blocked, false, 'the unpinned rules said "all candidates disabled"; the pin does not consult them');
  assert.equal(d.routing.pinned, true);
  assert.equal(d.routing.mappedTo, 'deepseek-v4-pro', 'the pinned account\'s own modelMap is what decides the wire id');
  assert.ok(d.findings.some(f => f.code === 'pin-outside-routing'),
    'reaching an account the rules would never pick is the POINT of a pin — say it, do not refuse it');

  // The same launch unpinned really is blocked, which is what the pin is for.
  const unpinned = preflightModel({ config, claudeArgs: ['--model', 'claude-fable-5'], availableModels: ['claude-fable-5'] });
  assert.equal(unpinned.blocked, true);
});

test('a pin does not bypass blockedModels, because the blocklist gate runs after the prefix is stripped', () => {
  const config = fixture();
  config.blockedModels = ['*fable*'];
  const d = preflightModel({
    config,
    claudeArgs: ['--model', 'claude-fable-5'],
    accountPin: { token: 'deepseek-v4-pro' },
  });
  assert.equal(d.blocked, true);
  assert.equal(d.findings[0].code, 'model-blocked');
  assert.match(d.findings[0].message, /a pin does not bypass it/);
});

test('an unresolved pin blocks: every request of that session 404s locally', () => {
  const d = preflightModel({
    config: fixture(),
    claudeArgs: ['--model', 'claude-opus-4-8'],
    accountPin: { token: 'no-such-account' },
  });
  assert.equal(d.blocked, true);
  assert.equal(d.findings[0].code, 'pin-cannot-serve');
  assert.match(d.findings[0].message, /Unknown account pin/);
});

test('a pinned but DISABLED account blocks the launch — the proxy would 403 every request', () => {
  const config = fixture();
  config.accounts[1].disabled = true;
  const d = preflightModel({
    config,
    claudeArgs: ['--model', 'claude-fable-5'],
    accountPin: { token: 'deepseek-v4-pro' },
  });
  assert.equal(d.blocked, true);
  const f = d.findings.find(x => x.code === 'pin-account-disabled');
  assert.equal(f.severity, 'error');
  assert.match(f.message, /disabled/);
  assert.match(f.remedies.join(' '), /teamclaude enable/);
});

test('a proxy-down --auto-fallback launch is not judged on routing rules it will never consult', () => {
  // The direct launch runs on the user's own credential straight at the
  // upstream: teamclaude's routes, models[] and blockedModels govern nothing.
  // Refusing it on those grounds inverts the purpose of --auto-fallback, which
  // exists precisely to keep a session launchable when the proxy is down.
  const config = fixture();
  config.blockedModels = ['*fable*'];
  const d = preflightModel({
    config,
    claudeArgs: ['--model', 'claude-fable-5'],
    routingApplies: false,
    availableModels: ['claude-fable-5'],
  });
  assert.equal(d.blocked, false);
  assert.equal(d.routing, null);
  const note = d.findings.find(f => f.code === 'routing-not-checked');
  assert.equal(note.severity, 'info');
  assert.match(note.message, /govern nothing here/);
});

// ── the client allowlist, and the tier sitting in the argv ───────────────────

test('a --settings tier in the same argv is unioned in, so the veto cannot recommend the flag already present', () => {
  const argv = ['--settings', '{"availableModels":["claude-zephyr-9"]}', '--model', 'claude-zephyr-9'];
  const d = preflightModel({
    config: fixture(),
    claudeArgs: argv,
    availableModels: ['claude-opus-4-8'],
    flagSettings: readFlagSettingsModels(argv),
  });
  assert.ok(!d.findings.some(f => f.code === 'client-allowlist-veto'),
    '--settings is a real settings tier and its arrays UNION, so the client admits this id');
  assert.equal(d.blocked, false);

  // …and with --strict, which is where the veto would otherwise refuse a launch
  // that provably works.
  const strict = preflightModel({
    config: fixture(), claudeArgs: argv, availableModels: ['claude-opus-4-8'],
    flagSettings: readFlagSettingsModels(argv), strict: true,
  });
  assert.equal(strict.blocked, false);
});

test('an UNREADABLE --settings suppresses the veto rather than guessing, and says why', () => {
  const argv = ['--settings', '/no/such/file.json', '--model', 'claude-zephyr-9'];
  const d = preflightModel({
    config: fixture(),
    claudeArgs: argv,
    availableModels: ['claude-opus-4-8'],
    flagSettings: readFlagSettingsModels(argv, () => { throw new Error('ENOENT'); }),
  });
  assert.ok(!d.findings.some(f => f.code === 'client-allowlist-veto'),
    'an unknown allowlist may not support a denial — that is the module\'s standing bias');
  assert.ok(d.findings.some(f => f.code === 'settings-flag-unread'));
  assert.equal(d.findings.find(f => f.code === 'settings-flag-unread').severity, 'info');
  assert.equal(d.blocked, false);
});

test('D4e: unreadable --settings under policyOverride is an explicit error, not a silent proceed', () => {
  const argv = ['--settings', '/no/such/file.json', '--model', 'claude-opus-4-8'];
  const d = preflightModel({
    config: fixture(),
    claudeArgs: argv,
    availableModels: ['claude-opus-4-8'],
    policyOverride: true,
    flagSettings: readFlagSettingsModels(argv, () => { throw new Error('ENOENT'); }),
  });
  const unread = d.findings.find(f => f.code === 'settings-flag-unread');
  assert.ok(unread, 'must surface the unreadable --settings');
  assert.equal(unread.severity, 'error');
  assert.equal(d.blocked, true, 'a named-but-unreadable settings file must refuse the launch');
  assert.match(unread.message, /managed policy|silently/i);
});

test('readFlagSettingsModels reads both spellings and never returns anything but availableModels', () => {
  assert.deepEqual(readFlagSettingsModels(['--settings={"availableModels":["a","b"],"apiKeyHelper":"secret"}']),
    { present: true, entries: ['a', 'b'], unreadable: false });
  assert.deepEqual(readFlagSettingsModels(['--settings', '{"other":1}']),
    { present: true, entries: null, unreadable: false }, 'a tier with no availableModels adds nothing');
  assert.deepEqual(readFlagSettingsModels(['-p', 'hi']), { present: false, entries: null, unreadable: false });
  assert.equal(readFlagSettingsModels(['--settings', '{bad json']).unreadable, true);
  assert.deepEqual(readFlagSettingsModels(['--settings', '/tmp/s.json'], () => '{"availableModels":["z"]}').entries, ['z']);
});

// ── an account name asked for as a model ─────────────────────────────────────

test('an account name is flagged even when it IS routable — the request never reaches that account', () => {
  // The sibling of the incident, and the case the narrow collision branch skips:
  // the account is listed in the catch-all, so the id "routes" — to a DIFFERENT
  // account that has never heard of it. It used to pass in total silence while
  // `explain` warned about it.
  const config = fixture();
  config.routes[0].accounts = ['primary', 'deepseek-v4-pro'];
  const d = preflightModel({ config, claudeArgs: ['--model', 'deepseek-v4-pro'] });
  assert.equal(d.routing.routable, true, 'the account of that name IS a candidate, so nothing is provably dead');
  assert.equal(d.blocked, false, 'and therefore nothing may be refused');
  const f = d.findings.find(x => x.code === 'model-is-account-name');
  assert.equal(f.severity, 'warn');
  assert.match(f.remedies.join(' '), /--account deepseek-v4-pro/);
});

// ── the refusal line has to be a working instruction ─────────────────────────

test('the refusal names the position of --force, because appending it to the failed line does nothing', () => {
  const d = preflightModel({ config: fixture(), claudeArgs: ['--model', 'deepseek-v4-pro'] });
  const last = formatPreflight(d).at(-1);
  assert.match(last, /teamclaude run --force -- /);
  assert.match(last, /BEFORE the `--`/);
});

test('a posture flag written after the separator is reported, not silently swallowed', () => {
  const d = preflightModel({
    config: fixture(),
    claudeArgs: ['--model', 'claude-opus-4-8', '--force'],
    misplacedFlags: ['--force'],
    availableModels: ['claude-opus-4-8'],
  });
  const f = d.findings.find(x => x.code === 'posture-flag-after-separator');
  assert.equal(f.severity, 'warn');
  assert.match(f.remedies[0], /BEFORE the separator/);
  assert.equal(d.blocked, false);
});

test('an unknown but claude-shaped id is NOT blocked — the oracle refuses to guess', () => {
  // The finite-allowlist bug this feature exists to kill would reappear if a
  // future real Anthropic id were treated as a typo.
  const d = preflightModel({ config: fixture(), claudeArgs: ['--model', 'claude-zephyr-9'] });
  assert.equal(d.blocked, false);
  assert.equal(d.routing.routable, true);
});
