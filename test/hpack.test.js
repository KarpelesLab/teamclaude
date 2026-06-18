import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  huffmanEncode, huffmanDecode, encodeInt, decodeInt,
  HpackEncoder, HpackDecoder,
} from '../src/h2/hpack.js';

const hex = (b) => Buffer.from(b).toString('hex');

// ── RFC 7541 §C.1 integer ──
test('integer C.1 vectors', () => {
  let out = []; encodeInt(out, 10, 5, 0); assert.equal(hex(out), '0a');
  assert.deepEqual(decodeInt(Buffer.from(out), 0, 5), [10, 1]);
  out = []; encodeInt(out, 1337, 5, 0); assert.equal(hex(out), '1f9a0a');
  assert.deepEqual(decodeInt(Buffer.from(out), 0, 5), [1337, 3]);
  out = []; encodeInt(out, 42, 8, 0); assert.equal(hex(out), '2a');
  assert.deepEqual(decodeInt(Buffer.from(out), 0, 8), [42, 1]);
});

// ── RFC 7541 §C.4 Huffman strings ──
test('huffman C.4 vectors', () => {
  assert.equal(hex(huffmanEncode(Buffer.from('www.example.com'))), 'f1e3c2e5f23a6ba0ab90f4ff');
  assert.deepEqual(huffmanDecode(Buffer.from('f1e3c2e5f23a6ba0ab90f4ff', 'hex')), Buffer.from('www.example.com'));
  assert.equal(hex(huffmanEncode(Buffer.from('no-cache'))), 'a8eb10649cbf');
  assert.equal(hex(huffmanEncode(Buffer.from('custom-key'))), '25a849e95ba97d7f');
  assert.equal(hex(huffmanEncode(Buffer.from('custom-value'))), '25a849e95bb8e8b4bf');
});

test('huffman round-trips all byte values', () => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  assert.deepEqual(huffmanDecode(huffmanEncode(all)), all);
  assert.deepEqual(huffmanDecode(Buffer.alloc(0)), Buffer.alloc(0));
});

test('huffman rejects EOS symbol and bad padding', () => {
  assert.throws(() => huffmanDecode(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xc0]))); // 30 ones = EOS
  assert.throws(() => huffmanDecode(Buffer.from([0b00000000]))); // "0" then 0-padding
});

// ── RFC 7541 §C.3 request sequence WITHOUT Huffman (shared dynamic table) ──
test('C.3 request sequence (literal, dynamic table evolves)', () => {
  const dec = new HpackDecoder();
  const f = (blockHex, expect) => {
    const got = dec.decode(Buffer.from(blockHex.replace(/\s/g, ''), 'hex'))
      .map(h => [h.name.toString(), h.value.toString()]);
    assert.deepEqual(got, expect);
  };
  // C.3.1
  f('828684410f7777772e6578616d706c652e636f6d', [[':method','GET'],[':scheme','http'],[':path','/'],[':authority','www.example.com']]);
  // C.3.2 — :authority comes from the dynamic table (index 62)
  f('828684be58086e6f2d6361636865', [[':method','GET'],[':scheme','http'],[':path','/'],[':authority','www.example.com'],['cache-control','no-cache']]);
  // C.3.3
  f('828785bf400a637573746f6d2d6b65790c637573746f6d2d76616c7565',
    [[':method','GET'],[':scheme','https'],[':path','/index.html'],[':authority','www.example.com'],['custom-key','custom-value']]);
});

// ── RFC 7541 §C.6 response sequence WITH Huffman + eviction ──
test('C.6 response sequence (Huffman + dynamic eviction) decodes', () => {
  const dec = new HpackDecoder(256); // C.6 uses a 256-byte table
  const b1 = '4882 6402 5885 aec3 771a 4b61 96d0 7abe 9410 54d4 44a8 2005 9504 0b81 66e0 82a6 2d1b ff6e 919d 29ad 1718 63c7 8f0b 97c8 e9ae 82ae 43d3';
  const out1 = dec.decode(Buffer.from(b1.replace(/\s/g, ''), 'hex')).map(h => [h.name.toString(), h.value.toString()]);
  assert.deepEqual(out1, [[':status','302'],['cache-control','private'],['date','Mon, 21 Oct 2013 20:13:21 GMT'],['location','https://www.example.com']]);
});

// ── encoder ↔ decoder interop (our encoder is simple; must decode back) ──
test('encoder/decoder round-trip incl. sensitive auth + dynamic indexing', () => {
  const enc = new HpackEncoder();
  const dec = new HpackDecoder();
  const fields = [
    { name: ':method', value: 'POST' },
    { name: ':path', value: '/v1/messages' },
    { name: 'authorization', value: 'Bearer sk-ant-oat01-secret', sensitive: true },
    { name: 'content-type', value: 'application/json' },
  ];
  // two blocks to exercise dynamic table state
  for (let i = 0; i < 2; i++) {
    const block = enc.encode(fields);
    const got = dec.decode(block).map(h => ({ name: h.name.toString(), value: h.value.toString(), sensitive: h.sensitive }));
    assert.equal(got[2].name, 'authorization');
    assert.equal(got[2].value, 'Bearer sk-ant-oat01-secret');
    assert.equal(got[2].sensitive, true); // round-trips as never-indexed
    assert.deepEqual(got.map(h => [h.name, h.value]), fields.map(f => [f.name, f.value]));
  }
});
