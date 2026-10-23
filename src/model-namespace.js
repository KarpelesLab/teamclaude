// The single owner of the truth "can this model id actually be served, and will
// the client even let it through". Three parties hold a partial copy of that
// truth today — Claude Code's `availableModels` allowlist, teamclaude's
// `routes[]`/`modelMap`/`models[]`, and whatever argv a launcher happens to
// emit — and every disagreement between them degrades silently: Claude Code
// warns in-band and falls back to its default without ever writing to stderr,
// so a launch with an unservable `--model` looks exactly like a good one. This
// module makes that verdict computable up front, in one place, so `run` can
// refuse loudly instead of running six minutes on the wrong model.
//
// Pure and side-effect free so it can be unit-tested: no fs, no network, no
// process.env, no console. The caller does all IO — it loads the config, reads
// Claude Code's settings tiers, and prints. Following src/model.js's leaf
// discipline it imports nothing but ./model.js, so it never pulls in the
// account-manager/server graph (and can therefore be imported from either).
//
// Two invariants this file exists to protect:
//
//   1. The namespace is NOT a finite list. It splits into an ENUMERABLE set
//      (modelMap keys, models[] claims — ids the config actually names) and an
//      UN-ENUMERABLE predicate (route globs; and every account with no custom
//      `upstream` passes arbitrary real Anthropic ids straight through). A
//      hand-written finite allowlist masquerading as the whole truth is exactly
//      the bug that caused this incident, so deriveNamespace() ships BOTH parts
//      plus the caveats, and routabilityOf() is the decidable predicate for any
//      id at all — including ones that appear nowhere in the config.
//
//   2. routabilityOf() must mirror account selection, not paraphrase it. Its
//      predicates are re-derivations of AccountManager._routeForModel /
//      _routeAllows / _accountOwnsModel and the [Nm]-tolerant modelMatches; the
//      accompanying test pins them to the real methods over a cross product of
//      models x accounts so the oracle and the request path cannot drift apart.
//
// Deliberately QUOTA-BLIND: routability is a static property of the config, so
// nothing here consults live quota, throttle holds, or rate-limit state. A
// `disabled` account is still reported (flagged), because "disabled" is an
// operator toggle a human can act on rather than transient health.
//
// clientAllowlistVerdict() models a FOREIGN gate — Claude Code 2.1.220's
// `Pl(model)` reading `settings.availableModels`. That build is not ours and
// will drift, so the verdict is ADVISORY and the implementation is
// deliberately ASYMMETRIC: it is faithful where the semantics are decidable
// from the id alone, and it BIASES TOWARD NOT BLOCKING everywhere else.
// Concretely, every branch of the real matcher that resolves a family alias
// through Claude Code's private tier-default table (which teamclaude cannot
// see) returns allowed=true with an "uncertain" reason rather than a denial.
// The asymmetry is chosen, not sloppy: a false "denied" makes teamclaude refuse
// a launch that would have worked — a self-inflicted outage — while a false
// "allowed" merely leaves the operator where they already are today, with
// Claude Code's own in-band warning. Cost of the two errors is not symmetric,
// so neither is the matcher.

// Deviations from the requested export shape, each justified where it is made:
//   * routabilityOf() returns routable=false in ONE case that bare eligibility
//     would call true — an id that is really a configured ACCOUNT name, is
//     excluded by the winning route, and is translated by no eligible account.
//     All three conditions are provable from the config, and "nothing can serve
//     it" is then literally true (it egresses verbatim and 404s). See the
//     comment at that branch; every other id keeps eligibility semantics.
//   * Its `route` is the normalized route plus an `index`, so a caller can say
//     WHICH route won — first-match means position is the whole story.
//   * `candidates` are ordered by priority (lowest value first, then config
//     order), mirroring _pickBestAvailable's primary key. Its secondary key is
//     the soonest quota reset, which is live state this module refuses to read,
//     so the first candidate is the static best guess and not a promise.
//   * The route/ownership predicates are exported alongside the three required
//     entry points so the test can pin them to AccountManager's own methods
//     (invariant 2) and so a future preflight/doctor reuses rather than recopies.

import { modelGlobMatches } from './model.js';

// The Claude Code build whose model gate clientAllowlistVerdict() reproduces.
// Exported so callers can print it in every verdict: a stale model of someone
// else's matcher should always be self-identifying.
export const CLAUDE_CODE_GATE_MODELED_VERSION = '2.1.220';

// ── config normalization ────────────────────────────────────

/**
 * Normalize the configurable routing table the same way AccountManager.setRoutes
 * does (routes with no usable glob are dropped, `match` is always an array,
 * `accounts` is always an array of strings), and stamp each route's index so
 * callers can report WHICH route won — route order is load-bearing.
 */
export function normalizeRoutes(routes) {
  return (Array.isArray(routes) ? routes : []).map((r, i) => {
    const tiers = (Array.isArray(r?.tiers) ? r.tiers : []).map((t, j) => ({
      name: t?.name || `tier-${j}`,
      accounts: Array.isArray(t?.accounts) ? t.accounts.map(String) : [],
    })).filter(t => t.accounts.length);
    const tierAccounts = [...new Set(tiers.flatMap(t => t.accounts))];
    return {
      index: i,
      name: r?.name || `route-${i + 1}`,
      match: (Array.isArray(r?.match) ? r.match : [r?.match]).filter(g => typeof g === 'string' && g),
      accounts: tiers.length ? tierAccounts : (Array.isArray(r?.accounts) ? r.accounts.map(String) : []),
      tiers,
      bucket: r?.bucket || null,
      color: r?.color || null,
    };
  }).filter(r => r.match.length)
    .map((r, i) => ({ ...r, index: i })); // reindex after the drop, matching this.routes
}

