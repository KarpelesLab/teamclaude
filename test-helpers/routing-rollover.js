// The (state, event) table of a pin's rollover and its neighbors: the drain,
// the sticky cursor, the reclaim window and the storm ramp on a move's
// destination. Rows share the schema of routing-transitions.js; `shape`
// holds the config the outcome depends on. The episodes generate() appends
// take these rows, and `rolloverMarks` counts a row only on the step where an
// invariant that judges its outcome, or part of it, returned true.

import { governing } from './routing-model.js';
import { inBand, reclaimable } from './routing-invariants.js';

/** The sentence each row that cites one cites, by row id. @type {Record<string, string>} */
export const ROLLOVER_QUOTES = {};

const on = (/** @type {object} */ extra = {}) => ({ advisor: false, dist: 'on', preempt: true, reclaimHours: 0, ...extra });
/** @returns {import('./routing-transitions.js').TransitionRow} */
const r = (/** @type {string} */ id, /** @type {string} */ machine, /** @type {string} */ state, /** @type {string} */ event,
  /** @type {any} */ shape, /** @type {string} */ expect, /** @type {[string, string]|{ inferred: string }} */ cite, /** @type {true|string} */ reachable = true) => {
  if (Array.isArray(cite)) ROLLOVER_QUOTES[id] = cite[1];
  return { id, machine, state, event, shape, expect, docs: Array.isArray(cite) ? cite[0] : cite, reachable };
};

const S0 = /** @type {[string, string]} */ (['docs/routing.md:455', 'With `preempt` on, a **pinned conversation** (and the sticky current account) is re-routed when its account\'s governing weekly window **rolls over** — the account just became both the freshest and the furthest-dated choice, so staying would burn the window that gained a full week while sooner-expiring quota goes unspent.']);
const S1 = /** @type {[string, string]} */ (['docs/routing.md:463', 'A rollover that moves nothing logs why: no eligible account could take the traffic, or the re-rank ran and the account it was on still ranked best.']);
const S2 = /** @type {[string, string]} */ (['docs/routing.md:457', 'The roll a preemption pushes traffic off is **held** until an attempt selecting under this move\'s stamp is **served** at the destination — upstream\'s response headers gave a status below 400 — and the reading is still the one that move left there: once it has moved away and come back its stamp is a later one, and the roll stays held.']);
const S3 = /** @type {[string, string]} */ (['docs/routing.md:463', 'Traffic that returns before the destination has served anything is preempted off the rolled account again as soon as anywhere better is available, because the stay was never confirmed.']);
const S4 = /** @type {[string, string]} */ (['docs/routing.md:457', 'A roll is handed back once.']);
const S5 = /** @type {[string, string]} */ (['docs/routing.md:494', 'Without it, the sticky current account (distribution off) or an existing conversation\'s pin stays where it is across a rollover, and long-lived conversations can still ride an account whose window just reset a week out.']);
const S6 = /** @type {[string, string]} */ (['docs/routing.md:455', 'A pin **stops being honoured** when the account cannot serve the request (every reason `teamclaude status` names on its **Blocked** line, from spent quota through a rate-limit hold to an upstream refusal), when a higher-priority account is available, or when that account was already tried and failed earlier in the same request.']);
const S7 = /** @type {[string, string]} */ (['docs/routing.md:455', 'A pin is **bypassed outright** by a manual route pin and by a `/tc-acct/` (`TC_ACCT`) override, both of which resolve before session affinity is consulted at all.']);
const S8 = /** @type {[string, string]} */ (['docs/routing.md:163', 'To prevent this, requests onto a **just-switched-to account** are paced: concurrency starts at 1 and the cap ramps up step by step, then lifts once the ramp window (`windowMs`, 30 seconds by default) has passed.']);

