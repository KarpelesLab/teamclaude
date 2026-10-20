import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';

// Point cert storage at a temp dir before importing modules that read the path.
const TMP = mkdtempSync(join(tmpdir(), 'tc-mitm-'));
process.env.TEAMCLAUDE_CONFIG = join(TMP, 'config.json');

const { ensureCerts, caCertPath, TEST_HOST, leafCovers, chainShortfall, parseConnectAuthority } = await import('../src/mitm.js');
const { AccountManager } = await import('../src/account-manager.js');
const { createProxyServer } = await import('../src/server.js');
const { allowLoopbackForward } = await import('../src/forward-target.js');
const { generateCertChain } = await import('../src/x509.js');

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

// CONNECT through the proxy, then TLS over the tunnel; resolve the decrypted socket.
function connectTls(proxyPort, target, caCertPem, servername) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.includes('\r\n\r\n')) {
        raw.removeListener('data', onData);
        const sock = tls.connect({ socket: raw, servername, ca: [caCertPem] }, () => resolve(sock));
        sock.once('error', reject);
      }
    };
    raw.on('data', onData);
  });
}

function httpOver(sock, hostHeader, path = '/') {
  return new Promise((resolve) => {
    sock.write(`GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => resolve(buf));
    sock.on('close', () => resolve(buf));
  });
}

test('ensureCerts generates a CA + leaf covering the host and the test host, idempotently', async () => {
  const a = await ensureCerts('api.anthropic.com');
  assert.equal(a.caPath, caCertPath());
  const leaf = new X509Certificate(a.leafCertPem);
  const names = (leaf.subjectAltName || '').split(',').map((s) => s.trim());
  assert.ok(names.includes('DNS:api.anthropic.com'));
  assert.ok(names.includes(`DNS:${TEST_HOST}`));

  // Second call returns the same cert (no regeneration).
  const b = await ensureCerts('api.anthropic.com');
  assert.equal(a.leafCertPem, b.leafCertPem);
});

test('CONNECT to the test host is intercepted and answered locally (proxy + CA proof)', async () => {
  const { caCertPem } = await ensureCerts('api.anthropic.com');
  const am = new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'sk' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' }, {});
  const port = await listen(proxy);
  try {
    const sock = await connectTls(port, `${TEST_HOST}:443`, caCertPem, TEST_HOST);
    assert.equal(sock.authorized, true); // our leaf trusted via the CA
    const resp = await httpOver(sock, TEST_HOST, '/hello');
    assert.match(resp, /200/);
    assert.match(resp, /"teamclaude":"mitm-proxy-ok"/);
    assert.match(resp, /"path":"\/hello"/);
  } finally {
    proxy.close();
  }
});

// Send a CONNECT and resolve with the status line the proxy answers.
function connectStatus(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = '';
    raw.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n\r\n')) { raw.destroy(); resolve(buf.split('\r\n')[0]); } });
    raw.on('close', () => { if (!buf.includes('\r\n\r\n')) reject(new Error(`closed with no CONNECT response: ${JSON.stringify(buf)}`)); });
  });
}

test('CONNECT to a non-intercepted host is blind-tunneled', async () => {
  // Echo server stands in for "some other host". It is on loopback, which the
  // tunnel refuses by default, so the test hook admits it for this server.
  const echo = net.createServer((s) => s.pipe(s));
  const echoPort = await listen(echo);
  const am = new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'sk' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' }, {});
  allowLoopbackForward(proxy);
  const port = await listen(proxy);
  try {
    const raw = net.connect(port, '127.0.0.1');
    await once(raw, 'connect');
    raw.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    // Wait for the 200, then send a payload and expect it echoed back.
    let established = false;
    const got = await new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      raw.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!established && buf.includes('\r\n\r\n')) {
          established = true;
          buf = Buffer.alloc(0);
          raw.write('PING');
        } else if (established && buf.toString().includes('PING')) {
          resolve(buf.toString());
        }
      });
    });
    assert.match(got, /PING/);
    raw.destroy();
  } finally {
    proxy.close();
    echo.close();
  }
});

// ── Tunnel destination policy ────────────────────────────────
//
// A blind tunnel to this machine is how a remote client with only a low-trust
// key reaches our own listener as a loopback caller (no API-key gate: /switch,
// /reload, /status, /v1/messages), any loopback-only service, or cloud metadata.

test('CONNECT to a loopback target is refused with 403 and never dialled', async () => {
  const trap = net.createServer(() => { throw new Error('the proxy must not connect to a loopback target'); });
  let connections = 0;
  trap.on('connection', () => { connections++; });
  const trapPort = await listen(trap);
  const am = new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'sk' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' }, {});
  const port = await listen(proxy);
  try {
    for (const target of [`127.0.0.1:${trapPort}`, `127.1.2.3:${trapPort}`, `localhost:${trapPort}`, `[::1]:${trapPort}`, `0.0.0.0:${trapPort}`, `[::ffff:127.0.0.1]:${trapPort}`, '169.254.169.254:80', '[fe80::1]:80']) {
      assert.match(await connectStatus(port, target), /^HTTP\/1\.1 403 /, target);
    }
    assert.equal(connections, 0, 'no connection may reach a loopback target');
  } finally {
    proxy.close(); trap.close();
  }
});

test("CONNECT to the proxy's own port is refused even where loopback is admitted", async () => {
  const am = new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'sk' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' }, {});
  const port = await listen(proxy);
  try {
    assert.match(await connectStatus(port, `127.0.0.1:${port}`), /^HTTP\/1\.1 403 /);
    // With the test hook the address class passes; the own-listener rule
    // (our port, connected to ourselves) still refuses the request loop.
    allowLoopbackForward(proxy);
    assert.match(await connectStatus(port, `127.0.0.1:${port}`), /^HTTP\/1\.1 403 /);
  } finally {
    proxy.close();
  }
});

// ── CONNECT authority parsing ────────────────────────────────

test('parseConnectAuthority normalizes the host and refuses what cannot be dialled', () => {
  assert.deepEqual(parseConnectAuthority('api.anthropic.com:443'), { host: 'api.anthropic.com', port: 443 });
  // Case and a root dot must not dodge hostMode's exact match into the blind tunnel.
  assert.deepEqual(parseConnectAuthority('API.ANTHROPIC.COM:443'), { host: 'api.anthropic.com', port: 443 });
  assert.deepEqual(parseConnectAuthority('api.anthropic.com.:443'), { host: 'api.anthropic.com', port: 443 });
  assert.deepEqual(parseConnectAuthority('[::1]:8443'), { host: '::1', port: 8443 });
  assert.deepEqual(parseConnectAuthority('example.org'), { host: 'example.org', port: 443 });
  // An empty host used to be dialled as localhost.
  for (const bad of [':443', '', undefined, 'host:0', 'host:65536', 'host:abc', '[::1', 'a:b:c', 'host/path:443', 'ho st:443', '[]:443']) {
    assert.equal(parseConnectAuthority(bad), null, String(bad));
  }
});

test('an unparseable CONNECT target gets a 400, and a differently-cased test host is still intercepted', async () => {
  const { caCertPem } = await ensureCerts('api.anthropic.com');
  const am = new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'sk' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' }, {});
  const port = await listen(proxy);
  try {
    assert.match(await connectStatus(port, ':443'), /^HTTP\/1\.1 400 /);
    assert.match(await connectStatus(port, 'example.org:0'), /^HTTP\/1\.1 400 /);
    const sock = await connectTls(port, `${TEST_HOST.toUpperCase()}.:443`, caCertPem, TEST_HOST);
    const resp = await httpOver(sock, TEST_HOST, '/upper');
    assert.match(resp, /"teamclaude":"mitm-proxy-ok"/);
  } finally {
    proxy.close();
  }
});

// ── Stored chain validity ────────────────────────────────────
//
// leafCovers used to check signature and SANs only, so an expired leaf or CA
// was reused for ever — every handshake failed and nothing regenerated it.

test('leafCovers rejects a chain with under 30 days left, on either certificate', () => {
  const hosts = ['api.anthropic.com', TEST_HOST];
  const fresh = generateCertChain(hosts);
  assert.equal(leafCovers(fresh.caCertPem, fresh.leafCertPem, hosts), true);
  const DAY = 24 * 3600 * 1000;
  // Judged from a clock 20 days before the leaf's expiry: too close to renew.
  assert.equal(leafCovers(fresh.caCertPem, fresh.leafCertPem, hosts, Date.now() + (825 - 20) * DAY), false);
  const shortLeaf = generateCertChain(hosts, { leafDays: 10 });
  assert.equal(leafCovers(shortLeaf.caCertPem, shortLeaf.leafCertPem, hosts), false);
  const shortCa = generateCertChain(hosts, { caDays: 10 });
  assert.equal(leafCovers(shortCa.caCertPem, shortCa.leafCertPem, hosts), false);
});

test('ensureCerts regenerates a stored chain that is about to expire', async () => {
  const { writeFile } = await import('node:fs/promises');
  const dir = join(caCertPath(), '..');
  const hosts = ['api.anthropic.com', TEST_HOST];
  const short = generateCertChain(hosts, { leafDays: 5 });
  await writeFile(join(dir, 'teamclaude-ca.pem'), short.caCertPem);
  await writeFile(join(dir, 'teamclaude-leaf.pem'), short.leafCertPem);
  await writeFile(join(dir, 'teamclaude-leaf.key'), short.leafKeyPem);

  const renewed = await ensureCerts('api.anthropic.com');
  assert.notEqual(renewed.leafCertPem, short.leafCertPem);
  assert.ok(new Date(new X509Certificate(renewed.leafCertPem).validTo) - Date.now() > 300 * 24 * 3600 * 1000);
  // And the renewed chain is then kept.
  const again = await ensureCerts('api.anthropic.com');
  assert.equal(again.leafCertPem, renewed.leafCertPem);
});

// A client handed the CA while a proxy runs has to get the CA that proxy's
// leaf is signed by. Regenerating replaces the CA too, so `env` and `run`
// keep a stored chain that falls short and say why (`keep`); they still
// replace a pair that no server could be presenting.

async function storeChain(chain) {
  const { writeFile } = await import('node:fs/promises');
  const dir = join(caCertPath(), '..');
  await writeFile(join(dir, 'teamclaude-ca.pem'), chain.caCertPem);
  await writeFile(join(dir, 'teamclaude-leaf.pem'), chain.leafCertPem);
  await writeFile(join(dir, 'teamclaude-leaf.key'), chain.leafKeyPem);
}

test('chainShortfall names the missing host or the expiry, and nothing for a fit chain', () => {
  const hosts = ['api.anthropic.com', TEST_HOST];
  const fresh = generateCertChain(hosts);
  assert.deepEqual(chainShortfall(fresh.caCertPem, fresh.leafCertPem, hosts), { signed: true, shortfall: null });
  assert.deepEqual(chainShortfall(fresh.caCertPem, fresh.leafCertPem, [...hosts, 'chatgpt.com']),
    { signed: true, shortfall: 'does not name chatgpt.com' });
  const short = generateCertChain(hosts, { leafDays: 10 });
  assert.match(chainShortfall(short.caCertPem, short.leafCertPem, hosts).shortfall, /^expires on \d{4}-\d{2}-\d{2}$/);
  const other = generateCertChain(hosts);
  assert.equal(chainShortfall(other.caCertPem, fresh.leafCertPem, hosts).signed, false);
});

test('ensureCerts with keep reuses a stored chain that falls short, and says why', async () => {
  const stored = generateCertChain(['api.anthropic.com', TEST_HOST]);
  await storeChain(stored);
  const kept = await ensureCerts(['api.anthropic.com', 'chatgpt.com'], { keep: true });
  assert.equal(kept.caCertPem, stored.caCertPem);
  assert.equal(kept.leafCertPem, stored.leafCertPem);
  assert.equal(kept.renewal, 'does not name chatgpt.com');

  const short = generateCertChain(['api.anthropic.com', TEST_HOST], { leafDays: 5 });
  await storeChain(short);
  const keptShort = await ensureCerts('api.anthropic.com', { keep: true });
  assert.equal(keptShort.caCertPem, short.caCertPem);
  assert.match(keptShort.renewal, /^expires on /);

  // Without keep, the same chain is renewed, as before.
  const renewed = await ensureCerts('api.anthropic.com');
  assert.notEqual(renewed.caCertPem, short.caCertPem);
  assert.equal(renewed.renewal, null);
});

test('ensureCerts with keep reports nothing for a fit chain, and still replaces a mismatched pair', async () => {
  const fit = await ensureCerts('api.anthropic.com', { keep: true });
  assert.equal(fit.renewal, null);

  // A leaf the stored CA did not sign is no chain any server presents.
  const a = generateCertChain(['api.anthropic.com', TEST_HOST]);
  const b = generateCertChain(['api.anthropic.com', TEST_HOST]);
  await storeChain({ ...a, leafCertPem: b.leafCertPem, leafKeyPem: b.leafKeyPem });
  const replaced = await ensureCerts('api.anthropic.com', { keep: true });
  assert.notEqual(replaced.caCertPem, a.caCertPem);
  assert.equal(replaced.renewal, null);
  assert.equal(leafCovers(replaced.caCertPem, replaced.leafCertPem, ['api.anthropic.com', TEST_HOST]), true);
});
