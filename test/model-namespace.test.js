import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import {
  deriveNamespace,
  routabilityOf,
  clientAllowlistVerdict,
  normalizeRoutes,
  normalizeAccounts,
  accountAllows,
  accountAcceptsModel,
  accountAcceptsAllIds,
  requestModelIds,
  collisionIdInSet,
  pinnedRoutabilityOf,
  resolveAccountToken,
  CLAUDE_CODE_GATE_MODELED_VERSION,
} from '../src/model-namespace.js';

// Covers src/model-namespace.js: the routable-namespace oracle and the advisory
// model of Claude Code's client-side availableModels gate.
//
// The fixture below reproduces the SHAPE of the live fleet config that produced
// the incident (7 accounts, 6 routes, catch-all last, an account literally named
// "deepseek-v4-pro" whose modelMap keys are all claude-shaped) — as a literal
// object. Nothing here reads ~/.config/teamclaude.json, and nothing here spawns
// a server or touches the network.
//
// Two fixture fields are documented facts, not reconstructions: the catch-all's
// account list, and the 12 modelMap keys on the deepseek accounts. The five
// specific routes' account lists are a reconstruction chosen to be consistent
// with the observed defect (opus keys dead on deepseek-v4-pro, sonnet keys dead
// on deepseek-v4-flash); the tests assert mechanics, not the live fleet's exact
// operator choices.

const CLAUDE_KEYS = [
  'claude-opus-4-8', 'claude-opus-4-8[1m]', 'opus',
  'claude-fable-5', 'claude-fable-5[1m]', 'fable',
  'claude-sonnet-5', 'claude-sonnet-5[1m]', 'sonnet', 'sonnet5',
  'claude-haiku-4-5', 'haiku',
];

function mapTo(target, keys) {
  return Object.fromEntries(keys.map(k => [k, target]));
}

// The live config's shape. A factory so each test can mutate its own copy.
function liveConfig() {
  return {
    accounts: [
      { name: 'primary@example.com', type: 'oauth', priority: 0 },
      { name: 'secondary@example.com', type: 'oauth', priority: 20 },
      { name: 'sakana-fugu', type: 'apikey', priority: 30, upstream: 'http://127.0.0.1:8081' },
      { name: 'codex-gpt56', type: 'apikey', priority: 40, upstream: 'http://127.0.0.1:8082' },
      { name: 'kimi-k3', type: 'apikey', priority: 60, upstream: 'http://127.0.0.1:8083' },
      {
        name: 'deepseek-v4-pro', type: 'apikey', priority: 80, upstream: 'http://127.0.0.1:8084',
        modelMap: mapTo('deepseek-v4-pro', CLAUDE_KEYS),
      },
      {
        name: 'deepseek-v4-flash', type: 'apikey', priority: 90, upstream: 'http://127.0.0.1:8085',
        modelMap: mapTo('deepseek-v4-flash', [
          'claude-sonnet-5', 'claude-sonnet-5[1m]', 'sonnet', 'sonnet5',
          'claude-opus-4-8', 'claude-opus-4-8[1m]', 'opus',
        ]),
      },
    ],
    routes: [
      { name: 'fable', match: ['*fable*', '*fable-5*'], accounts: ['primary@example.com', 'deepseek-v4-pro'] },
      { name: 'opus', match: ['*opus*'], accounts: ['primary@example.com', 'secondary@example.com', 'deepseek-v4-flash'] },
      { name: 'sonnet-haiku', match: ['*sonnet*', '*haiku*'], accounts: ['primary@example.com', 'deepseek-v4-pro'] },
      { name: 'kimi', match: ['*kimi*', '*k3*'], accounts: ['kimi-k3'] },
      { name: 'fugu', match: ['*fugu*'], accounts: ['sakana-fugu'] },
      {
        name: 'default (MUST stay last: pins unrouted models off deepseek-v4-flash)',
        match: ['*'],
        accounts: ['primary@example.com', 'sakana-fugu', 'codex-gpt56', 'secondary@example.com', 'deepseek-v4-flash'],
      },
    ],
  };
}

