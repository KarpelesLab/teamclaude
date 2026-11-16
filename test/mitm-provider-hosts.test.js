import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostMode, mitmHosts, ensureCerts, createConnectHandler, resolveConnectPin, TEST_HOST } from '../src/mitm.js';
import { providerForHost, isNeverIntercepted, interceptHostsFor } from '../src/provider.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { allowLoopbackForward } from '../src/forward-target.js';
import { generateCertChain } from '../src/x509.js';
import { X509Certificate } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// MITM is the mode that works without the client cooperating: a CLI that honours
// only HTTPS_PROXY has no base URL to redirect. So a provider the proxy will not
// intercept is a provider it does not support in its main mode. Codex was that
// case — chatgpt.com fell through to a blind tunnel.

const claude = (name) => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
const codex = (name) => ({ ...claude(name), provider: 'codex' });

test('a Codex fleet intercepts chatgpt.com', () => {
  const config = { accounts: [claude('a'), codex('c')] };
  assert.equal(hostMode('chatgpt.com', config), 'rewrite');
  assert.equal(hostMode('api.anthropic.com', config), 'rewrite');
});

test('terminal-only mode tunnels chatgpt.com even with Codex accounts', () => {
  const config = { proxy: { terminalOnly: true }, accounts: [claude('a'), codex('c')] };
  assert.equal(hostMode('chatgpt.com', config), 'tunnel');
  assert.equal(hostMode('api.anthropic.com', config), 'rewrite');
});

// The safety half: a fleet with no Codex account must not have its ChatGPT
// traffic terminated. Intercepting a host nobody asked us to read is not a
// neutral default.
test('an Anthropic-only fleet still tunnels chatgpt.com', () => {
  const config = { accounts: [claude('a')] };
  assert.equal(hostMode('chatgpt.com', config), 'tunnel');
  assert.equal(hostMode('api.anthropic.com', config), 'rewrite');
});

// ab.chatgpt.com is OpenAI's telemetry endpoint: no inference, nothing to
// rewrite, and terminating it would present our leaf for a host we have no
// reason to read.
test('ab.chatgpt.com is never intercepted, even with Codex accounts', () => {
  const config = { accounts: [codex('c')] };
  assert.equal(hostMode('ab.chatgpt.com', config), 'tunnel');
  assert.equal(isNeverIntercepted('ab.chatgpt.com'), true);
});

test('host matching is exact, never a suffix', () => {
  assert.equal(providerForHost('chatgpt.com'), 'codex');
  assert.equal(providerForHost('api.anthropic.com'), 'anthropic');
  assert.equal(providerForHost('ab.chatgpt.com'), null);
  assert.equal(providerForHost('evil-chatgpt.com'), null);
  assert.equal(providerForHost('chatgpt.com.evil.test'), null);
  assert.equal(providerForHost(null), null);
});

test('unrelated hosts still tunnel, and the test host is still answered locally', () => {
  const config = { accounts: [codex('c')] };
  assert.equal(hostMode('example.com', config), 'tunnel');
  assert.equal(hostMode(TEST_HOST, config), 'test');
});

test('interceptHostsFor only adds a provider an account actually uses', () => {
  assert.deepEqual(interceptHostsFor([claude('a')]), ['api.anthropic.com']);
  assert.deepEqual(interceptHostsFor([claude('a'), codex('c')]).sort(),
    ['api.anthropic.com', 'chatgpt.com']);
});

// The leaf has to NAME every host we intercept, or the CONNECT fails the
// handshake instead of being served — which is the failure this whole change
// exists to avoid.
test('mitmHosts covers the Anthropic upstream and every used provider host', () => {
  assert.deepEqual(mitmHosts({ accounts: [claude('a')] }), ['api.anthropic.com']);
  assert.deepEqual(mitmHosts({ accounts: [claude('a'), codex('c')] }).sort(),
    ['api.anthropic.com', 'chatgpt.com']);
  // A custom upstream is still covered alongside the provider hosts.
  assert.deepEqual(
    mitmHosts({ upstream: 'https://proxy.internal.test', accounts: [codex('c')] }).sort(),
    ['api.anthropic.com', 'chatgpt.com', 'proxy.internal.test'].sort(),
  );
});

