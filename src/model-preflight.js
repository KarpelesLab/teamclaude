// The launch preflight: decide, BEFORE `teamclaude run` spawns claude, whether
// the model the operator asked for can actually be served — and say so loudly.
//
// This module exists because of one asymmetry in Claude Code. At launch, a
// `--model` the client refuses is ADVISORY: the client warns in-band and
// silently falls back to its default. Not one of its warning call sites writes
// to stdout or stderr, and the process never aborts. So a session launched on a
// model nothing can serve is indistinguishable, from the outside, from a good
// one — it just quietly runs on something else, for hours, at another account's
// expense. (At runtime `/model x` is refused hard; only the launch path is
// silent, which is exactly the path a fleet launcher uses.) Nobody downstream
// will ever make this loud, so it has to be made loud here.
//
// The real incident this reproduces: a wrapper script emitted
//   run -- ... --model opus -n <session> --model deepseek-v4-pro
// Two `--model` flags, last one wins, and the winner was not a model id at all —
// it was the NAME OF A CONFIGURED ACCOUNT. Nothing produced a single line of
// output. Note what is NOT wrong here: the two flags are deliberate. Wrapper
// templates commonly append a default `--model` and document that caller args
// land after it, so the last flag winning is the override contract working as
// designed. The only fault was the winning VALUE — which is precisely why this
// module judges the winner and never the shape (see the asymmetry below).
//
// Pure and side-effect free: no fs, no process.env, no console, no clock. The
// caller loads the config, reads Claude Code's settings tiers, and prints. That
// keeps every decision here testable as data, which is the whole point — the
// duplicate-flag scan in particular is the sort of thing that is untestable and
// therefore wrong when it lives inside a command body.
//
// ── The blocking asymmetry, and why it is not an oversight ──
//
// A ROUTING failure BLOCKS the launch. Everything else WARNS. The verdicts have
// different epistemic standing:
//
//   * Routability is computed from teamclaude's OWN config with the very
//     predicates the router uses (model-namespace.js, pinned to
//     AccountManager's methods by a cross-product divergence test). When it says
//     "not routable" it is not predicting someone else's behaviour, it is
//     reporting its own — and it is deliberately built to say that only when it
//     can PROVE it (blocked by blockedModels; no eligible account; or an id that
//     is really an account name, excluded by the winning route, translated by
//     nobody, and headed for an account that talks to the real Anthropic API).
//     Every merely-unknown id stays routable, because teamclaude cannot tell a
//     future real Anthropic id from a typo and must not pretend to. A block on a
//     proof is safe; that narrowness is what earns it the right to block.
//   * The client allowlist is a model of a FOREIGN build that ships on its own
//     schedule, assembled from settings tiers we may not fully enumerate. A
//     false "denied" there would refuse a launch that works — a self-inflicted
//     outage caused by someone else's release. A false "allowed" merely leaves
//     the operator where they are today, with the client's own in-band warning
//     plus our stderr line. The costs are not symmetric, so neither is the rule.
//   * A DUPLICATE --model is a fact about the argv, not a proof about the
//     launch. Making it blocking was this module's worst bug and it is worth
//     recording why: a real launcher template appends `--model opus` to every
//     new session and documents that caller args land after it, so
//     `<wrapper> --model claude-fable-5` legitimately emits two flags and the
//     last one wins — exactly as intended. Blocking on the SHAPE would have
//     failed every model override on every session on that host, and such
//     sessions respawn automatically, so it would have failed repeatedly. The
//     duplicate is now reported loudly (with both values and the winner named)
//     and the decision to launch rests entirely on whether the WINNING value
//     can route, which is the part that can be proven. A guard against a silent
//     failure must never be able to cause a louder one.
//
// The one thing this preflight may never do is refuse a launch on rules that
// will not govern it. Two shapes of that were live and are now closed: a
// `--account` pin bypasses selection (routes and models[] are never consulted
// for a pinned request, so they cannot justify a refusal — `disabled` is an
// operator hard-stop and DOES refuse, with a local 403), and a `--auto-fallback`
// launch with the proxy down never reaches teamclaude at all (so its routing
// table is not consulted either). Both are threaded in as parameters rather
// than assumed away.
//
// `--force` bypasses a block for the operator who knows better; `--strict`
// promotes the client warning to a block for the operator who wants the mirror
// treated as authoritative. Both are explicit, both are reported in the output
// so a transcript shows which posture was in effect, and both are teamclaude's
// own flags — they belong BEFORE the `--` separator, which is what the refusal
// line now says, because "pass --force" appended to the failing command line is
// not a working instruction.