// The user's real ~/.claude/settings.json availableModels — 17 entries, no
// deepseek. Documented post-normalization, so the [1m] form of the duplicated
// kimi entry is restored here (it exercises the trailing-[1m] strip either way).
const AVAILABLE_17 = [
  'claude-fugu-ultra', 'claude-fugu', 'claude-gpt-5.6-sol', 'claude-gpt-5.6-terra',
  'claude-kimi-k3', 'claude-kimi-k3[1m]', 'claude-fable-5', 'fable',
  'claude-opus-4-8', 'claude-opus-4-7', 'sonnet', 'sonnet5', 'haiku',
  'claude-sonnet-5', 'claude-haiku-4-5', 'kimi', 'kimi-k3',
];

const CATCH_ALL = 'default (MUST stay last: pins unrouted models off deepseek-v4-flash)';

// ── namespace derivation ──────────────────────────────────────

test('the namespace splits into an enumerable set and un-enumerable patterns, and the enumerable half is exactly the modelMap keys', () => {
  const ns = deriveNamespace(liveConfig());

  assert.deepEqual(ns.concrete, [
    'claude-fable-5', 'claude-fable-5[1m]', 'claude-haiku-4-5',
    'claude-opus-4-8', 'claude-opus-4-8[1m]', 'claude-sonnet-5', 'claude-sonnet-5[1m]',
    'fable', 'haiku', 'opus', 'sonnet', 'sonnet5',
  ], 'sorted, de-duplicated, case-preserving union of every account modelMap key');

  // The whole incident in one assertion: the id the launcher asked for is an
  // ACCOUNT name and was never a member of the namespace.
  assert.ok(!ns.concrete.includes('deepseek-v4-pro'), 'an account name is not a model id');

  assert.deepEqual(ns.patterns,
    ['*fable*', '*fable-5*', '*opus*', '*sonnet*', '*haiku*', '*kimi*', '*k3*', '*fugu*', '*'],
    'route globs are reported as patterns, in route order, because they cannot be enumerated');
});

test('the namespace notes carry the caveats that make the list honest, computed from the config', () => {
  const notes = deriveNamespace(liveConfig()).notes.join('\n');
  assert.match(notes, /no custom upstream/, 'passthrough accounts serve ids that appear nowhere in the config');
  assert.match(notes, /never as "all available models"/);
  assert.match(notes, /cannot be enumerated/, 'the glob half is called out as un-enumerable');
  assert.match(notes, /availableModels/, 'routable here still is not accepted by the client');
});

test('modelMap translations that the first matching route can never select are reported as dead', () => {
  const notes = deriveNamespace(liveConfig()).notes.find(n => n.includes('can never fire'));
  assert.ok(notes, 'the dead-translation lint fires on the live config shape');
  assert.match(notes, /^7 modelMap translation\(s\)/, 'three opus keys on -pro plus four sonnet keys on -flash');
  for (const dead of ['deepseek-v4-pro:opus', 'deepseek-v4-pro:claude-opus-4-8', 'deepseek-v4-flash:sonnet']) {
    assert.ok(notes.includes(dead), `${dead} is unreachable: the winning route selects other accounts`);
  }
  // Id-level reachability hides these: a sibling account maps the same key.
  assert.equal(routabilityOf(liveConfig(), 'opus').routable, true);
});

test('a route that matches everything but is not last is flagged, and a last one is not', () => {
  const ok = deriveNamespace(liveConfig()).notes.join('\n');
  assert.ok(!ok.includes('matches everything but is not last'));

  const config = liveConfig();
  config.routes.unshift(config.routes.pop());          // catch-all first
  const notes = deriveNamespace(config).notes.join('\n');
  assert.match(notes, /matches everything but is not last/);
  assert.match(notes, /every route after it is dead/);
});

// ── routability: mirroring account selection ──────────────────