test('the minted leaf is valid for every intercepted host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cert-'));
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = join(dir, 'teamclaude.json');
  try {
    const hosts = mitmHosts({ accounts: [claude('a'), codex('c')] });
    const { leafCertPem } = await ensureCerts(hosts);
    const names = (new X509Certificate(leafCertPem).subjectAltName || '')
      .split(',').map(s => s.trim());
    for (const h of [...hosts, TEST_HOST]) {
      assert.ok(names.includes(`DNS:${h}`), `the leaf does not name ${h}: ${names.join(', ')}`);
    }
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

// A single host string must keep working — every existing caller passed one.
test('ensureCerts still accepts a single host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cert-'));
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = join(dir, 'teamclaude.json');
  try {
    const { leafCertPem } = await ensureCerts('api.anthropic.com');
    const names = (new X509Certificate(leafCertPem).subjectAltName || '').split(',').map(s => s.trim());
    assert.ok(names.includes('DNS:api.anthropic.com'));
    assert.ok(names.includes(`DNS:${TEST_HOST}`));
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

// ── A host a reload starts intercepting ──────────────────────
//
// A reload adds accounts to the config object the running server holds, and
// hostMode reads them live: the first Codex account makes chatgpt.com an
// intercepted host at once. The leaf is read at the first intercepted CONNECT
// and every terminating server presents it, and a leaf re-minted to name one
// more host would come with a new CA (its key is never kept), which every
// client launched before it refuses. The server used
// to terminate chatgpt.com with a leaf that did not name it, and every Codex
// client failed its TLS handshake on the name until a restart. Most of these
// drive the real server and the reload's own sync; the last drives the connect
// handler directly, with a leaf that cannot load. A tunnel would dial the real
// chatgpt.com, so its name resolves to a local stand-in instead: a TLS server
// with a chain of its own, as the real host has. Every other name is refused,
// and no request is ever sent through an intercepted tunnel, so nothing here
// reaches a real host, even under a regression that tunnels what it should not.

// Each row carries an entry id, as every row loadConfig hands out does: a reload
// pairs rows by it, and drops the running account whose row is gone.
const keyed = (name, provider) => ({ id: `id-${name}`, name, type: 'apikey', apiKey: `k-${name}`, ...(provider ? { provider } : {}) });
const subscription = (name, provider) => ({ ...claude(name), id: `id-${name}`, ...(provider ? { provider } : {}) });
const anthropicOnly = () => [keyed('claude-a')];
const withCodex = () => [keyed('claude-a'), keyed('codex-c', 'codex')];
const fleet = (accounts) => ({ proxy: {}, upstream: 'https://api.anthropic.com', accounts });

/**
 * Answer the lookup the tunnel uses (forward-target.js) from `addresses`, a
 * name-to-IPv4 map the test may change as it goes, and refuse every other name
 * with ENOTFOUND, as a resolver that knows nothing of it would.
 */
function resolveLocally(addresses) {
  const original = dns.lookup;
  dns.lookup = /** @type {any} */ ((name, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (net.isIP(name)) return original(name, options, callback);
    if (!Object.hasOwn(addresses, name)) {
      process.nextTick(() => callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND', hostname: name })));
      return;
    }
    const address = { address: addresses[name], family: 4 };
    process.nextTick(() => (options?.all ? callback(null, [address]) : callback(null, address.address, address.family)));
  });
  return () => { dns.lookup = original; };
}

/** A TLS server standing in for `host`: a chain of its own, and a fixed reply. */
async function standIn(host, reply) {
  const chain = generateCertChain([host]);
  const server = tls.createServer({ key: chain.leafKeyPem, cert: chain.leafCertPem }, (s) => s.end(reply));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, caCertPem: chain.caCertPem };
}

/** The real server for `config`, with loopback tunnel targets admitted. */
async function startProxy(config) {
  const am = new AccountManager(config.accounts, 0.98);
  const proxy = createProxyServer(am, config, {});
  allowLoopbackForward(proxy);
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  return { am, port: proxy.address().port, close: () => { proxy.closeAllConnections?.(); proxy.close(); } };
}

/** What `teamclaude login --codex` and POST /teamclaude/reload do: the rows land on disk, and the reload syncs them in. */
const reloadWith = (config, am, accounts) => syncAccountsFromDisk(JSON.parse(JSON.stringify({ ...config, accounts })), config, am);

/**
 * CONNECT `host:port` through the proxy, with `pin` as the Basic username if
 * given, then a TLS handshake as `host` trusting only `caPem`; nothing is sent.
 * Resolves { status, names } (names null when the CONNECT was refused), or
 * rejects with the TLS error.
 */
function handshake(proxyPort, host, port, caPem, pin = null) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    raw.once('error', reject);
    const auth = pin ? `Proxy-Authorization: Basic ${Buffer.from(`${pin}:`).toString('base64')}\r\n` : '';
    raw.once('connect', () => raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`));
    let head = Buffer.alloc(0);
    const onData = (d) => {
      head = Buffer.concat([head, d]);
      if (!head.includes('\r\n\r\n')) return;
      raw.removeListener('data', onData);
      const status = head.toString('latin1').split('\r\n')[0];
      if (!/ 200 /.test(status)) { raw.destroy(); resolve({ status, names: null }); return; }
      const sock = tls.connect({ socket: raw, servername: host, ca: [caPem] }, () => {
        const names = (sock.getPeerX509Certificate()?.subjectAltName || '').split(',').map((s) => s.trim());
        sock.destroy();
        resolve({ status, names });
      });
      sock.once('error', (err) => { raw.destroy(); reject(err); });
    };
    raw.on('data', onData);
  });
}

/**
 * CONNECT `host:port` through the proxy, then TLS as `host`, trusting only
 * `caPem`, and send `request` if given. Resolves { names, body } once the peer
 * closes, or rejects with the TLS error.
 */
function tlsThroughProxy(proxyPort, host, port, caPem, request = null) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    let head = Buffer.alloc(0);
    const onData = (d) => {
      head = Buffer.concat([head, d]);
      if (!head.includes('\r\n\r\n')) return;
      raw.removeListener('data', onData);
      const status = head.toString('latin1').split('\r\n')[0];
      if (!/ 200 /.test(status)) { raw.destroy(); reject(new Error(`CONNECT answered ${status}`)); return; }
      let names = null;
      let body = '';
      const sock = tls.connect({ socket: raw, servername: host, ca: [caPem] }, () => {
        names = (sock.getPeerX509Certificate()?.subjectAltName || '').split(',').map((s) => s.trim());
        if (request) sock.write(request);
      });
      sock.setEncoding('utf8');
      sock.on('data', (c) => { body += c; });
      sock.once('error', (err) => { raw.destroy(); reject(err); });
      sock.once('close', () => resolve({ names, body }));
    };
    raw.on('data', onData);
  });
}

/**
 * Run `fn(lines, dir, addresses)` with a fresh cert dir, the proxy's log
 * captured, and `hosts` resolving to loopback through `addresses`.
 */
async function withServerScene(hosts, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-leaf-hosts-'));
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = join(dir, 'teamclaude.json');
  const addresses = Object.fromEntries(hosts.map((h) => [h, '127.0.0.1']));
  const restoreLookup = resolveLocally(addresses);
  const lines = [];
  const consoleError = console.error;
  const consoleLog = console.log;
  console.error = (...a) => { lines.push(a.join(' ')); };
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    return await fn(lines, dir, addresses);
  } finally {
    console.error = consoleError;
    console.log = consoleLog;
    restoreLookup();
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test('a host a reload starts intercepting is tunnelled, not served a leaf that does not name it', async () => {
  await withServerScene(['chatgpt.com'], async (lines, dir) => {
    const real = await standIn('chatgpt.com', 'the real host');
    const config = fleet(anthropicOnly());
    // The chain a starting server finds on disk, minted for its fleet then.
    const { caCertPem } = await ensureCerts(mitmHosts(config));
    const s = await startProxy(config);
    try {
      await reloadWith(config, s.am, withCodex());
      assert.equal(hostMode('chatgpt.com', config), 'rewrite', 'the reload did not make chatgpt.com an intercepted host');

      // The server reads its leaf only now, after the reload, and it is still
      // the one under the CA every client launched before trusts: re-minted
      // for the grown host list, it would come with a new CA.
      const anthropic = await handshake(s.port, 'api.anthropic.com', 443, caCertPem);
      assert.ok(anthropic.names.includes('DNS:api.anthropic.com'), anthropic.names.join(', '));
      assert.equal(await readFile(join(dir, 'teamclaude-ca.pem'), 'utf8'), caCertPem, 'the CA on disk was replaced');

      for (let i = 0; i < 2; i++) {
        const { names, body } = await tlsThroughProxy(s.port, 'chatgpt.com', real.port, real.caCertPem);
        assert.deepEqual(names, ['DNS:chatgpt.com']);
        assert.equal(body, 'the real host');
      }
      const said = lines.filter((l) => l.includes('tunnelling chatgpt.com'));
      assert.equal(said.length, 1, `said ${said.length} times, not once: ${JSON.stringify(lines)}`);
      assert.match(said[0], /own login, until the proxy restarts/);
    } finally {
      s.close();
      real.server.close();
    }
  });
});

// The other side: a host the leaf was minted for is still intercepted, and the
// built-in test host is still answered locally. A tunnel to either would reach
// the stand-in, whose chain the client does not trust.
test('a host the server\'s leaf names is still intercepted', async () => {
  await withServerScene(['chatgpt.com', TEST_HOST], async (lines) => {
    const real = await standIn('chatgpt.com', 'the real host');
    const config = fleet(withCodex());
    const { caCertPem } = await ensureCerts(mitmHosts(config));
    const s = await startProxy(config);
    try {
      const { names } = await handshake(s.port, 'chatgpt.com', real.port, caCertPem);
      assert.ok(names.includes('DNS:chatgpt.com') && names.includes('DNS:api.anthropic.com'), `not this proxy's leaf: ${names.join(', ')}`);
      const local = await tlsThroughProxy(s.port, TEST_HOST, real.port, caCertPem,
        `GET / HTTP/1.1\r\nHost: ${TEST_HOST}\r\nConnection: close\r\n\r\n`);
      assert.match(local.body, /"teamclaude":"mitm-proxy-ok"/);
      assert.deepEqual(lines.filter((l) => l.includes('tunnelling')), []);
    } finally {
      s.close();
      real.server.close();
    }
  });
});