/**
 * Normalize config accounts to the fields routing depends on, stamping the
 * array position as `index` — account membership in a route may be declared by
 * name OR by String(index), so the position is load-bearing too. Records that
 * already carry an `index` (e.g. AccountManager's own) keep it.
 *
 * `type` is inferred from the credential SHAPE only when the config omits it,
 * mirroring makeAccount, so an apikey account is never mislabelled oauth in a
 * caller's table. It is never a credential value — only the discriminator.
 */
export function normalizeAccounts(accounts) {
  return (Array.isArray(accounts) ? accounts : []).map((a, i) => ({
    index: a?.index ?? i,
    name: a?.name ?? `(account ${i})`,
    type: a?.type || (a?.apiKey ? 'apikey' : 'oauth'),
    priority: a?.priority || 0,
    costTier: Number.isFinite(a?.costTier) ? a.costTier : 0,
    disabled: !!a?.disabled,
    upstream: a?.upstream || null,
    modelMap: a?.modelMap || null,
    models: Array.isArray(a?.models) && a.models.length ? a.models : null,
    acceptsModels: Array.isArray(a?.acceptsModels) ? a.acceptsModels.map(String) : null,
    strictModelMap: !!a?.strictModelMap,
  }));
}

// Normalized accounts/routes are pure functions of the config's routing-relevant
// fields. The ingress collision gate calls routabilityOf on every request, so
// cache the normalized view keyed on that identity rather than re-walking the
// tables. A fingerprint (not object identity) is required: reload and the TUI
// mutate accounts/routes/blockedModels in place on the same config object.
let _normalizedViewKey = null;
let _normalizedView = null;

/** Stable fingerprint of the fields routabilityOf / collisionIdInSet read. */
export function configIdentityKey(config) {
  const accounts = Array.isArray(config?.accounts) ? config.accounts : [];
  const routes = Array.isArray(config?.routes) ? config.routes : [];
  const blocked = Array.isArray(config?.blockedModels) ? config.blockedModels : [];
  const aPart = accounts.map(a => [
    a?.name ?? '',
    a?.upstream ? '1' : '0',
    a?.disabled ? '1' : '0',
    String(a?.priority ?? 0),
    a?.modelMap ? Object.keys(a.modelMap).sort().join(',') : '',
    Array.isArray(a?.models) ? a.models.join(',') : '',
    a?.strictModelMap ? '1' : '0',
    Array.isArray(a?.acceptsModels) ? [...a.acceptsModels].map(String).sort().join(',') : '',
  ].join('\x1f')).join('\x1e');
  const rPart = routes.map(r => {
    const match = Array.isArray(r?.match) ? r.match : [r?.match];
    const acct = Array.isArray(r?.accounts) ? r.accounts.map(String) : [];
    const tiers = Array.isArray(r?.tiers)
      ? r.tiers.map(t => `${t?.name ?? ''}:${(Array.isArray(t?.accounts) ? t.accounts : []).map(String).join(',')}`).join(';')
      : '';
    return [r?.name ?? '', match.map(String).join(','), acct.join(','), tiers].join('\x1f');
  }).join('\x1e');
  return `a=${aPart}\nr=${rPart}\nb=${blocked.map(String).join(',')}`;
}

/** Drop the cached normalized view. Called from the config-reload hot-swap and
 * AccountManager.setRoutes; fingerprint mismatch also misses without this. */
export function invalidateNormalizedConfigView() {
  _normalizedViewKey = null;
  _normalizedView = null;
}

/** Normalized {accounts, routes, blocked} for `config`, cached by identity key. */
export function normalizedConfigView(config) {
  const key = configIdentityKey(config);
  if (_normalizedView && _normalizedViewKey === key) return _normalizedView;
  _normalizedView = {
    accounts: normalizeAccounts(config?.accounts),
    routes: normalizeRoutes(config?.routes),
    blocked: Array.isArray(config?.blockedModels) ? [...config.blockedModels] : [],
  };
  _normalizedViewKey = key;
  return _normalizedView;
}

// ── routing predicates (mirror of AccountManager) ───────────

/** The first configured route whose globs match `model`, or null. First match
 * wins — several routes may match and array order decides, which is why a
 * catch-all `*` route has to stay last. */
export function routeForModel(routes, model) {
  if (!model || !routes?.length) return null;
  return routes.find(r => r.match.some(g => modelGlobMatches(g, model))) || null;
}

/** Does a declared `models` entry name `model`? The declared side may carry a
 * trailing [Nm] context-length suffix (e.g. "deepseek-v4-pro[1m]"); it matches a
 * bare request too.
 *
 * A non-string entry answers false rather than throwing. AccountManager's own
 * `_accountOwnsModel` does throw on one (`a.models.some(m => m === model || m.replace(…))`),
 * which turns every request that reaches the ownership fallback into a 502 — but
 * an ORACLE that throws is useless precisely when the config is broken, and the
 * doctor cannot report a defect it crashed on. So this stays total, and
 * config-doctor's `malformed-models-declaration` check reports the real hazard
 * with the outage named. */
