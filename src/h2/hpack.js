// HPACK header compression (RFC 7541) — pure JS, no deps.
//
// Ported clean-room from the compcol Rust implementation (itself transcribed
// from RFC 7541's appendices). Used by the MITM proxy to decode/re-encode the
// HTTP/2 header block so it can rewrite only the `authorization` field while
// leaving everything else intact. Names/values are Buffers (byte-exact).
//
// State note: an HPACK codec is stateful across header blocks (the dynamic
// table evolves), so one HpackDecoder/HpackEncoder instance is kept per
// direction per connection.

// ── Huffman code table (RFC 7541 Appendix B): [code, bitLength] by symbol ──
// Index = symbol value; index 256 = EOS.
const CODES = [
  [0x1ff8,13],[0x7fffd8,23],[0xfffffe2,28],[0xfffffe3,28],[0xfffffe4,28],[0xfffffe5,28],[0xfffffe6,28],[0xfffffe7,28],
  [0xfffffe8,28],[0xffffea,24],[0x3ffffffc,30],[0xfffffe9,28],[0xfffffea,28],[0x3ffffffd,30],[0xfffffeb,28],[0xfffffec,28],
  [0xfffffed,28],[0xfffffee,28],[0xfffffef,28],[0xffffff0,28],[0xffffff1,28],[0xffffff2,28],[0x3ffffffe,30],[0xffffff3,28],
  [0xffffff4,28],[0xffffff5,28],[0xffffff6,28],[0xffffff7,28],[0xffffff8,28],[0xffffff9,28],[0xffffffa,28],[0xffffffb,28],
  [0x14,6],[0x3f8,10],[0x3f9,10],[0xffa,12],[0x1ff9,13],[0x15,6],[0xf8,8],[0x7fa,11],
  [0x3fa,10],[0x3fb,10],[0xf9,8],[0x7fb,11],[0xfa,8],[0x16,6],[0x17,6],[0x18,6],
  [0x0,5],[0x1,5],[0x2,5],[0x19,6],[0x1a,6],[0x1b,6],[0x1c,6],[0x1d,6],
  [0x1e,6],[0x1f,6],[0x5c,7],[0xfb,8],[0x7ffc,15],[0x20,6],[0xffb,12],[0x3fc,10],
  [0x1ffa,13],[0x21,6],[0x5d,7],[0x5e,7],[0x5f,7],[0x60,7],[0x61,7],[0x62,7],
  [0x63,7],[0x64,7],[0x65,7],[0x66,7],[0x67,7],[0x68,7],[0x69,7],[0x6a,7],
  [0x6b,7],[0x6c,7],[0x6d,7],[0x6e,7],[0x6f,7],[0x70,7],[0x71,7],[0x72,7],
  [0xfc,8],[0x73,7],[0xfd,8],[0x1ffb,13],[0x7fff0,19],[0x1ffc,13],[0x3ffc,14],[0x22,6],
  [0x7ffd,15],[0x3,5],[0x23,6],[0x4,5],[0x24,6],[0x5,5],[0x25,6],[0x26,6],
  [0x27,6],[0x6,5],[0x74,7],[0x75,7],[0x28,6],[0x29,6],[0x2a,6],[0x7,5],
  [0x2b,6],[0x76,7],[0x2c,6],[0x8,5],[0x9,5],[0x2d,6],[0x77,7],[0x78,7],
  [0x79,7],[0x7a,7],[0x7b,7],[0x7ffe,15],[0x7fc,11],[0x3ffd,14],[0x1ffd,13],[0xffffffc,28],
  [0xfffe6,20],[0x3fffd2,22],[0xfffe7,20],[0xfffe8,20],[0x3fffd3,22],[0x3fffd4,22],[0x3fffd5,22],[0x7fffd9,23],
  [0x3fffd6,22],[0x7fffda,23],[0x7fffdb,23],[0x7fffdc,23],[0x7fffdd,23],[0x7fffde,23],[0xffffeb,24],[0x7fffdf,23],
  [0xffffec,24],[0xffffed,24],[0x3fffd7,22],[0x7fffe0,23],[0xffffee,24],[0x7fffe1,23],[0x7fffe2,23],[0x7fffe3,23],
  [0x7fffe4,23],[0x1fffdc,21],[0x3fffd8,22],[0x7fffe5,23],[0x3fffd9,22],[0x7fffe6,23],[0x7fffe7,23],[0xffffef,24],
  [0x3fffda,22],[0x1fffdd,21],[0xfffe9,20],[0x3fffdb,22],[0x3fffdc,22],[0x7fffe8,23],[0x7fffe9,23],[0x1fffde,21],
  [0x7fffea,23],[0x3fffdd,22],[0x3fffde,22],[0xfffff0,24],[0x1fffdf,21],[0x3fffdf,22],[0x7fffeb,23],[0x7fffec,23],
  [0x1fffe0,21],[0x1fffe1,21],[0x3fffe0,22],[0x1fffe2,21],[0x7fffed,23],[0x3fffe1,22],[0x7fffee,23],[0x7fffef,23],
  [0xfffea,20],[0x3fffe2,22],[0x3fffe3,22],[0x3fffe4,22],[0x7ffff0,23],[0x3fffe5,22],[0x3fffe6,22],[0x7ffff1,23],
  [0x3ffffe0,26],[0x3ffffe1,26],[0xfffeb,20],[0x7fff1,19],[0x3fffe7,22],[0x7ffff2,23],[0x3fffe8,22],[0x1ffffec,25],
  [0x3ffffe2,26],[0x3ffffe3,26],[0x3ffffe4,26],[0x7ffffde,27],[0x7ffffdf,27],[0x3ffffe5,26],[0xfffff1,24],[0x1ffffed,25],
  [0x7fff2,19],[0x1fffe3,21],[0x3ffffe6,26],[0x7ffffe0,27],[0x7ffffe1,27],[0x3ffffe7,26],[0x7ffffe2,27],[0xfffff2,24],
  [0x1fffe4,21],[0x1fffe5,21],[0x3ffffe8,26],[0x3ffffe9,26],[0xffffffd,28],[0x7ffffe3,27],[0x7ffffe4,27],[0x7ffffe5,27],
  [0xfffec,20],[0xfffff3,24],[0xfffed,20],[0x1fffe6,21],[0x3fffe9,22],[0x1fffe7,21],[0x1fffe8,21],[0x7ffff3,23],
  [0x3fffea,22],[0x3fffeb,22],[0x1ffffee,25],[0x1ffffef,25],[0xfffff4,24],[0xfffff5,24],[0x3ffffea,26],[0x7ffff4,23],
  [0x3ffffeb,26],[0x7ffffe6,27],[0x3ffffec,26],[0x3ffffed,26],[0x7ffffe7,27],[0x7ffffe8,27],[0x7ffffe9,27],[0x7ffffea,27],
  [0x7ffffeb,27],[0xffffffe,28],[0x7ffffec,27],[0x7ffffed,27],[0x7ffffee,27],[0x7ffffef,27],[0x7fffff0,27],[0x3ffffee,26],
  [0x3fffffff,30],
];
const EOS = 256;

