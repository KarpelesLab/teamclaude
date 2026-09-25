import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The whole feature, witnessed: a request forwarded for a routed account must
// reach the upstream THROUGH that account's proxy — and an account without one
// must keep going direct. These drive the real server as a subprocess against
// a throwaway TEAMCLAUDE_CONFIG; the SOCKS5 mock's connect log is the witness,
// since both paths end at the same stub upstream. Reload drives the disk edits,
// so the live-update path (sync-accounts.js) is covered too.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A port nothing is listening on: bind one, learn its number, give it back.
function closedPort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startServer(configPath) {
  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  const stop = async () => {
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => child.on('exit', resolve));
    }
    clearTimeout(killer);
  };
  return { child, stop, output: () => output };
}

async function waitForServer(port, childOutput) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${childOutput()}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

// A recording stand-in upstream: both the direct and the proxied path end
// here, so the hit count alone cannot tell them apart — the SOCKS log can.
function startStubUpstream(hits) {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push({ url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
    });
  });
}

// A minimal SOCKS5 server: no auth, records every CONNECT target, relays.
function startSocks5(connects) {
  return net.createServer((client) => {
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    client.on('data', (chunk) => {
      if (stage === 'relay') return;
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2 + (buf[1] || 0)) return;
        buf = buf.subarray(2 + buf[1]);
        stage = 'request';
        client.write(Buffer.from([0x05, 0x00]));
      }
      if (stage === 'request') {
        // Short reads are normal (the request follows the greeting in its own
        // segment): wait for more bytes rather than tearing the tunnel down.
        if (buf.length < 10) return;
        if (buf[3] !== 0x01) { client.destroy(); return; }
        const host = [...buf.subarray(4, 8)].join('.');
        const port = buf.readUInt16BE(8);
        buf = buf.subarray(10);
        connects.push(`${host}:${port}`);
        const up = net.connect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (buf.length) up.write(buf);
          up.pipe(client); client.pipe(up);
        });
        up.on('error', () => client.destroy());
        stage = 'relay';
      }
    });
    client.on('error', () => {});
  });
}

async function withServer(accounts, fn) {
  const hits = [];
  const stub = startStubUpstream(hits);
  const stubPort = await listen(stub);
  const connects = [];
  const socks = startSocks5(connects);
  const socksPort = await listen(socks);
  const proxyPort = await closedPort();

  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-routing-reload-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: proxyPort, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${stubPort}`,
    upstreamProxy: false,
    accounts,
  }));

  const server = startServer(configPath);
  try {
    await waitForServer(proxyPort, server.output);
    await fn({ hits, connects, stubPort, socksPort, proxyPort, configPath });
  } catch (err) {
    console.error('--- server output ---\n' + server.output());
    throw err;
  } finally {
    await server.stop();
    stub.close();
    socks.close();
  }
}

async function reload(proxyPort) {
  const res = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/reload`, { method: 'POST' });
  assert.equal(res.status, 200, await res.text());
}

// Fire one chat request at the proxy, optionally pinned to one account.
async function sendMessage(proxyPort, pin = null) {
  const path = pin ? `/tc-acct/${encodeURIComponent(pin)}/v1/messages` : '/v1/messages';
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test-model', max_tokens: 1, messages: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    await res.text();
    return res;
  } catch (err) {
    console.error('sendMessage failed:', err?.message, err?.cause?.message || '');
    return null;
  }
}

test('a routed account forwards through its proxy, set and removed live on reload', { timeout: 60000 }, async () => {
  await withServer([{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }], async ({ hits, connects, stubPort, socksPort, proxyPort, configPath }) => {
    // Baseline: no routing — the stub is reached directly.
    assert.equal((await sendMessage(proxyPort))?.status, 200);
    assert.equal(hits.length, 1);
    assert.equal(connects.length, 0, 'setup: the fleet path must not touch the SOCKS proxy');

    // The operator pins the account to its own proxy.
    const edited = JSON.parse(await readFile(configPath, 'utf8'));
    edited.accounts[0].routing = `socks5://127.0.0.1:${socksPort}`;
    await writeFile(configPath, JSON.stringify(edited));
    await reload(proxyPort);

    assert.equal((await sendMessage(proxyPort))?.status, 200);
    assert.equal(hits.length, 2, 'the upstream still answered');
    assert.deepEqual(connects, [`127.0.0.1:${stubPort}`], 'but the request arrived through the account proxy');

    // Taking the routing back off must revert the account without a restart.
    const reverted = JSON.parse(await readFile(configPath, 'utf8'));
    delete reverted.accounts[0].routing;
    await writeFile(configPath, JSON.stringify(reverted));
    await reload(proxyPort);

    assert.equal((await sendMessage(proxyPort))?.status, 200);
    assert.equal(hits.length, 3);
    assert.equal(connects.length, 1, 'with routing removed the account goes direct again');
  });
});

test('routing applies to ONLY the account that has it', { timeout: 60000 }, async () => {
  await withServer([
    { name: 'plain@example.com', type: 'apikey', apiKey: 'k1' },
    { name: 'routed@example.com', type: 'apikey', apiKey: 'k2' },
  ], async ({ hits, connects, socksPort, proxyPort, configPath }) => {
    const edited = JSON.parse(await readFile(configPath, 'utf8'));
    edited.accounts[1].routing = `socks5://127.0.0.1:${socksPort}`;
    await writeFile(configPath, JSON.stringify(edited));
    await reload(proxyPort);

    // The routed account's traffic tunnels...
    assert.equal((await sendMessage(proxyPort, 'routed@example.com'))?.status, 200);
    assert.equal(connects.length, 1, 'the routed account went through its proxy');

    // ...and only its traffic: the same request pinned to the other account
    // must not touch the proxy, and neither must an unpinned one (the first
    // account holds the rotation cursor).
    assert.equal((await sendMessage(proxyPort, 'plain@example.com'))?.status, 200);
    assert.equal((await sendMessage(proxyPort))?.status, 200);
    assert.equal(connects.length, 1, `the unrouted account must not touch the proxy, got ${connects.length} connects`);
    assert.equal(hits.length, 3, 'all three requests were answered upstream');
  });
});