// A stored chain is reused while it names at least the hosts a start needs, so
// the leaf can name more: an earlier start had a Codex account. What decides is
// the leaf the server presents, so a reload that adds one back is intercepted
// at once, and there is no renewal for `env` to warn about either.
test('a host a reload adds is intercepted when the stored leaf already names it', async () => {
  await withServerScene(['chatgpt.com'], async (lines) => {
    const real = await standIn('chatgpt.com', 'the real host');
    const earlier = await ensureCerts(mitmHosts(fleet(withCodex())));
    const config = fleet(anthropicOnly());
    // The start's renewal keeps it: naming more is no shortfall.
    assert.equal((await ensureCerts(mitmHosts(config))).caCertPem, earlier.caCertPem);
    const s = await startProxy(config);
    try {
      await reloadWith(config, s.am, withCodex());
      const { names } = await handshake(s.port, 'chatgpt.com', real.port, earlier.caCertPem);
      assert.ok(names.includes('DNS:chatgpt.com'), names.join(', '));
      // A pin is checked only when the leaf does not name the host.
      const pinned = await handshake(s.port, 'chatgpt.com', real.port, earlier.caCertPem, 'codex-c');
      assert.equal(pinned.status, 'HTTP/1.1 200 Connection Established');
      assert.ok(pinned.names.includes('DNS:chatgpt.com'), pinned.names.join(', '));
      assert.deepEqual(lines.filter((l) => /tunnelling|refused/.test(l)), []);
    } finally {
      s.close();
      real.server.close();
    }
  });
});

