// Explain how one model id routes: the decision trace a request for that id
// would follow through the proxy, in the order the proxy actually evaluates it.
//
// The routing rules are spread across three places that never mention each
// other — the blocklist gate in server.js, the route/ownership predicates
// buried inside account *eligibility* in account-manager.js, and the
// post-selection modelMap rewrite in server.js — so "which account and which
// model id will actually serve this request" is currently answerable only by
// reading all three. That is how a config can silently route a model to an
// account that cannot serve it: nothing ever prints the decision. This module
// prints it.
//
// Pure and side-effect free (no fs, no fetch, no console, no clock) so it can
// be unit-tested and so `explainRouting` is trivially JSON-serializable for a
// `--json` flag; `formatExplain` owns all presentation. It takes a plain config
// object — the same shape `loadConfig()` returns — and never constructs an
// AccountManager, so it cannot mutate live routing state.
//
// This module NARRATES a decision it does not make. Every predicate that decides
// anything — route normalization, first-match, [Nm]-tolerant claim matching,
// ownership, exclusivity, the blocklist — is imported from ./model-namespace.js,
// which owns the single copy and pins it to AccountManager's own methods with a
// cross-product divergence test. An explanation that could disagree with the
// router would be worse than none, so the two cannot be separately edited: what
// is local here is presentation and the reason STRINGS, never a verdict.
//
// The trace is deliberately QUOTA-BLIND: it answers "what does this config
// mean", not "what is healthy right now". Every runtime-only factor (quota
// utilization, throttle holds, error status, ephemeral route pins, session
// affinity) is reported as an explicit unknown in `notes` rather than guessed.
//
// Mirrored source (kept in sync by the tests, which assert the same invariants
// the router's own tests assert):
//   blocklist gate            server.js:295-303
//   route match, first wins   account-manager.js _routeForModel  :591-595
//   route normalization       account-manager.js setRoutes       :574-589
//   exclusivity + ownership   account-manager.js _routeAllows    :604-614
//                             account-manager.js _accountOwnsModel :617-625
//   candidate ranking         account-manager.js _pickBestAvailable :883-910
//   upstream + modelMap       server.js:633, :646, rewriteModel  :1025-1034
//   failover / no-failover    server.js:542-552, :606, :704-737, :794-807, :864

import { modelGlobMatches, weeklyBucketForModel } from './model.js';
import { redactUrlUserinfo } from './claude-env.js';
import {
  normalizeRoutes,
  normalizeAccounts,
  modelMatches,
  routeForModel,
  accountAllows,
  accountAcceptsModel,
  blockedByAll,
  routabilityOf,
  pinnedRoutabilityOf,
} from './model-namespace.js';

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

// ── the predicates, in evaluation order ───────────────────────

// server.js:295 — the blocklist is checked before anything else and short
// circuits the whole request with a local 400. The proxy uses `.find()`, so the
// FIRST matching pattern is the one it names; blockedByAll returns the rest so
// the display can say "also matches …" without a second matcher.
function checkBlocked(config, model) {
  const matching = model ? blockedByAll(config?.blockedModels, model) : [];
  return { blocked: matching.length > 0, pattern: matching[0] || null, patterns: matching };
}

// account-manager.js:591-595 — `routes.find(...)`: the first route in array
// order whose globs match wins, and every later matching route is dead for this
// id. Route order is load-bearing, which is why the losers are reported too.
//
// This is the router's `.find` continued past the first hit, purely to name the
// shadowed routes and the glob that matched. It does NOT decide the winner — the
// caller takes that from routeForModel — so the two can never disagree about
// which route fires. modelGlobMatches is the same leaf primitive both modules'
// predicates are built on, so using it here shares rather than duplicates.
function matchRoutes(routes, model) {
  if (!model) return [];
  const hits = [];
  for (const r of routes) {
    const glob = r.match.find(g => modelGlobMatches(g, model));
    if (glob) hits.push({ name: r.name, index: r.index, glob, route: r });
  }
  return hits;
}

// account-manager.js:617-625 — ownership is a GLOBAL trigger: the moment any
// account claims a model in its `models` list, every account that does not claim
// it becomes ineligible for that id.
function ownershipOwners(accounts, model) {
  if (!model) return [];
  return accounts.filter(a => a.models && a.models.some(m => modelMatches(m, model)));
}

