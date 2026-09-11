// How far a weekly reset must move forward to count as that window rolling over
// rather than the same window re-reported. The two writers of a reset disagree
// on precision (a response header carries whole seconds, the usage endpoint a
// fractional ISO timestamp), so one instant reaches the comparison as two values
// up to a second apart, and a strictly-forward test reads that as a rollover. A
// real weekly roll moves the window by a week, so an hour is a floor no genuine
// event can fall under.
export const ROLLOVER_MIN_JUMP_MS = 3600_000;

/** @typedef {import('./session-tracker.js').Hold} Hold */
/** @typedef {import('./session-tracker.js').Observation} Observation */

/**
 * A sticky choice with no reading taken yet. Both stores of observations create
 * one through here, so a field the shape gains cannot reach one store and miss
 * the other. `provider` starts null because nothing creating an observation
 * knows a fleet: a selection walk stamps it on the first move.
 *
 * @returns {Observation}
 */
export function newObservation() {
  return { idx: null, windows: new Map(), unescaped: null, gen: 0, provider: null, handedBack: null };
}

/**
 * Renumber the roll an observation is holding for the account it was pushed off,
 * after an account is removed and every index above it shifts down. Both stores
 * of observations call this so the two cannot answer differently: a held reading
 * whose account went away is dropped, because handing it back on a later
 * fail-back would hand it to whichever account inherited the slot. `mapFn` is
 * the same renumbering the observation's own index goes through, returning null
 * for the removed account. The stamp naming the fleet whose reading the hold
 * preserves travels with it: a renumbering is nobody's success, so it settles
 * nothing, and dropping the stamp would leave a hold no fleet can settle. Each
 * roll on the chain is renumbered, not just the newest.
 *
 * @param {Hold|null} held
 * @returns {Hold|null}
 */
export function remapHeld(held, mapFn) {
  if (!held) return null;
  const rest = remapHeld(held.prev, mapFn);
  const moved = mapFn(held.idx);
  return moved == null ? rest : { ...held, idx: moved, prev: rest };
}

// The roll this observation owes an account, or the one a stay's stamp names.
// The newest match, since a later escape of the same account was read after the
// earlier one's window had already rolled.
export function findHeld(held, match) {
  for (let h = held; h; h = h.prev) if (match(h)) return h;
  return null;
}

// The chain without the roll owed to `idx`. Handing a roll back and settling one
// both remove that account's own, and leave every other escape standing.
export function dropHeld(held, idx) {
  if (!held) return null;
  const rest = dropHeld(held.prev, idx);
  return held.idx === idx ? rest : { ...held, prev: rest };
}