test('claude-fable-5 takes the first matching route and the lowest-priority-value account in it', () => {
  const r = routabilityOf(liveConfig(), 'claude-fable-5');
  assert.equal(r.routable, true);
  assert.equal(r.route.name, 'fable', 'the fable route matches before the catch-all — array order decides');
  assert.deepEqual(r.candidates.map(c => c.name), ['primary@example.com', 'deepseek-v4-pro']);
  assert.equal(r.candidates[0].via, 'route', 'a route with an account list is exclusive');
  assert.equal(r.candidates[0].mappedTo, null, 'the oauth account has no modelMap: the id passes through verbatim');
  assert.equal(r.candidates[1].mappedTo, 'deepseek-v4-pro', 'the fallback rewrites the body after it is selected');
  assert.match(r.reason, /first choice "primary@example\.com"/);
});

test('route order is load-bearing: moving the catch-all first steals every model from the specific routes', () => {
  const config = liveConfig();
  config.routes.unshift(config.routes.pop());
  const r = routabilityOf(config, 'claude-fable-5');
  assert.equal(r.route.name, CATCH_ALL, 'first matching route wins, not the most specific one');
  assert.ok(!r.candidates.some(c => c.name === 'deepseek-v4-pro'), 'the fable fallback is now unreachable');
});

test('deepseek-v4-pro is not routable: it is an account name, the catch-all excludes that account, and nothing translates it', () => {
  const r = routabilityOf(liveConfig(), 'deepseek-v4-pro');

  assert.equal(r.routable, false);
  assert.equal(r.route.name, CATCH_ALL, 'no specific route matches; only the catch-all does');
  assert.ok(!r.candidates.some(c => c.name === 'deepseek-v4-pro'),
    'the account that bears the name is not in the catch-all account list, so it can never be selected for it');
  assert.ok(r.candidates.every(c => c.mappedTo === null), 'no eligible account translates this id');
  assert.match(r.reason, /name of a configured ACCOUNT/);
  assert.match(r.reason, /404/, 'the id would egress verbatim to the Anthropic API');
  assert.match(r.reason, /--account deepseek-v4-pro/, 'the fix is an account pin, not a model id');
  assert.equal(r.blockedBy, null);
});

test('the account-name collision only BLOCKS when the id would really reach the Anthropic API', () => {
  // The block asserts "the id egresses verbatim and 404s". That claim needs the
  // winning candidate to be an Anthropic-passthrough account. Give the catch-all
  // a third-party backend at the front and the claim is not merely unproven, it
  // is contradicted by the config: the id goes to an anthropic-proxy holding its
  // OWN model map, which teamclaude explicitly cannot see past. Block on a proof
  // or not at all — the narrowness is what earns this branch the right to block.
  const config = liveConfig();
  config.accounts[2].priority = -1;                      // sakana-fugu (upstream 8081) wins the catch-all
  const r = routabilityOf(config, 'deepseek-v4-pro');
  assert.equal(r.routable, true, 'unknowable is not the same as unservable');
  assert.equal(r.candidates[0].name, 'sakana-fugu');
  assert.match(r.reason, /also the NAME of a configured account/, 'the suspicion is still reported');
  assert.match(r.reason, /cannot see/, 'and so is the reason it cannot be settled from config');
  assert.match(r.reason, /--account deepseek-v4-pro/, 'with the pin as the remedy either way');

  // Unchanged where the proof holds: the default fixture's first candidate is an
  // oauth account with no custom upstream.
  assert.equal(routabilityOf(liveConfig(), 'deepseek-v4-pro').routable, false);
});

test('a non-string models[] entry is answered false, not thrown — an oracle that crashes on a broken config is useless', () => {
  const config = liveConfig();
  config.accounts[5].models = [42, 'deepseek-v4-pro'];
  config.routes[5].accounts = [];
  assert.doesNotThrow(() => routabilityOf(config, 'deepseek-v4-pro'));
  assert.equal(routabilityOf(config, 'deepseek-v4-pro').routable, true, 'the usable entry still decides');
  assert.doesNotThrow(() => deriveNamespace(config));
});

