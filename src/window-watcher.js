// Rollover bookkeeping for one sticky routing choice — a session's pins, or the
// global current account.
//
// EVERY map here is keyed by (named window, account index). The window name is
// what `_governingWindow` resolved for the request that touched this watcher:
// `unified7d`, a family's own `unified7dFable`/`unified7dSonnet`, a route
// override's bucket, or `scoped:<family>` for a weekly bucket upstream reports
// scoped to a family that has no dedicated field. It is the identity, not a
// stamp on some other identity.
//
// KEYING BY THE REQUEST BUCKET INSTEAD IS WHAT THIS REPLACES, AND IT WAS WRONG
// IN BOTH DIRECTIONS. Opus and Haiku share the static bucket `unified7d` while
// resolving to different windows the moment either is metered by a scoped
// bucket, so a rollover owed on one was consumed by the other's traffic: an
// unrelated family paid a cache-miss move and the family that actually rolled
// lost its event. And a bucket's window is not a fixed property of the bucket —
// it changes the first time an account reports that family's utilization, and
// changes back when `_clearExpiredQuotas` nulls it — so the bucket named a
// moving target while the window names the thing whose reset is being compared.
//
// Two request families that resolve to the SAME window name on the same account
// share an entry, and that is correct rather than tolerated: they are the same
// quota window, and it rolls once. One event, one move; the second family reads
// the post-roll baseline and correctly sees no further jump.
//
// A detected rollover is kept PENDING rather than applied. The preemption it
// asks for only really happens once a request is served somewhere else, and a
// request can be re-routed several times before that: it excludes an account
// that just failed, and it re-pins its session on every attempt. Consuming the
// event at detection time means a retry that fails back onto the rolled-over
// account banks a move that never happened, and the session then rides that
// account until its window rolls again a week later.
//
// EVIDENCE MUST POSTDATE THE EVENT IT CLEARS. Selection mutates a pin when it
// runs; a terminal response arrives whenever it arrives. A slow success from an
// attempt issued BEFORE a rollover was detected therefore lands after a later
// request has already fallen back onto the rolled account, and clearing the
// event on it settles a move that the fleet has since undone. Every event and
// every piece of evidence carries the monotonic sequence of the selection that
// produced it, and an event is only ever cleared by evidence from a LATER
// selection. Reordering the terminals of two requests issued before the event
// cannot settle it, which is the whole of the invariant.

// How far a weekly reset must move forward to count as that window rolling over
// rather than the same window re-reported. The two writers of a reset disagree
// on precision — a response header carries whole seconds, the usage endpoint a
// fractional ISO timestamp — so one instant reaches the detector as two values
// up to a second apart, and any strictly-forward test reads that as a rollover
// and re-routes every sticky session for nothing. A real weekly roll moves the
// window by a week, so an hour is a floor no genuine event can fall under.
export const ROLLOVER_MIN_JUMP_MS = 3600_000;

// The (window, account) maps below are nested — window -> account index -> entry
// — so the account half stays a live number the renumbering after a removal can
// rewrite, rather than being baked into a composite string key.
function readPair(map, window, idx) {
  return map.get(window)?.get(idx) ?? null;
}

function writePair(map, window, idx, value) {
  let byAccount = map.get(window);
  if (!byAccount) map.set(window, byAccount = new Map());
  byAccount.set(idx, value);
}

function deletePair(map, window, idx) {
  const byAccount = map.get(window);
  if (!byAccount) return;
  byAccount.delete(idx);
  if (!byAccount.size) map.delete(window);
}

// Renumber the account half of every entry through `mapFn`, dropping the ones
// whose account went away (and any window left holding none).
function remapPairs(map, mapFn) {
  for (const [window, byAccount] of [...map]) {
    const moved = new Map();
    for (const [idx, value] of byAccount) {
      const to = mapFn(idx);
      if (to != null) moved.set(to, value);
    }
    if (moved.size) map.set(window, moved);
    else map.delete(window);
  }
}