class HpackError extends Error {}

// ── Huffman decode trie (built once) ──────────────────────────────────────
const trie = { c0: [-1], c1: [-1], leaf: [-1] }; // node 0 = root
(function buildTrie() {
  for (let sym = 0; sym < CODES.length; sym++) {
    const [code, len] = CODES[sym];
    let node = 0;
    for (let i = len - 1; i >= 0; i--) {
      const bit = (code >>> i) & 1;
      const arr = bit ? trie.c1 : trie.c0;
      let next = arr[node];
      if (next === -1) {
        next = trie.leaf.length;
        trie.c0.push(-1); trie.c1.push(-1); trie.leaf.push(-1);
        arr[node] = next;
      }
      node = next;
    }
    trie.leaf[node] = sym;
  }
})();

export function huffmanEncodedLen(buf) {
  let bits = 0;
  for (const b of buf) bits += CODES[b][1];
  return Math.ceil(bits / 8);
}

export function huffmanEncode(buf) {
  const out = [];
  let acc = 0n, nbits = 0n;
  for (const b of buf) {
    const [code, len] = CODES[b];
    acc = (acc << BigInt(len)) | BigInt(code);
    nbits += BigInt(len);
    while (nbits >= 8n) {
      nbits -= 8n;
      out.push(Number((acc >> nbits) & 0xffn));
    }
  }
  if (nbits > 0n) {
    const pad = 8n - nbits;
    out.push(Number(((acc << pad) | ((1n << pad) - 1n)) & 0xffn));
  }
  return Buffer.from(out);
}

export function huffmanDecode(buf) {
  const out = [];
  let node = 0, depth = 0, allOnes = true;
  for (const byte of buf) {
    for (let i = 7; i >= 0; i--) {
      const bit = (byte >> i) & 1;
      node = bit ? trie.c1[node] : trie.c0[node];
      depth++; allOnes = allOnes && bit === 1;
      const sym = trie.leaf[node];
      if (sym >= 0) {
        if (sym === EOS) throw new HpackError('EOS symbol in input');
        out.push(sym);
        node = 0; depth = 0; allOnes = true;
      }
    }
  }
  if (depth >= 8 || !allOnes) throw new HpackError('bad Huffman padding');
  return Buffer.from(out);
}

