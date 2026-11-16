// Preloaded into a CLI child (`node --import <this file> src/index.js login
// ...`) to answer the OAuth token endpoint, which a login reaches at a fixed
// address: the code exchange gets the JSON that TEAMCLAUDE_TEST_TOKEN_RESPONSE
// holds, and every other fetch is refused. That keeps `login --long-lived` off
// the network, since every call it makes goes through fetch: proxyFetch calls
// the global fetch when no upstream proxy applies (the test's config says
// `upstreamProxy: false`, and the child's environment names no proxy), and so
// does the reload notice. Only fetch is replaced: a caller that reaches the
// network through node:https or node:net is not stopped by this.
//
// Lives outside test/ because node's default test glob runs everything there.

const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const body = process.env.TEAMCLAUDE_TEST_TOKEN_RESPONSE;

if (body) {
  globalThis.fetch = async (/** @type {any} */ url) => {
    if (String(url) === TOKEN_ENDPOINT) {
      return new globalThis.Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`token-endpoint stub: no network for ${url}`);
  };
}
