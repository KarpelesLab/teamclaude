// Transparent HTTP/2 relay for the MITM proxy.
//
// Bridges two already-decrypted h2 byte streams (claude ⇄ upstream). The
// request direction (claude→upstream) is parsed frame-by-frame: HEADERS/
// CONTINUATION blocks are HPACK-decoded, handed to `rewriteRequest` (which
// rewrites only the auth field), re-encoded, and re-framed; every other frame
// is forwarded verbatim. The response direction (upstream→claude) is passed
// through byte-for-byte and only *observed* (read-only HPACK decode) so we can
// surface `:status` + rate-limit headers for quota tracking.

import { readFrames, buildHeaderBlock, stripHeadersPayload, FRAME, FLAG, PREFACE } from './frames.js';
import { HpackDecoder, HpackEncoder } from './hpack.js';

const SETTINGS_HEADER_TABLE_SIZE = 0x1;

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
  const rewriteRequest = opts.rewriteRequest || ((f) => f);
  const onResponseHeaders = opts.onResponseHeaders || (() => {});
  const log = opts.log || (() => {});

  const reqDec = new HpackDecoder();         // decodes claude's request blocks
  const reqEnc = new HpackEncoder();         // re-encodes to upstream
  reqEnc.dynamicIndexing = false;            // independent of upstream's table size
  const respDec = new HpackDecoder();        // read-only, decodes upstream responses

  const destroyBoth = () => { claude.destroy(); upstream.destroy(); };

  // ── request direction: claude → upstream (rewrite HEADERS) ──
  let rbuf = Buffer.alloc(0);
  let prefaceSeen = false;
  let asm = null; // { streamId, frags:[], priority, endStream } while assembling a block
  let reqCtl;

  const onReqData = (chunk) => {
    rbuf = Buffer.concat([rbuf, chunk]);
    if (!prefaceSeen) {
      if (rbuf.length < PREFACE.length) return;
      writeBackpressured(upstream, rbuf.subarray(0, PREFACE.length), reqCtl); // forward preface verbatim
      rbuf = rbuf.subarray(PREFACE.length);
      prefaceSeen = true;
    }
    const { frames, rest } = readFrames(rbuf);
    rbuf = rest;
    for (const fr of frames) handleReqFrame(fr);
  };

  function handleReqFrame(fr) {
    // Mid-block: only CONTINUATION on the same stream may follow (RFC 7540 §6.10).
    if (asm) {
      if (fr.type === FRAME.CONTINUATION && fr.streamId === asm.streamId) {
        asm.frags.push(Buffer.from(fr.payload));
        if (fr.flags & FLAG.END_HEADERS) finishReqBlock();
        return;
      }
      // Shouldn't happen; bail safely.
      throw new Error('interleaved frame during header block');
    }
    if (fr.type === FRAME.HEADERS) {
      const { block, priority } = stripHeadersPayload(fr.payload, fr.flags);
      asm = { streamId: fr.streamId, frags: [block], priority, endStream: !!(fr.flags & FLAG.END_STREAM) };
      if (fr.flags & FLAG.END_HEADERS) finishReqBlock();
      return;
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
    const rewritten = rewriteRequest(fields);
    const newBlock = reqEnc.encode(rewritten);
    writeBackpressured(upstream, buildHeaderBlock(streamId, newBlock, { endStream, priority }), reqCtl);
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
        if (fr.flags & FLAG.END_HEADERS) finishRespBlock();
      }
      return;
    }
    if (fr.type === FRAME.HEADERS) {
      const { block } = stripHeadersPayload(fr.payload, fr.flags);
      rasm = { streamId: fr.streamId, frags: [block] };
      if (fr.flags & FLAG.END_HEADERS) finishRespBlock();
    }
  }

  function finishRespBlock() {
    const { frags } = rasm;
    rasm = null;
    try {
      const fields = respDec.decode(Buffer.concat(frags));
      onResponseHeaders(fields);
    } catch (err) {
      log(`[TeamClaude] h2 response header decode failed: ${err.message}`);
    }
  }

  respCtl = link(upstream, claude, onRespData, destroyBoth);
}

/**
 * Faithful HTTP/1.1 relay for the rare h1 case. Reads the first request head,
 * rewrites only the auth line (via `rewriteHead`), forwards it, then tunnels
 * both directions raw. (Real Anthropic traffic is h2; on a keep-alive h1
 * connection only the first request's auth is rewritten — documented tradeoff.)
 *
 * @param opts.rewriteHead (headText) => headText
 */
export function h1Relay(claude, upstream, opts = {}) {
  const rewriteHead = opts.rewriteHead || ((h) => h);
  const destroyBoth = () => { claude.destroy(); upstream.destroy(); };
  claude.on('error', destroyBoth);
  upstream.on('error', destroyBoth);
  claude.on('close', () => upstream.destroy());
  upstream.on('close', () => claude.destroy());

  let buf = Buffer.alloc(0);
  let done = false;
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx < 0) {
      if (buf.length > 65536) destroyBoth(); // runaway head
      return;
    }
    done = true;
    claude.removeListener('data', onData);
    const head = rewriteHead(buf.subarray(0, idx + 4).toString('latin1'));
    upstream.write(Buffer.from(head, 'latin1'));
    const remainder = buf.subarray(idx + 4);
    if (remainder.length) upstream.write(remainder);
    claude.pipe(upstream);
    upstream.pipe(claude);
  };
  claude.on('data', onData);
  void done;
}

/** Rewrite an HTTP/1.1 request head: replace the Authorization line with
 *  `authValue` (or set x-api-key), and drop the other client-supplied key. */
export function rewriteH1Auth(headText, { authorization = null, apiKey = null }) {
  const lines = headText.split('\r\n');
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
