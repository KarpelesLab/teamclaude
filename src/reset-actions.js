// Provider-neutral, on-demand reset details and operator-chosen redemption.
// Manual choices ignore auto policy, but share its replay keys and fleet holds.
import { claudeGrantKind } from './claude-resets.js';
import { weeklyExhausted } from './codex-reset-credits.js';
import { DEFAULT_PROVIDER, providerOf } from './provider.js';
import { safeLine } from './safe-text.js';

/**
 * @typedef {Object} ResetGrant
 * @property {string} id
 * @property {'weekly'|'fable'|'session'|'codex'} kind
 * @property {string|null} label
 * @property {number} resetsLeft
 * @property {number|null} resetsTotal
 * @property {string[]} clears
 * @property {number|null} endsAt
 * @property {boolean} next
 * @property {string|null} blocked  A hard block; warnings never prevent a manual claim.
 * @property {string[]} warnings
 */

/**
 * @typedef {Object} ResetDetails
 * @property {'claude'|'codex'} provider
 * @property {string|null} error  A failed read always has an empty grants list.
 * @property {string|null} ineligibleReason
 * @property {boolean|null} atLimit
 * @property {string[]} exhausted
 * @property {number|null} cooldownUntil
 * @property {number|null} weeklyResetsAt
 * @property {number|null} fleetHoldUntil
 * @property {ResetGrant[]} grants
 */

/**
 * @typedef {Object} ManualRedeemResult
 * @property {boolean} redeemed
 * @property {boolean} uncertain  No verdict was read; the reset may have been spent.
 * @property {string} message  One activity-log line, including the account name.
 * @property {string|null} [result]
 * @property {number|null} [resetsLeft]
 * @property {string[]} [cleared]
 */

/** @param {Record<string, any>} account */
function oauthAccount(account) {
  const provider = providerOf(account);
  return !!account && account.type === 'oauth'
    && (provider === 'codex' || (provider === DEFAULT_PROVIDER && !account.upstream));
}

/** @param {Record<string, any>} account */
function accountBlock(account) {
  if (!oauthAccount(account)) return 'not an OAuth Claude or Codex account';
  if (account.disabled) return 'account is disabled';
  if (providerOf(account) === DEFAULT_PROVIDER && !account.orgUuid) return 'missing Claude organization id';
  return null;
}

/**
 * @param {{ fleetHoldStartedAt: number|null }} redeemer
 * @param {number|null} until
 * @param {number} now
 */
function holdWarning(redeemer, until, now) {
  if (until == null) return [];
  const since = redeemer.fleetHoldStartedAt;
  return [since == null
    ? `a reset landed or may have landed; hold ${Math.ceil((until - now) / 60_000)} min left`
    : `a reset landed or may have landed ${Math.max(0, Math.floor((now - since) / 60_000))} min ago`];
}

/**
 * @param {Object} opts
 * @param {any} opts.accountManager
 * @param {import('./claude-resets.js').ClaudeResetRedeemer} opts.claudeRedeemer
 * @param {import('./codex-reset-credits.js').ResetCreditRedeemer} opts.codexRedeemer
 * @param {() => number} [opts.now]
 */
