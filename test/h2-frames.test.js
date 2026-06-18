import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME, FLAG, PREFACE, readFrames, buildFrame, stripHeadersPayload, buildHeaderBlock } from '../src/h2/frames.js';

test('buildFrame / readFrames round-trip multiple frames', () => {
  const a = buildFrame({ type: FRAME.SETTINGS, flags: 0, streamId: 0, payload: Buffer.alloc(0) });
  const b = buildFrame({ type: FRAME.DATA, flags: FLAG.END_STREAM, streamId: 5, payload: Buffer.from('hello') });
  const { frames, rest } = readFrames(Buffer.concat([a, b]));
  assert.equal(rest.length, 0);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, FRAME.SETTINGS);
  assert.equal(frames[1].type, FRAME.DATA);
  assert.equal(frames[1].streamId, 5);
  assert.equal(frames[1].flags & FLAG.END_STREAM, FLAG.END_STREAM);
  assert.equal(frames[1].payload.toString(), 'hello');
});

test('readFrames leaves an incomplete trailing frame in rest', () => {
  const f = buildFrame({ type: FRAME.PING, streamId: 0, payload: Buffer.alloc(8) });
  // feed all but the last 3 bytes
  const partial = f.subarray(0, f.length - 3);
  const { frames, rest } = readFrames(partial);
  assert.equal(frames.length, 0);
  assert.equal(rest.length, partial.length);
  // now complete it
  const { frames: f2, rest: r2 } = readFrames(Buffer.concat([rest, f.subarray(f.length - 3)]));
  assert.equal(f2.length, 1);
  assert.equal(r2.length, 0);
});

test('stripHeadersPayload removes PADDED + PRIORITY and yields the block', () => {
  const block = Buffer.from('deadbeef', 'hex');
  const prio = Buffer.from('0000000105', 'hex'); // 5-byte priority
  const pad = Buffer.from('aabbcc', 'hex');       // 3 bytes padding
  const payload = Buffer.concat([Buffer.from([pad.length]), prio, block, pad]);
  const got = stripHeadersPayload(payload, FLAG.PADDED | FLAG.PRIORITY);
  assert.equal(got.block.toString('hex'), 'deadbeef');
  assert.equal(got.priority.toString('hex'), '0000000105');
});

test('buildHeaderBlock single frame and split into CONTINUATION', () => {
  const block = Buffer.from('1122334455', 'hex');
  // single frame (END_HEADERS set, END_STREAM honored)
  let out = buildHeaderBlock(7, block, { endStream: true });
  let { frames } = readFrames(out);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, FRAME.HEADERS);
  assert.ok(frames[0].flags & FLAG.END_HEADERS);
  assert.ok(frames[0].flags & FLAG.END_STREAM);
  assert.equal(frames[0].payload.toString('hex'), '1122334455');

  // force a split with tiny maxFrameSize=2
  out = buildHeaderBlock(7, block, { maxFrameSize: 2 });
  ({ frames } = readFrames(out));
  assert.equal(frames[0].type, FRAME.HEADERS);
  assert.equal(frames[0].flags & FLAG.END_HEADERS, 0); // not last
  assert.equal(frames[frames.length - 1].type, FRAME.CONTINUATION);
  assert.ok(frames[frames.length - 1].flags & FLAG.END_HEADERS);
  // reassembled fragments equal the original block
  const reassembled = Buffer.concat(frames.map(f => f.payload));
  assert.equal(reassembled.toString('hex'), '1122334455');
});

test('PREFACE is the 24-byte client connection preface', () => {
  assert.equal(PREFACE.length, 24);
  assert.equal(PREFACE.toString('latin1'), 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
});
