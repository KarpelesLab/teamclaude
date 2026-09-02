// How far a weekly reset must move forward to count as that window rolling over
// rather than the same window re-reported. The two writers of a reset disagree
// on precision (a response header carries whole seconds, the usage endpoint a
// fractional ISO timestamp), so one instant reaches the comparison as two values
// up to a second apart, and a strictly-forward test reads that as a rollover. A
// real weekly roll moves the window by a week, so an hour is a floor no genuine
// event can fall under.
export const ROLLOVER_MIN_JUMP_MS = 3600_000;
