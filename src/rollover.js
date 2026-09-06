// How far a weekly reset must move forward to count as that window rolling over
// rather than the same window re-reported. The two writers of a reset disagree
// on precision (a response header carries whole seconds, the usage endpoint a
// fractional ISO timestamp), so one instant reaches the comparison as two values
// up to a second apart, and a strictly-forward test reads that as a rollover. A
// real weekly roll moves the window by a week, so an hour is a floor no genuine
// event can fall under.
export const ROLLOVER_MIN_JUMP_MS = 3600_000;

// Renumber the roll an observation is holding for the account it was pushed off,
// after an account is removed and every index above it shifts down. Both stores
// of observations call this so the two cannot answer differently: a held reading
// whose account went away is dropped, because handing it back on a later
// fail-back would hand it to whichever account inherited the slot. `mapFn` is
// the same renumbering the observation's own index goes through, returning null
// for the removed account.
export function remapHeld(held, mapFn) {
  if (!held) return null;
  const moved = mapFn(held.idx);
  return moved == null ? null : { idx: moved, windows: held.windows };
}