import { routabilityOf, pinnedRoutabilityOf, clientAllowlistVerdict } from './model-namespace.js';
import { registerBuildFeature } from './build-identity.js';

registerBuildFeature('model-preflight');

const MODEL_FLAG = '--model';
const MODEL_EQ = '--model=';

// `teamclaude run`'s own flags. Booleans are recognized bare; --account takes a
// value, in either the space or the `=` form. Kept as data so the split, the
// strip, the unknown-flag check and the help text cannot drift.
// `--no-launch-line` is spelled distinctively on purpose (see splitRunArgs): in
// the unseparated form an own-flag is stripped from claude's argv, so a name
// claude might plausibly also use — `--quiet` being the obvious temptation —
// would be silently eaten out of an unseparated launch.
export const RUN_BOOLEAN_FLAGS = ['--mitm', '--no-mitm', '--auto-fallback', '--force', '--strict', '--no-preflight', '--no-launch-line'];
export const RUN_VALUE_FLAGS = ['--account'];

// The subset that changes teamclaude's posture rather than the transport. These
// are the ones an operator reaches for AFTER a refusal, which is exactly when
// they are most likely to append them to the end of the failing command line —
// i.e. after the `--`, where they belong to claude and are silently ignored.
const POSTURE_FLAGS = ['--force', '--strict', '--no-preflight'];

/**
 * Split `teamclaude run`'s arguments into teamclaude's own flags and the argv
 * destined for claude.
 *
 * A `--` separator is the unambiguous form and the one the shell alias installs
 * (`teamclaude run --`): everything before it is ours, everything after it is
 * claude's, verbatim. With no separator the pre-existing behaviour is preserved
 * — teamclaude's flags are recognized and filtered out wherever they appear —
 * so `teamclaude run --no-mitm -p hello` keeps working. That is why the flag
 * names above have to stay distinctive: an unseparated launch cannot tell our
 * `--force` from a hypothetical claude `--force`.
 *
 * The `--` contract is NOT bent for our own flags: a `--force` after the
 * separator stays in claudeArgs, because "everything after -- is claude's,
 * verbatim" is the one promise this split makes and quietly eating three tokens
 * out of it would make the separator untrustworthy. It is instead REPORTED, via
 * `misplacedFlags`, so the caller can say where the flag belongs rather than
 * refusing twice with the same message.
 *
 * Pure, and returns the account token WITHOUT resolving it: name-vs-index
 * resolution needs the config, which is the caller's to load.
 */
export function splitRunArgs(rest) {
  const argv = (Array.isArray(rest) ? rest : []).filter(a => typeof a === 'string');
  const sep = argv.indexOf('--');
  const own = sep >= 0 ? argv.slice(0, sep) : argv;
  const claudeArgs = sep >= 0 ? argv.slice(sep + 1) : stripRunFlags(argv);
  const account = lastValueFlag(own, '--account');

  return {
    separated: sep >= 0,
    tcFlags: own,
    claudeArgs,
    accountRequested: account.present,
    account: account.value,
    useMitm: !own.includes('--no-mitm'),
    autoFallback: own.includes('--auto-fallback'),
    force: own.includes('--force'),
    strict: own.includes('--strict'),
    preflight: !own.includes('--no-preflight'),
    launchLine: !own.includes('--no-launch-line'),
    // Only meaningful in the separated form: with no `--`, an unrecognized flag
    // is claude's by construction and must be passed through.
    unknownFlags: sep >= 0 ? unknownOwnFlags(own) : [],
    misplacedFlags: POSTURE_FLAGS.filter(f => claudeArgs.includes(f)),
  };
}

/**
 * The LAST occurrence of a value flag in either spelling, `--flag value` or
 * `--flag=value`.
 *
 * lastIndexOf semantics, not indexOf: a repeated flag should behave like every
 * other last-wins argv convention rather than silently honouring the first. The
 * `=` spelling was originally unhandled, which made `run --account=fugu` launch
 * an UNPINNED session with exit 0 and no diagnostic — the operator believes the
 * session is on a paid apikey account and it quietly spends OAuth quota instead.
 * `present` is deliberately separate from `value`: "asked for a pin and gave no
 * name" must fail loudly, never launch unpinned.
 */
