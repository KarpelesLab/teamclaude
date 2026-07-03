// Transparent HTTP/2 relay for the MITM proxy.
//
// Bridges two already-decrypted h2 byte streams (claude ⇄ upstream). The
// request direction (claude→upstream) is parsed frame-by-frame: HEADERS/
// CONTINUATION blocks are HPACK-decoded, handed to `rewriteRequest` (which
// rewrites only the auth field), re-encoded, and re-framed; every other frame
// is forwarded verbatim. The response direction (upstream→claude) is passed
// through byte-for-byte and only *observed* (read-only HPACK decode) so we can
// surface `:status` + rate-limit headers for quota tracking.

import { readFrames, buildFrame, buildHeaderBlock, stripHeadersPayload, FRAME, FLAG, PREFACE } from './frames.js';
import { HpackDecoder, HpackEncoder } from './hpack.js';
import { TopLevelFieldFinder } from '../model.js';

const SETTINGS_HEADER_TABLE_SIZE = 0x1;
// How much request body to feed the model finder before binding an account. The
// model sits near the top of the Messages JSON, so this is only ever a small
// prefix; if it hasn't resolved within the cap we bind model-blind.
const MODEL_PEEK_CAP = 65536;

// Wire src→dst with backpressure; `onClose` fires once when either side ends.
function link(src, dst, onData, onClose) {
  let closed = false;
  const close = () => { if (closed) return; closed = true; onClose(); };
  src.on('data', (chunk) => {
    try { onData(chunk); } catch (err) { close(); src.destroy(err); }
  });
  src.on('end', close);
  src.on('close', close);
  src.on('error', close);
  return { pauseSrc: () => src.pause(), resumeSrc: () => src.resume() };
}

function writeBackpressured(dst, buf, ctl) {
  if (buf.length === 0) return;
  if (!dst.write(buf)) {
    ctl.pauseSrc();
    dst.once('drain', () => ctl.resumeSrc());
  }
}

/**
 * @param claude decrypted duplex toward the client
 * @param upstream decrypted duplex toward Anthropic
 * @param opts.rewriteRequest (fields[]) => fields[]   // mutate/return the header list
 * @param opts.onResponseHeaders (fields[]) => void    // observe response headers
 * @param opts.log
 */
