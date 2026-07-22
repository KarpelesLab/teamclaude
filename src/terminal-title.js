// Reflect the active account in the terminal title (e.g. "teamclaude 2/4 work"),
// so a backgrounded or tabbed `teamclaude server` is glanceable without
// switching to it. Pure/side-effect-free here so it can be unit-tested; the
// caller owns the TTY gate and the interval.

const OSC_TITLE = '\x1b]0;'; // OSC 0 — set icon name + window title
const BEL = '\x07';

// xterm title stack: save the shell's current title on start and restore it on
// exit. No-op on terminals that don't implement it.
export const TITLE_STACK_PUSH = '\x1b[22;2t';
export const TITLE_STACK_POP = '\x1b[23;2t';

function truncate(s, max) {
  s = String(s);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// Short, glanceable title: "teamclaude <pos>/<total> <name>". `index` is 0-based.
export function formatTerminalTitle({ index = 0, total = 0, name = null } = {}) {
  const pos = total > 0 ? `${index + 1}/${total}` : '0/0';
  const who = name ? ` ${truncate(name, 24)}` : '';
  return `teamclaude ${pos}${who}`;
}

// Wrap a title string in the OSC set-title sequence, stripping control chars so a
// crafted account name can't break out of the escape or move the cursor.
export function titleSequence(title) {
  const safe = String(title).replace(/[\x00-\x1f\x7f]/g, ' ').trimEnd();
  return `${OSC_TITLE}${safe}${BEL}`;
}