export function lastValueFlag(argv, flag) {
  const eq = `${flag}=`;
  for (let i = argv.length - 1; i >= 0; i--) {
    const a = argv[i];
    if (a === flag) {
      const next = argv[i + 1];
      return { present: true, value: (typeof next === 'string' && !next.startsWith('-')) ? next : null };
    }
    if (typeof a === 'string' && a.startsWith(eq)) {
      return { present: true, value: a.slice(eq.length) || null };
    }
  }
  return { present: false, value: null };
}

// Tokens in the pre-`--` slice that teamclaude does not recognize. In the
// separated form that slice is exclusively ours, so an unrecognized flag there
// is provably a mistake — and today it is discarded in silence, which is the
// same class of failure this whole branch exists to remove.
function unknownOwnFlags(own) {
  const out = [];
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (typeof a !== 'string' || !a.startsWith('-')) continue;
    if (RUN_BOOLEAN_FLAGS.includes(a)) continue;
    if (RUN_VALUE_FLAGS.includes(a)) {
      const next = own[i + 1];
      if (typeof next === 'string' && !next.startsWith('-')) i++;
      continue;
    }
    if (RUN_VALUE_FLAGS.some(f => a.startsWith(`${f}=`))) continue;
    out.push(a);
  }
  return out;
}

