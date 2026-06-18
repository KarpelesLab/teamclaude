// Minimal HTTP/2 framing (RFC 7540 §4) — just what the MITM relay needs:
// split a byte stream into frames, re-serialize frames, and (de)construct
// HEADERS/CONTINUATION header blocks so we can rewrite one header and re-emit.
// All other frame types are forwarded verbatim by the relay.

export const FRAME = {
  DATA: 0x0, HEADERS: 0x1, PRIORITY: 0x2, RST_STREAM: 0x3, SETTINGS: 0x4,
  PUSH_PROMISE: 0x5, PING: 0x6, GOAWAY: 0x7, WINDOW_UPDATE: 0x8, CONTINUATION: 0x9,
};
export const FLAG = { END_STREAM: 0x1, END_HEADERS: 0x4, PADDED: 0x8, PRIORITY: 0x20 };

// Client connection preface: "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n" (RFC 7540 §3.5).
export const PREFACE = Buffer.from('505249202a20485454502f322e300d0a0d0a534d0d0a0d0a', 'hex');

/**
 * Split as many complete frames as possible out of `buf`.
 * Returns { frames, rest } where rest is the unconsumed tail (incomplete frame).
 * Each frame: { type, flags, streamId, payload, raw } (payload/raw are subarrays).
 */
export function readFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 9) {
    const length = buf.readUIntBE(off, 3);
    if (buf.length - off < 9 + length) break;
    frames.push({
      type: buf[off + 3],
      flags: buf[off + 4],
      streamId: buf.readUInt32BE(off + 5) & 0x7fffffff,
      payload: buf.subarray(off + 9, off + 9 + length),
      raw: buf.subarray(off, off + 9 + length),
    });
    off += 9 + length;
  }
  return { frames, rest: buf.subarray(off) };
}

/** Serialize one frame. */
export function buildFrame({ type, flags = 0, streamId, payload = Buffer.alloc(0) }) {
  const h = Buffer.alloc(9);
  h.writeUIntBE(payload.length, 0, 3);
  h[3] = type;
  h[4] = flags;
  h.writeUInt32BE(streamId & 0x7fffffff, 5);
  return Buffer.concat([h, payload]);
}

/**
 * Pull the header-block fragment out of a HEADERS payload, stripping any
 * PADDED / PRIORITY prefixes. Returns { block, priority } where priority is the
 * 5-byte priority field (or null). Padding is discarded.
 */
export function stripHeadersPayload(payload, flags) {
  let off = 0;
  let padLen = 0;
  if (flags & FLAG.PADDED) { padLen = payload[0]; off = 1; }
  let priority = null;
  if (flags & FLAG.PRIORITY) { priority = Buffer.from(payload.subarray(off, off + 5)); off += 5; }
  const block = Buffer.from(payload.subarray(off, payload.length - padLen));
  return { block, priority };
}

/**
 * Build a HEADERS frame (+ CONTINUATION frames if the block exceeds
 * maxFrameSize) for a re-encoded header block. Padding is not re-added.
 */
export function buildHeaderBlock(streamId, block, { endStream = false, priority = null, maxFrameSize = 16384 } = {}) {
  const prio = priority || Buffer.alloc(0);
  const firstCap = Math.max(0, maxFrameSize - prio.length);
  const firstChunk = block.subarray(0, firstCap);
  let rest = block.subarray(firstChunk.length);

  let hFlags = (endStream ? FLAG.END_STREAM : 0) | (priority ? FLAG.PRIORITY : 0);
  if (rest.length === 0) hFlags |= FLAG.END_HEADERS;

  const out = [buildFrame({ type: FRAME.HEADERS, flags: hFlags, streamId, payload: Buffer.concat([prio, firstChunk]) })];
  while (rest.length) {
    const chunk = rest.subarray(0, maxFrameSize);
    rest = rest.subarray(chunk.length);
    out.push(buildFrame({ type: FRAME.CONTINUATION, flags: rest.length === 0 ? FLAG.END_HEADERS : 0, streamId, payload: chunk }));
  }
  return Buffer.concat(out);
}
