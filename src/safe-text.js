// One decision about what may reach an operator's terminal or a log file.
//
// Not every value that ends up there is ours. A pin segment is percent-encoded
// by the client and decoded here; an account name comes from an OAuth payload;
// a session title is read out of a transcript on disk. A control character in
// any of them is not cosmetic:
//
//   - an escape sequence repositions, colours, or clears the operator's
//     terminal when the value is rendered or the log is `cat`ed;
//   - a newline forges a whole log line. That is the one that matters, because
//     the activity log is what a deployment joins against to attribute traffic
//     to a person — a line an attacker can write is a line that can name
//     somebody else.
//
// So it is stripped once at the boundary, rather than at each interpolation
// where the next new field will forget to.

// SGR is only one of the escape forms: `\x1b[2J` (erase) and `\x1b[1;1H`
// (cursor home) are CSI sequences with a final byte outside `m`, so a
// colour-only strip lets them through. `\p{C}` then covers the rest —
// C0/C1 controls (including \n and \r), and format characters such as U+202E.
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\p{C}/gu;

/**
 * Strip escape sequences and control characters, collapsing the whitespace they
 * leave behind so a stripped value cannot pad a column or split a line.
 */
export function sanitizeText(value) {
  return String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

/** sanitizeText, bounded — for a value rendered into a fixed-width column. */
export function safeLine(value, max = 120) {
  const cleaned = sanitizeText(value);
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}