test('an unknown id that is not an account name stays routable, because a passthrough account may legitimately serve it', () => {
  const r = routabilityOf(liveConfig(), 'claude-zephyr-9-not-yet-released');
  assert.equal(r.routable, true, 'teamclaude cannot tell a future Anthropic id from a made-up one — do not guess');
  assert.equal(r.route.name, CATCH_ALL);
  assert.equal(r.candidates[0].name, 'primary@example.com');
  assert.match(r.reason, /forward the id verbatim to the Anthropic API/);
  assert.match(r.reason, /404s anything else/, 'the same sentence states both outcomes, since only upstream knows');
});

test('the catch-all shadows the per-account models[] ownership claim, and removing its account list restores it', () => {
  const config = liveConfig();
  config.accounts[5].models = ['deepseek-v4-pro[1m]', 'deepseek-v4-pro'];   // the README's own example

  const shadowed = routabilityOf(config, 'deepseek-v4-pro');
  assert.equal(shadowed.routable, false, 'declaring models[] alone does NOT fix it');
  assert.match(shadowed.reason, /suppresses the ownership claim entirely/);
  assert.match(shadowed.reason, /deepseek-v4-pro/);
  assert.match(deriveNamespace(config).notes.join('\n'), /makes the per-account models\[\] ownership claim unreachable/);

  // A matching route that lists NO accounts falls through to the claim...
  const viaOwnership = liveConfig();
  viaOwnership.accounts[5].models = ['deepseek-v4-pro[1m]', 'deepseek-v4-pro'];
  viaOwnership.routes[5].accounts = [];
  const owned = routabilityOf(viaOwnership, 'deepseek-v4-pro');
  assert.equal(owned.routable, true);
  assert.deepEqual(owned.candidates.map(c => c.name), ['deepseek-v4-pro'],
    'the claim is a global trigger: one owner bars every other account from the id');
  assert.equal(owned.candidates[0].via, 'ownership');

  // ...and the [Nm] suffix on the declared side matches a bare request.
  const bareOnly = liveConfig();
  bareOnly.accounts[5].models = ['deepseek-v4-pro[1m]'];
  bareOnly.routes[5].accounts = [];
  assert.equal(routabilityOf(bareOnly, 'deepseek-v4-pro').routable, true);
});

test('ownership is inert when no account declares a models list', () => {
  const config = liveConfig();
  config.routes[5].accounts = [];                       // fall through to the ownership branch
  const r = routabilityOf(config, 'some-unclaimed-id');
  assert.equal(r.routable, true);
  assert.equal(r.candidates.length, 7, 'no claim anywhere → every account is eligible');
  assert.ok(r.candidates.every(c => c.via === 'ownership'));
  assert.match(r.reason, /no account claims it via models\[\]/);
});

test('blockedModels subtracts first, before any route is consulted', () => {
  const config = liveConfig();
  config.blockedModels = ['*fable*'];

  const r = routabilityOf(config, 'claude-fable-5');
  assert.equal(r.routable, false);
  assert.equal(r.blockedBy, '*fable*');
  assert.equal(r.route, null, 'a blocked model never reaches route selection');
  assert.equal(r.candidates.length, 0);
  assert.match(r.reason, /rejects this id with a 400/);

  const ns = deriveNamespace(config);
  assert.deepEqual(ns.concrete.filter(id => /fable/i.test(id)), [], 'the blocked ids leave the namespace');
  assert.match(ns.notes.join('\n'), /blockedModels removes 3 named id\(s\)/);

  assert.equal(routabilityOf({ ...config, blockedModels: [] }, 'claude-fable-5').routable, true,
    'an empty blocklist blocks nothing');
});