// With no chain on disk a start mints none (index.js), so the first one can
// come from `teamclaude env` after a Codex login has reached the running
// server. Minted from the config on disk, it names chatgpt.com, and the server
// reads it at its first intercepted CONNECT.
test('a host a reload adds is intercepted when the first leaf is minted after it', async () => {
  await withServerScene(['chatgpt.com'], async (lines) => {
    const real = await standIn('chatgpt.com', 'the real host');
    const config = fleet(anthropicOnly());
    const s = await startProxy(config);
    try {
      await reloadWith(config, s.am, withCodex());
      const env = await ensureCerts(mitmHosts(fleet(withCodex())), { keep: true });
      assert.equal(env.renewal, null);
      const { names } = await handshake(s.port, 'chatgpt.com', real.port, env.caCertPem);
      assert.ok(names.includes('DNS:chatgpt.com'), names.join(', '));
      assert.deepEqual(lines.filter((l) => l.includes('tunnelling')), []);
    } finally {
      s.close();
      real.server.close();
    }
  });
});

// A pin asks for accounts of the pool. A tunnel would serve the client on its
// own login and drop the pin without a word, so a CONNECT to a host the
// presented leaf does not name is refused when its pin names an account of
// that host's provider (a Codex key or subscription, a disabled one too: a pin
// is served from a disabled account) or an API key with an upstream of its
// own (a gateway), or a list naming any of those. Any other pin is tunnelled,
// as it was before the Codex account was added, because the pool does not
// serve that pin on this host: a Claude subscription, among them a third-party
// backend with no provider field (`oauth` with an upstream), or a plain API
// key with no upstream of its own. TC_ACCT rides HTTPS_PROXY into whatever a
// session starts. An unknown pin keeps its 407.
test('a pinned CONNECT to a host the leaf does not name is refused only when its pin names any account the pool could serve there', async () => {
  await withServerScene(['chatgpt.com'], async (lines) => {
    const real = await standIn('chatgpt.com', 'the real host');
    const gateway = { ...keyed('gw'), upstream: 'https://gateway.test' };
    const backend = { id: 'id-backend', name: 'backend', type: 'oauth', accessToken: 't', upstream: 'https://backend.test' };
    const config = fleet([...anthropicOnly(), subscription('claude-o'), gateway, backend]);
    await ensureCerts(mitmHosts(config));
    const s = await startProxy(config);
    try {
      await reloadWith(config, s.am, [...withCodex(), subscription('claude-o'), gateway, backend, subscription('codex-o', 'codex'), { ...subscription('codex-x', 'codex'), disabled: true }]);
      const refused = ['codex-c', 'codex-o', 'codex-x', 'gw', 'codex-c,claude-o', 'claude-a,gw'];
      for (const pin of refused) {
        const pinned = await handshake(s.port, 'chatgpt.com', real.port, real.caCertPem, pin);
        assert.equal(pinned.status, 'HTTP/1.1 503 Service Unavailable', `pin ${pin}`);
      }
      const unknown = await handshake(s.port, 'chatgpt.com', real.port, real.caCertPem, 'no-such-account');
      assert.equal(unknown.status, 'HTTP/1.1 407 Proxy Authentication Required');
      for (const pin of ['claude-o', 'claude-a', 'backend']) {
        const tunnelled = await handshake(s.port, 'chatgpt.com', real.port, real.caCertPem, pin);
        assert.equal(tunnelled.status, 'HTTP/1.1 200 Connection Established', `pin ${pin}`);
        assert.deepEqual(tunnelled.names, ['DNS:chatgpt.com'], `pin ${pin}`);
      }
      assert.equal(lines.filter((l) => l.includes('refused for pin')).length, refused.length, JSON.stringify(lines));
    } finally {
      s.close();
      real.server.close();
    }
  });
});