/** Every row of the table. */
export const ROLLOVER = [
  r('RO-stay', 'rollover', 'resting', 'request; pin available, not rolled, not outranked', on(), 'stays on the pin; pressure or draining quota never moves it', ['docs/routing.md:455', 'Pressure on its own never moves one, and neither does the pinned account\'s quota draining — that is the policy working, and re-routing on it would thrash the prompt cache for nothing.']),
  r('RO-roll', 'rollover', 'resting', 'governing weekly window rolls, then request', on(), 're-routed off the pin', S0),
  r('RO-noelig', 'rollover', 'rolled', 'request; no other eligible account', on(), 'stays; logs that no eligible account could take it', S1),
  r('RO-rerank-even', 'rollover', 'rolled', 'request; re-rank ranks the pin best', on({ dist: 'even' }), 'stays only where the even re-rank still ranks it best', S1),
  r('RO-rerank-load', 'rollover', 'rolled', 'request; re-rank ranks the pin best (timed: a recent request LOAD_WINDOW old)', on({ dist: 'load' }), 'stays only where the load re-rank (recent requests first) still ranks it best', S1),
  r('RO-move-even', 'rollover', 'rolled', 'request; another band account ranks better', on({ dist: 'even' }), 'moves to the even placement pick over the band', { inferred: 'a move goes to the re-rank pick, since O29 says the re-rank runs and the pin is kept only where it still ranks best; docs/routing.md#session-aware-routing gives the even key' }),
  r('RO-move-load', 'rollover', 'rolled', 'request; another band account ranks better', on({ dist: 'load' }), 'moves to the load placement pick over the band', { inferred: 'O29 re-rank as for even; O6 gives the load key (fewest requests in LOAD_WINDOW, then the even keys)' }),
  r('RO-outband', 'rollover', 'rolled', 'request; pin outside the top pressure band', on(), 'moves off the pin', { inferred: 'O15 re-routes a rolled pin and O3 draws selection from the band, so a rolled pin outside it cannot be the re-rank pick' }),
  r('RO-pressure-dest', 'rollover', 'rolled', 'request; preemption moves the pin', on({ dist: 'adaptive-pressure' }), 'destination picked by pressure among the other accounts', ['docs/routing.md:411', 'When that decision has moved a conversation, `"pressure"` picks the destination among the other accounts.']),
  r('RO-unread', 'rollover', 'unread (first placement)', 'window rolls before anything read the account', on(), 'roll not detected; the pin stays', ['docs/routing.md:463', '**A rollover that happens before anything has read that account is not detected.**']),
  r('RO-settle', 'rollover', 'escaped, held under move stamp g', 'attempt selecting under g served (<400) at the destination', on(), 'roll released (settled)', S2),
  r('RO-body-fail', 'rollover', 'escaped, held under g', 'served under g, then the body fails', on(), 'still served: the roll stays released', ['docs/routing.md:457', 'A body that fails afterwards does not un-serve the attempt.']),
  r('RO-return-settled', 'rollover', 'settled', 'destination unavailable; conversation returns to the pin', on(), 'reads the origin whole and stays on it', ['docs/routing.md:463', 'Traffic that returns after a serve finds the roll released and reads the origin whole, keeping the week that account gained until the window rolls again.']),
  r('RO-handback', 'rollover', 'escaped, held, unserved', 'conversation returns to the pin before a serve', on(), 'preempted off the rolled pin again once anywhere better is available', S3),
  r('RO-handback-once', 'rollover', 'handed back once, second move served', 'conversation returns to the pin', on(), 'stays: no third move on that roll', S4),
  r('RO-later-stamp', 'rollover', 'escaped to x under g, moved away and back to x', 'served at x under a later stamp', on(), 'the roll stays held', S2),
  r('RO-restored-held', 'rollover', 'roll still held', 'conversation returns to the pin (restored reading has rolled)', on({ dist: 'even|load' }), 'pin re-ranked as a rolled pin; moves once anywhere better is available', S3),
  r('RO-other-window', 'rollover', 'handed back; another window (Fable) rolls since', 'conversation leaves and returns', on(), 'held again only for the window that rolled since; the weekly roll is not handed back a second time', ['docs/routing.md:457', 'A reading restored from a hold is held again only for a window that has rolled since the hand-back, so two accounts that have each rolled cannot trade their rolls for ever.']),
  r('RO-two-preempts', 'rollover', 'escaped, unsettled', 'second preemption before the first settles', on(), 'both rolls held, each until traffic returns to it or its own move\'s stay is served', ['docs/routing.md:457', 'A second preemption before the first is settled holds both: each escaped account keeps its own reading until traffic returns to it or a stay is served under the stamp of the move that escaped that roll.']),
  r('RO-left-by-handback', 'rollover', 'on a rolled destination', 'hand-back moves the conversation off it', on(), 'the left account keeps its roll under no stamp; a stay where it returns settles nothing for it', ['docs/routing.md:457', 'The account a hand-back leaves keeps its own roll the same way, under no move\'s stamp: the move that leaves it is a move back, so a stay served where it returns to is no evidence about the account it left.']),
  r('RO-stay-on-owed', 'rollover', 'roll held against account a', 'stay served on a', on(), 'releases that roll whatever move stamped it', ['docs/routing.md:457', 'A stay served on the account a roll is held against releases it whatever move stamped it, and only for the fleet the hold names, because the reading has come back to the account that owes it.']),
  r('RO-retry-same', 'rollover', 'escaped, held', 'retry that never leaves the destination (401 or short 429, no sibling)', on(), 'hold survives', ['docs/routing.md:459', 'Arriving is not being served, so the hold survives a retry that never leaves the destination, whether a 401 re-entering selection on the same account or a short-wait 429 with no idle sibling.']),
  r('RO-retry-confirms', 'rollover', 'escaped, something already rested at the destination', 'retry of the same request served', on(), 'can confirm the move: stamp re-read before every attempt', ['docs/routing.md:461', 'A retry of the same request can confirm the move, because the stamp is re-read before every attempt selects.']),
  r('RO-first-arrival', 'rollover', 'escaped, nothing rested at the destination', 'first attempt to arrive, selected before the stamp, served', on(), 'takes the reading; does not confirm', ['docs/routing.md:461', 'But only after something has come to rest at the destination: the move writes nothing there, so the first attempt to arrive takes the reading, having selected before it was stamped.']),
  r('RO-inflight', 'rollover', 'escaped; request A in flight', 'a later request B confirms the stay', on(), 'A still pays: the confirmation speaks only for B', ['docs/routing.md:463', 'A request still in flight when a later one confirms the stay pays that price: the confirmation speaks only for its own attempt.']),
  r('RO-scoped-family', 'rollover', 'learned scoped window shares a pin', 'pin preempted on rollover', on(), 'every family on the pin pays the turn', ['docs/routing.md:463', 'Where a learned scoped window shares a pin with the bucket it falls under (see above), every family on the pin pays that turn.']),
  r('RO-cost', 'rollover', 'resting', 'one roll of the pin\'s window', on(), 'one cache-miss turn per pin per rollover, and a second where a hand-back returns it before its stay is served', ['docs/routing.md:455', 'Cost of the rollover itself: one cache-miss turn per PIN per rollover of the window that pin is measured on, roughly once per account per week, and a second one where the conversation is sent back to the rolled account before a request confirmed its stay at the destination, as the next paragraphs define it (the destination ran out, say): the roll was never settled, so the pin moves off again as soon as somewhere better is available.']),
  r('RO-preempt-off', 'rollover', 'resting', 'governing window rolls, then request', on({ preempt: false }), 'pin stays across the rollover', S5),
  r('RO-knob-off', 'rollover', 'expiryRouting off', 'window rolls; reload turns it on', on({ expiry: 'off-then-on' }), 'the roll that happened while off is not carried across', ['docs/routing.md:496', 'The cost of that lifetime is stated rather than hidden: **a rollover that happens while the feature is off is not carried across.**']),
  r('RO-knob-on', 'rollover', 'expiryRouting off, live pins', 'reload turns it on', on({ expiry: 'off-then-on' }), 'fresh reading for the cursor and every live pin', ['docs/routing.md:496', 'Switching it back on takes a fresh reading for the current account and for every live conversation\'s pin — including any that a reload turning `distributeSessions` off in the same pass has just put into the drain, whose only bound is the rollover above — so the fleet is measured from the reload rather than from its next roll.']),
  r('RO-blocked', 'rollover', 'any', 'request; pin account cannot serve (Blocked reason)', on(), 'pin stops being honored; request routed elsewhere (holds: PR 3 hold machine)', S6),
  r('RO-outranked', 'rollover', 'any', 'request; a higher-priority account is available', on(), 'pin stops being honored', S6),
  r('RO-route-pin', 'rollover', 'rolled', 'request under a manual route pin', on(), 'route pin resolves first; affinity and rollover not consulted', S7),
  r('RO-tc-acct', 'rollover', 'rolled', 'request with a TC_ACCT or /tc-acct/ override', on(), 'override resolves first; affinity and rollover not consulted', S7, 'TC_ACCT and /tc-acct/ resolve in src/server.js before AccountManager selection; its public API takes no such override'),
  r('RO-extra-usage', 'rollover', 'kept past threshold by the extra-usage preference', 'window rolls, then request', on(), 'not moved by the rollover (nor by reclaim)', ['docs/routing.md:455', 'Neither applies to a conversation the [extra-usage preference](quota.md#extra-usage-fallback) keeps on a subscription past its switch threshold: both pick the destination among accounts that can serve normally, so the move would put it on API capacity the preference ranks after that subscription.']),
  r('PIN-remove-held', 'rollover', 'roll held against account a', 'account a removed', on(), 'pins naming a deleted; the roll owed to a is dropped (removal itself: PR 3 removal machine)', { inferred: 'PIN-release cites the sentence that says removing an account deletes the pins that named it; nothing remains to hand a roll back to' }),
  r('PIN-release', 'rollover', 'pinned', 'teamclaude release on the pin\'s account', on(), 'pins on it deleted; placed again on next request', ['docs/routing.md:455', 'And a pin can simply **cease to exist**: removing an account deletes the pins that named it, [`teamclaude release`](usage.md#releasing-the-conversations-on-an-account) deletes the pins on one account on your say-so, and a conversation idle past the known window is forgotten along with all of them.']),
  r('PIN-idle', 'rollover', 'pinned, idle', 'request after more than an hour idle (timed: lastSeen + 1 h)', on(), 'conversation forgotten with its pins', ['docs/routing.md:240', 'TeamClaude always tracks running Claude Code traffic by the `x-claude-code-session-id` header, narrowed to the **conversation** within it (see below) — the TUI header and `teamclaude status` show how many are **active** (a request in flight right now, or seen in the last ~2 min) and **known** (seen in the last hour; a conversation is forgotten after an hour idle, the maximum prompt-cache extension window).']),
  r('PIN-restart-nopersist', 'rollover', 'pinned, readings held', 'restart with persistSessionAffinity off', on({ persist: false }), 'saved affinity ignored: no pins, no readings', ['docs/routing.md:277', 'When off, startup ignores saved affinity and the next ordinary state save removes that section.']),
  r('PIN-restart-persist', 'rollover', 'pinned, roll held', 'restart with persistSessionAffinity on', on({ persist: true }), 'pin restored with the reading on its own account; a held roll is lost', ['docs/routing.md:310', 'A roll held for an account a preemption pushed the conversation off is not kept, so after a restart such a conversation can stay on its pin where an uninterrupted daemon moves it, and, more rarely, move once where an uninterrupted daemon would have kept it.']),
  r('PIN-restart-idle', 'rollover', 'restored after restart', 'request more than an hour after last use (timed)', on({ persist: true }), 'forgotten; restoring never refreshed the idle lifetime', ['docs/routing.md:317', 'Restoring never refreshes it: a conversation active for days can survive, while one idle for more than an hour is forgotten.']),
  r('DR-keep', 'drain', 'distribution on, pinned', 'reload turns distributeSessions off', on({ dist: 'on-then-off' }), 'running conversations keep their accounts; only new ones rotate', ['docs/routing.md:391', 'Instead, the conversations running at that moment keep their accounts, and only **new** ones go back to plain quota-driven rotation.']),
  r('DR-roll-preempt', 'drain', 'draining', 'governing window of the account rolls', on({ dist: 'on-then-off' }), 'drain ends for that conversation; rejoins normal rotation', ['docs/routing.md:393', 'With `expiryRouting.preempt` on, a governing-window **rollover** also ends the drain for the conversation whose account rolled, and it rejoins normal rotation there and then.']),
  r('DR-roll-nopreempt', 'drain', 'draining', 'governing window rolls', on({ dist: 'on-then-off', preempt: false }), 'rides the rolled account while it keeps talking', ['docs/routing.md:393', 'Nothing else bounds it — a conversation making requests never idles out — so without this a long-lived one rides a rolled-over account for as long as it keeps talking.']),
  r('CU-roll', 'cursor', 'cursor resting', 'cursor account\'s governing window rolls, then request', on({ dist: 'off' }), 'cursor re-routed', S0),
  r('CU-preempt-off', 'cursor', 'cursor resting', 'governing window rolls, then request', on({ dist: 'off', preempt: false }), 'cursor stays', S5),
  r('CU-borrow', 'cursor', 'cursor owned by provider A', 'request of provider B borrows it', on({ dist: 'off', providers: 2 }), 'gives the cursor back but not the reading', ['docs/routing.md:457', 'A request whose provider does not own the cursor borrows it, and gives it back but not the reading.']),
  r('RC-move', 'reclaim', 'pin P outside the band', 'request; A meets every reclaim condition', on({ reclaimHours: 24 }), 'moves to A', ['docs/routing.md:473', 'With it on, a conversation pinned to an account P moves to an account A on its next request when all of these hold:']),
  r('RC-inband', 'reclaim', 'pin P in the band', 'request', on({ reclaimHours: 24 }), 'stays (also keeps a moved conversation on A)', ['docs/routing.md:475', 'A conversation whose account is in the band stays, which is also what keeps a moved conversation on A.']),
  r('RC-window', 'reclaim', 'pin outside the band', 'request; A\'s deadline vs reclaimHours (timed: deadline - now = reclaimHours)', on({ reclaimHours: 24 }), 'moves only when the deadline is ahead and no more than reclaimHours away', ['docs/routing.md:476', 'A\'s deadline is ahead and no more than `reclaimHours` away.']),
  r('RC-sooner', 'reclaim', 'pin outside the band', 'request; A\'s deadline not sooner than P\'s', on({ reclaimHours: 24 }), 'no move', ['docs/routing.md:477', 'A\'s deadline is sooner than P\'s.']),
  r('RC-priority', 'reclaim', 'pin outside the band', 'request; A at another priority', on({ reclaimHours: 24 }), 'no move', ['docs/routing.md:479', 'A and P have the same `priority`.']),
  r('RC-org', 'reclaim', 'pin outside the band', 'request; A not known to share P\'s organization', on({ reclaimHours: 24, across: false }), 'no move', ['docs/routing.md:480', 'A and P are known to belong to the same organization.']),
  r('RC-across', 'reclaim', 'pin outside the band', 'request; A of another organization', on({ reclaimHours: 24, across: true }), 'organization condition dropped; may move', ['docs/routing.md:480', '`"reclaimAcrossOrganizations": true` drops this condition.']),
  r('RC-soft', 'reclaim', 'pin outside the band', 'request; fiveHourSoftMargin keeps new conversations off A', on({ dist: 'adaptive-pressure-soft', reclaimHours: 24 }), 'no reclaim onto A', ['docs/routing.md:478', 'Where [`fiveHourSoftMargin`](#scoring-by-expiry-pressure) keeps new conversations off A, it keeps a reclaim off it too.']),
  r('RC-several', 'reclaim', 'pin outside the band', 'request; several accounts qualify', on({ reclaimHours: 24 }), 'goes to the one a new conversation would be placed on among them', ['docs/routing.md:482', 'If several accounts qualify, the conversation goes to the one a new conversation would be placed on among them.']),
  r('RC-fivehour', 'reclaim', 'reclaimed onto A', 'A reaches its 5h threshold, later A\'s 5h window opens', on({ reclaimHours: 24 }), 'placed again by normal ranking; moves back to A when its window opens if the conditions hold', ['docs/routing.md:486', 'When A reaches its 5-hour or weekly switch threshold the conversation is placed again by the normal ranking, and when A\'s next 5-hour window opens it moves back to A if the conditions above still hold.']),
  r('RC-a-rolls', 'reclaim', 'reclaimed onto A', 'A\'s weekly window rolls or its quota is spent', on({ reclaimHours: 24 }), 'A leaves the band or the window; nothing more moves', ['docs/routing.md:486', 'Once A\'s weekly window rolls over, or its quota is spent, A leaves the band or the window and nothing more moves.']),
  r('RC-third-move', 'reclaim', 'roll handed back once', 'a third move off the same roll shaped like a reclaim', on({ reclaimHours: 24 }), 'a roll is handed back once (gap G7: reclaim and hand-back not separable)', S4),
  r('RC-cordon', 'reclaim', 'pin on a cordoned account, outside the band', 'request', on({ reclaimHours: 24 }), 'stays', ['docs/routing.md:484', 'A conversation kept on a [cordoned](usage.md#cordoning-one-account) account stays there as well.']),
  r('RC-off', 'reclaim', 'pin outside the band', 'request with reclaimHours 0', on(), 'pin treated as without the reclaim window: stays unless it rolled', ['docs/routing.md:473', 'With it off, a pin is treated exactly as described above.']),
  r('RA-move', 'ramp', 'pin moved off its roll', 'burst onto the destination', on({ ramp: 'default|tuned|malformed' }), 'concurrency starts at startConc; ramp counts from the switch', S8),
  r('RA-cursor', 'ramp', 'cursor moved (distribution off)', 'burst onto the new cursor', on({ dist: 'off', ramp: 'default|tuned|malformed' }), 'concurrency starts at startConc', S8),
  r('RA-reclaim', 'ramp', 'pin reclaimed onto A', 'burst onto A', on({ reclaimHours: 24, ramp: 'default|tuned|malformed' }), 'paced by the storm ramp as after any other move', ['docs/routing.md:482', 'It is logged as `Session pin on "P" released — reclaim: ...`, and the destination is paced by the [storm ramp](#storm-control) as after any other move.']),
  r('RA-off', 'ramp', 'storm control off', 'burst onto any destination', on({ ramp: 'off' }), 'full burst admitted immediately', ['docs/routing.md:174', '**`enabled: false`** — turn storm control off (send the full burst immediately, pre-#84 behavior).']),
  r('RA-window', 'ramp', 'ramping', 'windowMs after the switch (timed)', on({ ramp: 'default|tuned' }), 'pacing stops entirely', ['docs/routing.md:173', '**`windowMs`** — after this long, pacing stops entirely (default 30s).']),
  r('RA-malformed', 'ramp', 'stormRamp with a 0 and a quoted number', 'switch', on({ ramp: 'malformed' }), 'bad fields ignored; each keeps its default', ['docs/routing.md:176', 'A value that is not — `"1"`, `0`, a negative number, a field name the ramp does not know — is ignored with one line in the log, and that field keeps its default.']),
];

