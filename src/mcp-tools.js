import { distributionMode } from './account-manager.js';
import { configIndexFor, markAccountRemoved } from './account-pairing.js';
import { atomicConfigUpdate } from './config.js';
import {
  ConfigOpError,
  DISTRIBUTE_MODES,
  QUOTA_BUCKETS,
  removeRoute,
  setBlockedModels,
  setBucketThresholds,
  setDefaultClientMode,
  setDistribution,
  setProbeSeconds,
  setThreshold,
  setWarmupSchedule,
  setWarmupSeconds,
  upsertRoute,
} from './config-ops.js';
import { matchAccounts } from './identity.js';
import { McpError, serveMcp } from './mcp.js';
import { WEEKLY_BUCKET_KEYS } from './model.js';
import { sanitizeText } from './safe-text.js';
import { currentVersion } from './updater.js';
import { upstreamPoolStatus } from './upstream-fetch.js';
import { parseRoutingUrl, routingToUrl, describeRouting, maskRoutingUrl } from './account-routing.js';
import { isSelfProxy, localListener } from './upstream-proxy.js';

/**
 * The management tools served at /teamclaude/mcp, and the `proxy.mcp` gate in
 * front of them.
 *
 * @typedef {{
 *   accountManager: import('./account-manager.js').AccountManager,
 *   config: Record<string, any>,
 *   hooks: Record<string, any>,
 *   client?: string|null,
 * }} ToolContext `client` is the name the proxy key authenticated as, for the log
 * @typedef {{
 *   name: string,
 *   title: string,
 *   description: string,
 *   properties?: Record<string, Record<string, any>>,
 *   required?: string[],
 *   write?: boolean,
 *   auditArgs?: (args: Record<string, any>) => Record<string, any>,
 *   run: (args: Record<string, any>, ctx: ToolContext) => Record<string, any>|Promise<Record<string, any>>,
 * }} Tool `run` throws a ToolFailure or ConfigOpError to refuse with a message
 *   the caller may read; any other exception is reported without its text.
 *   `auditArgs` is what the write log prints in place of the arguments, for a
 *   tool whose arguments hold a secret.
 */

const INVALID_PARAMS = -32602;

/** A tool that ran and could not do what was asked. The message reaches the caller. */
class ToolFailure extends Error {}

const ACCOUNT_ARGS = {
  account: { type: 'string', description: 'The account\'s display name or email, as get_status lists it' },
  org: { type: 'string', description: 'Organization name or UUID, to pick one of several accounts sharing an email' },
};

// Read at load, not per request: `teamclaude update` swaps package.json under a
// running process, and a client should be told what is running.
const SERVER_INFO = { name: 'teamclaude', version: currentVersion() || 'unknown' };

const INSTRUCTIONS = 'Manages a running TeamClaude proxy: the fleet of upstream accounts it rotates across, their quota, and the settings that steer rotation. Read get_status before changing anything that names an account.';

/**
 * What `proxy.mcp` allows: 'read', 'full', or null for off. Anything but the
 * two exact spellings is off, so a typo cannot widen access.
 * @param {Record<string, any>|undefined} proxyConfig
 * @returns {'read'|'full'|null}
 */
export function mcpMode(proxyConfig) {
  const mode = proxyConfig?.mcp;
  return mode === 'read' || mode === 'full' ? mode : null;
}

/**
 * @param {Record<string, any>|undefined} source
 * @param {string[]} keys
 */
function pick(source, keys) {
  if (!source) return undefined;
  return Object.fromEntries(keys.filter(k => source[k] !== undefined).map(k => [k, source[k]]));
}

/**
 * The fleet at a glance. Built from the status payload rather than handed over
 * whole: that payload names every session, client and usage dimension, carries
 * raw upstream error text, and runs to a size no model context should pay for.
 * @param {ToolContext} ctx
 */