export function h2Relay(claude, upstream, opts = {}) {
  // rewriteRequest/makeBodyPatcher/onResponseHeaders all receive the stream id so
  // the caller can bind a DIFFERENT account per request on this one tunnel (the
  // upstream socket is account-agnostic; the account is only the injected auth +
  // body account_uuid). onStreamClose lets the caller drop its per-stream state.
  const rewriteRequest = opts.rewriteRequest || ((f) => f);
  const onResponseHeaders = opts.onResponseHeaders || (() => {});
  const onStreamClose = opts.onStreamClose || (() => {});
  const makeBodyPatcher = opts.makeBodyPatcher || null; // () => { push(buf)->buf } per stream
  const bodyPatchers = makeBodyPatcher ? new Map() : null; // streamId -> patcher
  // Model-aware binding: when enabled, a request with a body is held after its
  // HEADERS until the body's top-level `model` is peeked, so rewriteRequest can
  // pick the account from it. Off by default → HEADERS forward immediately.
  const peekModel = !!opts.peekModel;
  const deferred = peekModel ? new Map() : null; // streamId -> { fields, priority, chunks, finder, bodyLen }
  const tap = opts.tap || null; // optional request-logging tap (per streamId)
  const log = opts.log || (() => {});

  // Streams that have started (request headers seen) but not yet completed, so a
  // mid-flight connection teardown can close their tap records instead of
  // leaking them (e.g. a stuck "in-flight" entry in the TUI activity feed).
  const openStreams = new Set();
  const NO_PATCH = { push: (b) => b }; // per-stream sentinel when the chosen account has no uuid to patch
  const closeStream = (id) => { if (bodyPatchers) bodyPatchers.delete(id); tap?.end(id); openStreams.delete(id); onStreamClose(id); };

  const reqDec = new HpackDecoder();         // decodes claude's request blocks
  const reqEnc = new HpackEncoder();         // re-encodes to upstream
  reqEnc.dynamicIndexing = false;            // independent of upstream's table size
  const respDec = new HpackDecoder();        // read-only, decodes upstream responses

  const destroyBoth = () => {
    for (const id of openStreams) tap?.end(id);
    openStreams.clear();
    claude.destroy(); upstream.destroy();
  };

  // ── request direction: claude → upstream (rewrite HEADERS) ──
  let rbuf = Buffer.alloc(0);
  let prefaceSeen = false;
  let asm = null; // { streamId, frags:[], priority, endStream } while assembling a block
  let reqCtl;

  // The pump is async ONLY so it can await a token refresh before forwarding a
  // request whose account's token had expired (rewriteRequest returns a promise
  // in that rare case). In the common case handleReqFrame returns nothing, the
  // loop never awaits, and the whole pump runs synchronously start-to-finish — so
  // no frames can interleave. When it does suspend, `reqPumping` makes a
  // concurrent data event just append to rbuf; the running pump drains it on the
  // next iteration. The only suspension point is `await r`, and the tail after it
  // (break → finally) runs without yielding, so there is no lost-wakeup race.
  let reqPumping = false;
  const onReqData = (chunk) => {
    rbuf = Buffer.concat([rbuf, chunk]);
    if (reqPumping) return; // a suspended pump will pick up the appended bytes
    pumpReq();
  };

  async function pumpReq() {
    reqPumping = true;
    try {
      if (!prefaceSeen) {
        if (rbuf.length < PREFACE.length) return;
        writeBackpressured(upstream, rbuf.subarray(0, PREFACE.length), reqCtl); // forward preface verbatim
        rbuf = rbuf.subarray(PREFACE.length);
        prefaceSeen = true;
      }
      for (;;) {
        const { frames, rest } = readFrames(rbuf);
        rbuf = rest;
        if (!frames.length) break;
        for (const fr of frames) {
          const r = handleReqFrame(fr);
          if (r && typeof r.then === 'function') await r; // HEADERS awaiting a token refresh
        }
      }
    } catch { destroyBoth(); }
    finally { reqPumping = false; }
  }

  function handleReqFrame(fr) {
    // Mid-block: only CONTINUATION on the same stream may follow (RFC 7540 §6.10).
    if (asm) {
      if (fr.type === FRAME.CONTINUATION && fr.streamId === asm.streamId) {
        asm.frags.push(Buffer.from(fr.payload));
        if (fr.flags & FLAG.END_HEADERS) return finishReqBlock(); // may be a promise (token refresh)
        return;
      }
      // Shouldn't happen; bail safely.
      throw new Error('interleaved frame during header block');
    }
    if (fr.type === FRAME.HEADERS) {
      const { block, priority } = stripHeadersPayload(fr.payload, fr.flags);
      asm = { streamId: fr.streamId, frags: [block], priority, endStream: !!(fr.flags & FLAG.END_STREAM) };
      if (fr.flags & FLAG.END_HEADERS) return finishReqBlock(); // may be a promise (token refresh)
      return;
    }
    if (fr.type === FRAME.DATA && deferred) {
      // While a stream is held for model peeking, buffer its body frames instead
      // of forwarding them (upstream hasn't seen the HEADERS yet). Feed the finder
      // until the top-level `model` resolves, END_STREAM arrives, or the peek cap
      // is hit — then bind the account and flush everything in order.
      const d = deferred.get(fr.streamId);
      if (d) {
        const payload = Buffer.from(fr.payload);
        d.chunks.push({ flags: fr.flags, payload });
        const model = d.bodyLen < MODEL_PEEK_CAP ? d.finder.push(payload) : d.finder.value;
        d.bodyLen += payload.length;
        const end = !!(fr.flags & FLAG.END_STREAM);
        if (d.finder.done || end || d.bodyLen >= MODEL_PEEK_CAP) {
          deferred.delete(fr.streamId);
          return forwardReq(fr.streamId, d.fields, d.priority, false, d.chunks, model);
        }
        return; // keep buffering
      }
    }
    if (fr.type === FRAME.DATA && (bodyPatchers || tap)) {
      // Same-length in-place body patch (account_uuid) via a per-stream streaming
      // JSON state machine; re-emit the DATA frame unchanged in length/flags so
      // framing & flow control are preserved.
      let payload = Buffer.from(fr.payload);
      if (bodyPatchers) {
        let p = bodyPatchers.get(fr.streamId);
        if (p === undefined) { p = makeBodyPatcher(fr.streamId) || NO_PATCH; bodyPatchers.set(fr.streamId, p); }
        payload = p.push(payload);
      }
      if (tap) tap.reqData(fr.streamId, payload);
      writeBackpressured(upstream, buildFrame({ type: FRAME.DATA, flags: fr.flags, streamId: fr.streamId, payload }), reqCtl);
      if (fr.flags & FLAG.END_STREAM && bodyPatchers) bodyPatchers.delete(fr.streamId);
      return;
    }
    if (fr.type === FRAME.RST_STREAM) {
      // A held (not-yet-forwarded) stream: drop it without relaying the RST —
      // upstream never saw its HEADERS, so a RST would reference an unknown stream.
      if (deferred?.delete(fr.streamId)) { closeStream(fr.streamId); return; }
      closeStream(fr.streamId);
    }
    if (fr.type === FRAME.SETTINGS && fr.streamId === 0 && !(fr.flags & 0x1)) {
      applyTableSizeSetting(fr.payload, respDec); // claude's setting governs response encoding
    }
    writeBackpressured(upstream, fr.raw, reqCtl); // everything else: verbatim
  }

  function finishReqBlock() {
    const { streamId, frags, priority, endStream } = asm;
    asm = null;
    const fields = reqDec.decode(Buffer.concat(frags)); // keep decoder dynamic table in sync
    // Model-aware binding: hold a request that has a body until its `model` is
    // peeked (see the DATA handler). A bodyless request has no model to read, so
    // it forwards straight away. The decode above already ran, so the HPACK
    // decoder table stays in sync even while we defer the encode/forward.
    if (deferred && !endStream) {
      deferred.set(streamId, { fields, priority, chunks: [], finder: new TopLevelFieldFinder('model'), bodyLen: 0 });
      return;
    }
    return forwardReq(streamId, fields, priority, endStream, null, null);
  }

  // Encode + forward a request's HEADERS (choosing the account via rewriteRequest,
  // now that `model` is known), then flush any buffered body frames through the
  // account-bound patcher. The pump awaits this so decode & encode stay in wire
  // order and the HPACK tables never desync even when a token refresh suspends us.
  async function forwardReq(streamId, fields, priority, endStream, dataChunks, model) {
    let rewritten = rewriteRequest(fields, streamId, model);
    if (rewritten && typeof rewritten.then === 'function') rewritten = await rewritten;
    if (tap) tap.req(streamId, rewritten);
    openStreams.add(streamId);
    const newBlock = reqEnc.encode(rewritten);
    writeBackpressured(upstream, buildHeaderBlock(streamId, newBlock, { endStream, priority }), reqCtl);
    if (!dataChunks || !dataChunks.length) return;
    // Bind the body patcher to the chosen account, then replay the buffered body
    // frames (and, via bodyPatchers, any later DATA frames for this stream).
    let patcher = NO_PATCH;
    if (bodyPatchers) { patcher = makeBodyPatcher(streamId) || NO_PATCH; bodyPatchers.set(streamId, patcher); }
    for (const ch of dataChunks) {
      const payload = bodyPatchers ? patcher.push(ch.payload) : ch.payload;
      if (tap) tap.reqData(streamId, payload);
      writeBackpressured(upstream, buildFrame({ type: FRAME.DATA, flags: ch.flags, streamId, payload }), reqCtl);
      if ((ch.flags & FLAG.END_STREAM) && bodyPatchers) bodyPatchers.delete(streamId);
    }
  }

  reqCtl = link(claude, upstream, onReqData, destroyBoth);

  // ── response direction: upstream → claude (passthrough + observe) ──
  let sbuf = Buffer.alloc(0);
  let rasm = null;
  let respCtl;

  const onRespData = (chunk) => {
    writeBackpressured(claude, chunk, respCtl); // verbatim passthrough first
    sbuf = Buffer.concat([sbuf, chunk]);
    const { frames, rest } = readFrames(sbuf);
    sbuf = rest;
    for (const fr of frames) observeRespFrame(fr);
  };

  function observeRespFrame(fr) {
    if (rasm) {
      if (fr.type === FRAME.CONTINUATION && fr.streamId === rasm.streamId) {
        rasm.frags.push(Buffer.from(fr.payload));
        if (fr.flags & FLAG.END_HEADERS) finishRespBlock(rasm.streamId);
      }
      return;
    }
    if (fr.type === FRAME.HEADERS) {
      const { block } = stripHeadersPayload(fr.payload, fr.flags);
      rasm = { streamId: fr.streamId, frags: [block] };
      if (fr.flags & FLAG.END_HEADERS) finishRespBlock(fr.streamId);
      if (fr.flags & FLAG.END_STREAM) closeStream(fr.streamId);
      return;
    }
    if (fr.type === FRAME.DATA) {
      if (tap) tap.resData(fr.streamId, Buffer.from(fr.payload));
      if (fr.flags & FLAG.END_STREAM) closeStream(fr.streamId);
    }
  }

  function finishRespBlock(streamId) {
    const { frags } = rasm;
    rasm = null;
    try {
      const fields = respDec.decode(Buffer.concat(frags));
      onResponseHeaders(fields, streamId);
      if (tap) tap.res(streamId, fields);
    } catch (err) {
      log(`[TeamClaude] h2 response header decode failed: ${err.message}`);
    }
  }

  respCtl = link(upstream, claude, onRespData, destroyBoth);
}

