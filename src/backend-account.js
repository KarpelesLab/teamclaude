// API-key backends use the existing passthrough protocol and config lock.
// Keep validation here too: the CLI can be called without the desktop.
/** @param {unknown} input */
export function backendAccount(input) {
  /** @returns {never} */
  function fail() { throw new Error('Invalid backend account settings'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const { name, apiKey, upstream, auth, modelMap, priority = 100 } = /** @type {Record<string, unknown>} */ (input);
  if (typeof name !== 'string' || !name.trim() || name.length > 200 || /^\s*-/.test(name) || /[\x00-\x1f\x7f]/.test(name)) fail();
  if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 512 || /[\s\x00-\x1f\x7f]/.test(apiKey)) fail();
  if (typeof upstream !== 'string' || upstream.length > 2048) fail();
  let url;
  try { url = new URL(upstream); } catch { fail(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail();
  if (auth !== 'bearer' && auth !== 'x-api-key') fail();
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < -1000 || priority > 1000) fail();
  if (!modelMap || typeof modelMap !== 'object' || Array.isArray(modelMap)) fail();
  const pairs = Object.entries(modelMap);
  const model = (/** @type {unknown} */ v) => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
  if (!pairs.length || pairs.length > 50 || pairs.some(([a, b]) => !model(a) || !model(b))) fail();
  return {
    name: name.trim(), priority, upstream: url.href.replace(/\/+$/, '').replace(/\/v1$/, ''), modelMap,
    ...(auth === 'bearer' ? { type: 'oauth', accessToken: apiKey } : { type: 'apikey', apiKey }),
  };
}