const REASONS = /** @type {Record<string, string[]>} */ ({
  'RC-window': ['no deadline ahead', 'deadline outside the window'], 'RC-priority': ['another priority'],
  'RC-org': ['not known to share an organization'], 'RC-soft': ['held off by fiveHourSoftMargin'],
});

/**
 * The rows one played history takes, read off each judged step: `mark(ctx,
 * ok)` gets the step and the invariants that returned true on it. RO-settle
 * and RO-later-stamp show only on a later return, so play() waits for those.
 * @returns {(ctx: any, ok: Set<string>) => string[]}
 */
export function rolloverMarks() {
  const moves = new Map();
  const resets = new Map();
  /** @type {Map<string, { a: string, reset: number|null }>} */
  const reclaimed = new Map();
  return (ctx, ok) => {
    const out = [];
    const took = (/** @type {string} */ id, /** @type {any} */ cond) => { if (cond) out.push(id); };
    const { row, ex, d } = ctx;
    if (ctx.restart) {
      took('PIN-restart-nopersist', ok.has('U6'));
      return out;
    }
    const v = ctx.view;
    if (!v || ctx.removal || ctx.hop || ctx.failover || (ctx.adv && !ctx.adv.plain)) return out;
    const { model, now, fed } = ctx;
    const k = v.kind.kind; const q = v.kind.q;
    const dist = row.dist !== 'off';
    const preempt = ex.enabled && ex.preempt;
    const reclaim = ex.enabled && ex.reclaimHours > 0;
    const moved = d !== q && d !== '-';
    if (k === 'rolled') {
      took('RO-roll', moved && (ok.has('O15') || ok.has('O5') || ok.has('O6')));
      took('RO-outband', ok.has('O15'));
      took('RO-noelig', d === q && ok.has('O29') && v.av.every((/** @type {any} */ a) => a.id === q));
      took(`RO-rerank-${row.dist}`, d === q && ok.has('O29') && v.av.some((/** @type {any} */ a) => a.id !== q));
      took('RO-move-even', moved && ok.has('O5'));
      took('RO-move-load', moved && ok.has('O6'));
      took('RA-move', moved && ok.has('O27') && row.stormRamp !== 'off');
    }
    took('RO-return-settled', ctx.pinReturned && ok.has('O28'));
    took('RO-restored-held', ctx.pinHeld && ok.has('O28'));
    took('RO-cost', ok.has('O26'));
    took('PIN-idle', ctx.revived && ok.has('G1'));
    const p = v.p;
    const pin = p == null ? null : fed.get(p);
    if (dist && ctx.tagged && pin) {
      took('RO-blocked', v.reason(pin) != null && d !== p && ok.has('U2'));
      took('RO-outranked', v.reason(pin) == null && v.outranked(pin) && ok.has('U3'));
      const key = `${ctx.life}|${ctx.c}|${ctx.bucket}|${p}|${governing(pin, model).reset}`;
      const n = (moves.get(key) ?? 0) + (ok.has('O26') ? 1 : 0);
      moves.set(key, n);
      took('RO-handback', ok.has('O26') && n === 2);
      took('RO-handback-once', k === 'pin' && q === p && d === p && n >= 2 && ok.has('O1'));
      // With preempt off a roll shows only as the pin's reset moving on.
      const at = `${ctx.life}|${ctx.c}|${ctx.bucket}|${p}`;
      const reset = governing(pin, model).reset;
      took('RO-preempt-off', ex.enabled && !ex.preempt && k === 'pin' && d === q && ok.has('O1') && resets.has(at) && resets.get(at) !== reset);
      resets.set(at, reset);
    }
    if (preempt && k === 'pin') took('RO-stay', d === q && ok.has('O1'));
    if (!dist && ctx.cur != null && fed.get(ctx.cur)) {
      took('CU-roll', ctx.curRolled && ok.has('O25'));
      const at = `${ctx.life}|${ctx.cur}|${model}`;
      const reset = governing(fed.get(ctx.cur), model).reset;
      took('CU-preempt-off', ex.enabled && !ex.preempt && d === ctx.cur && ok.has('O2') && resets.has(at) && resets.get(at) !== reset);
      resets.set(at, reset);
    }
    if (dist && ctx.tagged && k === 'pin') {
      const pa = fed.get(q);
      const qIn = inBand(v.B, pa, model, now);
      took('RC-off', ex.enabled && !reclaim && qIn === false && d === q && ok.has('O1'));
      if (reclaim) {
        took('RC-inband', qIn === true && d === q && ok.has('O1'));
        const whys = new Set(v.av.filter((/** @type {any} */ a) => a.id !== q).map((/** @type {any} */ a) => reclaimable(ctx, v, pa, a)));
        for (const [id, rs] of Object.entries(REASONS)) took(id, qIn === false && ok.has('O11') && rs.some(x => whys.has(x)));
        const tk = `${ctx.life}|${ctx.c}|${ctx.bucket}`;
        const tg = reclaimed.get(tk);
        if (tg && p === tg.a) {
          const A = fed.get(tg.a);
          took('RC-a-rolls', governing(A, model).reset !== tg.reset && (ok.has('O11') || ok.has('O1')));
        }
        if (moved && ok.has('O11')) {
          const da = fed.get(d);
          took('RC-move', true);
          took('RC-across', ex.across && !(da.org != null && pa.org != null && da.org === pa.org));
          took('RA-reclaim', ok.has('O27') && row.stormRamp !== 'off');
          reclaimed.set(tk, { a: d, reset: governing(da, model).reset });
        }
      }
    }
    if (dist && ctx.tagged && k === 'cordon' && reclaim) took('RC-cordon', d === q && ok.has('U1'));
    took('RA-cursor', !dist && ok.has('O27') && row.stormRamp !== 'off');
    took('RA-off', row.stormRamp === 'off' && ok.has('O27'));
    took('RA-malformed', row.stormRamp === 'malformed' && ok.has('O27'));
    return out;
  };
}