const MAX_HEAD = 65536; // runaway-head guard for a single request/response head

// Parse an HTTP/1.1 message head: its start line + the body framing it declares.
// `chunked` wins over content-length per RFC 7230 §3.3.3.
function parseH1Head(headText) {
  const lines = headText.split('\r\n');
  let contentLength = null;
  let chunked = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') break;
    const c = line.indexOf(':');
    if (c < 0) continue;
    const name = line.slice(0, c).trim().toLowerCase();
    const value = line.slice(c + 1).trim().toLowerCase();
    if (name === 'transfer-encoding') { if (/(^|,)\s*chunked\s*$/.test(value)) chunked = true; }
    else if (name === 'content-length') { const n = parseInt(value, 10); if (!Number.isNaN(n)) contentLength = n; }
  }
  return { startLine: lines[0] || '', contentLength, chunked };
}

// A streaming body-length tracker. process(buf) returns how many leading bytes of
// `buf` belong to the current message body and whether the body is complete; it
// keeps internal state across calls so a body split over many chunks is tracked
// exactly. `kind`: 'none' | 'length' | 'chunked' | 'until-close'.
function makeBodyTracker(kind, length = 0) {
  if (kind === 'none') return () => ({ consumed: 0, done: true });
  if (kind === 'until-close') return (buf) => ({ consumed: buf.length, done: false });
  if (kind === 'length') {
    let need = length;
    return (buf) => { const take = Math.min(need, buf.length); need -= take; return { consumed: take, done: need === 0 }; };
  }
  // chunked: count framing bytes (size lines, data, trailing CRLFs, trailers)
  let phase = 'size'; // size | data | dataCRLF | trailers
  let need = 0;       // bytes left in current chunk's data
  let line = '';      // accumulates a CRLF-terminated control line across chunks
  return (buf) => {
    let i = 0;
    while (i < buf.length) {
      if (phase === 'size') {
        const nl = buf.indexOf(0x0a, i);
        if (nl < 0) { line += buf.toString('latin1', i); return { consumed: buf.length, done: false }; }
        line += buf.toString('latin1', i, nl + 1); i = nl + 1;
        const size = parseInt(line.trim().split(';')[0], 16); line = '';
        if (Number.isNaN(size)) return { consumed: i, done: true };  // malformed: stop here
        if (size === 0) phase = 'trailers'; else { need = size; phase = 'data'; }
      } else if (phase === 'data') {
        const take = Math.min(need, buf.length - i); i += take; need -= take;
        if (need === 0) phase = 'dataCRLF';
      } else if (phase === 'dataCRLF') {
        const nl = buf.indexOf(0x0a, i);
        if (nl < 0) return { consumed: buf.length, done: false };
        i = nl + 1; phase = 'size';
      } else { // trailers: read until a blank line ends the message
        const nl = buf.indexOf(0x0a, i);
        if (nl < 0) { line += buf.toString('latin1', i); return { consumed: buf.length, done: false }; }
        const seg = line + buf.toString('latin1', i, nl + 1); line = ''; i = nl + 1;
        if (seg === '\r\n' || seg === '\n') return { consumed: i, done: true };
      }
    }
    return { consumed: i, done: false };
  };
}

