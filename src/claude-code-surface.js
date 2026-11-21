// What the Claude Code status line and Stop hook show, as pure functions of the
// server's answers (GET /teamclaude/session-advice and /teamclaude/quota). The
// server decides whether to move; these only render its answer.

import { formatPercent } from './status-renderer.js';
import { safeLine, sanitizeText, shellWord } from './safe-text.js';

/**
 * @typedef {{ account: string|null, via: 'manual'|'affinity'|null, context?: number|null,
 *             advice: { enabled: boolean, ask: boolean },
 *             recommendation: { to: string, reread: number|null } | null,
 *             reason: string }} SessionAdviceReply
 * @typedef {{ accounts?: { name: string, buckets?: Record<string, { utilization?: number }|null> }[],
 *             aggregate?: Record<string, { utilization?: number }|null> }} QuotaReply
 * @typedef {{ outOfBand: boolean, pinnedAnnounced: string|null }} NoticeState
 * @typedef {{ systemMessage: string } | { decision: 'block', reason: string }} StopHookJson
 */

/** @type {NoticeState} */
export const EMPTY_NOTICE_STATE = Object.freeze({ outOfBand: false, pinnedAnnounced: null });

// Account names can come from upstream (an OAuth profile), and every string
// here reaches Claude or the terminal: one line each, and a shell word in a command.
const name = (/** @type {unknown} */ v) => safeLine(v, 60);
// Fails closed: a name with control characters or runs of spaces prints its
// cleaned form, which matches no account unless one is named exactly that.
const shellArg = (/** @type {unknown} */ v) => shellWord(sanitizeText(v));

/** @param {QuotaReply|null} quota */
function perAccount(quota) {
  return (quota?.accounts ?? [])
    .map(a => `${name(a.name)} ${formatPercent(a.buckets?.weeklyShared?.utilization)}`)
    .join(' · ');
}

/**
 * One status line: the session's account, each account's weekly usage, and the
 * move the server recommends, if any. Without the session's account it shows
 * the fleet's weekly usage and says the session is unknown.
 * @param {SessionAdviceReply|null} advice
 * @param {QuotaReply|null} quota
 * @returns {string}
 */
export function renderStatusLine(advice, quota) {
  if (!advice && !quota) return 'teamclaude offline';
  const usage = perAccount(quota);
  if (!advice?.account) {
    const fleet = quota?.aggregate?.weeklyShared?.utilization;
    return ['session unknown', `fleet ${formatPercent(fleet)}`, usage].filter(Boolean).join(' | ');
  }
  const parts = [`on ${name(advice.account)}${advice.via === 'manual' ? ' (pinned)' : ''}`];
  if (usage) parts.push(usage);
  const to = advice.recommendation?.to;
  if (advice.reason === 'pinned-unavailable') {
    parts.push(to ? `pinned account unavailable, move to ${name(to)}` : 'pinned account unavailable');
  } else if (to) {
    parts.push(`move to ${name(to)}`);
  }
  return parts.join(' | ');
}

/**
 * The command that makes the recommended move, ready to run as printed, or null
 * when no move is recommended. `sessionId`, when given, names the session.
 * @param {SessionAdviceReply|null} advice
 * @param {string|null} [sessionId]
 */
export function moveCommand(advice, sessionId = null) {
  const to = advice?.recommendation?.to;
  if (!to) return null;
  return `teamclaude switch --session ${sessionId ? `${shellWord(sessionId)} ` : ''}--to ${shellArg(to)}`;
}

/** @param {SessionAdviceReply} advice @param {string} to */
function moveText(advice, to) {
  const reread = advice.recommendation?.reread;
  const cost = reread != null ? ` (it re-reads about ${reread} tokens of context there)` : '';
  return `teamclaude suggests moving this session from "${name(advice.account)}" to "${name(to)}"${cost}.`;
}

/**
 * The Stop hook's answer for one turn, and the notice state to keep for the
 * next. The state is written before the answer is printed, so a `block` is not
 * repeated. `output` null means print nothing.
 * @param {SessionAdviceReply|null} advice
 * @param {NoticeState|null} state
 * @returns {{ output: StopHookJson|null, nextState: NoticeState }}
 */
export function stopHookOutput(advice, state) {
  const prev = state ?? EMPTY_NOTICE_STATE;
  if (!advice?.advice?.enabled) return { output: null, nextState: prev };
  let { outOfBand, pinnedAnnounced } = prev;
  // A pin that moved to another account, and serves, may be announced afresh.
  if (advice.via !== 'manual') pinnedAnnounced = null;
  else if (advice.reason !== 'pinned-unavailable' && advice.account !== pinnedAnnounced) pinnedAnnounced = null;

  /** @type {StopHookJson|null} */
  let output = null;
  const to = advice.recommendation?.to;
  if (advice.reason === 'pinned-unavailable') {
    // Never a block: the turn Claude would continue goes to the same dead pin.
    if (pinnedAnnounced !== advice.account) {
      pinnedAnnounced = advice.account;
      const pinned = `teamclaude: the pinned account "${name(advice.account)}" cannot serve this session.`;
      output = {
        systemMessage: to
          ? `${pinned} Move it with: ${moveCommand(advice)}`
          : `${pinned} No other account is known to take it now; drop the pin with: teamclaude switch --session --clear`,
      };
    }
  } else if (advice.reason === 'out-of-band' && to) {
    if (!outOfBand) {
      outOfBand = true;
      output = advice.advice.ask
        ? {
          decision: 'block',
          reason: `${moveText(advice, to)} Ask the user whether to move it, and do not move it without an answer. `
            + `To move: ${moveCommand(advice)}. To keep it on "${name(advice.account)}": teamclaude switch --session --stay.`,
        }
        : { systemMessage: `${moveText(advice, to)} Move with: ${moveCommand(advice)}, or keep it with: teamclaude switch --session --stay` };
    }
  } else {
    outOfBand = false;
  }
  return { output, nextState: { outOfBand, pinnedAnnounced } };
}