// ── integer codec (RFC 7541 §5.1) ─────────────────────────────────────────
export function encodeInt(out, value, n, flags) {
  const maxPrefix = (1 << n) - 1;
  if (value < maxPrefix) { out.push(flags | value); return; }
  out.push(flags | maxPrefix);
  let v = value - maxPrefix;
  while (v >= 128) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
}

export function decodeInt(buf, pos, n) {
  const maxPrefix = (1 << n) - 1;
  if (pos >= buf.length) throw new HpackError('truncated integer');
  let value = buf[pos] & maxPrefix;
  let p = pos + 1;
  if (value < maxPrefix) return [value, p];
  let shift = 0;
  for (;;) {
    if (p >= buf.length) throw new HpackError('truncated integer');
    const b = buf[p++];
    if (shift >= 53) throw new HpackError('integer overflow');
    value += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [value, p];
}

// ── static table (RFC 7541 Appendix A) ─────────────────────────────────────
const STATIC_TABLE = [
  [':authority', ''], [':method', 'GET'], [':method', 'POST'], [':path', '/'],
  [':path', '/index.html'], [':scheme', 'http'], [':scheme', 'https'], [':status', '200'],
  [':status', '204'], [':status', '206'], [':status', '304'], [':status', '400'],
  [':status', '404'], [':status', '500'], ['accept-charset', ''], ['accept-encoding', 'gzip, deflate'],
  ['accept-language', ''], ['accept-ranges', ''], ['accept', ''], ['access-control-allow-origin', ''],
  ['age', ''], ['allow', ''], ['authorization', ''], ['cache-control', ''],
  ['content-disposition', ''], ['content-encoding', ''], ['content-language', ''], ['content-length', ''],
  ['content-location', ''], ['content-range', ''], ['content-type', ''], ['cookie', ''],
  ['date', ''], ['etag', ''], ['expect', ''], ['expires', ''],
  ['from', ''], ['host', ''], ['if-match', ''], ['if-modified-since', ''],
  ['if-none-match', ''], ['if-range', ''], ['if-unmodified-since', ''], ['last-modified', ''],
  ['link', ''], ['location', ''], ['max-forwards', ''], ['proxy-authenticate', ''],
  ['proxy-authorization', ''], ['range', ''], ['referer', ''], ['refresh', ''],
  ['retry-after', ''], ['server', ''], ['set-cookie', ''], ['strict-transport-security', ''],
  ['transfer-encoding', ''], ['user-agent', ''], ['vary', ''], ['via', ''],
  ['www-authenticate', ''],
].map(([n, v]) => [Buffer.from(n), Buffer.from(v)]);
const STATIC_LEN = STATIC_TABLE.length;
const ENTRY_OVERHEAD = 32;

class DynamicTable {
  constructor(maxSize) { this.entries = []; this.size = 0; this.maxSize = maxSize; }
  setMaxSize(m) { this.maxSize = m; this.#evict(0); }
  #entrySize(n, v) { return n.length + v.length + ENTRY_OVERHEAD; }
  #evict(incoming) {
    while (this.size + incoming > this.maxSize && this.entries.length) {
      const [n, v] = this.entries.pop();
      this.size -= this.#entrySize(n, v);
    }
  }
  insert(name, value) {
    const need = this.#entrySize(name, value);
    this.#evict(need);
    if (need <= this.maxSize) { this.entries.unshift([name, value]); this.size += need; }
  }
  get(index) {
    if (index === 0) return null;
    if (index <= STATIC_LEN) return STATIC_TABLE[index - 1];
    const e = this.entries[index - STATIC_LEN - 1];
    return e || null;
  }
  find(name, value) {
    let nameOnly = null;
    for (let i = 0; i < STATIC_TABLE.length; i++) {
      const [n, v] = STATIC_TABLE[i];
      if (n.equals(name)) {
        if (v.equals(value)) return { index: i + 1, valueMatched: true };
        if (nameOnly === null) nameOnly = i + 1;
      }
    }
    for (let pos = 0; pos < this.entries.length; pos++) {
      const [n, v] = this.entries[pos];
      if (n.equals(name)) {
        const index = STATIC_LEN + 1 + pos;
        if (v.equals(value)) return { index, valueMatched: true };
        if (nameOnly === null) nameOnly = index;
      }
    }
    return nameOnly === null ? null : { index: nameOnly, valueMatched: false };
  }
}

export const DEFAULT_TABLE_SIZE = 4096;

function readString(block, pos) {
  if (pos >= block.length) throw new HpackError('truncated string');
  const huff = (block[pos] & 0x80) !== 0;
  const [len, p] = decodeInt(block, pos, 7);
  const end = p + len;
  if (end > block.length) throw new HpackError('truncated string');
  const raw = block.subarray(p, end);
  return [huff ? huffmanDecode(raw) : Buffer.from(raw), end];
}

// A decoded/encodable field. name/value are Buffers; sensitive = never-indexed.
export class HpackDecoder {
  constructor(maxSize = DEFAULT_TABLE_SIZE) { this.table = new DynamicTable(maxSize); this.sizeLimit = maxSize; }
  decode(block) {
    const fields = [];
    let pos = 0;
    while (pos < block.length) {
      const b = block[pos];
      if (b & 0x80) { // §6.1 indexed
        const [idx, np] = decodeInt(block, pos, 7); pos = np;
        if (idx === 0) throw new HpackError('index 0');
        const e = this.table.get(idx); if (!e) throw new HpackError('bad index');
        fields.push({ name: e[0], value: e[1], sensitive: false });
      } else if (b & 0x40) { // §6.2.1 literal w/ incremental indexing
        const [name, value, np] = this.#readLiteral(block, pos, 6); pos = np;
        this.table.insert(name, value);
        fields.push({ name, value, sensitive: false });
      } else if (b & 0x20) { // §6.3 dynamic table size update
        const [newMax, np] = decodeInt(block, pos, 5); pos = np;
        if (newMax > this.sizeLimit) throw new HpackError('size update over limit');
        this.table.setMaxSize(newMax);
      } else { // §6.2.2 / §6.2.3 (4-bit prefix; 0x10 = never indexed)
        const sensitive = (b & 0x10) !== 0;
        const [name, value, np] = this.#readLiteral(block, pos, 4); pos = np;
        fields.push({ name, value, sensitive });
      }
    }
    return fields;
  }
  #readLiteral(block, pos, prefix) {
    const [idx, p0] = decodeInt(block, pos, prefix);
    let p = p0, name;
    if (idx === 0) { const [n, np] = readString(block, p); name = n; p = np; }
    else { const e = this.table.get(idx); if (!e) throw new HpackError('bad name index'); name = e[0]; }
    const [value, np] = readString(block, p);
    return [name, value, np];
  }
}

