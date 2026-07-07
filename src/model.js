// Model-id helpers shared by the request path (server + MITM relay) and account
// selection. Kept dependency-free so the low-level h2/h1 relay can peek a
// request's model without pulling in the account-manager graph.

// A request targets the Fable model family when its `model` id names Fable
// (e.g. "claude-fable-5"). Account selection uses this to gate the Fable-only
// weekly bucket: a Fable-exhausted account still serves every other model.
export function isFableModel(model) {
  return typeof model === 'string' && /fable/i.test(model);
}

// The model "family" a request belongs to. Anthropic meters some families with
// their own weekly quota bucket (Fable, Sonnet) on top of the shared 5-hour and
// weekly buckets, so the family decides which bucket governs a given request —
// letting an account whose Fable bucket is spent keep serving Opus/Sonnet.
// Returns a stable lowercase tag; unknown ids fall back to 'other'.
export function modelFamily(model) {
  if (typeof model !== 'string' || !model) return 'other';
  if (/fable/i.test(model)) return 'fable';
  if (/sonnet/i.test(model)) return 'sonnet';
  if (/opus/i.test(model)) return 'opus';
  if (/haiku/i.test(model)) return 'haiku';
  return 'other';
}

// Quota buckets on an account (see AccountManager emptyQuota). The shared 5-hour
// bucket applies to every request; the weekly bucket depends on the family.
// A family with no dedicated weekly bucket falls back to the shared 'unified7d'.
const FAMILY_WEEKLY_BUCKET = {
  fable: 'unified7dFable',
  sonnet: 'unified7dSonnet',
};

// The weekly quota bucket key that governs a model, e.g. a Fable request is
// gated by 'unified7dFable' rather than the shared 'unified7d'. Used by account
// selection so a spent family bucket only bars that family's requests.
export function weeklyBucketForModel(model) {
  return FAMILY_WEEKLY_BUCKET[modelFamily(model)] || 'unified7d';
}

// Match a shell-style glob against a model id. Only `*` is special (matches any
// run of characters, including none); every other character is literal. The
// comparison is case-insensitive. Used by configurable routes so a pattern like
// `*fable*` or `claude-opus-*` selects the models a route handles.
export function modelGlobMatches(glob, model) {
  if (typeof glob !== 'string' || typeof model !== 'string') return false;
  const re = '^' + glob.split('*').map(escapeRegExp).join('.*') + '$';
  return new RegExp(re, 'i').test(model);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Streaming, byte-exact locator for a TOP-LEVEL string field of a JSON object,
// fed incrementally. It tracks JSON structure (container stack, key/value,
// string/escape) so it ONLY matches the field at depth 1 of the root object —
// a `"model": "..."` sitting inside conversation text (a message, a tool result)
// is nested deeper and is never mistaken for the real field. No regex, no
// whole-body buffering, so the relay can peek just the first frames.
export class TopLevelFieldFinder {
  constructor(field) {
    this.field = field;               // target key at the root, e.g. 'model'
    this.isObj = [];                  // container stack: true=object, false=array
    this.awaitingKey = false;         // at an object, the next string is a key
    this.inStr = false;
    this.esc = false;
    this.readingKey = false;
    this.readingValue = false;        // accumulating the target field's value
    this.curKey = null;               // last key seen in the current object
    this.buf = [];                    // key/value byte accumulation
    this.value = null;                // the found value, or null
    this.done = false;                // found it, or the root object closed without it
  }

  /** Feed a chunk (Buffer). Returns the found value so far (string) or null. */
  push(chunk) {
    if (this.done) return this.value;
    for (let i = 0; i < chunk.length && !this.done; i++) this.#byte(chunk[i]);
    return this.value;
  }

  #atRoot() { return this.isObj.length === 1 && this.isObj[0] === true; }

  #byte(b) {
    if (this.inStr) {
      if (this.esc) { this.esc = false; if (this.readingKey || this.readingValue) this.buf.push(b); return; }
      if (b === 0x5c) { this.esc = true; if (this.readingKey || this.readingValue) this.buf.push(b); return; } // backslash
      if (b === 0x22) {                                            // closing quote
        this.inStr = false;
        if (this.readingKey) {
          this.curKey = Buffer.from(this.buf).toString('utf8'); this.buf = []; this.readingKey = false;
        } else if (this.readingValue) {
          this.value = Buffer.from(this.buf).toString('utf8'); this.buf = [];
          this.readingValue = false; this.done = true;             // the one top-level field we want
        }
        return;
      }
      if (this.readingKey || this.readingValue) this.buf.push(b);
      return;
    }

    switch (b) {
      case 0x7b: this.isObj.push(true); this.awaitingKey = true; this.curKey = null; break;   // {
      case 0x5b: this.isObj.push(false); this.awaitingKey = false; break;                     // [
      case 0x7d: case 0x5d:                                                                    // } ]
        this.isObj.pop(); this.curKey = null;
        if (this.isObj.length === 0) this.done = true;             // root closed → field absent
        break;
      case 0x3a: this.awaitingKey = false; break;                  // :
      case 0x2c: this.awaitingKey = this.isObj[this.isObj.length - 1] === true; break;        // ,
      case 0x22:                                                   // string begins
        if (this.awaitingKey && this.isObj[this.isObj.length - 1]) {
          this.readingKey = true; this.buf = [];
        } else if (this.#atRoot() && this.curKey === this.field) {
          this.readingValue = true; this.buf = [];
        }
        this.inStr = true; this.esc = false;
        break;
      default: break;                                              // scalars / whitespace
    }
  }
}

// Extract the requested model id from a JSON request body (Buffer or string).
// Uses the streaming top-level finder so it is exact (never matches a `model`
// key nested in conversation content) and cheap on large bodies (it stops as
// soon as the top-level field resolves). Returns null if absent.
export function parseRequestModel(body) {
  if (!body) return null;
  try {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    return new TopLevelFieldFinder('model').push(buf);
  } catch { return null; }
}
