import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnServer } from '../test-helpers/spawn-server.js';

// SIGTERM against the real server, with a stream open through it. With
// proxy.drainTimeoutSeconds the server drains: the stream finishes before the
// process exits. Without it, shutdown is what it always was, and the open
// stream is cut. The upstream is a fake in this process that holds its stream
// until the test lets it end, so no assertion depends on a clock.

const START = 'event: message_start\ndata: {"type":"message_start"}\n\n';
const STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const DRAIN_LINE = /\[TeamClaude\] Draining/;

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

// Every request is answered with a stream that stays open until finish.
async function holdingUpstream() {
  const held = [];
  const server = http.createServer((req, res) => {
    res.on('error', () => {});
    req.resume();
    const hold = { finish: deferred() };
    held.push(hold);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(START);
    hold.finish.promise.then(() => { if (!res.destroyed) res.end(STOP); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    held,
    close: () => {
      for (const h of held) h.finish.resolve();
      server.closeAllConnections();
      return new Promise(r => server.close(r));
    },
  };
}

async function startServer(upstreamUrl, dir, proxyExtra) {
  return spawnServer({
    dir,
    config: () => ({
      upstream: upstreamUrl,
      upstreamProxy: false,
      autoUpdate: false,
      switchThreshold: 0.98,
      accounts: [{ name: 'test', type: 'apikey', apiKey: 'sk-test' }],
      proxy: { apiKey: 'tc-test', ...proxyExtra },
    }),
  });
}

// Opens a streaming request through the server and reads its first chunk, so
// the stream is known to be open before the signal is sent.
async function openStream(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
    body: JSON.stringify({ model: 'claude-test', stream: true, messages: [] }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  return { status: res.status, reader, decoder, first };
}

async function readRest(stream) {
  let text = stream.first;
  for (;;) {
    const { value, done } = await stream.reader.read();
    if (done) return text;
    text += stream.decoder.decode(value, { stream: true });
  }
}

test('SIGTERM with proxy.drainTimeoutSeconds lets an in-flight stream finish before the process exits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-drain-sigterm-'));
  const up = await holdingUpstream();
  let server = null;
  try {
    server = await startServer(up.url, dir, { drainTimeoutSeconds: 30 });
    const stream = await openStream(server.port);
    assert.equal(stream.status, 200);
    assert.match(stream.first, /message_start/);

    const exited = new Promise(resolve => server.child.once('exit', (code, signal) => resolve({ code, signal })));
    let seen = '';
    const announced = new Promise(resolve => {
      server.child.stdout.on('data', chunk => { seen += chunk; if (DRAIN_LINE.test(seen)) resolve(true); });
    });
    server.child.kill('SIGTERM');
    // The drain is announced before the server waits; a server that exits at
    // once (the old behaviour) ends the race with `false` instead.
    assert.equal(await Promise.race([announced, exited.then(() => false)]), true,
      'the server announces the drain rather than exiting at once');

    up.held[0].finish.resolve();
    const text = await readRest(stream);
    assert.match(text, /message_stop/, 'the in-flight stream completed');
    assert.equal((await exited).code, 0, 'the process exits cleanly once the stream is done');
  } finally {
    await up.close();
    if (server) await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SIGTERM without proxy.drainTimeoutSeconds keeps the existing shutdown: the in-flight stream is cut', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-drain-off-'));
  const up = await holdingUpstream();
  let server = null;
  try {
    server = await startServer(up.url, dir, {});
    const stream = await openStream(server.port);
    assert.equal(stream.status, 200);

    const exited = new Promise(resolve => server.child.once('exit', (code, signal) => resolve({ code, signal })));
    server.child.kill('SIGTERM');
    // The upstream never ends on its own, so the stream can finish only if
    // the proxy lets it, and the existing shutdown does not.
    const outcome = await readRest(stream).then(text => ({ text }), err => ({ err }));
    const completed = outcome.text !== undefined && /message_stop/.test(outcome.text);
    assert.equal(completed, false, 'the in-flight stream was not allowed to finish');
    assert.equal((await exited).code, 0);
    assert.doesNotMatch(server.output(), DRAIN_LINE, 'no drain is announced without the key');
  } finally {
    await up.close();
    if (server) await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// The drain window is a ceiling, not a floor: a second signal while the server
// is waiting on in-flight work goes straight to exit, as the shutdown funnel
// promises. The window here is far longer than the runner's timeout, so an
// exit that waited for the deadline would fail the test rather than pass it.
test('a second SIGTERM during a drain exits at once, without waiting for the deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-drain-twice-'));
  const up = await holdingUpstream();
  let server = null;
  try {
    server = await startServer(up.url, dir, { drainTimeoutSeconds: 600 });
    const stream = await openStream(server.port);
    assert.equal(stream.status, 200);

    const exited = new Promise(resolve => server.child.once('exit', (code, signal) => resolve({ code, signal })));
    let seen = '';
    const announced = new Promise(resolve => {
      server.child.stdout.on('data', chunk => { seen += chunk; if (DRAIN_LINE.test(seen)) resolve(true); });
    });
    server.child.kill('SIGTERM');
    assert.equal(await Promise.race([announced, exited.then(() => false)]), true, 'the first signal starts a drain');

    // The stream is still open and the upstream never ends on its own, so the
    // only thing that can end the wait is this second signal.
    server.child.kill('SIGTERM');
    const { code } = await exited;
    assert.equal(code, 0, 'the second signal exits cleanly');
    const text = await readRest(stream).then(t => t, () => '');
    assert.doesNotMatch(text, /message_stop/, 'the stream was cut by the exit, not completed');
  } finally {
    await up.close();
    if (server) await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