export class WindowWatcher {
  constructor() {
    // window -> account index -> the reset last seen for that window there.
    this.windows = new Map();
    // window -> account index -> { reset, seq }: rollovers found but not acted
    // on. Two accounts can owe on one window at once — a pin moves while its
    // event is still outstanding — and each is settled by its own traffic moving
    // off it, so the account is part of the key here too. `seq` is the selection
    // that detected it, and is what makes "later" mean something at settle time.
    this.pending = new Map();
    // window -> { idx, seq }: the account that most recently SERVED that
    // window's traffic, and the selection that sent it there. The account is the
    // ANSWER here, not part of the question. Held by highest `seq` rather than
    // by arrival, because arrival order is scheduling and the question is which
    // selection was the latest — a slow terminal from an older attempt is not
    // news about where traffic is going now.
    this.served = new Map();
  }

  /**
   * Record `windows` — { windowName: reset } — as baselines for account `idx`,
   * without disturbing one already there. Seed-only: overwriting here would
   * erase a jump nothing has acted on yet.
   *
   * This is the first-sight write. Establishing a tenure is a different act with
   * different rules — see establish().
   */
  seed(idx, windows) {
    for (const [window, reset] of Object.entries(windows)) {
      if (reset == null) continue;
      if (readPair(this.windows, window, idx) == null) writePair(this.windows, window, idx, reset);
    }
  }

  /**
   * Begin a TENURE on account `idx`: `windows` becomes the whole truth about
   * what that account's baselines are, replacing whatever an earlier tenure left
   * and DROPPING any window it does not mention.
   *
   * Authoritative, not additive, and the dropping is the point. A baseline
   * answers "what was this window when we chose this account", asked afresh each
   * time the account is chosen. Kept from an earlier tenure it answers a
   * different question — what the window was the last time traffic sat here,
   * which for an account that rolled while traffic was elsewhere is a roll
   * already spent. Selecting it again then reads that roll as new and moves
   * straight back off: an operator's manual switch does not survive its own next
   * request.
   *
   * Merely moving the mentioned baselines forward is not enough. A window can be
   * temporarily ABSENT — `_clearExpiredQuotas` nulls a family's utilization and
   * reset together, and a scoped entry is deleted outright once its reset passes
   * — so a tenure that begins during the gap mentions nothing for it, leaves an
   * earlier tenure's value in place, and reads the reset as a fresh rollover the
   * moment upstream reports it again. A window this account does not present has
   * no baseline here at all; when it returns it returns as a first sight.
   *
   * Safe against erasing live work: a rollover already detected lives in
   * `pending`, which rolledOver consults before it ever reads a baseline. An
   * owed event survives a new tenure; a spent one does not haunt it.
   */
  establish(idx, windows) {
    for (const [window, byAccount] of [...this.windows]) {
      if (windows[window] == null && byAccount.has(idx)) deletePair(this.windows, window, idx);
    }
    for (const [window, reset] of Object.entries(windows)) {
      if (reset != null) writePair(this.windows, window, idx, reset);
    }
  }

  /**
   * Has `window` on account `idx` rolled over since we last looked? `windows` is
   * every named window this account currently presents, all of which are seeded
   * — not just the one being asked about, or a session that has only ever sent
   * Opus would first-sight its Fable window on the very request that should have
   * caught it rolling. `seq` is the selection asking.
   *
   * This writes — it seeds a first-sight baseline — but it never advances a
   * window past a rollover it has found. Only settleServed does that, and only
   * once a preemption has actually moved a request. That is the invariant that
   * lets detection run on every selection pass, including one that cannot act on
   * what it finds: looking costs the event nothing.
   */
  rolledOver(idx, window, windows, seq = 0) {
    // Still owed from an earlier pass: re-report it rather than re-deriving it
    // from a baseline that a re-pin may since have moved.
    if (this.owedOn(window, idx)) return true;
    const now = windows[window];
    const prev = readPair(this.windows, window, idx);
    this.seed(idx, windows);
    if (now == null || prev == null) return false;
    if (now - prev <= ROLLOVER_MIN_JUMP_MS) return false;
    writePair(this.pending, window, idx, { reset: now, seq });
    return true;
  }