export function modelMatches(declared, model) {
  if (typeof declared !== 'string') return false;
  return declared === model || declared.replace(/\[\d+m\]$/, '') === model;
}

/** Returns true if no account claims ownership of `model`, or this one does.
 * The claim is a GLOBAL trigger: one account declaring `models: ["x"]` instantly
 * bars every other account from "x". */
export function accountOwnsModel(accounts, account, model) {
  for (const a of accounts) {
    if (a.models && a.models.some(m => modelMatches(m, model))) {
      return !!(account.models && account.models.some(m => modelMatches(m, model)));
    }
  }
  return true;
}

/** Whether `account` may serve `model`. A matching route with an `accounts`
 * list is exclusive (only listed accounts, by name or index) and completely
 * suppresses the ownership claim; with no matching route — or a route that
 * lists no accounts — it falls back to the per-account `models` claim. */
export function accountAllows(routes, accounts, account, model) {
  const route = routeForModel(routes, model);
  if (route && route.accounts.length) {
    const idx = account.index ?? accounts.indexOf(account);
    return route.accounts.includes(account.name) || route.accounts.includes(String(idx));
  }
  return accountOwnsModel(accounts, account, model);
}

/** Mirror AccountManager._acceptsModel: provider capability is independent of
 * route eligibility. A strict closed adapter must translate every non-native
 * id into its declared accepted set; an open/opaque adapter remains permissive. */
export function accountAcceptsModel(account, model) {
  if (!account || !model) return true;
  const accepted = account.acceptsModels;
  if (!accepted?.length && !account.strictModelMap) return true;
  const mapped = account.modelMap && Object.prototype.hasOwnProperty.call(account.modelMap, model)
    ? account.modelMap[model] : null;
  if (mapped != null) return !accepted?.length || accepted.includes(String(mapped));
  if (account.strictModelMap) return false;
  return !accepted?.length || accepted.includes(String(model));
}

// ── request identifier set ───────────────────────────────────
//
// Every judgment about a request MUST consume the full id set. Today that set
// is {executor model, advisorModel}; a future id source (e.g. fallbacks[].model)
// means adding an extractor and joining HERE — never a fourth ad-hoc gate in
// server.js. Selection (_isAvailable advisor branch) already quantifies over
// the set; the request-path gates (blockedModels, /tc-acct capability,
// rewriteModel) must use the same predicates so they cannot drift.

/** The ordered, de-duplicated model ids a request carries. Empty strings and
 * nulls are dropped; advisor duplicates the executor when they coincide. */
export function requestModelIds({ model = null, advisorModel = null } = {}) {
  const ids = [];
  if (typeof model === 'string' && model) ids.push(model);
  if (typeof advisorModel === 'string' && advisorModel && !ids.includes(advisorModel)) {
    ids.push(advisorModel);
  }
  return ids;
}

/** First blockedModels hit across the id set, or null. Ids are walked in
 * caller order (requestModelIds puts the executor first), so a dual hit
 * reports the executor — which still 400s. An advisor-only hit is what
 * strip-and-degrade consumes. `executor` names which id is the executor so
 * the role field is unambiguous when the set is built differently. */
export function blockedIdInSet(blockedModels, ids, { executor = null } = {}) {
  if (!Array.isArray(blockedModels) || !Array.isArray(ids)) return null;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const pattern = blockedBy(blockedModels, id);
    if (!pattern) continue;
    const role = (executor != null ? id === executor : i === 0) ? 'executor' : 'advisor';
    return { id, pattern, role };
  }
  return null;
}

/** True iff every id in the set is accepted by the account (empty set → true). */
export function accountAcceptsAllIds(account, ids) {
  if (!Array.isArray(ids) || !ids.length) return true;
  return ids.every(id => accountAcceptsModel(account, id));
}

/** First provable account-name collision across the id set, or null. Walks ids
 * in caller order (executor first via requestModelIds) so a dual hit reports
 * the executor — which still 400s. An advisor-only hit is what strip-and-degrade
 * consumes. Reuses routabilityOf.accountNameCollision; never re-derives the
 * four-condition proof. */
export function collisionIdInSet(config, ids, { executor = null } = {}) {
  if (!Array.isArray(ids)) return null;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (typeof id !== 'string' || !id) continue;
    const verdict = routabilityOf(config, id);
    if (!verdict.accountNameCollision) continue;
    const role = (executor != null ? id === executor : i === 0) ? 'executor' : 'advisor';
    return { id, role, accountName: id };
  }
  return null;
}

/** Every `blockedModels` glob that rejects `model`, in config order. The proxy
 * only ever names the first (server.js uses `.find`), but a caller explaining a
 * config wants the whole set — a second pattern matching the same id is a fact
 * about the config the operator should see. */
export function blockedByAll(blockedModels, model) {
  if (!Array.isArray(blockedModels) || typeof model !== 'string') return [];
  return blockedModels.filter(p => modelGlobMatches(p, model));
}