export class HpackEncoder {
  constructor(maxSize = DEFAULT_TABLE_SIZE) {
    this.table = new DynamicTable(maxSize);
    this.useHuffman = true;
    this.pendingSizeUpdate = maxSize === DEFAULT_TABLE_SIZE ? null : maxSize;
  }
  encode(fields) {
    const out = [];
    if (this.pendingSizeUpdate !== null) { encodeInt(out, this.pendingSizeUpdate, 5, 0x20); this.pendingSizeUpdate = null; }
    for (const f of fields) this.#field(out, f);
    return Buffer.from(out);
  }
  #field(out, f) {
    const name = Buffer.isBuffer(f.name) ? f.name : Buffer.from(f.name);
    const value = Buffer.isBuffer(f.value) ? f.value : Buffer.from(f.value);
    if (f.sensitive) {
      const m = this.table.find(name, value);
      const nameIdx = (m && this.table.get(m.index)[0].equals(name)) ? m.index : null;
      this.#literal(out, 0x10, 4, nameIdx, name, value);
      return;
    }
    const m = this.table.find(name, value);
    if (m && m.valueMatched) { encodeInt(out, m.index, 7, 0x80); return; }
    this.#literal(out, 0x40, 6, m ? m.index : null, name, value);
    this.table.insert(name, value);
  }
  #literal(out, pattern, prefix, nameIdx, name, value) {
    if (nameIdx !== null) encodeInt(out, nameIdx, prefix, pattern);
    else { encodeInt(out, 0, prefix, pattern); this.#string(out, name); }
    this.#string(out, value);
  }
  #string(out, s) {
    if (this.useHuffman && huffmanEncodedLen(s) < s.length) {
      const coded = huffmanEncode(s);
      encodeInt(out, coded.length, 7, 0x80);
      for (const b of coded) out.push(b);
    } else {
      encodeInt(out, s.length, 7, 0x00);
      for (const b of s) out.push(b);
    }
  }
}

export { HpackError };
