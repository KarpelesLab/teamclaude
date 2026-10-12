// The two OSC sequences the TUI writes on purpose: a hyperlink (OSC 8) and a
// clipboard write (OSC 52). Both are for the login panel, whose sign-in link is
// several hundred characters long and has to cross from a terminal that may be
// on another machine to a browser on this one.
//
// Everything else that reaches the frame is scrubbed of OSC (see scrubLine and
// truncate in tui.js), because a foreign value carrying one could plant a link
// or overwrite the clipboard. These builders are the deliberate exception, and
// they only take values the TUI composed itself.

const ESC = '\x1b';
const ST = `${ESC}\\`;
const BEL = '\x07';

/** Anything outside printable ASCII, percent-encoded as UTF-8. An OSC 8 URI
 *  may only hold bytes 32-126, and ESC or BEL inside one would end the
 *  sequence early and print the rest.
 *  @param {string} s */
function asciiOnly(s) {
  return String(s).replace(/[^\x21-\x7e]/gu, c => [...Buffer.from(c, 'utf8')].map(b => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''));
}

/**
 * `text` as a terminal hyperlink to `url` (OSC 8). A terminal that does not
 * know the sequence ignores it and shows `text` alone.
 *
 * `id` joins several pieces into one link: a URL wrapped across lines is drawn
 * as one link per line, and terminals that honour the id underline all of them
 * on hover and open the whole URL from any piece.
 *
 * `text` is drawn as given (it may carry the caller's colour), so it must be
 * the caller's own string.
 *
 * @param {string} url
 * @param {string} text
 * @param {{ id?: string | null }} [opts]
 */
export function hyperlink(url, text, { id = null } = {}) {
  // `:` and `;` separate the params themselves, so an id may not hold either.
  const params = id ? `id=${asciiOnly(id).replace(/[:;]/g, '')}` : '';
  return `${ESC}]8;${params};${asciiOnly(url)}${ST}${text}${ESC}]8;;${ST}`;
}

/**
 * Wrap a sequence in tmux's DCS passthrough, so tmux hands it to the outer
 * terminal unread. Every ESC inside is doubled; that is how tmux tells the
 * payload from the DCS terminator. tmux forwards it only with
 * `allow-passthrough on`.
 *
 * @param {string} seq
 */
export function tmuxPassthrough(seq) {
  return `${ESC}Ptmux;${seq.replaceAll(ESC, ESC + ESC)}${ST}`;
}

/**
 * Ask the terminal to put `text` on the system clipboard (OSC 52).
 *
 * Inside tmux an application's OSC 52 reaches the outer terminal only when
 * tmux allows it: `set-clipboard on` takes the plain sequence, and
 * `allow-passthrough on` forwards the wrapped one. Both are sent, because
 * either option may be the one set; with both set the terminal sets the same
 * clipboard twice, which is harmless.
 *
 * @param {string} text
 * @param {{ tmux?: boolean }} [opts]
 */
export function clipboardSequence(text, { tmux = false } = {}) {
  const osc = `${ESC}]52;c;${Buffer.from(String(text), 'utf8').toString('base64')}${BEL}`;
  return tmux ? osc + tmuxPassthrough(osc) : osc;
}