function stripRunFlags(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (RUN_BOOLEAN_FLAGS.includes(a)) continue;
    if (RUN_VALUE_FLAGS.some(f => a === f || a.startsWith(`${f}=`))) {
      if (RUN_VALUE_FLAGS.includes(a)) {
        const next = argv[i + 1];
        if (typeof next === 'string' && !next.startsWith('-')) i++;
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Every `--model` occurrence in the args destined for claude, in argv order,
 * plus which one actually takes effect. Both spellings are recognized:
 * `--model <id>` and `--model=<id>`.
 *
 * LAST ONE WINS — that is the client's own precedence, and reproducing it is the
 * entire point: reading the FIRST (which is what a naive `args.indexOf` helper
 * does) is the bug that let `--model opus … --model deepseek-v4-pro` look fine.
 *
 * A trailing `--model` with no value, or one followed by another flag, yields an
 * occurrence with `value: null` — reported rather than guessed at, since the
 * client's parser, not ours, decides what that means.
 */
export function scanModelArgs(claudeArgs) {
  const argv = Array.isArray(claudeArgs) ? claudeArgs : [];
  const occurrences = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (a === MODEL_FLAG) {
      const next = argv[i + 1];
      const value = (typeof next === 'string' && !next.startsWith('-')) ? next : null;
      occurrences.push({ at: i, form: 'space', value });
      if (value !== null) i++;
    } else if (a.startsWith(MODEL_EQ)) {
      const value = a.slice(MODEL_EQ.length);
      occurrences.push({ at: i, form: 'equals', value: value || null });
    }
  }
  const withValue = occurrences.filter(o => o.value !== null);
  return {
    occurrences,
    effective: withValue.length ? withValue[withValue.length - 1].value : null,
    duplicate: occurrences.length > 1,
    incomplete: occurrences.some(o => o.value === null),
  };
}

/**
 * The full preflight verdict for one launch, as data.
 *
 *   config           — teamclaude's config object (loadConfig()'s shape).
 *   claudeArgs       — the args after `--`, exactly as they will reach claude.
 *   envModel         — process.env.ANTHROPIC_MODEL, which the client vets with
 *                      the same gate as --model but at lower precedence.
 *   availableModels  — Claude Code's effective allowlist, or null/undefined when
 *                      no settings tier defines one (then the gate admits all).
 *                      The caller must have unioned any `--settings` tier in
 *                      already; see readFlagSettingsModels().
 *   accountPin       — the RESOLVED `--account` pin ({ token }) or null. When
 *                      present the launch is pinned and the unpinned routing
 *                      rules do not govern it — see pinnedRoutabilityOf.
 *   routingApplies   — false when the launch will bypass the proxy entirely
 *                      (`--auto-fallback` with the proxy down). teamclaude's
 *                      routing table is then not consulted by anything, so it
 *                      cannot justify a refusal.
 *   misplacedFlags   — teamclaude posture flags found after the `--`, reported
 *                      so the remedy can say where they belong.
 *   force / strict   — the two posture flags described in the header.
 *
 * Returns `{ requested, source, scan, routing, client, findings, blocked,
 * exitCode }`. `findings` are ordered errors-first and each carries `remedies`,
 * because a preflight that says "no" without saying "instead, do this" just
 * moves the outage to the operator's terminal.
 */
export function preflightModel({
  config,
  claudeArgs = [],
  envModel = null,
  availableModels = undefined,
  flagSettings = null,
  policyOverride = false,
  accountPin = null,
  routingApplies = true,
  misplacedFlags = [],
  force = false,
  strict = false,
} = {}) {
  const scan = scanModelArgs(claudeArgs);
  const requested = scan.effective || (typeof envModel === 'string' && envModel ? envModel : null);
  const source = scan.effective ? 'argv' : (requested ? 'ANTHROPIC_MODEL' : null);
  const findings = [];
  // Prefer the RESOLVED name over the raw pin token: the token may be a stable
  // identity (accountUuid, orgUuid, accountUuid/orgUuid) that pinnedRoutabilityOf
  // cannot match — model-namespace.js's normalizeAccounts() does not carry
  // accountUuid/orgUuid, so its account lookup only matches by name or index.
  // The caller (runCommand) already resolved the pin via the shared
  // resolveAccountPin contract before constructing accountPin, so `.name` is
  // always a valid account name here whenever `.token` was a UUID form; the
  // resulting explain/remedy text is also copy-pasteable either way.
  const pinToken = accountPin?.name ?? accountPin?.token ?? null;

  if (scan.duplicate) {
    const listed = scan.occurrences
      .map(o => (o.value === null ? `${MODEL_FLAG} (no value)` : `"${o.value}"`))
      .join(', ');
    const values = new Set(scan.occurrences.map(o => o.value));
    // WARN, never an error: see the header. A wrapper that appends a second
    // --model is a legitimate, documented pattern (last-wins is how an override
    // is expressed), so the shape alone proves nothing about whether the launch
    // works. If the winner is genuinely unservable, the routing check below
    // blocks on THAT — with the proof attached.
    findings.push({
      severity: 'warn',
      code: 'duplicate-model-flag',
      message: values.size === 1
        ? `${scan.occurrences.length} identical --model flags were passed to claude (${listed}); the launch runs on `
          + `${scan.effective ? `"${scan.effective}"` : 'no model at all'}, which is what was asked for either way.`
        : `${scan.occurrences.length} --model flags were passed to claude: ${listed}. Claude Code keeps the LAST one, `
          + `so this launch runs on ${scan.effective ? `"${scan.effective}"` : 'no model at all'} — not on the first `
          + 'value, which is usually the one a human wrote and the later one the one a wrapper appended.',
      remedies: values.size === 1
        ? ['harmless, but one of the two is redundant — drop it to keep the command line readable']
        : ['pass exactly one --model; remove the flag the wrapper adds, or drop yours',
          `the launch is NOT refused for this — only a model that provably cannot route is${scan.effective ? `, and "${scan.effective}" is checked below` : ''}`],
    });
  }
  if (misplacedFlags.length) {
    findings.push({
      severity: 'warn',
      code: 'posture-flag-after-separator',
      message: `${misplacedFlags.join(', ')} appeared AFTER the \`--\` separator, so ${misplacedFlags.length > 1 ? 'they were' : 'it was'} `
        + `handed to claude as ${misplacedFlags.length > 1 ? 'arguments' : 'an argument'} and had no effect on teamclaude. `
        + 'Everything after `--` is claude\'s, verbatim — that is the whole contract of the separator.',
      remedies: [`put ${misplacedFlags.length > 1 ? 'them' : 'it'} BEFORE the separator: \`teamclaude run ${misplacedFlags.join(' ')} -- …\``],
    });
  }
  if (scan.incomplete) {
    findings.push({
      severity: 'warn',
      code: 'model-flag-without-value',
      message: 'a --model flag was passed with no value after it (the next token is another flag, or there is none). '
        + 'What claude does with that is its parser\'s business, not ours, so this is only reported.',
      remedies: ['write --model <id> or --model=<id>'],
    });
  }
  if (scan.effective && typeof envModel === 'string' && envModel && envModel !== scan.effective) {
    findings.push({
      severity: 'info',
      code: 'env-model-shadowed',
      message: `ANTHROPIC_MODEL="${envModel}" is set but --model "${scan.effective}" takes precedence in the client, so `
        + 'only the flag was checked here. The env var is vetted by the same allowlist gate when it does win.',
      remedies: [],
    });
  }

  let routing = null;
  let client = null;

  if (requested) {
    const flag = source === 'argv' ? '--model' : 'ANTHROPIC_MODEL';

    // Which rules actually govern THIS launch decides which oracle answers.
    // Getting this wrong is not a cosmetic error: the unpinned oracle refuses
    // launches the pin provably serves, and the routing oracle refuses direct
    // launches that never touch the routing table at all.
    if (!routingApplies) {
      findings.push({
        severity: 'info',
        code: 'routing-not-checked',
        message: 'the proxy is not running and --auto-fallback will launch claude DIRECTLY against the upstream, so '
          + 'teamclaude\'s routes, per-account models[] claims and blockedModels govern nothing here and were not '
          + 'checked. The session runs on your own credential with no rotation.',
        remedies: ['start the proxy to get routing (and this check) back: teamclaude server'],
      });
    } else if (pinToken != null) {
      routing = pinnedRoutabilityOf(config, requested, pinToken);
      if (!routing.routable) {
        const disabledPin = !!routing.account?.disabled;
        findings.push({
          severity: 'error',
          code: routing.blockedBy ? 'model-blocked' : (disabledPin ? 'pin-account-disabled' : 'pin-cannot-serve'),
          message: `${flag} "${requested}" cannot be served by the pinned account. ${routing.reason}`,
          remedies: routing.blockedBy
            ? [`remove "${routing.blockedBy}" from blockedModels, or ask for a different id`,
              `see the full decision trace: \`teamclaude explain ${requested} --account ${pinToken}\``]
            : disabledPin
              ? [`teamclaude enable ${routing.account.name}`,
                'or drop --account and let rotation choose']
              : ['teamclaude accounts — the valid names',
                `see the full decision trace: \`teamclaude explain ${requested} --account ${pinToken}\``],
        });
      } else {
        for (const f of pinAdvisories(requested, routing, pinToken)) findings.push(f);
      }
    } else {
      routing = routabilityOf(config, requested);
      if (!routing.routable) {
        findings.push({
          severity: 'error',
          code: routing.blockedBy ? 'model-blocked' : 'model-not-routable',
          message: `${flag} "${requested}" cannot be served by this proxy. ${routing.reason}`,
          remedies: remediesForRouting(config, requested, routing),
        });
      } else if (routing.isAccountName) {
        // Unconditional, because the narrow collision branch above only fires
        // when the id is unroutable — and the sibling account name in the very
        // same config IS routable (it is listed in the catch-all), so it used to
        // pass in total silence while `explain` warned about it. The request
        // reaches whichever account the rules pick, never the account of that
        // name, and that account has no idea what the id means.
        findings.push({
          severity: 'warn',
          code: 'model-is-account-name',
          message: `"${requested}" is the NAME of a configured account as well as the model id you asked for. The `
            + 'request would NOT go to that account — a model id is not an account selector — it goes to whichever '
            + `account the routing rules pick. ${routing.reason}`,
          remedies: [`to run this session ON that account, pin it: \`teamclaude run --account ${requested} -- --model <a model id it serves>\``,
            `see where the request actually goes: \`teamclaude explain ${requested}\``],
        });
      }
    }

    // Fold in the `--settings` tier sitting in the very argv being judged.
    // Unreadable usually means UNKNOWN, and an unknown allowlist may not
    // support a denial — the module's standing bias. Exception: when a managed
    // policy already settled the allowlist (`policyOverride`), the effective
    // gate IS known; short-circuiting to "allowed" would silently ignore a file
    // the user named. Fail that case loudly instead of proceeding without it.
    const flagTier = flagSettings || { present: false, entries: null, unreadable: false };
    if (flagTier.present && flagTier.unreadable) {
      if (policyOverride) {
        findings.push({
          severity: 'error',
          code: 'settings-flag-unread',
          message: 'claude is being launched with --settings, but that file (or inline JSON) could not be read, '
            + 'and a managed policy has already replaced the availableModels union — proceeding would silently '
            + 'drop a settings tier the user named.',
          remedies: ['fix the --settings path (or pass inline JSON that parses)',
            'or drop --settings and rely on the managed policy alone'],
        });
      } else {
        findings.push({
          severity: 'info',
          code: 'settings-flag-unread',
          message: 'claude is being launched with --settings, which is a real settings tier whose availableModels union '
            + 'in — but this one could not be read (not inline JSON, or unparseable), so the client-allowlist check was '
            + 'skipped rather than guessed at.',
          remedies: [],
        });
      }
    }
    const effectiveAllowlist = flagTier.present && !flagTier.unreadable
      && Array.isArray(flagTier.entries) && !policyOverride
      ? [...new Set([...(Array.isArray(availableModels) ? availableModels : []), ...flagTier.entries])]
      : availableModels;

    // Under policyOverride the allowlist is already settled — still judge it.
    // Only the unknown-allowlist case (unreadable, no policy) suppresses the veto.
    client = (flagTier.present && flagTier.unreadable && !policyOverride)
      ? { allowed: true, reason: '--settings is present but unreadable, so the client gate cannot be modeled', matchedEntry: null }
      : clientAllowlistVerdict(effectiveAllowlist, requested);
    if (!client.allowed) {
      // Deliberately terse when it is only a warning. This fires on every
      // revive of a session whose last model is not in availableModels — an
      // automated path nobody reads — and a four-line block there is how
      // operators learn to skim past preflight output, which is the same
      // channel the blocking findings use. The full remedy list is kept for
      // --strict, where this finding actually changes the exit code.
      const strictFinding = strict;
      findings.push({
        severity: strictFinding ? 'error' : 'warn',
        code: 'client-allowlist-veto',
        message: strictFinding
          ? `Claude Code would refuse "${requested}" client-side and SILENTLY fall back to its default model — the `
            + 'warning it emits at launch never reaches stdout or stderr, so the session would look healthy while '
            + `running on something else. ${client.reason}`
          : `"${requested}" is not in Claude Code's availableModels, so the client would silently fall back to its `
            + 'default model (advisory — this mirrors one client build; `teamclaude doctor` names the file).',
        remedies: strictFinding
          ? ['add the id to "availableModels" in the settings file that defines it (teamclaude never writes that file)',
            'or launch claude with --settings \'{"availableModels":["<id>"]}\' — a per-process tier that unions in '
              + 'without touching any file on disk',
            'teamclaude doctor names the exact file and the drift it found']
          : [],
      });
    }
  }

  const hardErrors = findings.filter(f => f.severity === 'error');
  const blocked = hardErrors.length > 0 && !force;
  if (hardErrors.length && force) {
    findings.push({
      severity: 'info',
      code: 'forced',
      message: `--force was passed: ${hardErrors.length} blocking finding(s) were downgraded and the launch proceeds.`,
      remedies: [],
    });
  }

  const rank = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return { requested, source, scan, routing, client, findings, blocked, exitCode: blocked ? 1 : 0 };
}

// What a pinned launch can still be told, none of which is a refusal: the pin
// wins over route/models[] selection, and saying so is the honest report.
// `disabled` is NOT an advisory — pinnedRoutabilityOf already refuses it.
function pinAdvisories(model, routing, pinToken) {
  const out = [];
  const acct = routing.account;
  if (routing.outsideRouting) {
    out.push({
      severity: 'warn',
      code: 'pin-outside-routing',
      message: `account "${acct.name}" is pinned, so it serves this session even though the routing rules would never `
        + `select it for "${model}". That is what a pin is for — but it also means nothing in this config vouches for `
        + `the id: ${acct.upstream ? `it goes to ${acct.upstream}, whose model map teamclaude cannot see` : 'it goes to the Anthropic API verbatim'}`
        + `${routing.mappedTo ? `, after modelMap rewrites it to "${routing.mappedTo}"` : ''}.`,
      remedies: [`ids that account translates are listed by: \`teamclaude explain ${model} --account ${pinToken}\``],
    });
  }
  return out;
}

// Concrete next steps for an unroutable id. The account-name collision gets its
// own advice because it is the incident's actual shape: the operator wanted a
// particular ACCOUNT, and teamclaude already has a mechanism for that — the
// /tc-acct pin, now reachable as `run --account <name>` — which they could not
// have known, because until now it was only usable through a hand-built env.
function remediesForRouting(config, model, routing) {
  const out = [];
  const account = (config?.accounts || []).find(a => a?.name === model);
  if (account) {
    out.push(`"${model}" is an ACCOUNT, not a model: pin it with `
      + `\`teamclaude run --account ${model} -- --model <a model id that account serves>\``);
    const served = account.modelMap ? Object.keys(account.modelMap) : [];
    if (served.length) {
      out.push(`ids that account translates: ${served.slice(0, 8).join(', ')}${served.length > 8 ? ', …' : ''}`);
    }
  }
  if (routing.blockedBy) {
    out.push(`remove "${routing.blockedBy}" from blockedModels, or ask for a different id`);
  } else if (!account) {
    out.push('add a route matching this id BEFORE the catch-all: '
      + '`teamclaude route add <name> --match "<glob>" --accounts "<account>"`');
  }
  out.push(`see the full decision trace: \`teamclaude explain ${model}\``);
  return out;
}

/**
 * Render a preflight decision for stderr. Returns lines WITHOUT the runtime
 * prefix — the caller adds `[TeamClaude] ` to match the rest of `run`'s output.
 * Empty when there is nothing to say, so a clean launch stays silent.
 */
export function formatPreflight(decision) {
  const lines = [];
  const mark = { error: 'ERROR', warn: 'WARNING', info: 'note' };
  for (const f of decision.findings) {
    lines.push(`${mark[f.severity]}: ${f.message}`);
    for (const r of f.remedies) lines.push(`  → ${r}`);
  }
  if (decision.blocked) {
    // The position matters and the old wording omitted it: `--force` appended to
    // the failing command line lands after the `--`, where it is claude's
    // argument, and the operator is refused a second time by the same message.
    lines.push('Refusing to launch. Fix the above, or re-run as `teamclaude run --force -- …` '
      + '(--force is teamclaude\'s flag, so it must come BEFORE the `--`).');
  }
  return lines;
}

/**
 * The `availableModels` a `--settings` flag in `claudeArgs` contributes.
 *
 * `--settings <file-or-json>` is a real settings TIER in Claude Code
 * (`flagSettings`), and arrays UNION across tiers — so an id present only there
 * is admitted by the client even though it appears in no file this host would
 * otherwise read. Ignoring it made the client-allowlist finding assert a silent
 * fallback that provably would not happen, and recommend, as its own remedy, the
 * exact flag already sitting in the command line it had just judged.
 *
 * Returns `{ present, entries, unreadable }`. `present` without `entries` (a
 * file we cannot read, or JSON we cannot parse) is NOT nothing: it means the
 * effective allowlist is unknown, and the caller must then suppress the veto
 * rather than guess — the same bias the rest of this module keeps.
 *
 * `readFile` is injected so this stays pure by default and testable; the CLI
 * passes node's. Nothing but `availableModels` is ever read out of the parsed
 * object.
 */
export function readFlagSettingsModels(claudeArgs, readFile = null) {
  const argv = Array.isArray(claudeArgs) ? claudeArgs : [];
  const hit = lastValueFlag(argv, '--settings');
  if (!hit.present) return { present: false, entries: null, unreadable: false };
  if (hit.value == null) return { present: true, entries: null, unreadable: true };

  let text = hit.value;
  if (!text.trim().startsWith('{')) {
    if (!readFile) return { present: true, entries: null, unreadable: true };
    try { text = readFile(hit.value); }
    catch { return { present: true, entries: null, unreadable: true }; }
  }
  try {
    const parsed = JSON.parse(text);
    const list = parsed && Array.isArray(parsed.availableModels)
      ? parsed.availableModels.filter(m => typeof m === 'string')
      : null;
    return { present: true, entries: list, unreadable: false };
  } catch {
    return { present: true, entries: null, unreadable: true };
  }
}