  /** Is a rollover on `window` already owed against account `idx`? The question
   * rolledOver asks first, so a caller can tell a newly detected event from the
   * re-report of one still owed — the two are indistinguishable in its boolean,
   * and only the first is an event. */
  owedOn(window, idx) {
    return !!this.pending.get(window)?.has(idx);
  }

  /**
   * A request whose governing window could be any of `windows` was SERVED by
   * `acceptedIdx` — the response the client got, not an attempt that went on to
   * retry somewhere else. `seq` is the selection that sent it there.
   *
   * Filed under every window name this request's model resolves to across the
   * fleet, because the event is keyed on the window as the OWING account
   * resolved it, and the account that ended up serving may resolve the same
   * model differently. Over-filing is harmless: sharing a window name means
   * sharing the window.
   *
   * Kept by highest `seq`. A terminal that arrives late from an attempt issued
   * early is not evidence about where traffic is going now, and letting it
   * overwrite a later selection's answer is exactly how an event gets cleared by
   * a move the fleet has already undone.
   */
  noteServed(acceptedIdx, windows, seq = 0) {
    for (const window of windows) {
      const held = this.served.get(window);
      if (held && held.seq > seq) continue;
      this.served.set(window, { idx: acceptedIdx, seq });
    }
  }

  /**
   * Resolve every pending rollover against where its window was last served, and
   * return how many of them a move actually resolved — the count of preemptions
   * that happened, as distinct from the ones selection asked for.
   *
   * A window served off the rolled account is one the preemption moved, so bank
   * its post-rollover reset and drop the event. A window whose last service came
   * back to the rolled account — a retry that failed over and back — moved
   * nothing that stuck, so it stays owed and the next request preempts again. A
   * window nothing served settles nothing.
   *
   * AND EVIDENCE OLDER THAN THE EVENT SETTLES NOTHING EITHER. A success from an
   * attempt issued before the rollover was detected says where traffic was going
   * before anyone knew; clearing on it settles a move that a later request has
   * since fallen back from. Only a strictly later selection can clear.
   *
   * Called when the sticky choice is next quiescent, which for a session means
   * its last in-flight request has ended: an earlier settlement can be undone by
   * a slower sibling that fails back, so the answer is only stable once no
   * attempt is left to change it.
   */
  settleServed() {
    let moved = 0;
    for (const [window, byAccount] of [...this.pending]) {
      const accepted = this.served.get(window);
      if (!accepted) continue;
      for (const [idx, owed] of [...byAccount]) {
        if (accepted.idx === idx) continue;
        // Strictly older evidence only. The selection that DETECTED the event is
        // also the one preempted off the account, and its own success is what
        // normally settles it — so equal sequences must clear. What must not is
        // a terminal from a selection that ran before the event existed.
        if (accepted.seq < owed.seq) continue;
        writePair(this.windows, window, idx, owed.reset);
        deletePair(this.pending, window, idx);
        moved += 1;
      }
    }
    this.served.clear();
    return moved;
  }

  /** noteServed + settleServed, for a sticky choice with no quiescent point of
   * its own: the global current account is shared by every request, including
   * the ones carrying no session id, so there is nothing to wait for. Returns
   * settleServed's count of events a move resolved. */
  commitOn(acceptedIdx, windows, seq = 0) {
    this.noteServed(acceptedIdx, windows, seq);
    return this.settleServed();
  }

  /** Renumber after the account list shifts, dropping whatever named the account
   * that went away. Returns false once nothing is left, so the caller can drop
   * the watcher whole. */
  remap(mapFn) {
    remapPairs(this.pending, mapFn);
    for (const [window, entry] of [...this.served]) {
      const moved = mapFn(entry.idx);
      if (moved == null) this.served.delete(window);
      else this.served.set(window, { idx: moved, seq: entry.seq });
    }
    remapPairs(this.windows, mapFn);
    return this.windows.size > 0 || this.pending.size > 0;
  }
}
