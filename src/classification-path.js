// The path a request is CLASSIFIED on.
//
// Every routing decision this proxy makes (which pool of accounts is eligible,
// whether the client's own credential is relayed instead of a pooled one,
// whether the request is refused outright) is a prefix test on the request
// path, while the request goes out on the path as it arrived. Two spellings let
// the test and the destination read that string differently — and they are not
// the same kind of claim:
//
//   backslash    A parser fact. `\` is a separator for http(s) in the WHATWG
//                URL parser, so the `new URL(upstream + req.url)` that builds
//                the outgoing target rewrites `/api\oauth\profile` to
//                `/api/oauth/profile` in THIS process, before anything is sent.
//                Folding it here only makes the test agree with what we
//                ourselves are about to send.
//
//   percent-     A conservative choice, not a fact. `%2f` and `%61` survive to
//   encoding     the wire untouched, so whether `/api/oauth%2fprofile` reaches
//                the same handler as `/api/oauth/profile` is the receiving
//                server's policy — an RFC-conformant one may keep an encoded
//                reserved character opaque and route it elsewhere. We decode
//                anyway because the failure direction is the safe one: matching
//                the relay where the receiver would not have merely withholds a
//                pooled token and sends the client's own instead, and refusing a
//                dot-segment that would not have resolved returns a 400 the
//                caller can see. Not folding is the direction that puts a pooled
//                credential on a path nothing here classified.
//
// Exactly one decode, never a loop. One decode is the depth a receiving server
// applies to the target it routes on, so it is the depth that matches the wire.
// Decoding twice would classify `%252e%252e` as a dot-segment, and that path
// resolves — everywhere — to a literal segment with no traversal in it at all.
//
// BEHAVIOUR CHANGE, from that same conservative direction: hasDotSegment now
// refuses paths it used to forward. Any path whose one-decode form carries a `.`
// or `..` segment is a 400, which now includes the spellings that encode the
// separator itself (`..%2f..%2f`, `.%2f`, `..%5c`) even though nothing in this
// process folds those. The literal and `%2e` spellings were already refused. No
// client of ours emits any of them.

// Splits a path into segments AND separators, so a rejoin reproduces it.
const KEEP_SEPARATORS = /([/\\])/;

/**
 * @param {unknown} url
 */
function pathOnly(url) {
  return String(url || '').split('?')[0].split('#')[0];
}

/**
 * @param {string} s
 */
function decodeOnce(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * `path` percent-decoded exactly one level deep.
 *
 * A malformed escape (`%`, `%zz`) has no decoded form, so it is kept as sent —
 * the receiving server cannot resolve it either. It makes the WHOLE string
 * undecodable though, while only the one segment is at fault, so the remaining
 * segments are then decoded individually: a stray `%` must not shield an
 * encoding in a DIFFERENT segment. Inside its own segment it still shields —
 * `/a/%zz%2e%2e/b` is classified exactly as sent, as it was before — because
 * that segment has no decoded form either. Both branches are one decode deep,
 * so which one runs never changes how deep the decoding goes.
 * @param {string} path
 */
function decodeOncePath(path) {
  try { return decodeURIComponent(path); } catch { /* per-segment below */ }
  return path.split(KEEP_SEPARATORS).map(decodeOnce).join('');
}

/**
 * `url` reduced to the path the proxy should make its routing decisions on:
 * query and fragment removed, percent-decoded once, backslashes folded to
 * forward slashes.
 *
 * Decode BEFORE folding, not after: `%5c` is only a backslash once it has been
 * decoded, and folding first would leave it encoded and unseen. The order also
 * keeps the decoding one level deep — `%255c` decodes to a literal `%5c`, which
 * stays a character inside a segment rather than becoming a separator.
 * @param {unknown} url
 */
export function classificationPath(url) {
  return decodeOncePath(pathOnly(url)).replaceAll('\\', '/');
}