/** The first `blockedModels` glob that rejects `model`, or null — the one the
 * proxy itself names. Matched with the same modelGlobMatches used before
 * forwarding. */
export function blockedBy(blockedModels, model) {
  return blockedByAll(blockedModels, model)[0] ?? null;
}

// ── namespace derivation ────────────────────────────────────

/**
 * The model namespace this config describes, in its two irreducible halves.
 *
 *   concrete — ids the config actually names: every account's modelMap KEYS
 *              (byte-exact, because rewriteModel does a case-sensitive key
 *              lookup) plus every account's models[] entries and their
 *              [Nm]-stripped forms, minus anything blockedModels rejects.
 *              Sorted, de-duplicated, case-preserving.
 *   patterns — the route globs and any models[] entry containing `*`. These
 *              denote infinite sets and CANNOT be enumerated; use
 *              routabilityOf() as the decidable predicate instead.
 *   notes    — the caveats, computed against this config rather than recited
 *              from documentation, so they travel with the output.
 *
 * Membership in `concrete` means "nameable", NOT "servable": an id can be a
 * modelMap key on an account that the first matching route excludes, in which
 * case it is dead on arrival. That case is detected here and named in `notes`.
 */
export function deriveNamespace(config) {
  const accounts = normalizeAccounts(config?.accounts);
  const routes = normalizeRoutes(config?.routes);
  const blocked = Array.isArray(config?.blockedModels) ? config.blockedModels : [];

  const concreteSet = [];
  const patternSet = [];
  const push = (arr, v) => { if (typeof v === 'string' && v && !arr.includes(v)) arr.push(v); };

  for (const r of routes) for (const g of r.match) push(patternSet, g);

  for (const a of accounts) {
    if (a.modelMap) for (const k of Object.keys(a.modelMap)) push(concreteSet, k);
    if (Array.isArray(a.models)) {
      for (const m of a.models) {
        if (typeof m !== 'string' || !m) continue;
        if (m.includes('*')) { push(patternSet, m); continue; }
        push(concreteSet, m);
        const bare = m.replace(/\[\d+m\]$/, '');
        if (bare !== m) push(concreteSet, bare);
      }
    }
  }

  const removed = concreteSet.filter(id => blockedBy(blocked, id));
  const concrete = concreteSet
    .filter(id => !blockedBy(blocked, id))
    .sort((a, b) => {
      const la = a.toLowerCase(), lb = b.toLowerCase();
      if (la !== lb) return la < lb ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });

  const notes = [];
  const passthrough = accounts.filter(a => !a.upstream && !a.disabled).map(a => a.name);
  if (passthrough.length) {
    notes.push(
      `Not exhaustive: ${passthrough.length} account(s) (${passthrough.join(', ')}) have no custom upstream, so any real `
      + 'Anthropic model id is servable through them and appears nowhere in this config. Read the list as '
      + '"ids this proxy knows by name", never as "all available models".');
  }
  const custom = accounts.filter(a => a.upstream).map(a => a.name);
  if (custom.length) {
    notes.push(
      `Opaque backends: ${custom.length} account(s) (${custom.join(', ')}) forward to a custom upstream that holds its `
      + 'own model map; a listed id can still 4xx there. teamclaude cannot see past `upstream`.');
  }
  if (patternSet.length) {
    notes.push(
      `${patternSet.length} glob pattern(s) match model ids that cannot be enumerated. Check any specific id with `
      + '`teamclaude explain <model>` — that predicate is total and decidable, this list is not.');
  }

  const dead = concrete.filter(id => !routabilityOf(config, id).routable);
  if (dead.length) {
    notes.push(
      `${dead.length} named id(s) cannot actually be served by any account and are dead on arrival: `
      + `${dead.join(', ')}. A modelMap key only rewrites the body AFTER an account is selected — it never makes that `
      + 'account eligible — so an id whose only home is excluded by the first matching route is unreachable.');
  }
  if (removed.length) {
    notes.push(`blockedModels removes ${removed.length} named id(s) from the namespace: ${removed.join(', ')}.`);
  }

  // Per-account translations that can never fire: the account declares a
  // modelMap key, but the first route matching that key selects other accounts.
  // Id-level reachability hides these whenever a sibling account maps the same
  // key, which is precisely why they survive unnoticed in real configs.
  const deadTranslations = [];
  for (const a of accounts) {
    if (!a.modelMap) continue;
    for (const id of Object.keys(a.modelMap)) {
      if (blockedBy(blocked, id)) continue;
      if (accountAllows(routes, accounts, a, id)) continue;
      deadTranslations.push({ account: a.name, id, route: routeForModel(routes, id)?.name ?? null });
    }
  }
  if (deadTranslations.length) {
    notes.push(
      `${deadTranslations.length} modelMap translation(s) can never fire, because the first route matching the key `
      + 'selects other accounts: '
      + `${deadTranslations.map(d => `${d.account}:${d.id}${d.route ? ` (route "${d.route}")` : ''}`).join(', ')}.`);
  }

  const catchAllAt = routes.findIndex(r => r.match.some(g => g === '*'));
  if (catchAllAt >= 0 && catchAllAt < routes.length - 1) {
    notes.push(
      `Route "${routes[catchAllAt].name}" (#${catchAllAt + 1} of ${routes.length}) matches everything but is not last, `
      + 'so every route after it is dead: first matching route wins.');
  }
  // NOT gated on some account already declaring models[]. The defect is a
  // property of the ROUTE table, and it is worth knowing BEFORE the edit that
  // trips over it: the README documents models[] as the way to give an account
  // its own model ids, and following that advice on a config shaped like this
  // does nothing at all. Waiting for a claim to exist means the operator only
  // learns after they have edited, restarted, and watched it not work.
  if (catchAllAt >= 0 && routes[catchAllAt].accounts.length) {
    const claimers = accounts.filter(a => a.models).map(a => a.name);
    notes.push(
      `Route "${routes[catchAllAt].name}" matches everything AND lists accounts, which makes the per-account models[] `
      + 'ownership claim unreachable for every model id — a matching route with an account list suppresses it. '
      + (claimers.length
        ? `${claimers.length} account(s) declare models[] (${claimers.join(', ')}) and none of those declarations can `
          + 'decide anything. '
        : 'No account declares models[] today, so nothing is broken yet — but adding one would be inert. ')
      + 'Insert a more specific route BEFORE the catch-all instead of relying on models[].');
  }
  notes.push(
    'Routable here is not the same as accepted by the client: Claude Code applies its own availableModels allowlist '
    + 'before a request is ever sent, and at launch it falls back to its default silently. Cross-check with '
    + '`teamclaude doctor`.');

  return { concrete, patterns: patternSet, notes };
}