function fleetStatus({ accountManager, hooks }) {
  const status = accountManager.getStatus();
  const extra = hooks.getStatusExtra?.() || {};
  return {
    server: pick(extra.server, ['version', 'startedAt', 'uptimeSeconds', 'port']),
    currentAccount: status.currentAccount,
    sessions: {
      active: status.sessions.active,
      known: status.sessions.known,
      draining: status.sessions.draining,
      mode: status.sessions.mode,
    },
    accounts: status.accounts.map((a, index) => {
      const quota = Object.fromEntries(Object.entries(a.quota)
        .filter(([, value]) => value != null && !(typeof value === 'object' && Object.keys(value).length === 0)));
      return {
        // Verbatim, as in /teamclaude/status: these are what a caller hands
        // back to name an account, and the match is exact.
        name: a.name,
        ...(a.orgName ? { orgName: a.orgName } : {}),
        type: a.type,
        provider: a.provider,
        priority: a.priority,
        disabled: a.disabled,
        status: a.status,
        // Already password-masked by the status payload.
        ...(a.routing ? { routing: a.routing } : {}),
        current: index === accountManager.currentIndex,
        ...accountManager.eligibility(index),
        sessions: a.sessions,
        ...(Object.keys(quota).length ? { quota } : {}),
        ...(a.rateLimitedUntil ? { rateLimitedUntil: a.rateLimitedUntil } : {}),
        ...(a.pausedUntil ? { pausedUntil: a.pausedUntil } : {}),
      };
    }),
    probe: pick(extra.probe, ['enabled', 'intervalSeconds', 'running']),
    warm: pick(extra.warm, ['enabled', 'intervalSeconds', 'running']),
    upstreamPool: upstreamPoolStatus(),
  };
}

/**
 * The settings the write tools change. Named one by one: the config object
 * also holds the proxy keys, the sx.org key, the egress proxy URL and every
 * account credential, and none of those may ride along.
 * @param {ToolContext} ctx
 */
function tunableSettings({ config }) {
  return {
    switchThreshold: config.switchThreshold ?? null,
    distribution: distributionMode(config.distributeSessions),
    quotaProbeSeconds: config.quotaProbeSeconds || 0,
    warmupSeconds: config.warmupSeconds || 0,
    warmupSchedule: config.warmupSchedule || null,
    routes: config.routes || [],
    blockedModels: config.blockedModels || [],
    defaultClientMode: config.defaultClientMode === 'base-url' ? 'base-url' : 'mitm',
    mcp: mcpMode(config.proxy),
  };
}

/** @type {Tool[]} */
const READ_TOOLS = [
  {
    name: 'get_status',
    title: 'Fleet status',
    description: 'The running proxy at a glance: server version and uptime, the account in use, and for every account its priority, whether it is disabled, whether rotation can use it right now (and why not), its session count and its known quota windows.',
    run: (_args, ctx) => fleetStatus(ctx),
  },
  {
    name: 'get_quota',
    title: 'Fleet quota',
    description: 'Per-account quota utilization and reset times, with tier-weighted fleet aggregates. Reads what the proxy has already observed; it never calls upstream.',
    run: (_args, { accountManager, hooks }) => ({ ...accountManager.getQuotaSummary(), ...(hooks.getQuotaExtra?.() || {}) }),
  },
  {
    name: 'get_settings',
    title: 'Rotation settings',
    description: 'The settings that steer rotation: switch threshold (a 0-1 ratio, or a per-bucket table), session distribution mode, quota probe and keep-warm intervals, the keep-warm schedule, the model routes, the blocked-model patterns, the default client mode, and the MCP access mode.',
    run: (_args, ctx) => tunableSettings(ctx),
  },
];

/**
 * The manager index of the one account `args` names. A name that fits several
 * accounts is refused rather than resolved to the first: for a removal, the
 * first match is the wrong one often enough.
 * @param {ToolContext} ctx
 * @param {Record<string, any>} args
 */