// account-manager.js:604-614 — a matching route WITH a non-empty accounts list
// is exclusive and suppresses the ownership fallback entirely; otherwise the
// per-account `models` claim decides.
//
// The VERDICT is not computed here: `accountAllows` (model-namespace.js) decides,
// and this function only picks the sentence that explains it. `disabled` is
// checked first because it is an operator toggle rather than a routing rule, and
// accountAllows is deliberately blind to it.
function eligibilityFor(account, { model, routes, accounts, winner, owners }) {
  if (account.disabled) {
    return { eligible: false, reason: 'disabled', detail: 'disabled by the operator (teamclaude enable to restore)' };
  }
  if (!model) return { eligible: true, reason: 'no model id — route/ownership rules are not consulted' };
  const routeEligible = accountAllows(routes, accounts, account, model);
  const capable = accountAcceptsModel(account, model);
  const eligible = routeEligible && capable;
  if (routeEligible && !capable) {
    return { eligible: false, reason: 'provider-capability', detail: 'route allows it, but the closed adapter cannot translate this model id' };
  }
  if (winner && winner.route.accounts.length) {
    return eligible
      ? { eligible: true, reason: `listed in route "${winner.name}"` }
      : { eligible: false, reason: 'not-in-route', detail: `not listed in route "${winner.name}" (exclusive)` };
  }
  if (!owners.length) {
    return { eligible, reason: winner ? `route "${winner.name}" lists no accounts — all accounts allowed` : 'no route and no ownership claim — all accounts allowed' };
  }
  return eligible
    ? { eligible: true, reason: 'declares this model in its models[] claim' }
    : { eligible: false, reason: 'not-an-owner', detail: `models[] is claimed by ${owners.map(o => `"${o.name}"`).join(', ')}` };
}

// ── candidate ordering ────────────────────────────────────────

// Mirrors _pickBestAvailable (account-manager.js:883-910) run repeatedly with a
// growing `tried` set — which is exactly what failover does (server.js adds the
// failed account to ctx.tried and re-enters forwardRequest). The real ranking is
// (1) lowest priority value, then (2) soonest governing weekly reset, unknown
// first. From config alone every reset is unknown, so (2) collapses to a tie and
// the loop's strict `<` leaves the first account in array order ahead — the
// order reproduced here. `notes` says so out loud.
function orderCandidates(accounts, eligible, config = {}) {
  const allowed = accounts.filter(a => eligible.has(a.index));
  const mode = config?.routingPolicy?.mode || 'priority-first';
  if (mode === 'dynamic' || mode === 'shadow') {
    // Config alone has no live reset/utilization/health state. Show the hard
    // economic tiers, then priority only as the deterministic UNKNOWN-state
    // fallback; the trace notes explicitly point to /teamclaude/status for the
    // actual live order. Pretending this is the dynamic rank would recreate the
    // exact static-priority lie this feature removes.
    return [...allowed].sort((a, b) => a.costTier - b.costTier || a.priority - b.priority || a.index - b.index);
  }
  const order = [];
  const tried = new Set();
  while (order.length < accounts.length) {
    let best = null;
    let bestPriority = Infinity;
    for (const a of accounts) {
      if (tried.has(a.index) || !eligible.has(a.index)) continue;
      if (a.priority < bestPriority) { bestPriority = a.priority; best = a; }
    }
    if (!best) break;
    tried.add(best.index);
    order.push(best);
  }
  return order;
}

// ── upstream view ─────────────────────────────────────────────

// server.js:1025-1034 — rewriteModel does an EXACT, case-sensitive key lookup
// with a truthy guard (`modelMap[obj.model]`), so no glob, no [Nm] stripping,
// and an empty-string mapping is a no-op.
function rewriteFor(modelMap, model) {
  if (!modelMap || !model) return null;
  return modelMap[model] || null;
}

// A key that would have matched if rewriteModel were tolerant. It is not, so
// this is a live trap: `claude-fable-5[1m]` in the map does nothing for a bare
// `claude-fable-5` request, and the unmapped id reaches a third-party backend
// that has never heard of it.
function nearMissKey(modelMap, model) {
  if (!modelMap || !model || modelMap[model]) return null;
  const bare = model.replace(/\[\d+m\]$/, '').toLowerCase();
  for (const key of Object.keys(modelMap)) {
    if (key.toLowerCase() === model.toLowerCase()) return key;
    if (key.replace(/\[\d+m\]$/, '').toLowerCase() === bare) return key;
  }
  return null;
}