test('disabled accounts are reported but do not make a model routable', () => {
  const one = liveConfig();
  one.accounts[0].disabled = true;
  const partial = routabilityOf(one, 'claude-fable-5');
  assert.equal(partial.routable, true, 'the fable fallback is still enabled');
  assert.deepEqual(partial.candidates.map(c => c.disabled), [true, false], 'the disabled account is still reported');

  const both = liveConfig();
  both.accounts[0].disabled = true;
  both.accounts[5].disabled = true;
  const dead = routabilityOf(both, 'claude-fable-5');
  assert.equal(dead.routable, false);
  assert.equal(dead.candidates.length, 2, 'quota-blind: eligibility is unchanged, only the verdict is');
  assert.match(dead.reason, /are all disabled/);
  assert.match(dead.reason, /teamclaude enable/);
});

test('a route whose account list names nobody leaves the model unservable, with an actionable reason', () => {
  const config = liveConfig();
  config.routes[0].accounts = ['typo-account'];
  const r = routabilityOf(config, 'claude-fable-5');
  assert.equal(r.routable, false);
  assert.equal(r.candidates.length, 0);
  assert.match(r.reason, /no configured account has that name or index/);
});

test('an empty config and an empty model id are answered, not thrown', () => {
  assert.equal(routabilityOf({}, 'anything').routable, false);
  assert.match(routabilityOf({}, 'anything').reason, /no accounts are configured/);
  assert.equal(routabilityOf(liveConfig(), '').routable, false);
  for (const empty of [undefined, null, {}, { accounts: 'nope', routes: 7 }]) {
    const ns = deriveNamespace(empty);
    assert.deepEqual(ns.concrete, []);
    assert.deepEqual(ns.patterns, []);
    assert.ok(Array.isArray(ns.notes) && ns.notes.length >= 1, 'the client-gate caveat is unconditional');
  }
});

// ── pinned routability (/tc-acct) ─────────────────────────────

test('a pin bypasses route exclusivity and the models[] claim — because the request path does', () => {
  // forwardRequest indexes accountManager.accounts[ctx.pinnedIndex] directly
  // and never calls getActiveAccount, so route/ownership rules are not
  // consulted. `disabled` is the exception: it is an operator hard-stop.
  const config = liveConfig();
  const pinned = pinnedRoutabilityOf(config, 'claude-fable-5', 'deepseek-v4-pro');
  assert.equal(pinned.routable, true);
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.account.name, 'deepseek-v4-pro');
  assert.equal(pinned.mappedTo, 'deepseek-v4-pro', 'the pinned account\'s own modelMap decides the wire id');
  assert.match(pinned.reason, /bypasses selection/);

  // An id the routing rules would never send to this account.
  const outside = pinnedRoutabilityOf(liveConfig(), 'claude-opus-4-8', 'deepseek-v4-pro');
  assert.equal(outside.routable, true);
  assert.equal(outside.outsideRouting, true, 'route "opus" excludes deepseek-v4-pro — the pin is what reaches it');
});

test('a pin to a disabled account is not routable — the proxy 403s locally', () => {
  const config = liveConfig();
  config.accounts[5].disabled = true;                    // deepseek-v4-pro
  const pinned = pinnedRoutabilityOf(config, 'claude-fable-5', 'deepseek-v4-pro');
  assert.equal(pinned.routable, false);
  assert.equal(pinned.account.name, 'deepseek-v4-pro');
  assert.equal(pinned.account.disabled, true);
  assert.match(pinned.reason, /disabled/);
  assert.match(pinned.reason, /403/);
});

test('a pin is resolved name-first then by index, and an unresolved one is the one thing that always fails', () => {
  assert.equal(pinnedRoutabilityOf(liveConfig(), 'claude-fable-5', '2').account.name, 'sakana-fugu');
  const bad = pinnedRoutabilityOf(liveConfig(), 'claude-fable-5', 'nope');
  assert.equal(bad.routable, false);
  assert.match(bad.reason, /404 "Unknown account pin"/);
  assert.equal(pinnedRoutabilityOf(liveConfig(), 'claude-fable-5', '99').routable, false, 'index out of range');
});

test('blockedModels survives a pin, because the blocklist gate runs after the prefix is stripped', () => {
  const config = liveConfig();
  config.blockedModels = ['*fable*'];
  const r = pinnedRoutabilityOf(config, 'claude-fable-5', 'deepseek-v4-pro');
  assert.equal(r.routable, false);
  assert.equal(r.blockedBy, '*fable*');
  assert.match(r.reason, /a pin does not bypass it/);
});