function accountIndexFor({ accountManager }, { account, org }) {
  const matches = matchAccounts(accountManager.accounts, account, org);
  if (matches.length === 1) return accountManager.accounts.indexOf(matches[0]);
  if (matches.length === 0) {
    throw new ToolFailure(`no account "${account}"${org ? ` in organization "${org}"` : ''}; get_status lists the names`);
  }
  throw new ToolFailure(`"${account}" matches ${matches.length} accounts — narrow it with "org": ${matches.map((/** @type {any} */ a) => `"${a.name}"`).join(', ')}`);
}

/**
 * Change one account in the running fleet and in its config entry, then save,
 * the way the TUI does. Not a file edit plus reload: a reload applies a
 * disk-side priority or disabled flag to the manager without mirroring it onto
 * the entry the next save is built from.
 * @param {ToolContext} ctx
 * @param {Record<string, any>} args
 * @param {(index: number, entry: Record<string, any>|null, entryIndex: number) => void} mutate
 */
async function changeAccount(ctx, args, mutate) {
  const { accountManager, config, hooks } = ctx;
  if (!hooks.persistAccounts) {
    throw new ToolFailure('this server cannot save account changes; edit the config file and reload_config instead');
  }
  const index = accountIndexFor(ctx, args);
  const name = accountManager.accounts[index].name;
  // Resolved before the change: a removal splices the manager's list.
  const entryIndex = configIndexFor(config.accounts, accountManager.accounts, index);
  mutate(index, entryIndex >= 0 ? config.accounts[entryIndex] : null, entryIndex);
  try {
    await hooks.persistAccounts();
  } catch (err) {
    // The fleet has already changed; a plain "failed" would send the caller
    // away believing nothing happened, and the next restart would prove it wrong.
    console.error('[TeamClaude] MCP: saving an account change failed:', err instanceof Error ? err.message : err);
    throw new ToolFailure(`${name}: changed in the running server, but the config file could not be saved; see the proxy log`);
  }
  return { account: name, persisted: entryIndex >= 0 };
}

/**
 * Change a setting the way the CLI does: in the file, under the config lock,
 * then a reload applies it to the running server. A refusal from `apply`
 * writes nothing.
 * @template T
 * @param {ToolContext} ctx
 * @param {(disk: Record<string, any>) => T} apply
 * @returns {Promise<T>}
 */
async function changeSetting({ hooks }, apply) {
  /** @type {T|undefined} */
  let outcome;
  await atomicConfigUpdate((/** @type {Record<string, any>} */ disk) => { outcome = apply(disk); });
  try {
    if (!hooks.reload) throw new Error('this server has no reload hook');
    await hooks.reload();
  } catch (err) {
    console.error('[TeamClaude] MCP: reload after a settings change failed:', err instanceof Error ? err.message : err);
    throw new ToolFailure('saved to the config file, but the reload failed; see the proxy log');
  }
  return /** @type {T} */ (outcome);
}