const methodOf = (startLine) => startLine.split(' ')[0].toUpperCase();
const statusOf = (startLine) => parseInt(startLine.split(' ')[1], 10) || 0;

/**
 * Faithful HTTP/1.1 relay. Frames every request/response on a keep-alive
 * connection (parsing content-length / chunked bodies), so each request's auth
 * line is rewritten via `rewriteHead`, each request body is patched, and each
 * exchange is logged to its own tap record. Responses are written to claude
 * verbatim first — parsing is observation-only, so a framing miss can never
 * corrupt the relayed stream — and matched to requests in FIFO order (HTTP/1.1
 * guarantees in-order responses).
 *
 * @param opts.rewriteHead (headText) => headText      // rewrite each request head
 * @param opts.onResponseHeaders (fields[]) => void    // observe each response's headers
 */
export function h1Relay(claude, upstream, opts = {}) {
  // rewriteHead/makeBodyPatcher/onResponseHeaders receive the per-request id so
  // the caller can bind a different account to each request on this keep-alive
  // connection; onRequestClose lets it drop that per-request state.
  const rewriteHead = opts.rewriteHead || ((h) => h);
  const makeBodyPatcher = opts.makeBodyPatcher || null;
  const onResponseHeaders = opts.onResponseHeaders || (() => {});
  const onRequestClose = opts.onStreamClose || (() => {});
  const tap = opts.tap || null;
  // Model-aware binding: hold a content-length request body to peek its top-level
  // `model` before rewriteHead picks the account. Off by default; chunked and
  // bodyless requests always bind immediately.
  const peekModel = !!opts.peekModel;
  const destroyBoth = () => { claude.destroy(); upstream.destroy(); };
  claude.on('error', destroyBoth);
  upstream.on('error', destroyBoth);

  let nextId = 0;
  const pending = []; // request ids awaiting a response head, in send order

  // Close any tap records still open when the connection tears down.
  const endOpen = () => { if (!tap) return; if (resId !== null) tap.end(resId); for (const p of pending) tap.end(p.id); pending.length = 0; };

  // ── request direction: claude → upstream (rewrite head, patch + forward body) ──
  let reqBuf = Buffer.alloc(0);
  let reqPhase = 'head';
  let reqTrack = null, reqPatcher = null, reqId = null;
  let pend = null; // while peeking a body for `model`: { head, info, track, finder, raw[], len }

  // Async ONLY so a request head whose account token expired can await a refresh
  // before it is forwarded (rewriteHead returns a promise in that rare case).
  // Requests are strictly serial in h1, so `reqPumping` guards re-entrancy: while
  // suspended, a data event just appends to reqBuf and the running pump drains it.
  // The common case never awaits and runs fully synchronously.
  let reqPumping = false;
  const pumpReq = async () => {
    if (reqPumping) return;
    reqPumping = true;
    try {
      while (reqBuf.length) {
        if (reqPhase === 'head') {
          const idx = reqBuf.indexOf('\r\n\r\n');
          if (idx < 0) { if (reqBuf.length > MAX_HEAD) destroyBoth(); break; }
          // Assign the id BEFORE rewriting so the caller can bind this request's
          // account (used again to attribute the response and patch the body).
          reqId = ++nextId;
          const rawHead = reqBuf.subarray(0, idx + 4).toString('latin1');
          reqBuf = reqBuf.subarray(idx + 4);
          const info = parseH1Head(rawHead); // framing is unchanged by the auth rewrite
          const kind = info.chunked ? 'chunked' : (info.contentLength > 0 ? 'length' : 'none');
          // Defer a content-length body to peek `model` first; bind other requests now.
          if (peekModel && kind === 'length') {
            pend = { head: rawHead, info, track: makeBodyTracker('length', info.contentLength), finder: new TopLevelFieldFinder('model'), raw: [], len: 0 };
            reqPhase = 'peek';
            continue;
          }
          const rew = rewriteHead(rawHead, reqId, null);
          const head = (rew && typeof rew.then === 'function') ? await rew : rew;
          pending.push({ id: reqId, method: methodOf(info.startLine) });
          if (tap) tap.reqHead(reqId, head);
          upstream.write(Buffer.from(head, 'latin1'));
          reqPatcher = makeBodyPatcher ? makeBodyPatcher(reqId) : null;
          reqTrack = makeBodyTracker(kind, info.contentLength || 0);
          reqPhase = 'body';
        } else if (reqPhase === 'peek') {
          // Accumulate the body (raw, for faithful replay) and feed the finder
          // until the top-level `model` resolves, the body ends, or the cap is hit.
          const { consumed, done } = pend.track(reqBuf);
          if (consumed > 0) {
            const slice = Buffer.from(reqBuf.subarray(0, consumed));
            reqBuf = reqBuf.subarray(consumed);
            pend.raw.push(slice);
            if (pend.len < MODEL_PEEK_CAP) pend.finder.push(slice);
            pend.len += slice.length;
          }
          if (done || pend.finder.done || pend.len >= MODEL_PEEK_CAP) {
            const model = pend.finder.value;
            const rew = rewriteHead(pend.head, reqId, model);
            const head = (rew && typeof rew.then === 'function') ? await rew : rew;
            pending.push({ id: reqId, method: methodOf(pend.info.startLine) });
            if (tap) tap.reqHead(reqId, head);
            upstream.write(Buffer.from(head, 'latin1'));
            reqPatcher = makeBodyPatcher ? makeBodyPatcher(reqId) : null;
            let body = Buffer.concat(pend.raw);
            if (reqPatcher) body = reqPatcher.push(body);
            if (body.length) { if (tap) tap.reqData(reqId, body); upstream.write(body); }
            const remaining = pend.info.contentLength - pend.len;
            if (done) { reqPhase = 'head'; reqTrack = null; reqPatcher = null; }
            else { reqTrack = makeBodyTracker('length', remaining); reqPhase = 'body'; }
            pend = null;
          } else if (consumed === 0) break; // need more body bytes
        } else {
          const { consumed, done } = reqTrack(reqBuf);
          if (consumed > 0) {
            let slice = Buffer.from(reqBuf.subarray(0, consumed));
            reqBuf = reqBuf.subarray(consumed);
            if (reqPatcher) slice = reqPatcher.push(slice); // same-length account_uuid patch
            if (tap) tap.reqData(reqId, slice);
            upstream.write(slice);
          }
          if (done) { reqPhase = 'head'; reqTrack = null; reqPatcher = null; }
          else if (consumed === 0) break; // need more body bytes
        }
      }
    } catch { destroyBoth(); }
    finally { reqPumping = false; }
  };
  claude.on('data', (c) => { reqBuf = Buffer.concat([reqBuf, c]); pumpReq(); });
  claude.on('end', () => upstream.end());
  claude.on('close', () => upstream.destroy());

  // ── response direction: upstream → claude (verbatim passthrough + observe) ──
  let resBuf = Buffer.alloc(0);
  let resPhase = 'head';
  let resTrack = null, resId = null;

  const pumpRes = () => {
    while (resBuf.length) {
      if (resPhase === 'head') {
        const idx = resBuf.indexOf('\r\n\r\n');
        if (idx < 0) { if (resBuf.length > MAX_HEAD) resBuf = resBuf.subarray(resBuf.length - MAX_HEAD); return; }
        const head = resBuf.subarray(0, idx + 4).toString('latin1');
        resBuf = resBuf.subarray(idx + 4);
        const info = parseH1Head(head);
        const status = statusOf(info.startLine);
        if (status >= 100 && status < 200) continue; // interim (e.g. 100-continue): no body, no request consumed
        // Match the response to its request FIRST so quota is attributed to the
        // account THAT request used (each request may be a different account).
        const req = pending.shift();
        resId = req ? req.id : ++nextId;
        onResponseHeaders(headFields(head), resId);
        if (tap) tap.resHead(resId, head);
        const bodyless = req?.method === 'HEAD' || status === 204 || status === 304;
        const kind = bodyless ? 'none'
          : info.chunked ? 'chunked'
          : info.contentLength !== null ? 'length'
          : 'until-close';
        resTrack = makeBodyTracker(kind, info.contentLength || 0);
        resPhase = 'body';
      } else {
        const { consumed, done } = resTrack(resBuf);
        if (consumed > 0) { if (tap) tap.resData(resId, Buffer.from(resBuf.subarray(0, consumed))); resBuf = resBuf.subarray(consumed); }
        if (done) { if (tap) tap.end(resId); onRequestClose(resId); resId = null; resPhase = 'head'; resTrack = null; }
        else if (consumed === 0) return;
      }
    }
  };
  upstream.on('data', (c) => {
    claude.write(c);                 // faithful passthrough first
    resBuf = Buffer.concat([resBuf, c]);
    try { pumpRes(); } catch { resBuf = Buffer.alloc(0); } // never let a parse bug break the relay
  });
  upstream.on('end', () => { endOpen(); claude.end(); });
  upstream.on('close', () => { endOpen(); claude.destroy(); });
}

