import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnServer, closedPort } from '../test-helpers/spawn-server.js';
import { generateCertChain } from '../src/x509.js';

// The MITM chain a client is handed has to be the one the running proxy
// presents. `teamclaude env` and `run` used to regenerate the whole chain, CA
// included, as soon as the stored leaf fell short: the first Codex account
// adds chatgpt.com to the hosts it must name, and a leaf with under 30 days
// left is renewed early. The old CA's key is never kept, so the new leaf came
// with a new CA, while the running proxy still presented the leaf it had read
// at its first intercepted CONNECT. Every client launched after that trusted a
// CA the proxy's leaf was not signed by, and failed its TLS handshake until the
// proxy was restarted. These drive the real server and the real `env`.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const T = { timeout: 60_000 };

const claude = { name: 'claude-a', type: 'apikey', apiKey: 'k1' };
const codex = { name: 'codex-c', type: 'apikey', apiKey: 'k2', provider: 'codex' };

/** `teamclaude env` against `configPath`, with no proxy inherited from the shell. */
function runEnv(configPath) {
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' };
  for (const key of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key];
  const child = spawn(process.execPath, [cliPath, 'env', '--mitm'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      const caPath = /^export NODE_EXTRA_CA_CERTS='([^']*)'$/m.exec(stdout)?.[1] ?? null;
      resolve({ code, stdout, stderr, caPath });
    });
  });
}

/**
 * GET the proxy's built-in test host through a CONNECT tunnel, trusting only
 * `caPem`, as a client launched with NODE_EXTRA_CA_CERTS does. Resolves the
 * response, or rejects with the TLS error.
 */
function fetchTestHost(proxyPort, caPem) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => raw.write('CONNECT www.example.org:443 HTTP/1.1\r\nHost: www.example.org:443\r\n\r\n'));
    let head = Buffer.alloc(0);
    const onData = (d) => {
      head = Buffer.concat([head, d]);
      if (!head.includes('\r\n\r\n')) return;
      raw.removeListener('data', onData);
      const sock = tls.connect({ socket: raw, servername: 'www.example.org', ca: [caPem], ALPNProtocols: ['http/1.1'] }, () => {
        sock.write('GET / HTTP/1.1\r\nHost: www.example.org\r\nConnection: close\r\n\r\n');
      });
      let body = '';
      sock.setEncoding('utf8');
      sock.on('data', (c) => { body += c; });
      sock.once('error', (err) => { raw.destroy(); reject(err); });
      sock.once('close', () => resolve(body));
    };
    raw.on('data', onData);
  });
}

test('env keeps the CA the running proxy presents when the host list grows', T, async () => {
  const deadPort = await closedPort();
  const server = await spawnServer({
    config: () => ({ upstream: `http://127.0.0.1:${deadPort}`, upstreamProxy: false, accounts: [claude] }),
  });
  try {
    const first = await runEnv(server.configPath);
    assert.equal(first.code, 0, first.stderr);
    assert.ok(first.caPath, first.stdout);
    const ca = await readFile(first.caPath, 'utf8');
    // The proxy reads the chain here and presents it from now on.
    assert.match(await fetchTestHost(server.port, ca), /mitm-proxy-ok/);

    // `teamclaude login --codex` writes the account and reloads the server.
    const config = JSON.parse(await readFile(server.configPath, 'utf8'));
    config.accounts.push(codex);
    await writeFile(server.configPath, JSON.stringify(config));
    const reload = await fetch(`http://127.0.0.1:${server.port}/teamclaude/reload`, { method: 'POST' });
    assert.equal(reload.status, 200, await reload.text());

    const second = await runEnv(server.configPath);
    assert.equal(second.code, 0, second.stderr);
    const handed = await readFile(second.caPath, 'utf8');
    assert.equal(handed, ca, 'env replaced the CA that the running proxy\'s leaf is signed by');
    assert.match(second.stderr, /MITM certificate does not name chatgpt\.com.*restart the proxy/);
    // A client launched now still gets through.
    assert.match(await fetchTestHost(server.port, handed), /mitm-proxy-ok/);
  } finally {
    await server.stop();
  }
});

test('a starting server renews a stored chain that falls short before its port opens', T, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-served-ca-'));
  const deadPort = await closedPort();
  // Ten days left: under the 30-day margin, so it is due for renewal.
  const stale = generateCertChain(['127.0.0.1', 'api.anthropic.com', 'www.example.org'], { leafDays: 10 });
  await writeFile(join(dir, 'teamclaude-ca.pem'), stale.caCertPem);
  await writeFile(join(dir, 'teamclaude-leaf.pem'), stale.leafCertPem);
  await writeFile(join(dir, 'teamclaude-leaf.key'), stale.leafKeyPem, { mode: 0o600 });
  const server = await spawnServer({
    dir,
    config: () => ({ upstream: `http://127.0.0.1:${deadPort}`, upstreamProxy: false, accounts: [claude] }),
  });
  try {
    // Renewed by the time the port answers. Left to the first intercepted
    // CONNECT, `env` would hand out the stale CA (a proxy is up, so it is
    // kept) and the client launched with it would meet the renewed leaf.
    const onDisk = await readFile(join(dir, 'teamclaude-ca.pem'), 'utf8');
    assert.notEqual(onDisk, stale.caCertPem, 'the stale chain was still on disk once the port was open');

    const env = await runEnv(server.configPath);
    assert.equal(env.code, 0, env.stderr);
    assert.doesNotMatch(env.stderr, /MITM certificate/);
    const handed = await readFile(env.caPath, 'utf8');
    assert.equal(handed, onDisk);
    assert.match(await fetchTestHost(server.port, handed), /mitm-proxy-ok/);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