/** @type {Tool[]} */
const WRITE_TOOLS = [
  {
    name: 'switch_account',
    title: 'Switch account',
    description: 'Make one account the preferred one for new requests, as the TUI\'s switch key does. A weak preference: rotation leaves it as soon as it is unavailable or outranked, and the answer says whether traffic will follow.',
    properties: ACCOUNT_ARGS,
    required: ['account'],
    write: true,
    run: (args, ctx) => {
      const index = accountIndexFor(ctx, args);
      ctx.accountManager.setCurrentAccount(index);
      return { account: ctx.accountManager.accounts[index].name, ...ctx.accountManager.eligibility(index) };
    },
  },
  {
    name: 'reload_config',
    title: 'Reload config',
    description: 'Re-read the config file and apply it to the running server without a restart: accounts added, removed or edited on disk, client keys, routes, thresholds and the other settings. Returns how many accounts were added and how many were removed.',
    write: true,
    run: async (_args, { hooks }) => {
      if (!hooks.reload) throw new ToolFailure('reload is not available on this server');
      const r = await hooks.reload();
      return { added: r?.added || 0, removed: r?.removed || 0 };
    },
  },
  {
    name: 'probe_quota',
    title: 'Probe quota',
    description: 'Refresh every account\'s quota from the usage endpoint now, as the TUI\'s probe key does. Spends no quota; takes a few seconds.',
    write: true,
    run: async (_args, { hooks }) => {
      if (!hooks.probeQuota) throw new ToolFailure('the quota probe is not available on this server');
      await hooks.probeQuota();
      return { ok: true };
    },
  },
  {
    name: 'set_account_enabled',
    title: 'Enable or disable an account',
    description: 'Take an account out of rotation, or put it back (which also clears a stuck error state). Saved to the config file.',
    properties: { ...ACCOUNT_ARGS, enabled: { type: 'boolean' } },
    required: ['account', 'enabled'],
    write: true,
    run: (args, ctx) => changeAccount(ctx, args, (index, entry) => {
      ctx.accountManager.setDisabled(index, !args.enabled);
      // An explicit boolean, never a deleted key: the save merges over the
      // on-disk entry, and a missing key leaves a stale `disabled: true` standing.
      if (entry) entry.disabled = !args.enabled;
    }).then(outcome => ({ ...outcome, enabled: args.enabled })),
  },
  {
    name: 'set_account_priority',
    title: 'Set account priority',
    description: 'Set an account\'s rotation priority: lower is preferred, default 0, negative allowed. Saved to the config file.',
    properties: { ...ACCOUNT_ARGS, priority: { type: 'integer' } },
    required: ['account', 'priority'],
    write: true,
    run: (args, ctx) => changeAccount(ctx, args, (index, entry) => {
      ctx.accountManager.accounts[index].priority = args.priority;
      if (entry) entry.priority = args.priority;
    }).then(outcome => ({ ...outcome, priority: args.priority })),
  },
  {
    name: 'set_account_routing',
    title: 'Set or clear account routing',
    description: 'Pin one account\'s egress to its own proxy: EVERY connection for it (completions, token refresh, profile and quota) tunnels through, no other account is touched, and the account bypasses the fleet upstream proxy and sx. URL schemes: http (CONNECT), socks4, socks4a, socks5, socks5h (a/h resolve hostnames at the proxy), optional user:pass@ auth — e.g. socks5h://alice:s3cret@proxy.example.com:1080. An empty value (or "none"/"off") clears it back to the fleet egress. Saved to the config file.',
    properties: { ...ACCOUNT_ARGS, routing: { type: 'string', description: 'The proxy URL, or an empty value / "none" / "off" to clear' } },
    required: ['account', 'routing'],
    write: true,
    // The URL carries the proxy password, and the write log is not a place for it.
    auditArgs: args => ({ ...args, routing: maskRoutingUrl(args.routing) }),
    run: (args, ctx) => {
      /** @type {import('./account-routing.js').RoutingProxy|null} */
      let routing = null;
      if (!/^\s*(|none|off|-)$/i.test(String(args.routing ?? ''))) {
        try {
          routing = parseRoutingUrl(String(args.routing));
        } catch (/** @type {any} */ err) {
          throw new ToolFailure(err?.message || String(err));
        }
        // This server's own listener: a request tunnelled through it would
        // come straight back in (the MITM listener intercepts the upstream
        // host). The server drops such a routing on load anyway, so saving it
        // would only store a value it then ignores.
        if (isSelfProxy(routing, localListener(ctx.config))) {
          throw new ToolFailure(`${describeRouting(routing)} is this server's own address; routing an account through it would loop back into this proxy`);
        }
      }
      return changeAccount(ctx, args, (index, entry) => {
        ctx.accountManager.setRouting(index, routing);
        // Null, not a deleted key: the save merges over the on-disk entry, and
        // a missing key leaves a stale `routing` standing (the same reason
        // set_account_enabled writes an explicit boolean).
        if (entry) entry.routing = routing ? routingToUrl(routing) : null;
      }).then(outcome => ({ ...outcome, routing: describeRouting(routing) }));
    },
  },
  {
    name: 'remove_account',
    title: 'Remove account',
    description: 'Remove an account from the fleet and from the config file, credentials included. There is no undo; disable it instead when in doubt.',
    properties: ACCOUNT_ARGS,
    required: ['account'],
    write: true,
    run: (args, ctx) => changeAccount(ctx, args, (index, entry, entryIndex) => {
      ctx.accountManager.removeAccount(index);
      if (entry) {
        // The save adopts rows on disk that are not in memory, so the entry has
        // to be marked before it goes or the save would read it back in.
        markAccountRemoved(ctx.config, entry.id);
        ctx.config.accounts.splice(entryIndex, 1);
      }
    }).then(outcome => ({ ...outcome, removed: true })),
  },
  {
    name: 'set_threshold',
    title: 'Set switch threshold',
    description: 'The utilization (1-100 percent) at which rotation leaves an account. Give `percent` for one number governing every quota bucket, or `buckets` with a percentage per bucket (null drops that bucket\'s override); the bucket names are those get_settings shows under switchThreshold. Saved and applied live.',
    properties: {
      percent: { type: 'number' },
      buckets: {
        type: 'object',
        description: 'e.g. {"unified7d": 90, "unified5h": null}',
        // The validator already refuses any other key; saying so here lets the
        // model pick a valid bucket without a refusal round trip.
        propertyNames: { enum: ['default', ...QUOTA_BUCKETS] },
        additionalProperties: { type: ['number', 'null'] },
      },
    },
    write: true,
    run: (args, ctx) => {
      if ((args.percent === undefined) === (args.buckets === undefined)) {
        throw new ToolFailure('give either percent or buckets');
      }
      if (args.buckets !== undefined && Object.keys(args.buckets).length === 0) {
        throw new ToolFailure('buckets names at least one bucket');
      }
      return changeSetting(ctx, disk => {
        if (args.percent !== undefined) {
          const { dropped } = setThreshold(disk, args.percent);
          return { switchThreshold: disk.switchThreshold, dropped };
        }
        setBucketThresholds(disk, Object.entries(args.buckets));
        return { switchThreshold: disk.switchThreshold };
      });
    },
  },
  {
    name: 'set_distribution',
    title: 'Set session distribution',
    description: `How new sessions are spread across equal-priority accounts. ${Object.entries(DISTRIBUTE_MODES).map(([mode, m]) => `${mode}: ${m.said}`).join(' ')} Saved and applied live.`,
    properties: { mode: { type: 'string', enum: Object.keys(DISTRIBUTE_MODES) } },
    required: ['mode'],
    write: true,
    run: (args, ctx) => changeSetting(ctx, disk => ({ distribution: args.mode, changed: setDistribution(disk, args.mode) })),
  },
  {
    name: 'set_probe_interval',
    title: 'Set quota probe interval',
    description: 'How often idle accounts\' quota is refreshed from the usage endpoint, in seconds; 0 turns the probe off. Spends no quota. Saved and applied live.',
    properties: { seconds: { type: 'integer' } },
    required: ['seconds'],
    write: true,
    run: (args, ctx) => changeSetting(ctx, disk => { setProbeSeconds(disk, args.seconds); return { quotaProbeSeconds: disk.quotaProbeSeconds }; }),
  },
  {
    name: 'set_warmup',
    title: 'Set keep-warm',
    description: 'Keep idle accounts\' five-hour windows running by sending each a minimal request, which spends a little quota. Either `seconds` for an interval (0 turns it off), or a schedule: `mode` "reset" for a daily target or "rolling" for a five-hour cadence, with `time` (HH:MM) and `timezone` (IANA name). Saved and applied live.',
    properties: {
      seconds: { type: 'integer' },
      mode: { type: 'string', enum: ['reset', 'rolling'] },
      time: { type: 'string' },
      timezone: { type: 'string' },
    },
    write: true,
    run: (args, ctx) => {
      const scheduled = args.mode !== undefined || args.time !== undefined || args.timezone !== undefined;
      if ((args.seconds === undefined) === !scheduled) {
        throw new ToolFailure('give either seconds or a schedule (mode, time, timezone)');
      }
      if (args.mode !== undefined && (!args.time || !args.timezone)) {
        throw new ToolFailure('a schedule needs time and timezone');
      }
      return changeSetting(ctx, disk => {
        if (args.seconds !== undefined) setWarmupSeconds(disk, args.seconds);
        else setWarmupSchedule(disk, args.mode, { resetTime: args.time, timezone: args.timezone });
        return { warmupSeconds: disk.warmupSeconds || 0, warmupSchedule: disk.warmupSchedule || null };
      });
    },
  },
  {
    name: 'set_route',
    title: 'Add or replace a route',
    description: 'Pin model ids matching the globs in `match` to the accounts in `accounts` (names, or indexes written as strings; omit to route to every account). Replaces a route already holding the name. `bucket` overrides the quota bucket the route is judged by; `color` tints its TUI marker. Saved and applied live.',
    properties: {
      name: { type: 'string' },
      match: { type: 'array', items: { type: 'string' }, description: 'Model id globs, e.g. ["claude-opus-*"]' },
      accounts: { type: 'array', items: { type: 'string' }, description: 'Account names, or indexes as strings, e.g. ["0", "work@example.com"]' },
      bucket: { type: 'string', enum: [...WEEKLY_BUCKET_KEYS] },
      color: { type: 'string' },
    },
    required: ['name', 'match'],
    write: true,
    run: (args, ctx) => changeSetting(ctx, disk => upsertRoute(disk, args)),
  },
  {
    name: 'remove_route',
    title: 'Remove a route',
    description: 'Delete a route by name. Saved and applied live.',
    properties: { name: { type: 'string' } },
    required: ['name'],
    write: true,
    run: (args, ctx) => changeSetting(ctx, disk => { removeRoute(disk, args.name); return { removed: args.name }; }),
  },
  {
    name: 'set_blocked_models',
    title: 'Set blocked models',
    description: 'Replace the list of model-id globs the proxy refuses outright. Saved and applied live.',
    properties: { patterns: { type: 'array', items: { type: 'string' } } },
    required: ['patterns'],
    write: true,
    run: (args, ctx) => changeSetting(ctx, disk => { setBlockedModels(disk, args.patterns); return { blockedModels: disk.blockedModels }; }),
  },
  {
    name: 'set_client_mode',
    title: 'Set default client mode',
    description: 'How `teamclaude run` and `teamclaude env` point Claude Code at the proxy by default: "mitm" (an HTTPS forward proxy with a local CA, which also catches hardcoded endpoints) or "base-url" (ANTHROPIC_BASE_URL only). Read by the next run; the server itself is unaffected.',
    properties: { mode: { type: 'string', enum: ['mitm', 'base-url'] } },
    required: ['mode'],
    write: true,
    run: (args, ctx) => changeSetting(ctx, disk => { setDefaultClientMode(disk, args.mode); return { defaultClientMode: disk.defaultClientMode }; }),
  },
];

