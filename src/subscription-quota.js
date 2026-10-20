import { readFile } from 'node:fs/promises';

export const isSubscriptionSource = source =>
  ['cursor-subscription', 'antigravity-subscription', 'codex-subscription'].includes(source?.type);
const validPercent = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** Consume CLIProxyAPI's canonical observation; provider auth/parsing stays there. */
export async function fetchSubscriptionQuota(source) {
  try {
    const apiKey = (await readFile(source.apiKeyFile, 'utf8')).trim();
    if (!apiKey || !source.authIndex) throw new Error('Missing management configuration');
    const base = new URL(source.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid URL');
    const response = await fetch(new URL('/v0/management/quota/subscription', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_index: source.authIndex }),
    });
    if (!response.ok) return { error: `Subscription quota HTTP ${response.status}`, status: response.status };
    const data = await response.json();
    if (data.schema !== 'cliproxy.subscription.v1' || !data.snapshot) throw new Error('Invalid observation');
    const q = data.snapshot;
    const subscription = { ...q, observedAt: Date.parse(q.observedAt),
      windows: q.windows.map(w => ({ ...w, resetAt: w.resetAt == null ? null : Date.parse(w.resetAt) })) };
    const admission = subscriptionAdmission({ quotaSource: source, quota: { subscription } });
    if (source.type === 'antigravity-subscription' ? !validAntigravityObservation(subscription)
      : source.type === 'codex-subscription' ? !validCodexObservation(subscription)
        : admission.reason === 'subscription-quota-unknown') throw new Error('Incomplete observation');
    return { subscription };
  } catch {
    return { error: 'Subscription quota unavailable', status: null };
  }
}

/** A stale or failed observation never grants admission, including manual pins.
 * The proxy also checks immediately before inference; this is the routing view. */