// ── per-model routability ───────────────────────────────────

/**
 * Can this config serve `model`, and who would serve it? Mirrors account
 * eligibility exactly — blockedModels subtracts first, then the FIRST matching
 * route wins, and a matching route with a non-empty account list is exclusive;
 * with no matching route (or one that lists no accounts) the per-account
 * models[] ownership claim decides.
 *
 * Quota-blind: `disabled` accounts are listed with disabled=true but do not
 * count toward routable, since an operator can flip that back. Candidates are
 * ordered by priority (lowest value first, then config order), mirroring the
 * ranking selection uses; live quota can still pick a different one.
 */
export function routabilityOf(config, model) {
  const view = normalizedConfigView(config);
  const accounts = view.accounts;
  const routes = view.routes;
  const blocked = view.blocked;
  const empty = {
    routable: false, route: null, candidates: [], blockedBy: null,
    isAccountName: false, accountNameCollision: false,
  };

  if (typeof model !== 'string' || !model) {
    return { ...empty, reason: 'no model id given' };
  }

  const block = blockedBy(blocked, model);
  if (block) {
    return {
      ...empty,
      blockedBy: block,
      reason: `blocked by the blockedModels pattern "${block}" — the proxy rejects this id with a 400 before any `
        + 'account is tried. Remove that pattern or request a different model.',
    };
  }

  if (!accounts.length) return { ...empty, reason: 'no accounts are configured' };

  const route = routeForModel(routes, model);
  const exclusive = !!(route && route.accounts.length);
  const glob = route ? (route.match.find(g => modelGlobMatches(g, model)) ?? route.match[0]) : null;

  const candidates = accounts
    .filter(a => accountAllows(routes, accounts, a, model) && accountAcceptsModel(a, model))
    .map(a => ({
      name: a.name,
      priority: a.priority,
      costTier: a.costTier,
      disabled: a.disabled,
      via: exclusive ? 'route' : 'ownership',
      mappedTo: a.modelMap && Object.prototype.hasOwnProperty.call(a.modelMap, model) ? a.modelMap[model] : null,
    }))
    .sort((x, y) => x.priority - y.priority);

  const live = candidates.filter(c => !c.disabled);
  const where = route ? `route "${route.name}" (glob "${glob}")` : 'no route';
  const first = live[0] || candidates[0] || null;
  const firstAccount = first ? accounts.find(a => a.name === first.name) : null;

  // Account-name collision. An id that is really an ACCOUNT name looks routable
  // — a catch-all route matches it and some passthrough account is eligible —
  // but nothing can serve it: the account that bears the name is excluded by the
  // winning route, no eligible account translates it, and the account that WOULD
  // take the request talks to the real Anthropic API, so the id egresses
  // verbatim and 404s. This is the one case where the verdict deviates from bare
  // eligibility, and it does so only when all four conditions are provable from
  // the config. Everything else keeps eligibility semantics, because teamclaude
  // genuinely cannot tell an unknown-but-real Anthropic id from a made-up one.
  //
  // The fourth condition (`!firstAccount.upstream`) is load-bearing and was
  // missing: with a custom upstream the "404 at the Anthropic API" claim is not
  // just unproven, it is contradicted by the config — the id goes to a
  // third-party backend holding its OWN model map (the documented
  // anthropic-proxy fallback-tier pattern), which teamclaude cannot see past.
  // Blocking on a proof is what earns this branch the right to block; without
  // the proof it must degrade to a warning, which is what the caller does with
  // `collisionSuspect`.
  const collision = accounts.find(a => a.name === model) || null;
  const collisionSuspect = !!collision && !candidates.some(c => c.name === collision.name)
    && !live.some(c => c.mappedTo);
  const collided = collisionSuspect && !firstAccount?.upstream;
  const routable = live.length > 0 && !collided;

  // Same shape as `collided` but unprovable: say what is actually known.
  const opaqueCollisionNote = collisionSuspect && routable && first
    ? ` Note: "${model}" is also the NAME of a configured account. This request would NOT reach that account — `
      + `${where} picks "${first.name}" instead — and since that account forwards to ${firstAccount.upstream}, whose `
      + 'own model map teamclaude cannot see, whether the id resolves there is unknowable from this config. If you '
      + `meant the account, pin it: teamclaude run --account ${collision.name} -- --model <a model id it serves>.`
    : '';

  // The un-enumerable half, per model: an account with no custom upstream and no
  // modelMap entry for this id forwards it to the real Anthropic API untouched.
  // That is how a genuine new Anthropic id works without appearing in the config
  // — and equally how a typo reaches upstream and 404s. Say both.
  const passthroughNote = routable && first && !first.mappedTo && !firstAccount?.upstream
    ? ` Account "${first.name}" has no custom upstream and no modelMap entry for this id, so it will forward the id `
      + 'verbatim to the Anthropic API — which serves any real Anthropic model id, and 404s anything else.'
    : '';

  // The F7(b) defect: an account declares this id in models[] but a matching
  // route with an account list suppresses the claim, so the declaration is inert.
  const claimants = accounts.filter(a => a.models && a.models.some(m => modelMatches(m, model)));
  const suppressed = exclusive
    ? claimants.filter(a => !candidates.some(c => c.name === a.name)).map(a => a.name)
    : [];
  const suppressedNote = suppressed.length
    ? ` Note: account(s) ${suppressed.join(', ')} declare this id in models[], but a matching route with an account `
      + 'list suppresses the ownership claim entirely — the declaration is inert. Insert a more specific route BEFORE '
      + `"${route.name}" to reach them.`
    : '';

  let reason;
  if (collided) {
    reason = `"${model}" is the name of a configured ACCOUNT, not a model id this config can serve. ${where} matched `
      + `first and does not list account "${collision.name}", and no eligible account translates "${model}" via `
      + 'modelMap, so the id would be forwarded verbatim to the Anthropic API and 404. Ask for a model id the account '
      + `serves and pin the account instead (teamclaude run --account ${collision.name}), or add a route matching `
      + `"${model}" BEFORE "${route ? route.name : '(none)'}".${suppressedNote}`;
  } else if (!candidates.length) {
    reason = exclusive
      ? `${where} matched first and pins this id to account(s) ${route.accounts.join(', ')}, but no configured account `
        + 'has that name or index — nothing can serve it. Fix the route\'s account list, or insert a more specific '
        + `route BEFORE "${route.name}".`
      : `${where} matches this id and another account claims it via models[], so no other account may serve it; `
        + `claimant(s) ${claimants.map(a => a.name).join(', ') || '(none)'} are not usable here.`;
  } else if (!routable) {
    reason = `${where}: the only account(s) that may serve this id (${candidates.map(c => c.name).join(', ')}) are all `
      + `disabled. Re-enable one with: teamclaude enable <name>.${suppressedNote}`;
  } else if (exclusive) {
    reason = `${where} matched first and pins this id to ${live.length} account(s); first choice "${first.name}"`
      + `${first.mappedTo ? ` (rewritten upstream to "${first.mappedTo}")` : ''}.${passthroughNote}${opaqueCollisionNote}${suppressedNote}`;
  } else if (claimants.length) {
    reason = `${where} matches this id, so the per-account models[] ownership claim decides: `
      + `${claimants.map(a => a.name).join(', ')} own it; first choice "${first.name}"`
      + `${first.mappedTo ? ` (rewritten upstream to "${first.mappedTo}")` : ''}.${passthroughNote}${opaqueCollisionNote}`;
  } else {
    reason = `${where} matches this id and no account claims it via models[], so any account may serve it; `
      + `first choice "${first.name}"`
      + `${first.mappedTo ? ` (rewritten upstream to "${first.mappedTo}")` : ''}.${passthroughNote}${opaqueCollisionNote}`;
  }

  return {
    routable, reason, route, candidates, blockedBy: null,
    isAccountName: !!collision, accountNameCollision: collided,
  };
}

