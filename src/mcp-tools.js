import { distributionMode } from './account-manager.js';
import { McpError, serveMcp } from './mcp.js';
import { sanitizeText } from './safe-text.js';
import { currentVersion } from './updater.js';
import { upstreamPoolStatus } from './upstream-fetch.js';

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
 *   run: (args: Record<string, any>, ctx: ToolContext) => Record<string, any>|Promise<Record<string, any>>,
 * }} Tool
 */

const INVALID_PARAMS = -32602;

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
 * The tools a mode exposes, in a fixed order.
 * @param {'read'|'full'} _mode
 * @param {ToolContext} ctx
 * @returns {import('./mcp.js').ToolSet}
 */
export function createToolSet(_mode, ctx) {
  const tools = new Map(READ_TOOLS.map(tool => [tool.name, tool]));
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
      annotations: { readOnlyHint: true },
    })),
    call: async (name, args) => {
      const tool = tools.get(name);
      if (!tool) throw new McpError(INVALID_PARAMS, `Unknown tool: ${name}`);
      const problem = argumentProblem(tool, args);
      if (problem) throw new McpError(INVALID_PARAMS, problem);
      const value = await tool.run(args, ctx);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    },
  };
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
  await serveMcp(req, res, { readBody, tools: createToolSet(mode, ctx), serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
}