export function createResetActions({ accountManager, claudeRedeemer, codexRedeemer, now = Date.now }) {
  // One operator action across both providers, including its refresh and read.
  let manualInFlight = false;

  /** @param {Record<string, any>} account */
  function redeemerFor(account) {
    return providerOf(account) === 'codex' ? codexRedeemer : claudeRedeemer;
  }

  /** @param {Record<string, any>} account */
  function holdUntilFor(account) {
    const hold = providerOf(account) === 'codex' ? codexRedeemer.fleetCooldownUntil : claudeRedeemer.fleetHoldUntil;
    return Number.isFinite(hold) && hold > now() ? hold : null;
  }

  /**
   * Always fetch detail rows, never the auto path's cached Codex list. The
   * caller refreshes the token first, so redemption can use this exact read.
   * @param {Record<string, any>} account
   * @returns {Promise<ResetDetails>}
   */
  async function readFresh(account) {
    let at = now();
    const codex = providerOf(account) === 'codex';
    const redeemer = redeemerFor(account);
    const fleetHoldUntil = holdUntilFor(account);
    /** @type {ResetDetails} */
    const details = {
      provider: codex ? 'codex' : 'claude', error: null, ineligibleReason: null,
      atLimit: null, exhausted: [], cooldownUntil: null, weeklyResetsAt: null,
      fleetHoldUntil, grants: [],
    };
    if (!oauthAccount(account)) return { ...details, error: accountBlock(account) };
    try {
      const blocked = accountBlock(account);
      const held = holdWarning(redeemer, fleetHoldUntil, at);
      if (codex) {
        const read = await codexRedeemer.detailsFn(account);
        if (read?.error) return { ...details, error: safeLine(read.error, 120) };
        if (!Array.isArray(read?.credits)) return { ...details, error: 'could not read reset credits' };
        at = now();
        const spent = weeklyExhausted(account, at);
        details.atLimit = spent;
        details.exhausted = spent ? ['weekly'] : [];
        details.weeklyResetsAt = Number.isFinite(account.quota?.unified7dReset) ? account.quota.unified7dReset : null;
        details.grants = read.credits.map((/** @type {import('./codex-reset-credits.js').ResetCredit} */ credit) => ({
          id: credit.id, kind: 'codex', label: credit.title, resetsLeft: credit.status === 'available' ? 1 : 0,
          resetsTotal: null, clears: [], endsAt: credit.expiresAt, next: false,
          blocked: blocked || (credit.status !== 'available' ? `credit is ${safeLine(credit.status || 'unavailable', 32)}`
            : !credit.supportedByPlan ? 'not supported by this plan'
              : credit.expiresAt != null && credit.expiresAt <= at ? 'credit has expired' : null),
          warnings: [...(!spent ? ['weekly window is not exhausted'] : []), ...held],
        }));
      } else {
        const read = await claudeRedeemer.statusFn(account);
        if (read?.error) return { ...details, error: safeLine(read.error, 120) };
        /** @type {import('./claude-resets.js').ResetStatus|null} */
        const status = read?.reset;
        if (!status) return { ...details, error: 'could not read reset status' };
        at = now();
        details.ineligibleReason = status.eligible ? null : status.ineligibleReason;
        details.atLimit = status.atLimit;
        details.exhausted = status.exhausted;
        details.cooldownUntil = status.cooldownUntil;
        details.weeklyResetsAt = status.weeklyResetsAt;
        details.grants = status.grants.map((/** @type {import('./claude-resets.js').ResetStatus['grants'][number]} */ grant) => {
          const warnings = [...held];
          if (!status.atLimit && grant.useRequiresLimit !== false) warnings.push('not at a usage limit — upstream will probably decline; nothing is spent then');
          if (!status.exhausted.some(limit => limit.startsWith('seven_day'))) warnings.push('no weekly limit is exhausted');
          const uncovered = status.exhausted.filter(limit => !grant.clears.includes(limit));
          if (uncovered.length) warnings.push(`does not clear ${safeLine(uncovered.join(', '), 120)}`);
          if (status.cooldownUntil != null && status.cooldownUntil > at) warnings.push('upstream reports a reset cooldown');
          return {
            id: grant.id, kind: claudeGrantKind(grant), label: grant.label,
            resetsLeft: grant.resetsLeft, resetsTotal: grant.resetsTotal, clears: grant.clears,
            endsAt: grant.endsAt, next: grant.id === status.nextGrantId,
            blocked: blocked || (!status.eligible ? `not eligible for resets${status.ineligibleReason ? ` (${status.ineligibleReason})` : ''}`
              : grant.resetsLeft < 1 ? 'no resets left'
                : grant.paused ? 'reset is paused'
                  : !grant.usableNow ? `reset is not usable now${grant.unavailableReason ? ` (${grant.unavailableReason})` : ''}`
                    : grant.endsAt != null && grant.endsAt <= at ? 'reset has expired' : null),
            warnings,
          };
        });
      }
      return details;
    } catch (/** @type {any} */ err) {
      return { ...details, error: safeLine(err?.message || String(err), 120), grants: [] };
    }
  }

  /** @param {Record<string, any>} account @returns {Promise<ResetDetails>} */
  async function read(account) {
    if (oauthAccount(account)) {
      try { await accountManager.ensureTokenFresh(account.index); } catch (/** @type {any} */ err) {
        return {
          provider: providerOf(account) === 'codex' ? 'codex' : 'claude',
          error: `token refresh failed (${safeLine(err?.message || String(err), 80)})`,
          ineligibleReason: null, atLimit: null, exhausted: [], cooldownUntil: null,
          weeklyResetsAt: null, fleetHoldUntil: holdUntilFor(account), grants: [],
        };
      }
    }
    return readFresh(account);
  }

  /**
   * @param {Record<string, any>} account
   * @param {string} grantId
   * @returns {Promise<ManualRedeemResult>}
   */
  async function redeem(account, grantId) {
    const name = safeLine(account?.name || 'unknown account', 64);
    /** @param {string} reason @returns {ManualRedeemResult} */
    const decline = reason => ({ redeemed: false, uncertain: false, message: `Manual reset on "${name}": ${safeLine(reason, 240)}` });
    const blocked = accountBlock(account);
    if (blocked) return decline(blocked);
    const redeemer = redeemerFor(account);
    if (manualInFlight || redeemer.manualInFlight) return decline('a manual reset is in progress');
    if (redeemer.inFlight) return decline('an automatic reset is in progress');
    manualInFlight = true;
    redeemer.manualInFlight = true;
    try {
      try { await accountManager.ensureTokenFresh(account.index); } catch (/** @type {any} */ err) {
        return decline(`token refresh failed (${safeLine(err?.message || String(err), 80)})`);
      }
      const details = await readFresh(account);
      if (details.error) return decline(details.error);
      const grant = details.grants.find(g => g.id === grantId);
      if (!grant) return decline('chosen reset is no longer listed');
      const currentBlock = accountBlock(account) || grant.blocked;
      if (currentBlock) return decline(currentBlock);
      const result = await redeemer.redeemGrant(account, grantId, { manual: true });
      const verdict = 'result' in result ? result.result : 'code' in result ? result.code : null;
      return {
        redeemed: result.redeemed, uncertain: result.uncertain === true,
        message: safeLine(result.redeemed
          ? `Manually redeemed a ${details.provider} reset on "${name}" (${verdict || 'reset'})`
          : `Manual reset on "${name}": ${result.reason}`, 320),
        result: verdict,
        ...('resetsLeft' in result ? { resetsLeft: result.resetsLeft } : {}),
        ...('cleared' in result ? { cleared: result.cleared } : {}),
      };
    } finally {
      redeemer.manualInFlight = false;
      manualInFlight = false;
    }
  }

  return { read, redeem };
}