test('resolveAccountToken is the one resolver, so explain/preflight/server cannot disagree about a pin', () => {
  const accounts = normalizeAccounts(liveConfig().accounts);
  assert.equal(resolveAccountToken(accounts, 'kimi-k3').index, 4);
  assert.equal(resolveAccountToken(accounts, '4').name, 'kimi-k3');
  assert.equal(resolveAccountToken(accounts, ''), null);
  assert.equal(resolveAccountToken(accounts, null), null);
  assert.equal(resolveAccountToken(accounts, '7'), null);
});

// ── divergence gate: the oracle vs the real request path ──────

test('accountAllows agrees with AccountManager._routeAllows for every model x account in the fixture', () => {
  const config = liveConfig();
  const am = new AccountManager(config.accounts, 0.98, { routes: config.routes });
  const routes = normalizeRoutes(config.routes);
  const models = [
    'claude-fable-5', 'claude-fable-5[1m]', 'fable', 'claude-opus-4-8', 'opus',
    'claude-sonnet-5', 'sonnet5', 'claude-haiku-4-5', 'kimi-k3', 'claude-fugu-ultra',
    'deepseek-v4-pro', 'something-nobody-routes',
  ];
  let checked = 0;
  for (const model of models) {
    for (const account of am.accounts) {
      assert.equal(
        accountAllows(routes, am.accounts, account, model),
        am._routeAllows(account, model),
        `divergence on ${account.name} x ${model}`);
      checked++;
    }
  }
  assert.equal(checked, models.length * config.accounts.length);

  // ...and again with a models[] claim in play, which switches on the other branch.
  const owned = liveConfig();
  owned.accounts[5].models = ['deepseek-v4-pro[1m]'];
  owned.routes[5].accounts = [];
  const am2 = new AccountManager(owned.accounts, 0.98, { routes: owned.routes });
  const routes2 = normalizeRoutes(owned.routes);
  for (const model of ['deepseek-v4-pro', 'deepseek-v4-pro[1m]', 'claude-fable-5']) {
    for (const account of am2.accounts) {
      assert.equal(accountAllows(routes2, am2.accounts, account, model), am2._routeAllows(account, model),
        `divergence on ${account.name} x ${model}`);
    }
  }
});

test('accountAcceptsModel agrees with AccountManager._acceptsModel for every model x account', () => {
  const config = liveConfig();
  // Arm the closed-adapter contract the live fleet currently leaves inert.
  config.accounts[5].strictModelMap = true;
  config.accounts[5].acceptsModels = ['deepseek-v4-pro'];
  config.accounts[6].strictModelMap = true;
  config.accounts[6].acceptsModels = ['deepseek-v4-flash'];
  const am = new AccountManager(config.accounts, 0.98, { routes: config.routes });
  const models = [
    'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'kimi-k3',
    'deepseek-v4-pro', 'something-nobody-maps',
  ];
  let checked = 0;
  for (const model of models) {
    for (const account of am.accounts) {
      assert.equal(
        accountAcceptsModel(account, model),
        am._acceptsModel(account, model),
        `accepts divergence on ${account.name} x ${model}`);
      checked++;
    }
  }
  assert.equal(checked, models.length * config.accounts.length);
});