function shortUpstream(url) {
  return String(url).replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

// ── the trace ─────────────────────────────────────────────────

/**
 * Build the decision trace for `model` under `config`. Pure: no IO, no clock,
 * no mutation of the input, and the result is plain JSON (no Sets, no
 * Infinity), so a caller can `JSON.stringify` it for `--json`.
 *
 * opts:
 *   account  — a `/tc-acct/<name-or-index>` pin token (what `run --account`
 *              would send). Resolved name-first then numeric index, mirroring
 *              resolveAccountPin (server.js:148-156). A pinned request is forced
 *              onto that one account and NEVER fails over.
 *   upstream — override the global upstream default (default: config.upstream).
 */
export function explainRouting(config, model, opts = {}) {
  const cfg = config || {};
  const id = typeof model === 'string' && model ? model : null;
  const routes = normalizeRoutes(cfg.routes);
  const accounts = normalizeAccounts(cfg.accounts);
  const globalUpstream = opts.upstream || cfg.upstream || DEFAULT_UPSTREAM;

  const blocked = checkBlocked(cfg, id);
  const hits = matchRoutes(routes, id);
  // The winner comes from the shared predicate, not from hits[0]: matchRoutes
  // exists only to name the glob and the shadowed losers.
  const winningRoute = routeForModel(routes, id);
  const winner = hits.find(h => h.route === winningRoute) || null;
  const owners = ownershipOwners(accounts, id);
  const ownershipDecides = !!id && !(winner && winner.route.accounts.length);

  const eligible = new Set();
  const ineligible = [];
  const reasons = new Map();
  for (const a of accounts) {
    const verdict = eligibilityFor(a, { model: id, routes, accounts, winner, owners });
    reasons.set(a.index, verdict.reason);
    if (verdict.eligible) eligible.add(a.index);
    else ineligible.push({
      name: a.name, index: a.index, type: a.type, priority: a.priority,
      reason: verdict.reason, detail: verdict.detail,
    });
  }

  const view = (a, rank) => {
    const upstream = a.upstream || globalUpstream;
    const mapped = rewriteFor(a.modelMap, id);
    const nearMiss = nearMissKey(a.modelMap, id);
    const notes = [];
    if (nearMiss) {
      notes.push(`modelMap has "${nearMiss}" but the rewrite is exact and case-sensitive, so "${id}" is sent verbatim`);
    } else if (!mapped && a.modelMap && a.upstream) {
      notes.push(`modelMap does not list "${id}" — the id reaches ${shortUpstream(upstream)} unchanged, which may not know it`);
    }
    return {
      rank, name: a.name, index: a.index, type: a.type, priority: a.priority,
      disabled: a.disabled,
      upstream, upstreamHost: shortUpstream(upstream),
      upstreamModel: mapped || id, rewritten: !!mapped,
      modelMapKeys: a.modelMap ? Object.keys(a.modelMap).length : 0,
      modelMapNearMiss: nearMiss,
      whyEligible: reasons.get(a.index) || null,
      notes,
    };
  };

  // A pin bypasses selection entirely (server.js:536-537): one account, no
  // rotation, no failover — but the route/ownership rules are NOT re-checked, so
  // a pin can legitimately reach an account the routing table would never pick.
  let pin = null;
  if (opts.account != null && opts.account !== '') {
    const token = String(opts.account);
    let target = accounts.find(a => a.name === token) || null;
    if (!target && /^\d+$/.test(token)) target = accounts[Number(token)] || null;
    pin = {
      token,
      resolved: !!target,
      name: target ? target.name : null,
      index: target ? target.index : null,
      failsOver: false,
      routable: target ? eligible.has(target.index) : null,
      account: target ? view(target, 1) : null,
    };
  }

  const ordered = orderCandidates(accounts, eligible, config);
  const candidates = pin
    ? (pin.account ? [pin.account] : [])
    : ordered.map((a, i) => view(a, i + 1));

  // The headline verdict, taken from the same oracle `run`'s preflight blocks on
  // — not recomputed. A walk that narrates five eligible accounts while the
  // preflight refuses to launch would be worse than no explanation at all, so
  // the two read the same value. It answers a strictly narrower question than
  // the walk below (can ANYTHING serve this id) and can therefore be `false`
  // while candidates are listed: that is precisely the account-name collision,
  // where the request does reach an account and then 404s upstream.
  //
  // Under a PIN it must be the pinned oracle, for the same reason: the verdict
  // row is the line an operator reads first, and printing the unpinned verdict
  // there made the headline contradict the pin row two lines below it — "NOT
  // ROUTABLE … first choice X" above "pinned to Y, which serves it". The
  // unpinned answer is still shown, labelled, because "the rules would never
  // have picked this account" is exactly what a pin is for and is worth seeing.
  const unpinnedVerdict = id ? routabilityOf(cfg, id) : null;
  const pinnedVerdict = id && pin && pin.resolved ? pinnedRoutabilityOf(cfg, id, pin.token) : null;
  const verdict = pinnedVerdict || unpinnedVerdict;

  const trace = {
    model: id,
    verdict: verdict
      ? { routable: verdict.routable, reason: verdict.reason, pinned: !!pinnedVerdict }
      : null,
    verdictUnpinned: pinnedVerdict && unpinnedVerdict
      ? { routable: unpinnedVerdict.routable, reason: unpinnedVerdict.reason }
      : null,
    upstreamDefault: globalUpstream,
    pin,
    blocked: { ...blocked, shortCircuits: blocked.blocked },
    route: {
      total: routes.length,
      matched: winner ? {
        name: winner.name, index: winner.index, glob: winner.glob,
        accounts: winner.route.accounts,
        exclusive: winner.route.accounts.length > 0,
        bucket: winner.route.bucket,
      } : null,
      matchCount: hits.length,
      shadowed: hits.slice(1).map(h => ({ name: h.name, index: h.index, glob: h.glob })),
      governingBucket: winner?.route.bucket || (id ? weeklyBucketForModel(id) : null),
    },
    ownership: {
      consulted: ownershipDecides,
      claimed: owners.length > 0,
      owners: owners.map(o => ({ name: o.name, index: o.index, models: o.models })),
    },
    candidates,
    ineligible,
    fallback: buildFallback(candidates, accounts.length, !!pin),
    warnings: buildWarnings({ routes, accounts, id, winner, owners, ownershipDecides, candidates, pin, blocked, verdict }),
    notes: buildNotes({ cfg, candidates, id }),
    explanation: [],
  };
  trace.explanation = buildExplanation(trace);
  return trace;
}

// server.js failover semantics, stated once so the CLI and the tests agree.
function buildFallback(candidates, accountCount, pinned) {
  const chain = candidates.map(c => c.name);
  if (pinned) {
    return {
      pinned: true,
      maxRetries: 0,
      chain,
      rules: [
        'a /tc-acct pinned request is forced onto exactly one account and never fails over: once that account has been tried the proxy returns 429 "pinned account is unavailable" rather than leaking the request to another account (server.js:542-552)',
      ],
    };
  }
  return {
    pinned: false,
    maxRetries: accountCount,
    chain,
    rules: [
      `a quota-rejection 429 (anthropic-ratelimit-unified-*-status: rejected) throttles the account and retries the request on the next candidate, up to ${accountCount} attempt(s) — one per account (server.js:704-737, maxRetries = account count at :525)`,
      'a transient rate-limit 429 pauses and retries the same account by default (issue #84); after transient429RotateAfter consecutive hits on that account (default 3; 0 = never) it cools the account down and rotates to the next eligible candidate (R1)',
      'a transport/stream failure also fails over to the next candidate for this request only, without sidelining the account (server.js:864-866)',
      'any non-429 response — including the 404 an unknown model id earns — is relayed to the client verbatim with no retry and no rotation (server.js:794-807)',
      'a /tc-acct pinned request never fails over at all (server.js:542-552)',
    ],
  };
}

// Config defects this trace can prove from the config alone. These are the
// findings worth acting on, not decoration.
function buildWarnings({ routes, accounts, id, winner, owners, ownershipDecides, candidates, pin, blocked, verdict }) {
  const out = [];

  // The incident's exact shape, and the one case where the candidate table above
  // is genuinely misleading on its own: the requested id IS the name of a
  // configured account. Something serves the request, so the walk looks healthy
  // — but it is whatever the routing table picked, not the account that bears
  // the name, and the id then egresses verbatim and 404s. teamclaude has a real
  // mechanism for "run on THAT account", and it is not the model field.
  const named = id ? accounts.find(a => a.name === id) : null;
  if (named && !pin) {
    out.push({
      code: 'model-is-account-name',
      message: `"${id}" is the NAME of a configured account, not a model id. `
        + (verdict && !verdict.routable
          ? 'Nothing can serve it as a model'
          : `As a model id it would be served by ${candidates[0] ? `"${candidates[0].name}"` : 'whichever account the rules pick'}, not by the account of that name`)
        + `. To run on that account, pin it: teamclaude run --account ${id} -- --model <a model id it serves>`,
    });
  }

  // A catch-all that is not last makes every later route unreachable — and the
  // catch-all's own accounts list then suppresses ownership for EVERY model id.
  const catchAll = routes.findIndex(r => r.match.some(g => g === '*'));
  if (catchAll >= 0 && catchAll < routes.length - 1) {
    out.push({
      code: 'catch-all-not-last',
      message: `route "${routes[catchAll].name}" (#${catchAll + 1}) matches "*" but ${routes.length - catchAll - 1} route(s) follow it; first match wins, so those routes can never fire`,
    });
  }

  // The latent defect that makes the documented models[] mechanism inert.
  if (owners.length && !ownershipDecides) {
    out.push({
      code: 'ownership-suppressed',
      message: `${owners.map(o => `"${o.name}"`).join(', ')} claim${owners.length > 1 ? '' : 's'} "${id}" in models[], but route "${winner.name}" lists accounts and is therefore exclusive — the ownership claim is never consulted for this id`,
    });
  }

  // A route naming an account that does not exist silently shrinks its own
  // eligible set (route add only warns at write time).
  if (winner) {
    const known = new Set(accounts.map(a => a.name));
    for (const token of winner.route.accounts) {
      if (known.has(token)) continue;
      if (/^\d+$/.test(token) && Number(token) < accounts.length) continue;
      out.push({
        code: 'route-names-unknown-account',
        message: `route "${winner.name}" lists "${token}", which is not a configured account`,
      });
    }
  }

  if (!blocked.blocked && !pin && !candidates.length && id) {
    out.push({
      code: 'no-eligible-account',
      message: `no account may serve "${id}" — the proxy would answer 429 "(none available)" without contacting any upstream`,
    });
  }

  if (pin && !pin.resolved) {
    out.push({
      code: 'pin-unresolved',
      message: `"${pin.token}" matches no account name or index — the proxy answers 404 "Unknown account pin" locally (server.js:255-259)`,
    });
  }
  if (pin && pin.resolved && pin.account?.disabled) {
    out.push({
      code: 'pin-account-disabled',
      message: `account "${pin.name}" is disabled — the proxy answers 403 locally and never contacts upstream`,
    });
  } else if (pin && pin.resolved && pin.routable === false) {
    out.push({
      code: 'pin-outside-routing',
      message: `account "${pin.name}" is pinned, so it serves this request even though the routing rules would never select it for "${id}" — the pin bypasses selection, not the upstream's own model support`,
    });
  }

  for (const c of candidates) {
    for (const note of c.notes) out.push({ code: 'model-map', message: `${c.name}: ${note}` });
  }
  return out;
}

// Everything this trace deliberately cannot know. Stating them is the point:
// a quota-blind explanation that pretends to be live is worse than none.
function buildNotes({ cfg, candidates, id }) {
  const mode = cfg?.routingPolicy?.mode || 'priority-first';
  const notes = mode === 'priority-first' ? [
    'order is quota-blind: priority ascending, then config array order. The live router may use a same-priority weekly-reset tiebreak that config alone cannot supply.',
    'a running server also stays on its current account within a priority tier for cache locality, so the live intra-tier order can differ from the static order shown.',
    'not visible from config: live quota utilization/reset, circuit state/latency, throttle holds, error/exhausted status, and ephemeral route pins — any can skip a candidate at request time.',
  ] : [
    `routingPolicy.mode is "${mode}": the table shows costTier then static priority ONLY as the unknown-state fallback. The live data plane ranks complete weekly reset → complete session reset → utilization inside the cheapest eligible tier.`,
    'config-only explain cannot see the live quota/circuit/session state that decides dynamic order; read GET /teamclaude/status for routingPolicy, shadowDecisions, account quota and health.',
    'known sessions remain pinned for prompt-cache locality; dynamic rank assigns new sessions and failover, rather than thrashing an existing session on every reset change.',
  ];
  if (cfg.distributeSessions) {
    notes.push('distributeSessions is ON: a request carrying x-claude-code-session-id is placed by session affinity / least-loaded selection instead of this walk (account-manager.js:234-237, :302-315).');
  }
  if (candidates.some(c => c.type === 'apikey')) {
    notes.push('apikey accounts show no live token/request quota in the TUI ("Tok - Req -"); that is a prober/status-renderer concern and is out of scope here — it does not affect the routing shown.');
  }
  if (id) {
    notes.push('an id that routes cleanly here can still be refused by Claude Code before the request is ever sent: the client checks its own settings.availableModels allowlist and silently falls back to the default model.');
  }
  return notes;
}

// ── plain-English summary ─────────────────────────────────────

function buildExplanation(trace) {
  const out = [];
  const id = trace.model ? `"${trace.model}"` : 'a request with no model id';

  if (trace.blocked.blocked) {
    out.push(`${id} matches the blockedModels pattern "${trace.blocked.pattern}", so the proxy rejects it locally with a non-retryable 400 before any account is considered — no upstream call, no token spent.`);
    out.push('Everything below is what WOULD happen once that pattern is removed.');
  } else {
    out.push(`${id} is not blocked, so the proxy proceeds to pick an account.`);
  }

  if (trace.route.matched) {
    const r = trace.route.matched;
    const others = trace.route.matchCount - 1;
    const ordinal = others > 0
      ? `the first of ${trace.route.matchCount} matching routes — array order decides, and the other ${others === 1 ? 'one never fires' : `${others} never fire`} for this id`
      : 'the only matching route';
    out.push(`Route "${r.name}" matched on glob ${r.glob} and is ${ordinal}.`);
    out.push(r.exclusive
      ? `It lists accounts, so it is exclusive: only ${r.accounts.map(a => `"${a}"`).join(', ')} may serve this id, and the per-account models[] ownership claim is not consulted at all.`
      : 'It lists no accounts, so it does not restrict anything — eligibility falls through to the per-account models[] ownership claim.');
  } else if (trace.model) {
    out.push(`No route glob matches, so route exclusivity does not apply and eligibility falls through to the per-account models[] ownership claim.${trace.ownership.claimed ? ` "${trace.model}" is claimed by ${trace.ownership.owners.map(o => `"${o.name}"`).join(', ')}, so only those accounts may serve it.` : ' No account claims it, so every account is allowed.'}`);
  }

  if (!trace.model) {
    out.push('With no model id the route and ownership rules are skipped entirely (account-manager.js:554 guards on `model`), so every enabled account is eligible.');
  }

  if (trace.pin) {
    if (!trace.pin.resolved) {
      out.push(`The pin "${trace.pin.token}" resolves to no account, so the proxy answers 404 locally and never forwards.`);
    } else {
      const c = trace.candidates[0];
      out.push(`The request is pinned to "${trace.pin.name}" via /tc-acct, which bypasses selection entirely: it is the only account tried and there is no failover.`);
      if (c) out.push(upstreamSentence(c));
      if (trace.pin.routable === false) {
        out.push('Note that the routing rules would never have selected this account for this id — the pin is what makes it reachable.');
      }
    }
  } else if (trace.candidates.length) {
    const first = trace.candidates[0];
    const tierPeers = trace.candidates.filter(c => c.priority === first.priority).length;
    out.push(`${trace.candidates.length} account(s) are eligible. The proxy sends to "${first.name}" first — lowest priority value (${first.priority})${tierPeers > 1 ? `, tied with ${tierPeers - 1} other account(s) at that priority, where config array order breaks the tie here` : ''}.`);
    out.push(upstreamSentence(first));
    const next = trace.candidates[1];
    if (next) {
      out.push(`If that account's quota is rejected with a 429 it is throttled and the request is retried on "${next.name}"${next.rewritten ? `, where modelMap rewrites the id to "${next.upstreamModel}"` : ''}; a transient rate-limit 429 pauses and retries the same account, then rotates after transient429RotateAfter consecutive hits (default 3).`);
    } else {
      out.push('There is no second eligible account, so a quota rejection has nowhere to fail over to and the client receives the 429.');
    }
  } else if (!trace.blocked.blocked) {
    out.push('No account is eligible, so the proxy answers 429 "(none available)" without contacting any upstream.');
  }

  return out;
}

function upstreamSentence(c) {
  return c.rewritten
    ? `Its modelMap rewrites the id to "${c.upstreamModel}" before the body leaves, so ${c.upstreamHost} sees "${c.upstreamModel}".`
    : `It has no modelMap entry for this id, so ${c.upstreamHost} receives the model id verbatim.`;
}

// ── presentation ──────────────────────────────────────────────

const LABEL = 12;

/**
 * Render a trace for a terminal. Plain text, no ANSI: the output is meant to be
 * copied into an issue or diffed, and colouring is the status renderer's job.
 * `width` wraps prose only — the candidate table is never wrapped, since
 * breaking a column would destroy the alignment that makes it readable.
 */
export function formatExplain(trace, opts = {}) {
  const width = opts.width || 78;
  const pad = opts.indent || '  ';
  const lines = [];
  const body = width - pad.length - LABEL - 2;
  const row = (label, value) => lines.push(`${pad}${label.padEnd(LABEL)}: ${value}`);
  const cont = (value) => lines.push(`${pad}${' '.repeat(LABEL)}  ${value}`);
  // A wrapped bullet keeps a hanging indent so the marker stays scannable.
  const bullet = (marker, text) => {
    const hang = ' '.repeat(marker.length);
    const parts = wrap(text, body - marker.length);
    cont(`${marker}${parts[0]}`);
    for (const l of parts.slice(1)) cont(`${hang}${l}`);
  };

  lines.push(`model: ${trace.model || '(none — request carries no model field)'}`);

  // The verdict leads, because it is the one line an operator debugging a failed
  // launch needs, and it is the same value `run`'s preflight blocks on.
  if (trace.verdict) {
    const head = trace.verdict.pinned
      ? (trace.verdict.routable ? 'PINNED — SERVED' : 'PINNED — CANNOT BE SERVED')
      : (trace.verdict.routable ? 'ROUTABLE' : 'NOT ROUTABLE');
    const parts = wrap(`${head} — ${trace.verdict.reason}`, body);
    row('verdict', parts[0]);
    for (const l of parts.slice(1)) cont(l);
    if (trace.verdictUnpinned) {
      for (const l of wrap(`without the pin: ${trace.verdictUnpinned.routable ? 'ROUTABLE' : 'NOT ROUTABLE'} — `
        + trace.verdictUnpinned.reason, body)) cont(l);
    }
  }

  row('blocklist', trace.blocked.blocked
    ? `BLOCKED by "${trace.blocked.pattern}" — rejected locally with 400, never forwarded`
    : 'not blocked');
  if (trace.blocked.patterns.length > 1) {
    cont(`also matches ${trace.blocked.patterns.slice(1).map(p => `"${p}"`).join(', ')}`);
  }

  // route
  if (trace.route.matched) {
    const r = trace.route.matched;
    row('route', `"${r.name}"  (matched ${r.glob})`);
    cont(trace.route.matchCount > 1
      ? `first of ${trace.route.matchCount} matching routes — array order is load-bearing`
      : `only match of ${trace.route.total} configured route(s)`);
    cont(r.exclusive
      ? `exclusive to: ${r.accounts.join(', ')}`
      : 'lists no accounts → does not restrict; ownership decides');
    if (r.bucket) cont(`bucket override: ${r.bucket}`);
    for (const s of trace.route.shadowed) {
      cont(`shadowed: "${s.name}" (#${s.index + 1}, ${s.glob}) never fires for this id`);
    }
  } else {
    row('route', trace.route.total
      ? `no match among ${trace.route.total} route(s) → eligibility falls through to per-account models[]`
      : 'no routes configured → eligibility falls through to per-account models[]');
  }
  if (trace.route.governingBucket) {
    cont(`governing weekly bucket: ${trace.route.governingBucket}`);
  }

  // ownership
  if (trace.ownership.claimed) {
    row('ownership', trace.ownership.consulted
      ? `claimed by ${trace.ownership.owners.map(o => o.name).join(', ')} — only owners may serve this id`
      : `claimed by ${trace.ownership.owners.map(o => o.name).join(', ')}, but NOT consulted (an exclusive route matched first)`);
  } else if (trace.ownership.consulted && trace.model) {
    row('ownership', 'no account claims this id → every account is allowed');
  }

  // pin
  if (trace.pin) {
    row('pin', trace.pin.resolved
      ? `/tc-acct/${trace.pin.token} → account "${trace.pin.name}" (#${trace.pin.index}) — rotation and failover disabled`
      : `/tc-acct/${trace.pin.token} → UNRESOLVED — the proxy answers 404 locally`);
  }

  // candidates
  const cs = trace.candidates;
  if (!cs.length) {
    row('candidates', trace.pin ? 'none — the pin does not resolve' : 'none — no account may serve this id (proxy answers 429)');
  } else {
    row('candidates', trace.blocked.blocked
      ? '(never reached — blocked above) would be tried in this order'
      : (trace.pin ? 'pinned — exactly one account, no failover' : 'tried in this order (priority ascending, then config array order)'));
    const nameW = Math.max(...cs.map(c => c.name.length));
    const typeW = Math.max(4, ...cs.map(c => c.type.length));
    const prioW = Math.max(...cs.map(c => `prio ${c.priority}`.length));
    const hostW = Math.max(...cs.map(c => c.upstreamHost.length));
    for (const c of cs) {
      const modelCell = c.rewritten ? `model -> ${c.upstreamModel}` : 'model unchanged';
      cont(`${c.rank}. ${c.name.padEnd(nameW)}  ${c.type.padEnd(typeW)}  ${`prio ${c.priority}`.padEnd(prioW)}  -> ${c.upstreamHost.padEnd(hostW)}  ${modelCell}`);
    }
  }

  if (trace.ineligible.length) {
    // Under a pin this table describes the rules the pin BYPASSES, and the
    // pinned account itself can legitimately appear in it — say so, or the row
    // reads as a contradiction of the candidates row directly above.
    row('not eligible', trace.pin && trace.pin.resolved
      ? `${trace.ineligible.length} account(s) the ROUTING rules exclude (the pin bypasses these; the pinned account may itself be listed)`
      : `${trace.ineligible.length} account(s) excluded by the rules above`);
    const nameW = Math.max(...trace.ineligible.map(a => a.name.length));
    for (const a of trace.ineligible) {
      cont(`- ${a.name.padEnd(nameW)}  ${a.detail || a.reason}`);
    }
  }

  // fallback
  row('fallback', trace.fallback.chain.length > 1
    ? trace.fallback.chain.join(' → ')
    : (trace.fallback.pinned ? 'none — a pinned request never fails over' : 'no second candidate — a 429 reaches the client'));
  for (const rule of trace.fallback.rules) bullet('- ', rule);

  if (trace.warnings.length) {
    row('warnings', `${trace.warnings.length} finding(s)`);
    for (const w of trace.warnings) bullet('! ', `${w.message} [${w.code}]`);
  }

  const prose = wrap(trace.explanation.join(' '), body);
  row('explanation', prose[0] || '(none)');
  for (const l of prose.slice(1)) cont(l);

  row('caveats', `${trace.notes.length} thing(s) this trace cannot know`);
  for (const n of trace.notes) bullet('- ', n);

  return lines.join('\n');
}

// ── the launch line ─────────────────────────────────────────

/**
 * ONE line describing where this launch's traffic will actually go, for
 * `teamclaude run` to print on EVERY launch — not only when something is wrong.
 *
 * This is the cheapest guard in the module and, for the incident that motivated
 * all of it, the most reliable one. The preflight can only object to what it can
 * prove is broken; it is silent whenever routing merely differs from what the
 * operator assumed. That silence is the actual failure mode: a session ran six
 * minutes on the wrong model and the only signal existed inside the client's own
 * transcript, where nobody looks. A launch that always states its destination
 * makes the whole class visible without a veto, without forking another
 * program's private logic, and without any power to refuse valid work.
 *
 * Deliberately one line. A paragraph here would be scrolled past on every launch
 * and would train operators to ignore exactly the line that matters; `teamclaude
 * explain <model>` exists for the full trace, and this line names it.
 *
 * Quota-blind like the rest of the module: it reports the FIRST candidate the
 * config implies, which is the account a fresh request tends to get, and says
 * how many others stand behind it. Live quota can reorder that at request time
 * (see the trace notes), so the line describes the config, never the moment.
 *
 * Pure: returns the string, never prints it, and is written so that no input can
 * make it throw — the caller still guards, because a launch must never fail
 * because its narration did.
 */
export function launchSummary(config, {
  model = null, accountPin = null, routingApplies = true, via = [],
} = {}) {
  const id = typeof model === 'string' && model ? `"${model}"` : null;

  // A direct launch never consults teamclaude at all, so any route we named
  // would be a claim about rules this session will not run under.
  //
  // `via` keeps that claim honest. A direct launch inherits its parent's
  // environment, and teamclaude declines to delete a proxy variable it cannot
  // prove is its own, so "bypassing the proxy" can be true of THIS teamclaude
  // and false of the environment. Saying "direct" while an inherited HTTPS_PROXY
  // quietly forwards the session somewhere else would be exactly the silent
  // wrong-destination this line exists to expose.
  if (!routingApplies) {
    const hops = (Array.isArray(via) ? via : []).filter(v => v && v.value);
    const through = hops.length
      // Redact userinfo before narrating: inherited proxy URLs may embed
      // credentials (B62 SECRET_IN_PANE). Destination host:port stays visible.
      ? ` — but still via inherited ${hops.map(v => `${(v.names || [])[0] || 'proxy'}=${redactUrlUserinfo(v.value)}`).join(', ')}`
      : ' — teamclaude routing does not apply';
    return `${id ? `model ${id}` : 'no --model'} → direct launch, bypassing this proxy${through}`;
  }

  if (accountPin) {
    // Accept a resolved pin object ({ name, token }) or a bare token string.
    // Callers that already resolved via resolveAccountPin (run's launch line)
    // must pass `.name` so a UUID-form pin does not false-negative here —
    // pinnedRoutabilityOf only matches name/index (normalizeAccounts drops uuids).
    const pinToken = accountPin && typeof accountPin === 'object'
      ? (accountPin.name || accountPin.token || null)
      : accountPin;
    const displayPin = typeof accountPin === 'object'
      ? (accountPin.token || accountPin.name || pinToken)
      : accountPin;
    const pin = pinnedRoutabilityOf(config, model, pinToken);
    const acct = pin.account;
    if (!acct) return `model ${id ?? '(client default)'} → pin "${displayPin}" matches NO account — every request 404s`;
    if (acct.disabled) {
      return `${id ? `model ${id}` : 'client default model'} → PINNED account "${acct.name}" (#${acct.index}) is DISABLED — every request 403s locally`;
    }
    const dest = acct.upstream || 'the Anthropic API';
    const as = pin.mappedTo ? ` as "${pin.mappedTo}"` : '';
    const outside = pin.outsideRouting ? ', outside the routing rules' : '';
    return `${id ? `model ${id}` : 'client default model'} → PINNED account "${acct.name}" (#${acct.index})`
      + ` → ${dest}${as}${outside} — no rotation, no failover`;
  }

  // No --model: Claude Code will pick its own default, which teamclaude cannot
  // predict (the default bypasses the client's own allowlist gate entirely), so
  // claiming a route here would be a guess presented as fact.
  if (!id) return 'no --model → Claude Code picks its own default; teamclaude routes whatever it sends';

  const r = routabilityOf(config, model);
  if (r.blockedBy) return `model ${id} → BLOCKED by blockedModels pattern "${r.blockedBy}" — every request 400s`;

  const live = (r.candidates || []).filter(c => !c.disabled);
  const first = live[0] || (r.candidates || [])[0] || null;
  if (!r.routable || !first) {
    return `model ${id} → NOT ROUTABLE by this config — see: teamclaude explain ${model}`;
  }

  const raw = (Array.isArray(config?.accounts) ? config.accounts : []).find(a => a?.name === first.name);
  const dest = raw?.upstream || 'the Anthropic API';
  const as = first.mappedTo ? ` as "${first.mappedTo}"` : '';
  const where = r.route ? `route "${r.route.name}"` : 'no route (models[] ownership)';
  const behind = live.length - 1;
  const more = behind > 0 ? `, ${behind} more on failover` : ', no failover candidate';
  const kind = raw?.type || (raw?.apiKey ? 'apikey' : 'oauth');

  return `model ${id} → ${where} → account "${first.name}" (${kind}, prio ${first.priority})`
    + ` → ${dest}${as}${more}`;
}

// Greedy wrap; never splits a token, so long model ids and URLs stay intact.
function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const out = [];
  let line = words[0];
  for (const w of words.slice(1)) {
    if (line.length + 1 + w.length > width) { out.push(line); line = w; }
    else line += ` ${w}`;
  }
  out.push(line);
  return out;
}
