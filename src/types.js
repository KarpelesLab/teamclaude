// JSDoc typedefs shared across modules. Nothing here runs: `npm run typecheck`
// (tsc over the plain-JS sources, see tsconfig.json) reads these through
// `@typedef {import('./types.js').Name} Name` in the modules that use them.

/**
 * An Error carrying the fields Node and this codebase hang on one: `code` (an
 * errno such as ECONNRESET, or one of the TEAMCLAUDE_* codes the proxy mints),
 * `status` (the HTTP status a refused request was answered with) and
 * `answered` (whether that status came from a teamclaude control plane).
 *
 * @typedef {Error & { code?: string, status?: number, answered?: boolean }} CodedError
 */

export {};