test('requestModelIds + accountAcceptsAllIds pins set-quantified gates to selection', () => {
  const account = {
    name: 'closed', strictModelMap: true, acceptsModels: ['exec-native'],
    modelMap: { 'claude-opus-4-8': 'exec-native', 'claude-sonnet-5': 'exec-native' },
  };
  const am = new AccountManager([{
    ...account, type: 'apikey', apiKey: 'k', upstream: 'http://127.0.0.1:9',
  }], 0.98);
  const a = am.accounts[0];
  const pairs = [
    ['claude-opus-4-8', null],
    ['claude-opus-4-8', 'claude-sonnet-5'],
    ['claude-opus-4-8', 'claude-fable-5'],
    ['claude-fable-5', 'claude-opus-4-8'],
  ];
  for (const [model, advisorModel] of pairs) {
    const ids = requestModelIds({ model, advisorModel });
    const setOk = accountAcceptsAllIds(a, ids);
    const selectOk = am._acceptsModel(a, model) && (!advisorModel || am._acceptsModel(a, advisorModel));
    assert.equal(setOk, selectOk, `set vs selection on ${model}+${advisorModel}`);
    // _isAvailable's advisor branch is exactly the set conjunction for capability.
    if (advisorModel) {
      assert.equal(am._isAvailable(a, model, advisorModel), setOk
        && am._isAvailable(a, model, null)); // quota/route may still exclude
    }
  }
});

test('collisionIdInSet pins the ingress collision gate to routabilityOf.accountNameCollision', () => {
  // Same cross-product discipline as accountAllows/_routeAllows: the server call
  // site must not drift from the oracle's four-condition proof.
  const config = liveConfig();
  const models = [
    'deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3', 'claude-opus-4-8',
    'claude-nonexistent-9', 'primary@example.com', 'sakana-fugu',
  ];
  for (const model of models) {
    const oracle = routabilityOf(config, model);
    const hit = collisionIdInSet(config, [model], { executor: model });
    assert.equal(!!hit, !!oracle.accountNameCollision, `ingress vs oracle on ${model}`);
    if (oracle.accountNameCollision) {
      assert.equal(oracle.routable, false);
      assert.equal(oracle.isAccountName, true);
      assert.equal(hit.id, model);
      assert.equal(hit.role, 'executor');
    }
  }
  // Advisor-only collision must not be reported as executor.
  const ids = requestModelIds({ model: 'claude-opus-4-8', advisorModel: 'deepseek-v4-pro' });
  const adv = collisionIdInSet(config, ids, { executor: 'claude-opus-4-8' });
  assert.equal(adv?.role, 'advisor');
  assert.equal(adv?.id, 'deepseek-v4-pro');
});

test('normalizeRoutes matches AccountManager.setRoutes: unusable globs drop the route, scalars become arrays', () => {
  const routes = [
    { name: 'scalar', match: '*fable*' },
    { name: 'empty', match: [] },
    { name: 'junk', match: [null, 42] },
    { match: ['*'], accounts: [0, 'a'] },
  ];
  const mine = normalizeRoutes(routes);
  const theirs = new AccountManager([{ name: 'a', type: 'oauth' }], 0.98, { routes }).routes;
  assert.deepEqual(mine.map(r => ({ name: r.name, match: r.match, accounts: r.accounts })),
    theirs.map(r => ({ name: r.name, match: r.match, accounts: r.accounts })));
  assert.deepEqual(mine.map(r => r.name), ['scalar', 'route-4']);
  assert.deepEqual(mine.map(r => r.index), [0, 1], 'routes are reindexed after the drop');
});

// ── Claude Code's client-side allowlist (advisory) ────────────

test('the real 17-entry availableModels admits claude-fable-5 but refuses deepseek-v4-pro', () => {
  const ok = clientAllowlistVerdict(AVAILABLE_17, 'claude-fable-5');
  assert.equal(ok.allowed, true);
  assert.equal(ok.matchedEntry, 'claude-fable-5');
  assert.match(ok.reason, /exactly/);

  const no = clientAllowlistVerdict(AVAILABLE_17, 'deepseek-v4-pro');
  assert.equal(no.allowed, false, 'this is the client-side veto that actually fired');
  assert.equal(no.matchedEntry, null);
  assert.match(no.reason, /matches none of the 17 availableModels entries/);
  assert.match(no.reason, /silently fall back to its default/);
  assert.match(no.reason, new RegExp(CLAUDE_CODE_GATE_MODELED_VERSION));
});