// Write tools run one at a time. A client may issue several calls at once,
// and a reload started by one reads the disk before a removal made by another
// has been saved — then re-adds the removed account from that stale read.
let writeQueue = Promise.resolve();

// Every turn of the queue settles within this long. A reload can hang on an
// upstream that accepts the connection and then says nothing; one caller
// waiting on that is one thing, every later write waiting behind it until a
// restart is another. The price: a turn that finishes after its timeout still
// has its side effects, now out of order with whatever ran meanwhile, so for
// that one turn the stale-read re-add above is possible again. A permanent
// wedge is worse.
const WRITE_TIMEOUT_MS = 60_000;

// How many writes may wait their turn. A client that loops tool calls would
// otherwise stack up every one of them, each holding its request open for up
// to WRITE_TIMEOUT_MS after the one before. Past the cap a call is refused at
// once with a tool error the model can read and retry later. Counted across
// every tool set in the process, as the queue itself is.
const WRITE_QUEUE_DEPTH = 8;
let writesPending = 0;

/**
 * `pending`, or a tool error once `ms` have passed without it settling. The
 * work is not cancelled — a hook has nothing to cancel it with — so a late
 * result is dropped, and the log says so. Never rejects: a rejection here
 * would reach the process-wide handler and take the proxy down.
 * @param {Promise<Record<string, any>>} pending
 * @param {number} ms
 * @param {string} toolName
 * @returns {Promise<Record<string, any>>}
 */
