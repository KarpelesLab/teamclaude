/**
 * A Model Context Protocol server over Streamable HTTP, tools only, answering
 * every request with a single JSON object.
 *
 * It speaks two eras of the protocol on one endpoint, because clients in the
 * field are split between them:
 *   - the stateless revision, where each request carries its protocol version
 *     and client identity in `params._meta`, mirrored into HTTP headers the
 *     server has to check against the body;
 *   - the handshake revisions before it, which open with `initialize`.
 * A request that carries the body metadata (or the stateless version header)
 * is held to the stateless rules; anything else is served as the handshake era.
 * No session id is issued in either: the handshake revisions make it optional,
 * and nothing here needs state between requests.
 *
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
 *
 * @typedef {Record<string, string|string[]|undefined>} Headers
 * @typedef {{ name: string, version: string }} ServerInfo
 * @typedef {{ status: number, body: Record<string, any>|null }} McpReply
 * @typedef {{
 *   list: () => Array<Record<string, any>>,
 *   call: (name: string, args: Record<string, any>) => Promise<Record<string, any>>,
 * }} ToolSet `call` throws an McpError for a protocol-level refusal (unknown
 *   tool, arguments that do not fit the schema); a tool that ran and failed
 *   returns a result with `isError: true` instead.
 */

const STATELESS_VERSION = '2026-07-28';
const HANDSHAKE_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SUPPORTED_VERSIONS = [STATELESS_VERSION, ...HANDSHAKE_VERSIONS];

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

/** A JSON-RPC error to send back as is. The message reaches the client. */
export class McpError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   * @param {Record<string, any>} [data]
   * @param {number} [status] the HTTP status, where the protocol names one
   *   that the code alone does not imply
   */
  constructor(code, message, data, status) {
    super(message);
    this.code = code;
    this.data = data;
    this.status = status;
  }
}

/**
 * @param {Headers} headers
 * @param {string} name lowercase, as Node stores header names
 * @returns {string|undefined}
 */