test('an undefined allowlist allows everything and an empty array allows only the default', () => {
  for (const list of [undefined, null]) {
    const r = clientAllowlistVerdict(list, 'deepseek-v4-pro');
    assert.equal(r.allowed, true);
    assert.match(r.reason, /no availableModels allowlist is configured/);
  }
  const empty = clientAllowlistVerdict([], 'claude-fable-5');
  assert.equal(empty.allowed, false);
  assert.match(empty.reason, /ONLY its tier-default model/, 'the default bypasses the gate entirely');
});

test('matching is case-insensitive, strips a trailing [1m] on both sides, and honors version prefixes', () => {
  assert.equal(clientAllowlistVerdict(AVAILABLE_17, '  CLAUDE-Fable-5  ').allowed, true);
  assert.equal(clientAllowlistVerdict(AVAILABLE_17, 'claude-fable-5[1m]').allowed, true, 'requested [1m] is stripped');
  assert.equal(clientAllowlistVerdict(['claude-kimi-k3[1m]'], 'claude-kimi-k3').allowed, true, 'entry [1m] is stripped');

  const prefix = clientAllowlistVerdict(AVAILABLE_17, 'claude-sonnet-5-20260101');
  assert.equal(prefix.allowed, true);
  assert.equal(prefix.matchedEntry, 'claude-sonnet-5');

  assert.equal(clientAllowlistVerdict(['opus-4-8'], 'claude-opus-4-8').allowed, true, 'the implicit claude- retry');
  assert.equal(clientAllowlistVerdict(['claude-sonnet-5'], 'claude-sonnet-50').allowed, false,
    'a prefix only counts on a - boundary or at the end');
});

test('a bare family-alias entry admits a whole-token match unless a concrete entry shadows it', () => {
  const alias = clientAllowlistVerdict(['opus'], 'claude-opus-5');
  assert.equal(alias.allowed, true);
  assert.equal(alias.matchedEntry, 'opus');

  assert.equal(clientAllowlistVerdict(['opus', 'claude-opus-4-8'], 'claude-opus-5').allowed, false,
    'claude-opus-4-8 shadows the bare opus entry, so the alias branch never runs');
  assert.equal(clientAllowlistVerdict(['opus'], 'claude-opusplan-x').allowed, false,
    'whole-token: opus must be bounded by a non-alphanumeric character');
});

test('anything that would depend on Claude Code\'s private alias table is reported as uncertain and NOT blocked', () => {
  for (const model of ['opus', 'sonnet', 'haiku', 'fable', 'best', 'opusplan', 'opus[1m]']) {
    const r = clientAllowlistVerdict(AVAILABLE_17, model);
    assert.equal(r.allowed, true, `${model} must not be reported as blocked`);
    assert.match(r.reason, /^uncertain: /, `${model} resolves inside the client, where teamclaude cannot follow`);
  }
  const entrySide = clientAllowlistVerdict(['best'], 'deepseek-v4-pro');
  assert.equal(entrySide.allowed, true, 'an alias ENTRY may resolve to anything, so it cannot support a denial');
  assert.match(entrySide.reason, /^uncertain: /);

  // The asymmetry, stated as a test: a malformed allowlist never blocks.
  assert.equal(clientAllowlistVerdict('claude-fable-5', 'deepseek-v4-pro').allowed, true);
  assert.equal(clientAllowlistVerdict({ availableModels: [] }, 'deepseek-v4-pro').allowed, true);
  assert.equal(clientAllowlistVerdict(AVAILABLE_17, '').allowed, true);
});

test('a pin to a strict closed adapter is unroutable when the model cannot be translated', () => {
  const config = {
    accounts: [{
      name: 'deepseek', type: 'apikey', upstream: 'http://127.0.0.1:8085',
      strictModelMap: true, acceptsModels: ['deepseek-v4-pro'],
      modelMap: { good: 'deepseek-v4-pro' },
    }],
  };
  assert.equal(pinnedRoutabilityOf(config, 'good', 'deepseek').routable, true);
  const bad = pinnedRoutabilityOf(config, 'missing', 'deepseek');
  assert.equal(bad.routable, false);
  assert.match(bad.reason, /non-retryable 400/);
});