function settleWithin(pending, ms, toolName) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      console.error(`[TeamClaude] MCP ${toolName} did not finish within ${ms} ms; later writes no longer wait for it`);
      resolve({ content: [{ type: 'text', text: `${toolName} did not finish within ${Math.round(ms / 1000)}s; see the proxy log` }], isError: true });
    }, ms);
    /** @type {(value: Record<string, any>) => void} */
    const done = value => { clearTimeout(timer); resolve(value); };
    pending.then(done, err => {
      console.error(`[TeamClaude] MCP ${toolName} failed:`, err instanceof Error ? err.message : err);
      done({ content: [{ type: 'text', text: `${toolName} failed; see the proxy log` }], isError: true });
    });
  });
}

/**
 * Why `args` does not fit a tool's declared properties, or null when it does.
 * Covers what the tools here declare — a type, an enum, a list of strings —
 * and refuses a key the tool does not declare, so a misspelt argument is an
 * error rather than a silently ignored one.
 * @param {Tool} tool
 * @param {Record<string, any>} args
 * @returns {string|null}
 */
function argumentProblem(tool, args) {
  const properties = tool.properties || {};
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) return `${tool.name} takes no argument "${key}"`;
  }
  for (const key of tool.required || []) {
    if (args[key] === undefined) return `${tool.name} needs "${key}"`;
  }
  for (const [key, spec] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined) continue;
    const fits = spec.type === 'integer' ? Number.isInteger(value)
      : spec.type === 'array' ? Array.isArray(value) && value.every(item => typeof item === 'string')
        : spec.type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
          : typeof value === spec.type;
    if (!fits) return `"${key}" must be ${spec.type === 'array' ? 'a list of strings' : `of type ${spec.type}`}`;
    if (spec.enum && !spec.enum.includes(value)) return `"${key}" must be one of: ${spec.enum.join(', ')}`;
  }
  return null;
}

