// Token usage as OpenAI's Responses API reports it, rewritten into the shape
// the rest of this proxy books.
//
// Every counter here — the account totals, the per-session ones, the per-client
// ones — speaks Anthropic's usage vocabulary, because that is the only shape
// this proxy had to read for its first year. A Codex account is a passthrough,
// so its usage arrives in OpenAI's vocabulary instead, and the two disagree in
// a way that is easy to miss because they share field NAMES:
//
//   Anthropic   `input_tokens` is the UNCACHED input. The cached part is
//               reported separately (`cache_read_input_tokens`,
//               `cache_creation_input_tokens`) and the three are disjoint — the
//               readers here add them up to get a context size or a total.
//
//   Responses   `input_tokens` is the WHOLE prompt, with the cached part named
//               again underneath it as `input_tokens_details.cached_tokens`.
//               Booking it as Anthropic's would count the cached prefix twice
//               once the cache field is also read, and on Codex traffic that
//               prefix is most of the prompt.
//
// So the subtraction below is the entire point of this file: the cached tokens
// move out of `input_tokens` and into `cache_read_input_tokens`, leaving three
// disjoint figures that every existing reader already knows how to add.
//
// `output_tokens_details.reasoning_tokens` is NOT added to the output side —
// it is a breakdown of `output_tokens`, not a second quantity beside it (a real
// turn: input 54904, output 132 of which 18 reasoning, total_tokens 55036 =
// 54904 + 132). `input_tokens_details.cache_write_tokens` is likewise left
// folded into the uncached remainder rather than mapped onto Anthropic's
// `cache_creation_input_tokens`: a cache write IS fresh input being processed,
// OpenAI does not bill it at a premium the way Anthropic does, and inventing a
// fourth disjoint bucket out of a field whose subset relationship is not stated
// anywhere would risk a total that no longer adds up.
//
// Shape confirmed against OpenAI's generated SDK types (`ResponseUsage`) and
// the Codex CLI's own per-turn records.

/** Terminal stream events, the only ones that carry a settled usage object.
 *
 *  Named rather than inferred from "the event has a usage object". A Responses
 *  stream mixes two kinds of event: the LIFECYCLE ones (`response.created`,
 *  `response.in_progress`, `response.queued` and the three below) each carry the
 *  whole response envelope, and therefore a `usage` key — null until the
 *  response settles; the rest, which is most of the stream, carry a fragment
 *  instead (`response.output_text.delta` carries a `delta` string, the
 *  `.added`/`.done` events an `item` or a `part`) and no envelope at all.
 *
 *  So matching the key rather than the name would make this proxy's accounting
 *  depend on the in-flight envelopes keeping `usage: null` for ever, and an
 *  upstream that began reporting progress figures would book one turn once per
 *  lifecycle event. Naming the terminal events keeps that decision here.
 *
 *  The names alone do not stop a terminal event arriving TWICE, so they are not
 *  the whole guard: the stream reader books the first one and ignores the rest
 *  (see `parseSSEDataLine` in src/server.js), because the account and per-client
 *  counters are incremental and would otherwise count the turn again.
 *
 *  `response.failed` is in the set because a failure that got far enough to
 *  report figures still spent them; when it carries none — the usual case — the
 *  normaliser below returns null and nothing is recorded.
 */
const TERMINAL_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed']);

/**
 * A wire figure as a non-negative integer. Everything here is untrusted JSON:
 * a string, a null, a NaN or a negative count must read as "nothing reported"
 * rather than poison a cumulative total that is never recomputed.
 *
 * @param {unknown} v
 * @returns {number}
 */
function count(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

/**
 * A Responses `usage` object in Anthropic's disjoint shape, or null when there
 * is nothing to record.
 *
 * Null for an absent, non-object or all-zero usage, because the recorders
 * downstream treat a written record as an observation that happened: an
 * all-zero one would claim a report arrived and count against `reports`, which
 * is the one thing that distinguishes "upstream told us nothing" from "upstream
 * told us zero".
 *
 * @param {any} usage
 * @returns {{input_tokens: number, output_tokens: number, cache_read_input_tokens: number}|null}
 */
export function normalizeResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  // Clamped to the prompt it is a part of. Upstream cannot report more cached
  // tokens than input tokens, but the uncached remainder is a subtraction, and
  // an unclamped one would go negative and silently shrink a lifetime total.
  const cached = Math.min(count(usage.input_tokens_details?.cached_tokens), prompt);
  if (!prompt && !output) return null;
  return {
    input_tokens: prompt - cached,
    output_tokens: output,
    cache_read_input_tokens: cached,
  };
}

/**
 * Usage from one parsed SSE event of a Responses stream, or null when this
 * event is not a terminal one (the common case — a stream is mostly deltas).
 *
 * @param {any} event
 */
export function responsesEventUsage(event) {
  if (!event || !TERMINAL_EVENTS.has(event.type)) return null;
  return normalizeResponsesUsage(event.response?.usage);
}

/**
 * Whether a NON-streaming body is a Responses one, and so has to be read with
 * `normalizeResponsesUsage` rather than as Anthropic's usage shape.
 *
 * A predicate rather than a "give me the usage or null" reader, because the
 * caller has to tell two different nulls apart: a body that is not a Responses
 * one falls back to reading `usage` directly, while a body that IS one but whose
 * figures do not survive the normaliser must book NOTHING — falling back there
 * would book the very numbers this file exists to stop.
 *
 * Two independent tells, either of which is enough, and neither of which an
 * Anthropic message body can produce:
 *
 *   `object: "response"`     what the Responses envelope calls itself.
 *   `input_tokens_details`   present exactly when a prompt-cache breakdown is
 *                            reported, which is the case that actually needs
 *                            rewriting.
 *
 * Both, rather than either alone, because the first is the honest discriminator
 * while the second is the one that matters: a Responses body that reports no
 * cache breakdown at all needs no rewriting — its `input_tokens` is already
 * uncached input — so a body that somehow shows neither tell is read as
 * Anthropic's and lands on exactly the same numbers it would have anyway.
 *
 * @param {any} json
 * @returns {boolean}
 */
export function isResponsesBody(json) {
  if (!json || typeof json !== 'object') return false;
  const usage = json.usage;
  return json.object === 'response'
    || (usage != null && typeof usage === 'object' && usage.input_tokens_details != null);
}