// ── pinned routability (/tc-acct) ───────────────────────────

/**
 * Resolve a `/tc-acct/<token>` pin against normalized accounts: exact name
 * first, then numeric index — the same order as resolveAccountPin
 * (server.js:148-156) and resolveRunAccountPin in the CLI. Exported so `explain`,
 * the preflight and the doctor cannot each invent their own resolution order.
 */
export function resolveAccountToken(accounts, token) {
  if (token == null || token === '') return null;
  const t = String(token);
  const byName = accounts.find(a => a.name === t);
  if (byName) return byName;
  if (/^\d+$/.test(t)) {
    const i = Number(t);
    if (i >= 0 && i < accounts.length) return accounts[i];
  }
  return null;
}

/**
 * Routability of `model` for a request PINNED to one account via /tc-acct — a
 * strictly different question from routabilityOf(), and the reason this function
 * exists rather than a flag on that one.
 *
 * A pinned request skips account selection: forwardRequest indexes
 * `accountManager.accounts[ctx.pinnedIndex]` directly and never calls
 * getActiveAccount, so _routeAllows and _accountOwnsModel are not consulted.
 * `disabled` IS consulted — a pin names the account, it does not override an
 * operator hard-stop; the proxy answers 403 locally and never egresses.
 *
 * What survives a pin, and is therefore all this can block on:
 *   * an unresolved pin — the proxy answers 404 locally, so EVERY request of
 *     that session fails;
 *   * a disabled pin — the proxy answers 403 locally, so nothing reaches
 *     upstream (including quota/429 waits);
 *   * blockedModels — the blocklist gate runs after the pin prefix is stripped,
 *     so it still rejects with a 400.
 * Everything else is reported as a warning, because the pinned account's own
 * upstream is the only thing that can answer "does this id work", and teamclaude
 * cannot see past it.
 */