/**
 * The tools a mode exposes, in a fixed order. In 'read' mode the write tools
 * are not merely hidden: a call to one is an unknown tool.
 * @param {'read'|'full'} mode
 * @param {ToolContext} ctx
 * @param {{ writeTimeoutMs?: number, writeQueueDepth?: number }} [options]
 * @returns {import('./mcp.js').ToolSet}
 */
export function createToolSet(mode, ctx, { writeTimeoutMs = WRITE_TIMEOUT_MS, writeQueueDepth = WRITE_QUEUE_DEPTH } = {}) {
  const tools = new Map([...READ_TOOLS, ...(mode === 'full' ? WRITE_TOOLS : [])].map(tool => [tool.name, tool]));

  const caller = ctx.client ? sanitizeText(ctx.client) : 'a local caller';
  /** @type {(tool: Tool, args: Record<string, any>, outcome: string) => void} */
  const audit = (tool, args, outcome) => {
    // auditArgs masks what must not reach the log (a proxy password in a routing URL).
    const shown = tool.auditArgs ? tool.auditArgs(args) : args;
    console.log(`[TeamClaude] MCP ${tool.name} by ${caller}${outcome}: ${sanitizeText(JSON.stringify(shown)).slice(0, 300)}`);
  };

  /** @type {(tool: Tool, args: Record<string, any>) => Promise<Record<string, any>>} */
  const run = async (tool, args) => {
    try {
      const value = await tool.run(args, ctx);
      // Logged once the change has landed, as POST /teamclaude/switch does: the
      // line is a record of what happened, not of what was attempted, so a call
      // that was refused or blew up never reads like a change that went through.
      if (tool.write) audit(tool, args, '');
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (err) {
      /** @type {string} */
      let text;
      if (err instanceof ToolFailure || err instanceof ConfigOpError) {
        text = err.message;
        if (tool.write) audit(tool, args, ` refused (${sanitizeText(text).slice(0, 120)})`);
      } else {
        // Ours, not the caller's: the detail goes to the log, as the other
        // control endpoints do with a failure that may name paths or accounts.
        console.error(`[TeamClaude] MCP ${tool.name} failed:`, err instanceof Error ? err.message : err);
        text = `${tool.name} failed; see the proxy log`;
      }
      return { content: [{ type: 'text', text }], isError: true };
    }
  };

  return {
    list: () => [...tools.values()].map(tool => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: tool.properties || {},
        ...(tool.required?.length ? { required: tool.required } : {}),
        additionalProperties: false,
      },
      // No destructiveHint: its default is true, and false would promise
      // additive-only updates, which a setter that replaces a value does not keep.
      annotations: { readOnlyHint: !tool.write },
    })),
    call: async (name, args) => {
      const tool = tools.get(name);
      if (!tool) throw new McpError(INVALID_PARAMS, `Unknown tool: ${name}`);
      // A tool error, not a protocol one: the protocol keeps -32602 for a call
      // that is malformed as a call, and files arguments a tool's own schema
      // refuses under input validation — the kind of error a client hands to
      // the model, which can then correct itself.
      const problem = argumentProblem(tool, args);
      if (problem) return { content: [{ type: 'text', text: problem }], isError: true };
      if (!tool.write) return run(tool, args);
      if (writesPending >= writeQueueDepth) {
        return { content: [{ type: 'text', text: `${tool.name} refused: ${writesPending} writes are already waiting their turn; try again once they have finished` }], isError: true };
      }
      writesPending++;
      const turn = writeQueue.then(() => settleWithin(run(tool, args), writeTimeoutMs, tool.name));
      writeQueue = turn.then(() => {}, () => {});
      writeQueue.then(() => { writesPending--; });
      return turn;
    },
  };
}