export function subscriptionAdmission(account, model = null, now = Date.now()) {
  if (!isSubscriptionSource(account.quotaSource)) return { allowed: true };
  const q = account.quota?.subscription;
  const maxAge = account.quotaSource.maxAgeMs ?? 90000;
  if (!q || account.subscriptionError || !Number.isFinite(q.observedAt)
      || !Number.isFinite(maxAge) || maxAge <= 0 || now < q.observedAt || now - q.observedAt > maxAge
      || !Array.isArray(q.windows) || q.windows.length === 0) {
    return { allowed: false, reason: 'subscription-quota-unknown' };
  }
  if (account.quotaSource.type === 'codex-subscription') {
    if (!validCodexObservation(q) || q.windows.some(w => w.resetAt <= now)) {
      return { allowed: false, reason: 'subscription-quota-unknown' };
    }
    return !q.admissionAllowed || q.windows.some(w => w.usedPercent >= 100)
      ? { allowed: false, reason: 'subscription-quota-exhausted' } : { allowed: true };
  }
  if (account.quotaSource.type === 'antigravity-subscription') {
    return antigravityAdmission(account, model, now);
  }
  let windows = q.windows;
  const expectedPools = ['auto', 'api', 'total'];
  if (q.provider !== 'cursor' || q.windows.length !== 3
      || expectedPools.some(pool => !q.windows.some(w => w?.pool === pool))
      || q.windows.some(w => !w || !expectedPools.includes(w.pool) || !validPercent(w.usedPercent)
        || !Number.isFinite(w.resetAt) || w.resetAt <= now || w.period !== 'monthly')) {
    return { allowed: false, reason: 'subscription-quota-unknown' };
  }
  if (q.provider === 'cursor') {
    if (!Array.isArray(q.autoBucketModels) || !validPercent(q.includedRemaining)) {
      return { allowed: false, reason: 'subscription-quota-unknown' };
    }
    if (q.includedRemaining <= 0) return { allowed: false, reason: 'subscription-quota-exhausted' };
    const actual = account.modelMap?.[model] || model;
    const nativeModel = actual?.replace(/^cursor\//, '');
    const pool = q.autoBucketModels.includes(nativeModel) ? 'auto' : 'api';
    windows = windows.filter(w => w.pool === 'total' || (model ? w.pool === pool : false));
    if (!model && !q.windows.some(w => ['auto', 'api'].includes(w.pool) && w.usedPercent < 100)) {
      return { allowed: false, reason: 'subscription-quota-exhausted' };
    }
  }
  if (windows.some(w => !validPercent(w.usedPercent)
      || (w.resetAt != null && (!Number.isFinite(w.resetAt) || w.resetAt <= now)))) {
    return { allowed: false, reason: 'subscription-quota-unknown' };
  }
  if (windows.some(w => w.usedPercent >= 100)) {
    return { allowed: false, reason: 'subscription-quota-exhausted' };
  }
  return { allowed: true };
}

export function subscriptionSummary(account, now = Date.now()) {
  const q = account.quota?.subscription;
  if (!q) return 'Subscription quota unknown';
  const labels = { fiveHour: '5h', weekly: '7d', monthly: 'monthly' };
  const windows = q.windows.map(w => `${w.pool} ${labels[w.period] || w.period} ${w.disabled ? 'inactive' : w.usedPercent.toFixed(1) + '%'}`).join(' | ');
  const admission = subscriptionAdmission(account, null, now);
  return admission.reason === 'subscription-quota-unknown' ? `${windows} (stale/unavailable)` : windows;
}

// A partial provider response remains visible, but cannot grant admission to
// the absent family. Provider bucket parsing belongs in CLIProxyAPI.
function validAntigravityObservation(q) {
  if (q.provider !== 'antigravity' || !Number.isFinite(q.observedAt)
      || !Array.isArray(q.windows) || !q.windows.length) return false;
  const keys = new Set();
  return q.windows.every(w => {
    if (!w || !['gemini', '3p'].includes(w.pool) || !['5h', 'weekly'].includes(w.period)
        || (w.disabled != null && typeof w.disabled !== 'boolean')
        || !validPercent(w.usedPercent) || w.usedPercent > 100 || !Number.isFinite(w.resetAt)) return false;
    const key = `${w.pool}/${w.period}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function antigravityAdmission(account, model, now) {
  const q = account.quota.subscription;
  const unknown = { allowed: false, reason: 'subscription-quota-unknown' };
  if (!validAntigravityObservation(q)) return unknown;
  const source = account.quotaSource;
  const actual = account.modelMap?.[model] || model;
  const native = actual?.replace(/^antigravity\//, '');
  const selected = source.modelFamilies?.[actual] || source.modelFamilies?.[model]
    || source.family || (native?.startsWith('gemini-') ? 'gemini' : native?.startsWith('claude-') ? '3p' : null);
  const check = pool => {
    const windows = q.windows.filter(w => w.pool === pool);
    if (windows.length !== 2 || windows.some(w => w.resetAt <= now)) return unknown;
    if (windows.some(w => w.usedPercent >= 100)) return { allowed: false, reason: 'subscription-quota-exhausted' };
    return windows.some(w => w.disabled) ? unknown : { allowed: true };
  };
  if (selected) return ['gemini', '3p'].includes(selected) ? check(selected) : unknown;
  if (model) return unknown;
  // Account-level health can stay available while one family is exhausted;
  // every concrete request is checked against its own mapped model again.
  const results = ['gemini', '3p'].map(check);
  if (results.some(r => r.allowed)) return { allowed: true };
  return results.every(r => r.reason === 'subscription-quota-exhausted') ? results[0] : unknown;
}

function validCodexObservation(q) {
  if (q.provider !== 'codex' || !Number.isFinite(q.observedAt) || typeof q.admissionAllowed !== 'boolean'
      || !Array.isArray(q.windows) || q.windows.length < 1 || q.windows.length > 2) return false;
  const pools = new Set();
  return q.windows.every(w => {
    if (!w || !['primary', 'secondary'].includes(w.pool) || pools.has(w.pool)
        || !Number.isSafeInteger(w.windowSeconds) || w.windowSeconds <= 0
        || !validPercent(w.usedPercent) || !Number.isFinite(w.resetAt)) return false;
    const period = w.windowSeconds === 18000 ? '5h' : w.windowSeconds === 604800 ? 'weekly' : `${w.windowSeconds}s`;
    if (w.period !== period) return false;
    pools.add(w.pool);
    return true;
  });
}
