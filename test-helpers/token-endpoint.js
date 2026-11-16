// Preloaded into a CLI child (`node --import <this file> src/index.js login
// ...`) to answer the Anthropic addresses a login or an import reaches, which
// are fixed. The token endpoint gets the JSON that TEAMCLAUDE_TEST_TOKEN_RESPONSE
// holds, and each call writes `token-endpoint stub: answered <grant_type>` to
// stderr, so a test can tell whether a sign-in or a renewal was spent. The
// profile endpoint gets TEAMCLAUDE_TEST_PROFILE_RESPONSE, when it is set. Every
// other fetch is refused. That keeps `login` and `import` off the network,
// since every call they make goes through fetch: proxyFetch calls the global
// fetch when no upstream proxy applies (the test's config says
// `upstreamProxy: false`, and the child's environment names no proxy), and so
// does the reload notice. Only fetch is replaced: a caller that reaches the
// network through node:https or node:net is not stopped by this.
//
// Lives outside test/ because node's default test glob runs everything there.

const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const body = process.env.TEAMCLAUDE_TEST_TOKEN_RESPONSE;
const profile = process.env.TEAMCLAUDE_TEST_PROFILE_RESPONSE;
const json = (/** @type {string} */ text) => new globalThis.Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });

if (body) {
  globalThis.fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
    if (String(url) === TOKEN_ENDPOINT) {
      let grant = '?';
      try { grant = JSON.parse(String(init?.body)).grant_type; } catch { /* not JSON: said as "?" */ }
      process.stderr.write(`token-endpoint stub: answered ${grant}\n`);
      return json(body);
    }
    if (String(url) === PROFILE_URL && profile) return json(profile);
    throw new Error(`token-endpoint stub: no network for ${url}`);
  };
}