export function pinnedRoutabilityOf(config, model, pinToken) {
  const accounts = normalizeAccounts(config?.accounts);
  const routes = normalizeRoutes(config?.routes);
  const blocked = Array.isArray(config?.blockedModels) ? config.blockedModels : [];
  const account = resolveAccountToken(accounts, pinToken);
  const base = { pinned: true, routable: false, account: null, blockedBy: null, outsideRouting: false, mappedTo: null };

  if (!account) {
    return {
      ...base,
      reason: `the pin "${pinToken}" matches no account name or index, so the proxy answers 404 "Unknown account pin" `
        + 'locally and every request of this session fails before an upstream is contacted.',
    };
  }

  const view = {
    name: account.name, index: account.index, type: account.type,
    disabled: account.disabled, upstream: account.upstream,
  };
  const block = typeof model === 'string' && model ? blockedBy(blocked, model) : null;
  if (account.disabled) {
    return {
      ...base,
      account: view,
      reason: `pinned account "${account.name}" is disabled, so the proxy answers 403 locally and never contacts `
        + `upstream. Re-enable with: teamclaude enable ${account.name}`,
    };
  }

  if (block) {
    return {
      ...base,
      account: view,
      blockedBy: block,
      reason: `blocked by the blockedModels pattern "${block}" — the blocklist gate runs after the /tc-acct prefix is `
        + 'stripped, so a pin does not bypass it; the proxy rejects this id with a 400.',
    };
  }

  const mappedTo = account.modelMap && typeof model === 'string'
    && Object.prototype.hasOwnProperty.call(account.modelMap, model)
    ? account.modelMap[model]
    : null;
  if (model && !accountAcceptsModel(account, model)) {
    return {
      ...base, account: view, mappedTo,
      reason: `pinned account "${account.name}" is a closed adapter and cannot translate model "${model}" into its acceptsModels set. `
        + 'The pin bypasses route selection, but it cannot make an unsupported provider model valid; forwarding would produce a known non-retryable 400.',
    };
  }
  const outsideRouting = !!model && !accountAllows(routes, accounts, account, model);
  const dest = account.upstream || 'the Anthropic API';

  const reason = `pinned to account "${account.name}" (#${account.index}) via /tc-acct, which bypasses selection: the `
    + 'route table and the per-account models[] claim are skipped (`disabled` is not — a disabled pin 403s locally). '
    + `${mappedTo ? `Its modelMap rewrites the id to "${mappedTo}" before the body leaves` : 'It has no modelMap entry for this id, so the id is forwarded verbatim'}`
    + ` to ${dest}${account.upstream ? ', whose own model map teamclaude cannot see' : ''}.`;

  return { ...base, routable: true, account: view, mappedTo, outsideRouting, reason };
}

// ── Claude Code's client-side allowlist (advisory) ──────────

// Bare family aliases Claude Code matches as whole tokens inside a concrete id
// ("opus" admits "claude-opus-5"). From Rjr in the 2.1.220 bundle.
const BARE_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'];
// Every alias token, bare or not. These resolve through Claude Code's private
// tier-default table, which teamclaude cannot see — so any verdict that would
// depend on one is reported as uncertain (and therefore allowed).
const ALL_ALIASES = [...BARE_ALIASES, 'best', 'opusplan'];

// Qs(): strips a trailing [1m] context tag, case-insensitively. Only [1m], and
// only at the end — matching the bundle rather than generalizing it.
function stripContextTag(s) {
  return s.replace(/\[1m\]$/i, '');
}

function normalizeEntry(s) {
  return stripContextTag(String(s).trim().toLowerCase());
}

// $ji(): is `needle` present in `hay` as a whole token — bounded on both sides
// by a non-alphanumeric character or by the string edge?
function wholeTokenIncludes(hay, needle) {
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const beforeOk = i === 0 || !/[a-z0-9]/i.test(hay[i - 1]);
    const end = i + needle.length;
    const afterOk = end === hay.length || !/[a-z0-9]/i.test(hay[end]);
    if (beforeOk && afterOk) return true;
  }
  return false;
}

// eRc(): entry is a version prefix of model on a '-' boundary (or equal).
function prefixOnBoundary(model, entry) {
  if (!model.startsWith(entry)) return false;
  return model.length === entry.length || model[entry.length] === '-';
}