// A provider a reload removes is tunnelled by hostMode, and the leaf still
// names it, so adding it back is intercepted again with no restart.
test('a provider a reload removes and adds back is intercepted again', async () => {
  await withServerScene(['chatgpt.com'], async (lines) => {
    const real = await standIn('chatgpt.com', 'the real host');
    const config = fleet(withCodex());
    const { caCertPem } = await ensureCerts(mitmHosts(config));
    const s = await startProxy(config);
    try {
      assert.ok((await handshake(s.port, 'chatgpt.com', real.port, caCertPem)).names.includes('DNS:chatgpt.com'));
      await reloadWith(config, s.am, anthropicOnly());
      assert.equal(hostMode('chatgpt.com', config), 'tunnel', 'the reload did not remove the Codex account');
      assert.equal((await tlsThroughProxy(s.port, 'chatgpt.com', real.port, real.caCertPem)).body, 'the real host');
      await reloadWith(config, s.am, withCodex());
      assert.ok((await handshake(s.port, 'chatgpt.com', real.port, caCertPem)).names.includes('DNS:chatgpt.com'));
      assert.deepEqual(lines.filter((l) => l.includes('tunnelling')), []);
    } finally {
      s.close();
      real.server.close();
    }
  });
});

// The fallback is reported once it is a tunnel. A dial the destination policy
// refuses (here a resolver answering 0.0.0.0, as a DNS sinkhole does) is a 403
// and says so; it is not reported as tunnelled, and does not use up the report
// a tunnel that does come up later is owed.
test('a fallback the destination policy refuses is not reported as tunnelled', async () => {
  await withServerScene(['chatgpt.com'], async (lines, _dir, addresses) => {
    const real = await standIn('chatgpt.com', 'the real host');
    const config = fleet(anthropicOnly());
    await ensureCerts(mitmHosts(config));
    const s = await startProxy(config);
    try {
      await reloadWith(config, s.am, withCodex());
      addresses['chatgpt.com'] = '0.0.0.0';
      assert.equal((await handshake(s.port, 'chatgpt.com', real.port, real.caCertPem)).status, 'HTTP/1.1 403 Forbidden');
      addresses['chatgpt.com'] = '127.0.0.1';
      // Refused after the dial, too: a tunnel back to this proxy's own listener.
      assert.equal((await handshake(s.port, 'chatgpt.com', s.port, real.caCertPem)).status, 'HTTP/1.1 403 Forbidden');
      assert.deepEqual(lines.filter((l) => l.includes('tunnelling')), []);
      assert.equal((await tlsThroughProxy(s.port, 'chatgpt.com', real.port, real.caCertPem)).body, 'the real host');
      assert.equal(lines.filter((l) => l.includes('tunnelling chatgpt.com')).length, 1, JSON.stringify(lines));
    } finally {
      s.close();
      real.server.close();
    }
  });
});