/**
 * The mode one caller is served in. A named client key never gets more than
 * 'read', whatever the config says: those keys are handed to the machines and
 * people who use the fleet, and everywhere else in the control plane one can
 * switch, reload and probe at most. The write tools go well past that —
 * remove_account deletes credentials from disk, and a blocklist or a route can
 * refuse service to everyone — so they stay with the operator: the shared
 * `proxy.apiKey`, or a caller on this machine that needed no key. Both arrive
 * here with no client name.
 * @param {'read'|'full'} mode what `proxy.mcp` allows
 * @param {string|null|undefined} client the name a client key authenticated as
 * @returns {'read'|'full'}
 */
export function modeFor(mode, client) {
  return client ? 'read' : mode;
}

/**
 * Serve /teamclaude/mcp. The caller has already passed the proxy's own gates.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {ToolContext & { readBody: (req: import('node:http').IncomingMessage) => Promise<string> }} deps
 */
export async function serveManagementMcp(req, res, { readBody, ...ctx }) {
  const mode = mcpMode(ctx.config.proxy);
  if (!mode) {
    // Answered here rather than left to fall through: an unclaimed path is
    // forwarded upstream with a fleet credential attached.
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'the MCP endpoint is off; set proxy.mcp to "read" or "full" to serve it' }));
    return;
  }
  await serveMcp(req, res, { readBody, tools: createToolSet(modeFor(mode, ctx.client), ctx), serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
}