// Parse an HTTP/1.1 head into an h2-style [{name,value}] list (lowercased names),
// so a response can feed the same quota observer the h2 path uses.
function headFields(headText) {
  const out = [];
  const lines = headText.split('\r\n');
  out.push({ name: ':status', value: String(statusOf(lines[0] || '')) });
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') break;
    const c = line.indexOf(':');
    if (c < 0) continue;
    out.push({ name: line.slice(0, c).trim().toLowerCase(), value: line.slice(c + 1).trim() });
  }
  return out;
}

/** Rewrite an HTTP/1.1 request head: replace the Authorization line with
 *  `authValue` (or set x-api-key), and drop the other client-supplied key. */
export function rewriteH1Auth(headText, { authorization = null, apiKey = null }) {
  const lines = headText.split('\r\n');
  // Claude Code's Remote Control control channel (/v1/code/*) is bound to the
  // claude.ai identity the session is paired with. Injecting a rotated account's
  // token makes the upstream reject the worker event stream with 403, which kills
  // Remote Control. Pass these requests through untouched so Claude's own paired
  // credential reaches the server (same spirit as the /v1/oauth/token passthrough).
  const reqPath = (lines[0] || '').split(' ')[1] || '';
  if (reqPath.startsWith('/v1/code/')) return headText;
  const out = [lines[0]]; // request line
  let setAuth = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') { out.push(line); continue; }
    const lower = line.toLowerCase();
    if (lower.startsWith('x-api-key:')) continue;
    if (lower.startsWith('authorization:')) {
      if (authorization) { out.push(`authorization: ${authorization}`); setAuth = true; }
      continue;
    }
    out.push(line);
  }
  // insert our credential just before the terminating blank line if not already set
  if (!setAuth && (authorization || apiKey)) {
    const blank = out.lastIndexOf('');
    const hdr = authorization ? `authorization: ${authorization}` : `x-api-key: ${apiKey}`;
    out.splice(blank, 0, hdr);
  }
  return out.join('\r\n');
}

// Parse a SETTINGS payload for HEADER_TABLE_SIZE and apply it to a decoder's
// size limit (so it stays in sync with the announcing peer's encoder).
function applyTableSizeSetting(payload, decoder) {
  for (let i = 0; i + 6 <= payload.length; i += 6) {
    if (payload.readUInt16BE(i) === SETTINGS_HEADER_TABLE_SIZE) {
      const size = payload.readUInt32BE(i + 2);
      decoder.sizeLimit = size;
      decoder.table.setMaxSize(Math.min(size, decoder.table.maxSize));
    }
  }
}