function header(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A mirrored header value, with the base64 wrapping a client uses for a value
 * that is not plain ASCII undone.
 * @param {string|undefined} value
 */
function mirrored(value) {
  if (value === undefined) return undefined;
  const wrapped = /^=\?base64\?(.*)\?=$/.exec(value);
  return wrapped ? Buffer.from(wrapped[1], 'base64').toString('utf8') : value;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The HTTP status a JSON-RPC error travels with. The stateless revision maps
 * three of them onto 4xx so a client can tell this server from an older one
 * before reading the body; the handshake era reports errors in a 200.
 * @param {number} code
 * @param {boolean} stateless
 */
function statusFor(code, stateless) {
  if (code === PARSE_ERROR || code === INVALID_REQUEST) return 400;
  if (code === HEADER_MISMATCH || code === UNSUPPORTED_VERSION) return 400;
  if (code === METHOD_NOT_FOUND && stateless) return 404;
  return 200;
}

/**
 * Hold a stateless-revision request to its headers: a gateway may route on
 * them, so a body that says something else must not be executed.
 * @param {Headers} headers
 * @param {string} method
 * @param {Record<string, any>} params
 */
function checkMirroredHeaders(headers, method, params) {
  const bodyVersion = params._meta?.[META_VERSION];
  const headerVersion = header(headers, 'mcp-protocol-version');
  if (headerVersion === undefined || headerVersion !== bodyVersion) {
    throw new McpError(HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version does not match the protocol version in the request body');
  }
  if (bodyVersion !== STATELESS_VERSION) {
    throw new McpError(UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: bodyVersion });
  }
  if (!isObject(params._meta?.[META_CLIENT_CAPABILITIES])) {
    throw new McpError(INVALID_PARAMS, `Malformed request: _meta is missing ${META_CLIENT_CAPABILITIES}`, undefined, 400);
  }
  if (header(headers, 'mcp-method') !== method) {
    throw new McpError(HEADER_MISMATCH, 'Header mismatch: Mcp-Method does not match the method in the request body');
  }
  if (method === 'tools/call' && mirrored(header(headers, 'mcp-name')) !== params.name) {
    throw new McpError(HEADER_MISMATCH, 'Header mismatch: Mcp-Name does not match the tool name in the request body');
  }
}

/**
 * @param {string} method
 * @param {Record<string, any>} params
 * @param {boolean} stateless
 * @param {{ tools: ToolSet, serverInfo: ServerInfo, instructions?: string }} server
 * @returns {Promise<Record<string, any>>}
 */
async function dispatch(method, params, stateless, { tools, serverInfo, instructions }) {
  // The stateless revision requires caching hints on a list or discover
  // result, and a client that validates results refuses one without them.
  // Public: neither result holds anything about the caller. The tool list is
  // kept short-lived because the mode that decides it can change on a reload,
  // and nothing here pushes a list_changed notification.
  const cacheable = (/** @type {number} */ ttlMs) => stateless ? { ttlMs, cacheScope: 'public' } : {};
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: tools.list(), ...cacheable(60_000) };
  if (method === 'tools/call') {
    const args = params.arguments ?? {};
    if (typeof params.name !== 'string' || !isObject(args)) {
      throw new McpError(INVALID_PARAMS, 'tools/call needs a tool name and, when given, an object of arguments');
    }
    return tools.call(params.name, args);
  }
  if (method === 'server/discover') {
    return {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      ...(instructions ? { instructions } : {}),
      ...cacheable(3_600_000),
    };
  }
  if (method === 'initialize' && !stateless) {
    const asked = params.protocolVersion;
    return {
      protocolVersion: HANDSHAKE_VERSIONS.includes(asked) ? asked : HANDSHAKE_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo,
      ...(instructions ? { instructions } : {}),
    };
  }
  throw new McpError(METHOD_NOT_FOUND, `Method not found: ${method}`);
}

/**
 * Answer one JSON-RPC message.
 * @param {{ bodyText: string, headers: Headers, tools: ToolSet, serverInfo: ServerInfo, instructions?: string }} input
 * @returns {Promise<McpReply>}
 */
export async function handleMcpMessage({ bodyText, headers, tools, serverInfo, instructions }) {
  /** @type {(id: unknown, code: number, message: string, stateless: boolean, data?: Record<string, any>, status?: number) => McpReply} */
  const failure = (id, code, message, stateless, data, status) => ({
    status: status ?? statusFor(code, stateless),
    body: { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } },
  });

  /** @type {unknown} */
  let message;
  try {
    message = JSON.parse(bodyText);
  } catch {
    return failure(null, PARSE_ERROR, 'Parse error', false);
  }
  // Batching left the protocol in 2025-06-18; an array is not a request.
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    const id = isObject(message) && message.id !== undefined ? message.id : null;
    return failure(id, INVALID_REQUEST, 'Invalid Request', false);
  }
  if (message.id === undefined || message.id === null) return { status: 202, body: null };

  const { id, method } = message;
  const params = isObject(message.params) ? message.params : {};
  const stateless = params._meta?.[META_VERSION] !== undefined
    || header(headers, 'mcp-protocol-version') === STATELESS_VERSION;

  try {
    if (stateless) checkMirroredHeaders(headers, method, params);
    const result = await dispatch(method, params, stateless, { tools, serverInfo, instructions });
    if (!stateless) return { status: 200, body: { jsonrpc: '2.0', id, result } };
    // With no session to have learned it from, every result names the server.
    const _meta = { ...result._meta, [META_SERVER_INFO]: serverInfo };
    return { status: 200, body: { jsonrpc: '2.0', id, result: { resultType: 'complete', ...result, _meta } } };
  } catch (err) {
    if (err instanceof McpError) return failure(id, err.code, err.message, stateless, err.data, err.status);
    // Anything else is ours, not the caller's: the reason goes to the log.
    console.error('[TeamClaude] MCP request failed:', err instanceof Error ? err.message : err);
    return failure(id, INTERNAL_ERROR, 'Internal error; see the proxy log', stateless);
  }
}

/**
 * Serve the MCP endpoint for one HTTP request.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   readBody: (req: import('node:http').IncomingMessage) => Promise<string>,
 *   tools: ToolSet,
 *   serverInfo: ServerInfo,
 *   instructions?: string,
 * }} deps `readBody` rejects with the message 'body too large' past its cap
 */
export async function serveMcp(req, res, { readBody, tools, serverInfo, instructions }) {
  /** @type {(status: number, body: Record<string, any>|null, extra?: Record<string, string>) => void} */
  const reply = (status, body, extra = {}) => {
    if (body === null) {
      res.writeHead(status, extra);
      res.end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
    res.end(JSON.stringify(body));
  };
  /** @type {(message: string) => Record<string, any>} */
  const invalid = message => ({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message } });

  // The stateless revision has no GET stream and no session to DELETE, and the
  // handshake revisions let a server decline both the same way.
  if (req.method !== 'POST') {
    reply(405, invalid('Method not allowed: the MCP endpoint takes POST only'), { Allow: 'POST' });
    return;
  }

  let bodyText;
  try {
    bodyText = await readBody(req);
  } catch (err) {
    const tooLarge = err instanceof Error && err.message === 'body too large';
    reply(tooLarge ? 413 : 400, invalid(tooLarge ? 'Request body too large' : 'Invalid request body'));
    return;
  }

  const answer = await handleMcpMessage({ bodyText, headers: req.headers, tools, serverInfo, instructions });
  reply(answer.status, answer.body);
}