// tRc(): a bare alias entry is shadowed when some non-alias entry contains it
// on a '-'/end boundary — e.g. "claude-sonnet-5" shadows a bare "sonnet".
function isShadowed(alias, entries) {
  for (const e of entries) {
    if (BARE_ALIASES.includes(e)) continue;
    const at = e.indexOf(alias);
    if (at === -1) continue;
    const end = at + alias.length;
    if (end === e.length || e[end] === '-') return true;
  }
  return false;
}

/**
 * Would Claude Code's own model gate let `model` through, given the effective
 * `availableModels` array? ADVISORY — this reproduces build
 * CLAUDE_CODE_GATE_MODELED_VERSION's matcher and that build will drift.
 *
 * Faithful where the decision is decidable from the id alone (exact match after
 * trim/lowercase/[1m]-strip; unshadowed bare-family-alias entries matched as
 * whole tokens; version-prefix entries on a '-' boundary, with the implicit
 * "claude-" retry). Everywhere the real matcher would consult Claude Code's
 * private alias table, this returns allowed=true with an "uncertain:" reason:
 * refusing a launch that would have worked is a far worse failure than passing
 * one the client will merely warn about in-band.
 *
 * Not modeled at all, and they do NOT all bias the same way — the honest
 * accounting, since a comment that waves at "the bias is intact" is how the
 * bias stops being checked:
 *   * settings `modelOverrides` reverse mapping — ADDITIVE. Ignoring it shrinks
 *     the effective allowlist and makes a FALSE DENIAL more likely. This is the
 *     dangerous direction, and it is the reason the verdict is advisory.
 *   * the server-supplied entitlement DENY set, and the fail-closed
 *     managed-policy preamble — SUBTRACTIVE. Ignoring them makes a false ALLOW
 *     more likely, which is the cheap direction.
 * The `--settings` tier is the one additive source that IS recovered: the
 * preflight reads it out of the argv it is judging and unions it in before
 * calling this function.
 */
export function clientAllowlistVerdict(availableModels, model) {
  const v = (allowed, reason, matchedEntry = null) => ({ allowed, reason, matchedEntry });
  const tag = `(modeled on Claude Code ${CLAUDE_CODE_GATE_MODELED_VERSION}; advisory)`;

  if (availableModels === undefined || availableModels === null) {
    return v(true, `no availableModels allowlist is configured, so Claude Code allows any model ${tag}`);
  }
  if (!Array.isArray(availableModels)) {
    return v(true, `availableModels is not an array; the gate cannot be modeled, so this is not treated as a block ${tag}`);
  }
  if (typeof model !== 'string' || !model.trim()) {
    return v(true, `no model id given; nothing to check against the client allowlist ${tag}`);
  }
  if (availableModels.length === 0) {
    return v(false,
      `availableModels is an empty array: Claude Code allows ONLY its tier-default model (the default bypasses the `
      + `gate entirely), so "${model}" would be refused ${tag}`);
  }

  const entries = availableModels.map(normalizeEntry);
  const req = normalizeEntry(model);
  const original = e => availableModels[entries.indexOf(e)] ?? e;

  // 1. Literal membership — but NOT for a bare family alias, which the real
  //    matcher excludes here (`!lj(i)`) precisely because it has to resolve.
  if (entries.includes(req) && !BARE_ALIASES.includes(req)) {
    return v(true, `"${model}" matches the availableModels entry "${original(req)}" exactly ${tag}`, original(req));
  }

  // 2. Unshadowed bare-family-alias entries admit a concrete id containing them
  //    as a whole token: "opus" admits "claude-opus-5".
  for (const e of entries) {
    if (!BARE_ALIASES.includes(e) || isShadowed(e, entries)) continue;
    if (wholeTokenIncludes(req, e)) {
      return v(true, `"${model}" is admitted by the family-alias entry "${original(e)}" ${tag}`, original(e));
    }
  }

  // 3. Version-prefix entries: "claude-opus-4" admits "claude-opus-4-8"; a
  //    non-"claude-" entry is retried with the prefix attached.
  for (const e of entries) {
    if (ALL_ALIASES.includes(e)) continue;
    if (prefixOnBoundary(req, e) || (!e.startsWith('claude-') && prefixOnBoundary(req, `claude-${e}`))) {
      return v(true, `"${model}" is admitted by the version-prefix entry "${original(e)}" ${tag}`, original(e));
    }
  }

  // 4. Uncertainty, in both directions: an alias on either side resolves
  //    through Claude Code's private tier-default table. Do not guess — allow.
  if (ALL_ALIASES.includes(req)) {
    return v(true,
      `uncertain: "${model}" is a Claude Code alias whose concrete id resolves inside the client, where teamclaude `
      + `cannot follow. Not treated as a block ${tag}`);
  }
  const aliasEntry = entries.find(e => ALL_ALIASES.includes(e) && !BARE_ALIASES.includes(e));
  if (aliasEntry) {
    return v(true,
      `uncertain: the availableModels entry "${original(aliasEntry)}" is a Claude Code alias that resolves inside the `
      + `client, and may resolve to "${model}". Not treated as a block ${tag}`);
  }

  return v(false,
    `"${model}" matches none of the ${availableModels.length} availableModels entries — no exact match, no family `
    + `alias, no version prefix — so Claude Code would refuse it client-side and silently fall back to its default. `
    + `Add "${model}" to availableModels (or launch with --settings) if it should be allowed ${tag}`);
}
