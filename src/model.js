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

// A per-account usage cap (accounts[].maxUsage) for one quota bucket, or null
// when that bucket is uncapped. Shapes mirror switchThreshold: a bare number
// caps every bucket, a table caps the buckets it lists, and `default` covers the
// rest. Lives here, beside the bucket keys, so the status renderer can draw a
// cap without importing the account manager (it renders remote JSON too).
export function resolveMaxUsage(maxUsage, bucket) {
  if (typeof maxUsage === 'number' && Number.isFinite(maxUsage)) return maxUsage;
  if (maxUsage && typeof maxUsage === 'object') {
    const v = maxUsage[bucket] ?? maxUsage.default;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

// A per-account money cap (accounts[].maxSpend) in the smallest unit of the
// account's billing currency, or null when the account carries no valid cap or
// upstream has not said what its currency is. The cap is written in major units
// (`20` is $20.00) because that is how a person thinks about a budget; the
// exponent that turns it into minor units comes from the same upstream `spend`
// record the month-to-date figure does, so the two are always compared in the
// same unit. Lives here for the reason resolveMaxUsage does: the status
// renderer draws it from remote JSON as well as from a live account.
/**
 * @param {unknown} maxSpend
 * @param {{ exponent?: number } | null | undefined} spend
 * @returns {number | null}
 */
export function resolveMaxSpendMinor(maxSpend, spend) {
  if (typeof maxSpend !== 'number' || !Number.isFinite(maxSpend) || maxSpend < 0) return null;
  const exponent = spend?.exponent ?? 2;
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) return null;
  return Math.round(maxSpend * 10 ** exponent);
}

// Whether an account has spent its money cap this month: `usedMinor` is the
// month-to-date extra-usage figure upstream reports, and the cap binds at the
// level set (`>=`), except that a cap of 0 means "not one cent" rather than
// "nothing at all" — an account that has billed nothing is still under it.
// Only an account that CAN bill is judged: with extra usage off upstream no
// request costs money, and barring it would only waste the quota it still has.
/**
 * @param {unknown} maxSpend
 * @param {{ enabled?: boolean, usedMinor?: number | null, exponent?: number } | null | undefined} spend
 */
export function spendCapReached(maxSpend, spend) {
  if (!spend?.enabled) return false;
  const cap = resolveMaxSpendMinor(maxSpend, spend);
  if (cap == null) return false;
  const used = spend.usedMinor || 0;
  return used > 0 && used >= cap;
}

// The switch threshold for one bucket on one account (accounts[].switchThreshold,
// issue #409), falling back to the fleet's own thresholdFor(bucket) rather than
// to DEFAULT_SWITCH_THRESHOLD directly — an account whose table lists only, say,
// `unified7dFable` still inherits the fleet's `unified5h`/`unified7d` instead of
// opting out of them. Resolution order, closest override wins:
//   1. the account table's entry for THIS bucket
//   2. the account's own `default` (or a bare per-account number)
//   3. `fleetValue`, already fully resolved by the caller
//
// Lives beside resolveMaxUsage for the same reason: the status renderer and the
// attach-mode TUI draw against a JSON payload, not an AccountManager, and both
// need this exact resolution to agree with the live gate.
//
// Array.isArray is checked explicitly — `typeof [] === 'object'` passes the
// object branch, and a hand-edited `"switchThreshold": [0.9]` would otherwise be
// spread as a bucket table keyed by numeric string indices (see #425, the same
// hazard for the fleet-wide setting). Falling through to `fleetValue` here is
// the same refusal thresholdTable() applies to the fleet field.
/**
 * @param {number|Object<string, number>|null|undefined} accountThreshold
 * @param {string} bucket
 * @param {number} fleetValue
 * @returns {number}
 */
export function resolveSwitchThreshold(accountThreshold, bucket, fleetValue) {
  if (typeof accountThreshold === 'number' && Number.isFinite(accountThreshold)) return accountThreshold;
  if (accountThreshold && typeof accountThreshold === 'object' && !Array.isArray(accountThreshold)) {
    const v = accountThreshold[bucket] ?? accountThreshold.default;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return fleetValue;
}

// Every bucket a switchThreshold/maxUsage table can be keyed by, plus the
// `default` fallback the CLI's `threshold` command already validates against
// (index.js QUOTA_BUCKETS). Shared here so a reader that must recognise "is
// this a real bucket, or a typo/garbage key" — the account-vs-fleet diff below,
// a future validator — does not keep a second copy of the list (#426).
export const THRESHOLD_BUCKET_KEYS = Object.freeze([
  'unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable', 'tokens', 'requests',
]);

// The fleet-wide switch threshold for one bucket, reconstructed from the SPLIT
// status payload: `switchThreshold` (thresholdFor('default'), already resolved
// to a number) and `switchThresholds` (the raw per-bucket table, or null when
// the fleet setting is a bare number). This is the wire-shape twin of
// AccountManager's own private _fleetThresholdFor, for a reader — the status
// renderer, the dashboard — that only ever sees the JSON payload, never the
// AccountManager itself. 0.98 mirrors DEFAULT_SWITCH_THRESHOLD (account-manager.js)
// without importing it, the same way RemoteAccountManager's own fleet lookup does
// — account-manager.js already imports FROM this file, so the reverse import
// would be circular.
/**
 * @param {number|undefined|null} switchThreshold
 * @param {Object<string, number>|null|undefined} switchThresholds
 * @param {string} bucket
 * @returns {number}
 */
export function resolveFleetThreshold(switchThreshold, switchThresholds, bucket) {
  if (switchThresholds && typeof switchThresholds === 'object') {
    const v = switchThresholds[bucket] ?? switchThresholds.default;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return typeof switchThreshold === 'number' && Number.isFinite(switchThreshold) ? switchThreshold : 0.98;
}

/**
 * Which buckets an account's OWN switchThreshold actually moves away from the
 * fleet's — the "only when it differs" filter a per-account display needs so a
 * table that merely repeats the fleet's numbers (or a stray unknown key) stays
 * silent instead of adding a badge that says nothing new.
 *
 * `accountThreshold` is the raw `accounts[].switchThreshold` value (number,
 * table, null, or garbage — same tolerance as resolveSwitchThreshold, so an
 * invalid shape here answers "nothing to show" rather than throwing).
 * `fleetFor(bucket)` answers what the FLEET alone resolves that bucket to —
 * `AccountManager#thresholdFor(bucket)` (no account arg) in-process, or
 * `resolveFleetThreshold(status.switchThreshold, status.switchThresholds, bucket)`
 * off a status payload.
 *
 * Returns `[]` for "nothing to show" and otherwise a list of
 * `{ bucket, value }`, `bucket` being `'default'` (a bare account number, or a
 * table's own `default` entry) or one of THRESHOLD_BUCKET_KEYS — never a key
 * the table carried but this function does not recognise, so a typo'd bucket
 * (already inert for routing — thresholdFor() is never asked about it) does
 * not get displayed as though it did something. A bucket the account does
 * not list is still reported when the account's own default moves it off a
 * value the fleet table gives that bucket.
 *
 * @param {number|Object<string, number>|null|undefined} accountThreshold
 * @param {(bucket: string) => number} fleetFor
 * @returns {Array<{bucket: string, value: number}>}
 */
export function switchThresholdDiffs(accountThreshold, fleetFor) {
  const isTable = !!accountThreshold && typeof accountThreshold === 'object' && !Array.isArray(accountThreshold);
  /** @type {Record<string, any>} */
  const table = isTable ? /** @type {any} */ (accountThreshold) : {};
  /** @param {unknown} v */
  const valid = v => typeof v === 'number' && Number.isFinite(v);
  if (!isTable && !valid(accountThreshold)) return [];

  const out = [];
  if (isTable) {
    for (const [key, v] of Object.entries(table)) {
      if (!valid(v)) continue;
      if (key !== 'default' && !THRESHOLD_BUCKET_KEYS.includes(key)) continue;
      if (v !== fleetFor(key)) out.push({ bucket: key, value: v });
    }
  } else if (accountThreshold !== fleetFor('default')) {
    out.push({ bucket: 'default', value: /** @type {number} */ (accountThreshold) });
  }

  // The account's own default (a bare number, or its table's `default`) also
  // governs every bucket its table does not list, and it outranks a bucket
  // entry in the FLEET table. So an account default equal to the fleet default
  // can still move a bucket: fleet { default: 0.98, unified7d: 0.85 } with an
  // account 0.98 lifts that account's weekly wall from 0.85 to 0.98. Comparing
  // only the two defaults showed nothing for it. When the defaults do differ
  // the "at N%" entry above already says every unlisted bucket sits at N%, so
  // naming them again would only repeat it.
  const ownDefault = isTable ? table.default : accountThreshold;
  if (valid(ownDefault) && ownDefault === fleetFor('default')) {
    for (const key of THRESHOLD_BUCKET_KEYS) {
      if (valid(table[key])) continue;
      if (ownDefault !== fleetFor(key)) out.push({ bucket: key, value: ownDefault });
    }
  }
  return out;
}

/**
 * An `accounts[].switchThreshold` as read from the config, reduced to the part
 * that can be honoured: finite numbers in (0, 1]. 1.0 is valid — "never rotate
 * this account early" is the example issue #409 opens with. Everything else is
 * dropped here, once, rather than tolerated at each read: `98` (a percentage
 * typed where a ratio belongs) is finite, so the resolver's own guard lets it
 * through and the account then never rotates, while `0` takes it out of
 * rotation for good. Neither looks wrong on a status screen.
 *
 * `rejected` names the fields that were dropped so the caller can tell the
 * operator; this module stays free of logging. A table left with no usable
 * entry comes back as null, the same as no override at all.
 *
 * @param {unknown} raw
 * @returns {{ value: number|Object<string, number>|null, rejected: string[] }}
 */
export function sanitizeSwitchThreshold(raw) {
  /** @param {unknown} v */
  const inRange = v => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1;
  if (raw == null) return { value: null, rejected: [] };
  if (typeof raw === 'number') {
    return inRange(raw) ? { value: raw, rejected: [] } : { value: null, rejected: ['switchThreshold'] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { value: null, rejected: ['switchThreshold'] };
  /** @type {Object<string, number>} */
  const value = {};
  const rejected = [];
  for (const [key, v] of Object.entries(raw)) {
    if (inRange(v)) value[key] = v;
    else rejected.push(`switchThreshold.${key}`);
  }
  return { value: Object.keys(value).length ? value : null, rejected };
}

// The weekly quota bucket key that governs a model, e.g. a Fable request is
// gated by 'unified7dFable' rather than the shared 'unified7d'. Used by account
// selection so a spent family bucket only bars that family's requests.
export function weeklyBucketForModel(model) {
  return FAMILY_WEEKLY_BUCKET[modelFamily(model)] || 'unified7d';
}

/**
 * The weekly utilization that GATES a request whose governing bucket is
 * `bucketKey`: the higher of that bucket and the shared `unified7d`, or null
 * when neither is reported.
 *
 * WHY A MAXIMUM. Family spend meters twice, once in the family bucket and once
 * in the shared one, so the two are not independent (issue #175 measured the
 * coupling at [+1.14e-4, +5.21e-4] on the shared bucket per Fable request).
 * Reading the family bucket alone let an account sitting at `unified7d` 1.00
 * with `unified7dFable` 0.20 keep serving Fable, and each such request pushed
 * the shared bucket further past its cap. Once the shared bucket is spent,
 * family requests are the only ones still admitted, which makes it a one-way
 * ratchet rather than a bounded overshoot.
 *
 * NULL IS UNREPORTED AND NEVER ZERO. `Math.max` coerces null to 0, and 0 reads
 * as "empty" — the opposite of "unknown", and in the direction that keeps an
 * account serving. Both absent cases are answered before the maximum rather
 * than falling into it.
 *
 * ONE DEFINITION, because the gate and every display of it answer the SAME
 * question: can this account serve this family right now. A second derivation
 * of one question is a copy that drifts.
 */
export function gatingUtilization(quota, bucketKey) {
  const own = quota?.[bucketKey] ?? null;
  // Already the shared bucket: max(x, x) is x.
  if (bucketKey === 'unified7d') return own;
  const shared = quota?.unified7d ?? null;
  if (own == null) return shared;
  if (shared == null) return own;
  return Math.max(own, shared);
}

// Every bucket weeklyBucketForModel can name: the family-specific ones plus the
// shared bucket the rest fall back to. Exported so a caller that must cover all
// of them at once does not keep a second copy of the list.
export const WEEKLY_BUCKET_KEYS = Object.freeze(
  [...new Set([...Object.values(FAMILY_WEEKLY_BUCKET), 'unified7d'])]);

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

// Do two model globs describe any model in common? Used to tell whether a route
// is fully shadowed by the blocklist. Exact glob intersection is not decidable
// in general, so this compares literal cores (the pattern with `*` removed) in
// both directions: `claude-fable-5` overlaps `*fable*`, and a bare `*` (empty
// core) overlaps everything. Display-only, and deliberately inclusive — the
// authoritative per-request gate still matches the concrete model id.
export function modelGlobOverlaps(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const core = s => s.replace(/\*/g, '').toLowerCase();
  const ca = core(a);
  const cb = core(b);
  return ca.includes(cb) || cb.includes(ca);
}

// The `blockedModels` pattern that takes a model FAMILY out of service, or null.
//
// The blocklist is written against concrete model ids (`*fable*`,
// `claude-fable-5`) but the status view reasons in families (`Fable`), so a
// direct glob match is not enough: `claude-fable-5` never matches the literal
// string `Fable`. Both spellings are checked so the two natural ways to block a
// family light up the same row — the glob (via modelGlobMatches, which also
// makes a bare `*` block everything) and a concrete id (via substring).
//
// Deliberately advisory: this drives display only. The authoritative gate is the
// per-request check in server.js, which matches the real model id. A pattern
// that names no family (say `claude-3-*`) simply lights up no row, and the
// header list still shows it verbatim.
export function findFamilyBlock(patterns, family) {
  if (!Array.isArray(patterns) || !family) return null;
  const key = String(family).toLowerCase();
  return patterns.find(p => typeof p === 'string'
    && (modelGlobMatches(p, key) || p.toLowerCase().includes(key))) || null;
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
    this.readingScalar = false;       // accumulating a bare scalar (true/false/null/number)
    this.curKey = null;               // last key seen in the current object
    this.buf = [];                    // key/value byte accumulation
    this.value = null;                // the found value, or null
    this.scalar = false;              // the value was a bare scalar, not a quoted string
    this.done = false;                // found it, or the root object closed without it
  }

  /** Feed a chunk (Buffer). Returns the found value so far (string) or null. */
  push(chunk) {
    if (this.done) return this.value;
    for (let i = 0; i < chunk.length && !this.done; i++) this.#byte(chunk[i]);
    return this.value;
  }

  #atRoot() { return this.isObj.length === 1 && this.isObj[0] === true; }

  // A bare scalar (`true`, `false`, `null`, a number) has no closing quote; it
  // ends at the first byte that cannot be part of it. The token is kept as its
  // source text, so `stream: true` reads back as the string 'true'.
  #endScalar() {
    this.value = Buffer.from(this.buf).toString('utf8'); this.buf = [];
    this.readingScalar = false; this.scalar = true; this.done = true;
  }

  #byte(b) {
    if (this.readingScalar) {
      const scalarByte = (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a)
        || b === 0x2b || b === 0x2d || b === 0x2e;                 // 0-9 a-z A-Z + - .
      if (scalarByte) { this.buf.push(b); return; }
      this.#endScalar();
      // Fall through: the byte that ended the scalar still counts as structure.
    }
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
      default:                                                     // scalars / whitespace
        if (this.#atRoot() && this.curKey === this.field && !this.awaitingKey
          && b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
          this.readingScalar = true; this.buf = [b];               // the target field's bare value
        }
        break;
    }
  }
}

// Whether a JSON request body asks for a streamed reply: its top-level
// `stream` field is the literal `true`. Same finder as the model, so a
// `"stream": true` inside conversation text is never mistaken for the field.
// Absent, malformed, or anything but `true` reads as false.
/** @param {Buffer|string|null|undefined} body */
export function parseRequestStream(body) {
  if (!body) return false;
  try {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const finder = new TopLevelFieldFinder('stream');
    return finder.push(buf) === 'true' && finder.scalar;
  } catch { return false; }
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

// Byte-exact locator for the SECOND model an advisor request carries: Claude
// Code's advisor tool (`anthropic-beta: advisor-tool-…`) keeps the executor in
// the top-level `model` field and nests the advisor's model inside the tools
// array — `tools: [{ type: "advisor_20260301", name: "advisor", model: "…" }]`.
// The advisor sub-inference runs on the same account and spends that model's
// quota bucket, so account selection must see it (issue #98).
//
// Same byte-machine discipline as TopLevelFieldFinder: it walks the container
// stack and only reads `type`/`model` strings that are DIRECT fields of an
// object element of the ROOT object's `tools` array — a "model" inside a tool's
// input_schema or inside conversation text is deeper (or under another root
// key) and never matches. Elements are judged when they close, so field order
// within the tool object doesn't matter.
export class AdvisorModelFinder {
  constructor() {
    this.stack = [];                  // frames: {isObj, key, awaitingKey}
    this.inStr = false;
    this.esc = false;
    this.reading = null;              // 'key' | 'type' | 'model' while in a string
    this.buf = [];
    this.toolType = null;             // fields of the tools[] element being read
    this.toolModel = null;
    this.value = null;                // the advisor model, once found
    this.done = false;
  }

  /** Feed a chunk (Buffer). Returns the found value so far (string) or null. */
  push(chunk) {
    if (this.done) return this.value;
    for (let i = 0; i < chunk.length && !this.done; i++) this.#byte(chunk[i]);
    return this.value;
  }

  // The stack is exactly [root object (last key "tools"), array, element object].
  #inToolElement() {
    const s = this.stack;
    return s.length === 3 && s[0].isObj && s[0].key === 'tools' && !s[1].isObj && s[2].isObj;
  }

  #byte(b) {
    if (this.inStr) {
      if (this.esc) { this.esc = false; if (this.reading) this.buf.push(b); return; }
      if (b === 0x5c) { this.esc = true; if (this.reading) this.buf.push(b); return; } // backslash
      if (b === 0x22) {                                            // closing quote
        this.inStr = false;
        if (this.reading) {
          const text = Buffer.from(this.buf).toString('utf8');
          if (this.reading === 'key') this.stack[this.stack.length - 1].key = text;
          else if (this.reading === 'type') this.toolType = text;
          else this.toolModel = text;
          this.reading = null;
          this.buf = [];
        }
        return;
      }
      if (this.reading) this.buf.push(b);
      return;
    }

    switch (b) {
      case 0x7b:                                                   // {
        this.stack.push({ isObj: true, key: null, awaitingKey: true });
        if (this.#inToolElement()) { this.toolType = null; this.toolModel = null; }
        break;
      case 0x5b: this.stack.push({ isObj: false, key: null, awaitingKey: false }); break; // [
      case 0x7d:                                                   // }
        if (this.#inToolElement()
            && typeof this.toolType === 'string' && /^advisor/i.test(this.toolType)
            && this.toolModel) {
          this.value = this.toolModel;
          this.done = true;
        }
        // fall through: pop like ]
      case 0x5d:                                                   // ]
        this.stack.pop();
        if (this.stack.length === 0) this.done = true;             // root closed → absent
        break;
      case 0x3a: { const t = this.stack[this.stack.length - 1]; if (t?.isObj) t.awaitingKey = false; break; } // :
      case 0x2c: { const t = this.stack[this.stack.length - 1]; if (t?.isObj) t.awaitingKey = true; break; }  // ,
      case 0x22: {                                                 // string begins
        const t = this.stack[this.stack.length - 1];
        if (t?.isObj && t.awaitingKey) this.reading = 'key';
        else if (this.#inToolElement() && (t.key === 'type' || t.key === 'model')) this.reading = t.key;
        else this.reading = null;                                  // uninteresting string: skip bytes
        this.buf = [];
        this.inStr = true;
        this.esc = false;
        break;
      }
      default: break;                                              // scalars / whitespace
    }
  }
}

// Extract the advisor model from a JSON request body, or null when the request
// carries no advisor tool. Gated on a cheap byte search for "advisor" so the
// full structural scan only runs on bodies that could possibly contain one —
// for everything else this is a single Buffer.includes.
export function parseAdvisorModel(body) {
  if (!body) return null;
  try {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    if (!buf.includes('advisor')) return null;
    return new AdvisorModelFinder().push(buf);
  } catch { return null; }
}