// The decision needs the leaf, and the leaf can fail to load: no usable stored
// chain and a config directory that cannot be written. Then no leaf names the
// host, so it is decided as one that does not: an unpinned CONNECT is still
// tunnelled and a pinned one refused, rather than both answered 502. The
// config keeps a row the manager was not given, as resolveAccounts drops one
// with no usable credential, so a config index and a manager index name
// different accounts (account-pairing.js): the pin is read against the
// manager's.
test('a host off the list is tunnelled, or refused when pinned, when the leaf cannot load', async () => {
  await withServerScene(['chatgpt.com'], async () => {
    const real = await standIn('chatgpt.com', 'the real host');
    const config = fleet([{ id: 'id-nt', name: 'no-token', type: 'oauth', provider: 'codex', importFrom: '/nonexistent' }, ...withCodex()]);
    const lines = [];
    let loads = 0;
    /** @type {{ key: string, cert: string }|null} */
    let leaf = null;
    const proxy = http.createServer();
    proxy.on('connect', createConnectHandler({
      config,
      accountManager: new AccountManager(withCodex(), 0.98),
      ensureLeaf: async () => { loads++; if (leaf) return leaf; throw new Error('EROFS: read-only file system'); },
      leafHosts: ['api.anthropic.com'],
      log: (l) => lines.push(l),
    }));
    allowLoopbackForward(proxy);
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    try {
      const port = /** @type {import('node:net').AddressInfo} */ (proxy.address()).port;
      assert.equal((await tlsThroughProxy(port, 'chatgpt.com', real.port, real.caCertPem)).body, 'the real host');
      assert.equal((await handshake(port, 'chatgpt.com', real.port, real.caCertPem, 'codex-c')).status, 'HTTP/1.1 503 Service Unavailable');
      assert.equal(loads, 2);
      assert.match(lines.find((l) => l.includes('tunnelling chatgpt.com')) || '', /this proxy's certificate could not be loaded \(EROFS/);
      assert.match(lines.find((l) => l.includes('refused for pin')) || '', /this proxy's certificate could not be loaded \(EROFS/);
      // Once it loads, a leaf that does not name the host is a reason of its
      // own, and is reported although the load failure was.
      const chain = generateCertChain(['api.anthropic.com']);
      leaf = { key: chain.leafKeyPem, cert: chain.leafCertPem };
      assert.equal((await tlsThroughProxy(port, 'chatgpt.com', real.port, real.caCertPem)).body, 'the real host');
      const said = lines.filter((l) => l.includes('tunnelling chatgpt.com'));
      assert.equal(said.length, 2, JSON.stringify(lines));
      assert.match(said[1], /does not name it/);
    } finally {
      proxy.closeAllConnections?.();
      proxy.close();
      real.server.close();
    }
  });
});

// The pin is decided on the accounts it resolved to when the CONNECT came in,
// not once the leaf has loaded. A reload while the load is pending can remove
// or rename the pinned account, or one a pin list names, and the pin resolved
// again after it named nothing and was tunnelled on the client's own login.
// Removing codex-c also moves the accounts after it down one place, so the
// index it had, read again after the load, would name a Claude subscription.
// The load is held open here until the reload has landed, so the CONNECT is
// decided across it, and the stand-in for the real host must hear nothing.
test('a pin is decided before the leaf loads, so a reload during the load cannot tunnel it', async () => {
  await withServerScene(['chatgpt.com'], async () => {
    const real = await standIn('chatgpt.com', 'the real host');
    let dialled = 0;
    real.server.on('connection', () => { dialled++; });
    const chain = generateCertChain(['api.anthropic.com']);
    const leaf = { key: chain.leafKeyPem, cert: chain.leafCertPem };
    const start = () => [keyed('claude-a'), keyed('codex-c', 'codex'), subscription('claude-o'), keyed('codex-d', 'codex')];
    try {
      for (const [pin, after] of [
        ['codex-c', [keyed('claude-a'), subscription('claude-o'), keyed('codex-d', 'codex')]],
        ['codex-c,codex-d', [keyed('claude-a'), keyed('codex-c', 'codex'), subscription('claude-o')]],
      ]) {
        const config = fleet(start());
        const am = new AccountManager(config.accounts, 0.98);
        /** @type {() => void} */
        let release = () => {};
        const loaded = new Promise((r) => { release = () => r(undefined); });
        /** @type {() => void} */
        let entered = () => {};
        const loading = new Promise((r) => { entered = () => r(undefined); });
        const proxy = http.createServer();
        proxy.on('connect', createConnectHandler({
          config,
          accountManager: am,
          ensureLeaf: async () => { entered(); await loaded; return leaf; },
          leafHosts: ['api.anthropic.com'],
        }));
        allowLoopbackForward(proxy);
        await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
        try {
          const port = /** @type {import('node:net').AddressInfo} */ (proxy.address()).port;
          const pending = handshake(port, 'chatgpt.com', real.port, real.caCertPem, pin);
          // A CONNECT answered before it asks for the leaf ends the handshake
          // first, and the leaf is then never asked for: fail on that answer
          // rather than wait for a load that will not come. An early
          // rejection of the handshake fails the test here too.
          const early = await Promise.race([loading.then(() => null), pending]);
          assert.equal(early, null, `pin ${pin} was answered ${early?.status} before the leaf was asked for`);
          await reloadWith(config, am, after);
          const now = resolveConnectPin({ headers: { 'proxy-authorization': `Basic ${Buffer.from(`${pin}:`).toString('base64')}` } }, am, config.proxy);
          assert.match(now.error || '', /Unknown account pin/, `the reload did not take ${pin} away`);
          release();
          assert.equal((await pending).status, 'HTTP/1.1 503 Service Unavailable', `pin ${pin}`);
          assert.equal(dialled, 0, `pin ${pin} was tunnelled to the real host`);
        } finally {
          release();
          proxy.closeAllConnections?.();
          proxy.close();
        }
      }
    } finally {
      real.server.close();
    }
  });
});
