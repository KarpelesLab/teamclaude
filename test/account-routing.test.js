import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { generateCertChain } from '../src/x509.js';
import { parseRoutingUrl, routingToUrl, describeRouting, maskRoutingUrl, connectThroughRouting, routingAgent, checkRouting } from '../src/account-routing.js';
import { upstreamFetch, proxyFetch } from '../src/upstream-fetch.js';
import { setUpstreamProxy, resetUpstreamProxy, resolveUpstreamProxy } from '../src/upstream-proxy.js';

const T = { timeout: 30000 };
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
function closeHard(s) { if (!s) return; s.closeAllConnections?.(); try { s.close(); } catch { /* closing */ } }

// ── URL parsing ──────────────────────────────────────────────

test('parseRoutingUrl parses every scheme with defaults and auth', () => {
  assert.deepEqual(parseRoutingUrl(null), null);
  assert.deepEqual(parseRoutingUrl(''), null);
  assert.deepEqual(parseRoutingUrl('  '), null);

  assert.deepEqual(parseRoutingUrl('http://proxy.example.com'), {
    protocol: 'http', host: 'proxy.example.com', port: 8080, username: null, password: null,
  });
  assert.deepEqual(parseRoutingUrl('http://bob:s3cret@proxy.example.com:3128'), {
    protocol: 'http', host: 'proxy.example.com', port: 3128, username: 'bob', password: 's3cret',
  });
  assert.deepEqual(parseRoutingUrl('socks5h://alice:s3cret@proxy.example.com:1080'), {
    protocol: 'socks5h', host: 'proxy.example.com', port: 1080, username: 'alice', password: 's3cret',
  });
  assert.deepEqual(parseRoutingUrl('socks5://proxy.example.com'), {
    protocol: 'socks5', host: 'proxy.example.com', port: 1080, username: null, password: null,
  });
  assert.deepEqual(parseRoutingUrl('socks4://proxy.example.com:4145'), {
    protocol: 'socks4', host: 'proxy.example.com', port: 4145, username: null, password: null,
  });
  assert.deepEqual(parseRoutingUrl('socks4a://carol@proxy.example.com'), {
    protocol: 'socks4a', host: 'proxy.example.com', port: 1080, username: 'carol', password: null,
  });
  // A bare host:port is a CONNECT proxy by convention (same as upstreamProxy).
  assert.deepEqual(parseRoutingUrl('proxy.example.com:3128'), {
    protocol: 'http', host: 'proxy.example.com', port: 3128, username: null, password: null,
  });
  // Percent-encoded credentials survive the round trip.
  assert.deepEqual(parseRoutingUrl('socks5://al%40ice:p%3Ass@proxy.example.com'), {
    protocol: 'socks5', host: 'proxy.example.com', port: 1080, username: 'al@ice', password: 'p:ss',
  });
});

test('parseRoutingUrl refuses unusable input with a named reason', () => {
  assert.throws(() => parseRoutingUrl('https://proxy.example.com'), /unsupported routing protocol "https"/);
  assert.throws(() => parseRoutingUrl('ftp://proxy.example.com'), /unsupported routing protocol "ftp"/);
  assert.throws(() => parseRoutingUrl('http://'), /invalid routing URL|no host/);
  // WHATWG URL rejects these before our own range check ever runs.
  assert.throws(() => parseRoutingUrl('http://proxy.example.com:99999'), /invalid routing URL/);
  // ...but port 0 parses fine and is ours to refuse.
  assert.throws(() => parseRoutingUrl('socks5://proxy.example.com:0'), /invalid port/);
  // SOCKS4 carries a userid only — a password would be silently dropped.
  assert.throws(() => parseRoutingUrl('socks4://bob:s3cret@proxy.example.com'), /SOCKS4 has no password/);
  assert.throws(() => parseRoutingUrl('not a url at all:8bad'), /invalid routing URL|invalid port/);
});

test('parseRoutingUrl reads none and off as no routing, not as a proxy host', () => {
  for (const value of ['none', 'None', ' off ', 'OFF']) assert.equal(parseRoutingUrl(value), null, value);
  // A real single-label host still parses: only the two words are reserved.
  assert.equal(parseRoutingUrl('localhost').host, 'localhost');
  assert.equal(parseRoutingUrl('socks5://none:1080').host, 'none', 'with a scheme it is a host, as written');
});

test('a refused routing URL never echoes its password', () => {
  // These messages reach the server log (a bad config value is reported at
  // startup and on every reload), so each refusal is checked, not just one.
  const refusedValues = [
    'ftp://alice:s3cret@proxy.example.com:21',          // unsupported scheme
    'socks5://alice:s3cret@proxy.example.com:0',        // invalid port
    'socks5://alice:s3cret@proxy.example.com:99999',    // port out of range
    'socks4://alice:s3cret@proxy.example.com:1080',     // SOCKS4 has no password
    'socks5://alice:s3%zzcret@proxy.example.com:1080',  // malformed percent-escape
    'socks5://alice:s3c#ret@proxy.example.com:1080',    // unescaped '#' cuts the authority short
    'socks5://alice:s3cret@',                           // no host
  ];
  for (const value of refusedValues) {
    assert.throws(() => parseRoutingUrl(value), (err) => {
      assert.ok(err instanceof Error);
      assert.equal(/s3c|cret/.test(err.message), false, `${value} → ${err.message}`);
      assert.ok(err.message.includes('alice:***@'), `${value} → ${err.message}`);
      return true;
    });
  }
  assert.throws(() => parseRoutingUrl('socks5://alice:s3%zzcret@proxy.example.com:1080'), /malformed percent-escape/);
});

test('maskRoutingUrl masks a password in a value that may not parse at all', () => {
  assert.equal(maskRoutingUrl('socks5h://alice:s3cret@proxy.example.com:1080'), 'socks5h://alice:***@proxy.example.com:1080');
  assert.equal(maskRoutingUrl('alice:s3cret@proxy.example.com:3128'), 'alice:***@proxy.example.com:3128', 'no scheme');
  assert.equal(maskRoutingUrl('socks5://alice:s3c@ret@host:1080'), 'socks5://alice:***@host:1080', 'cut at the LAST @');
  assert.equal(maskRoutingUrl('socks5://alice:s3c/r#et@host:1080'), 'socks5://alice:***@host:1080', 'delimiters inside the password');
  assert.equal(maskRoutingUrl('socks4a://alice@host:1080'), 'socks4a://alice@host:1080', 'a username alone is left as it is');
  assert.equal(maskRoutingUrl('proxy.example.com:3128'), 'proxy.example.com:3128');
  assert.equal(maskRoutingUrl('none'), 'none');
  assert.equal(maskRoutingUrl(null), '');
});

test('routingToUrl round-trips and describeRouting masks the password', () => {
  const r = parseRoutingUrl('socks5h://alice:s3cret@proxy.example.com:1080');
  assert.equal(routingToUrl(r), 'socks5h://alice:s3cret@proxy.example.com:1080');
  assert.equal(describeRouting(r), 'socks5h://alice:***@proxy.example.com:1080');
  const bare = parseRoutingUrl('http://proxy.example.com:3128');
  assert.equal(routingToUrl(bare), 'http://proxy.example.com:3128');
  assert.equal(describeRouting(bare), 'http://proxy.example.com:3128');
  assert.equal(routingToUrl(null), null);
  assert.equal(describeRouting(null), null);
});

// ── SOCKS mocks ──────────────────────────────────────────────

// A minimal SOCKS5 server (RFC 1928 + 1929): records the offered methods, the
// auth attempt and the CONNECT target, then blind-tunnels to it. The `parsed`
// latch matters: pipe() does not stop 'data' events, so without it the relayed
// HTTP bytes would be re-read as another handshake.
function makeSocks5Server({ username = null, password = null, repCode = 0x00 } = {}) {
  const seen = { methods: null, auth: null, host: null, port: null, atyp: null };
  const srv = net.createServer((client) => {
    let stage = 'greeting';
    let parsed = false;
    let buf = Buffer.alloc(0);
    client.on('data', (chunk) => {
      if (parsed) return;
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf.length < 2 + n) return;
        seen.methods = [...buf.subarray(2, 2 + n)];
        buf = buf.subarray(2 + n);
        if (username) { stage = 'auth'; client.write(Buffer.from([0x05, 0x02])); }
        else { stage = 'request'; client.write(Buffer.from([0x05, 0x00])); }
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        const ulen = buf[1];
        if (buf.length < 3 + ulen) return;
        const uname = buf.subarray(2, 2 + ulen).toString();
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const passwd = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        seen.auth = `${uname}:${passwd}`;
        if (uname !== username || passwd !== password) { client.write(Buffer.from([0x01, 0x01])); return; }
        stage = 'request';
        client.write(Buffer.from([0x01, 0x00]));
      }
      if (stage === 'request') {
        if (buf.length < 4) return;
        const atyp = buf[3];
        seen.atyp = atyp;
        let host; let len;
        if (atyp === 0x01) {
          if (buf.length < 10) return;
          host = [...buf.subarray(4, 8)].join('.'); seen.port = buf.readUInt16BE(8); len = 10;
        } else if (atyp === 0x03) {
          const dlen = buf[4];
          if (buf.length < 7 + dlen) return;
          host = buf.subarray(5, 5 + dlen).toString(); seen.port = buf.readUInt16BE(5 + dlen); len = 7 + dlen;
        } else if (atyp === 0x04) {
          if (buf.length < 22) return;
          const groups = [];
          for (let i = 0; i < 8; i++) groups.push(buf.readUInt16BE(4 + i * 2).toString(16));
          host = groups.join(':'); // expanded form — net.connect takes it as-is
          seen.port = buf.readUInt16BE(20); len = 22;
        } else {
          client.destroy(); return;
        }
        buf = buf.subarray(len);
        seen.host = host;
        if (repCode !== 0x00) { client.write(Buffer.from([0x05, repCode, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); return; }
        const up = net.connect(seen.port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (buf.length) up.write(buf);
          up.pipe(client); client.pipe(up);
        });
        up.on('error', () => client.destroy());
        parsed = true;
      }
    });
    client.on('error', () => {});
  });
  return { srv, seen };
}

// A minimal SOCKS4/SOCKS4a server: records userid and target (resolving the
// 0.0.0.x + domain form), then blind-tunnels. Same parsed latch as above.
function makeSocks4Server() {
  const seen = { userid: null, host: null, port: null, domain: null };
  const srv = net.createServer((client) => {
    let parsed = false;
    let buf = Buffer.alloc(0);
    client.on('data', (chunk) => {
      if (parsed) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 9) return;
      assert.equal(buf[0], 0x04, 'VN is 4');
      assert.equal(buf[1], 0x01, 'CD is CONNECT');
      seen.port = buf.readUInt16BE(2);
      const ip = [...buf.subarray(4, 8)].join('.');
      const nul = buf.indexOf(0, 8);
      if (nul < 0) return;
      seen.userid = buf.subarray(8, nul).toString();
      let host = ip;
      let rest = buf.subarray(nul + 1);
      if (buf[4] === 0 && buf[5] === 0 && buf[6] === 0 && buf[7] !== 0) {
        const nul2 = rest.indexOf(0);
        if (nul2 < 0) return;
        seen.domain = rest.subarray(0, nul2).toString();
        host = seen.domain;
        rest = rest.subarray(nul2 + 1);
      }
      seen.host = host;
      const up = net.connect(seen.port, host, () => {
        client.write(Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0]));
        if (rest.length) up.write(rest);
        up.pipe(client); client.pipe(up);
      });
      up.on('error', () => client.destroy());
      parsed = true;
    });
    client.on('error', () => {});
  });
  return { srv, seen };
}

function jsonOrigin() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
}

function getViaAgent(url, agent) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(url, { agent }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.once('error', reject);
    req.end();
  });
}

// ── SOCKS5 end to end ────────────────────────────────────────

test('socks5h: the proxy receives the hostname and relays the request', T, async () => {
  const origin = jsonOrigin();
  const originPort = await listen(origin);
  const { srv, seen } = makeSocks5Server();
  const proxyPort = await listen(srv);
  try {
    const agent = routingAgent(parseRoutingUrl(`socks5h://127.0.0.1:${proxyPort}`),
      { targetHost: 'localhost', targetPort: originPort, tls: false });
    const res = await getViaAgent(`http://localhost:${originPort}/v1/messages`, agent);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, path: '/v1/messages' });
    assert.equal(seen.atyp, 0x03, 'hostname went to the proxy as a domain');
    assert.equal(seen.host, 'localhost');
    assert.equal(seen.port, originPort);
    assert.deepEqual(seen.methods, [0x00], 'no-auth greeting when no credentials');
  } finally { closeHard(srv); closeHard(origin); }
});

test('socks5: the hostname is resolved locally and sent as an address', T, async () => {
  const origin = jsonOrigin();
  // Dual-stack: the client resolves 'localhost' to ::1 or 127.0.0.1 per the
  // host's resolver, and the proxy then connects to whatever it was handed.
  const originPort = await new Promise((r) => origin.listen(0, '::', () => r(origin.address().port)));
  const { srv, seen } = makeSocks5Server();
  const proxyPort = await listen(srv);
  try {
    const agent = routingAgent(`socks5://127.0.0.1:${proxyPort}`, // string form is parsed for the caller
      { targetHost: 'localhost', targetPort: originPort, tls: false });
    const res = await getViaAgent(`http://localhost:${originPort}/x`, agent);
    assert.equal(res.status, 200);
    // localhost resolves to 127.0.0.1 or ::1 depending on the host — either way
    // the proxy got a literal address (ATYP 1 or 4), never a domain name.
    assert.ok(seen.atyp === 0x01 || seen.atyp === 0x04, `locally resolved target went as a literal (atyp ${seen.atyp})`);
    assert.ok(seen.host === '127.0.0.1' || seen.host === '0:0:0:0:0:0:0:1', `resolved to loopback, got ${seen.host}`);
    assert.equal(seen.port, originPort);
  } finally { closeHard(srv); closeHard(origin); }
});

test('socks5 username/password auth is offered and verified', T, async () => {
  const origin = jsonOrigin();
  const originPort = await listen(origin);
  const { srv, seen } = makeSocks5Server({ username: 'alice', password: 's3cret' });
  const proxyPort = await listen(srv);
  try {
    const agent = routingAgent(parseRoutingUrl(`socks5://alice:s3cret@127.0.0.1:${proxyPort}`),
      { targetHost: '127.0.0.1', targetPort: originPort, tls: false });
    const res = await getViaAgent(`http://127.0.0.1:${originPort}/y`, agent);
    assert.equal(res.status, 200);
    assert.equal(seen.auth, 'alice:s3cret');
    assert.deepEqual(seen.methods, [0x00, 0x02], 'credentials offered the user/pass method');
  } finally { closeHard(srv); closeHard(origin); }
});

test('socks5 auth failure rejects the connect', T, async () => {
  const { srv } = makeSocks5Server({ username: 'alice', password: 's3cret' });
  const proxyPort = await listen(srv);
  try {
    await assert.rejects(
      connectThroughRouting(parseRoutingUrl(`socks5://alice:WRONG@127.0.0.1:${proxyPort}`),
        { targetHost: '127.0.0.1', targetPort: 9, timeout: 5000 }),
      /SOCKS5 authentication failed/,
    );
  } finally { closeHard(srv); }
});

test('socks5 CONNECT failure surfaces the reply code', T, async () => {
  const { srv } = makeSocks5Server({ repCode: 0x05 });
  const proxyPort = await listen(srv);
  try {
    await assert.rejects(
      connectThroughRouting(parseRoutingUrl(`socks5://127.0.0.1:${proxyPort}`),
        { targetHost: '127.0.0.1', targetPort: 9, timeout: 5000 }),
      /connection refused/,
    );
  } finally { closeHard(srv); }
});

// ── SOCKS4 end to end ────────────────────────────────────────

test('socks4a: the domain travels after the 0.0.0.x marker', T, async () => {
  const origin = jsonOrigin();
  const originPort = await listen(origin);
  const { srv, seen } = makeSocks4Server();
  const proxyPort = await listen(srv);
  try {
    const agent = routingAgent(parseRoutingUrl(`socks4a://carol@127.0.0.1:${proxyPort}`),
      { targetHost: 'localhost', targetPort: originPort, tls: false });
    const res = await getViaAgent(`http://localhost:${originPort}/z`, agent);
    assert.equal(res.status, 200);
    assert.equal(seen.domain, 'localhost');
    assert.equal(seen.userid, 'carol');
    assert.equal(seen.host, 'localhost');
    assert.equal(seen.port, originPort);
  } finally { closeHard(srv); closeHard(origin); }
});

test('socks4: an IPv4 literal goes direct in the address field', T, async () => {
  const origin = jsonOrigin();
  const originPort = await listen(origin);
  const { srv, seen } = makeSocks4Server();
  const proxyPort = await listen(srv);
  try {
    const agent = routingAgent(parseRoutingUrl(`socks4://127.0.0.1:${proxyPort}`),
      { targetHost: '127.0.0.1', targetPort: originPort, tls: false });
    const res = await getViaAgent(`http://127.0.0.1:${originPort}/w`, agent);
    assert.equal(res.status, 200);
    assert.equal(seen.domain, null);
    assert.equal(seen.host, '127.0.0.1');
    assert.equal(seen.port, originPort);
  } finally { closeHard(srv); closeHard(origin); }
});

// ── HTTP CONNECT and TLS ─────────────────────────────────────

test('http routing uses a CONNECT tunnel with Basic auth', T, async () => {
  const origin = jsonOrigin();
  const originPort = await listen(origin);
  const seen = { target: null, auth: null };
  const proxy = net.createServer((client) => {
    client.once('data', (buf) => {
      const head = buf.toString('latin1');
      const m = head.match(/^CONNECT (\S+) HTTP\/1\.1/);
      seen.target = m?.[1] ?? null;
      const authLine = head.split('\r\n').find((l) => l.toLowerCase().startsWith('proxy-authorization:'));
      seen.auth = authLine ? Buffer.from(authLine.split(/\s+/)[2], 'base64').toString() : null;
      const [host, port] = seen.target.split(':');
      const up = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.pipe(client); client.pipe(up);
      });
      up.on('error', () => client.destroy());
    });
    client.on('error', () => {});
  });
  const proxyPort = await listen(proxy);
  try {
    const agent = routingAgent(parseRoutingUrl(`http://bob:s3cret@127.0.0.1:${proxyPort}`),
      { targetHost: '127.0.0.1', targetPort: originPort, tls: false });
    const res = await getViaAgent(`http://127.0.0.1:${originPort}/c`, agent);
    assert.equal(res.status, 200);
    assert.equal(seen.target, `127.0.0.1:${originPort}`);
    assert.equal(seen.auth, 'bob:s3cret');
  } finally { closeHard(proxy); closeHard(origin); }
});

test('TLS is end-to-end through a socks5 tunnel', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = tls.createServer({ key: leafKeyPem, cert: leafCertPem }, (s) => {
    s.on('data', () => {
      const body = JSON.stringify({ ok: true, sni: s.servername || null });
      s.end(`HTTP/1.1 200 OK\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
    });
  });
  const upPort = await listen(upstream);
  const { srv, seen } = makeSocks5Server({ username: 'alice', password: 's3cret' });
  const proxyPort = await listen(srv);
  try {
    const agent = routingAgent(parseRoutingUrl(`socks5h://alice:s3cret@127.0.0.1:${proxyPort}`),
      { targetHost: 'localhost', targetPort: upPort, tls: true, tlsOptions: { ca: caCertPem } });
    const res = await getViaAgent(`https://localhost:${upPort}/tls`, agent);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, sni: 'localhost' });
    assert.equal(seen.host, 'localhost');
    assert.equal(seen.port, upPort);
  } finally { closeHard(srv); closeHard(upstream); }
});

// ── checkRouting: the question asked before a routing is saved ──

test('checkRouting completes the TLS handshake through the proxy and sends no request', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  let received = 0;
  const upstream = tls.createServer({ key: leafKeyPem, cert: leafCertPem }, (s) => {
    s.on('data', (d) => { received += d.length; });
    s.on('error', () => {});
  });
  const upPort = await listen(upstream);
  const { srv, seen } = makeSocks5Server({ username: 'alice', password: 's3cret' });
  const proxyPort = await listen(srv);
  try {
    const routing = parseRoutingUrl(`socks5h://alice:s3cret@127.0.0.1:${proxyPort}`);
    const ok = await checkRouting(routing, `https://localhost:${upPort}/v1/messages`, { tlsOptions: { ca: caCertPem } });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.host, `localhost:${upPort}`);
    assert.ok(Number.isFinite(ok.ms));
    assert.equal(seen.host, 'localhost', 'the proxy was asked for the upstream by name');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received, 0, 'a check is a handshake, never a request');

    // A certificate the machine does not trust is a failed check, not a pass:
    // that is what a TLS-intercepting proxy looks like from here.
    const untrusted = await checkRouting(routing, `https://localhost:${upPort}/`);
    assert.equal(untrusted.ok, false);
    assert.match(untrusted.error, /certificate|self.signed|unable to verify/i);
  } finally { closeHard(srv); closeHard(upstream); }
});

test('checkRouting resolves with a masked reason instead of rejecting', T, async () => {
  const { srv } = makeSocks5Server({ username: 'alice', password: 's3cret' });
  const proxyPort = await listen(srv);
  const origin = jsonOrigin();
  const originPort = await listen(origin);
  try {
    const wrong = await checkRouting(parseRoutingUrl(`socks5://alice:wr0ng@127.0.0.1:${proxyPort}`), `http://127.0.0.1:${originPort}`);
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, `account routing proxy socks5://alice:***@127.0.0.1:${proxyPort}: SOCKS5 authentication failed`);

    const right = await checkRouting(parseRoutingUrl(`socks5://alice:s3cret@127.0.0.1:${proxyPort}`), `http://127.0.0.1:${originPort}`);
    assert.equal(right.ok, true, right.error);
  } finally { closeHard(srv); closeHard(origin); }
});

test('an IPv6 literal target reaches SOCKS as an address and CONNECT in brackets', T, async () => {
  // URL.hostname hands an IPv6 literal over bracketed. Left that way, SOCKS
  // would send "[::1]" to DNS as a hostname.
  const socks = makeSocks5Server();
  const socksPort = await listen(socks.srv);
  const connect = makeCountingConnectProxy();
  const connectPort = await listen(connect.srv);
  try {
    await connectThroughRouting(parseRoutingUrl(`socks5://127.0.0.1:${socksPort}`), { targetHost: '[::1]', targetPort: 9, timeout: 3000 })
      .then((s) => s.destroy(), () => {});
    assert.equal(socks.seen.atyp, 0x04, 'sent as an IPv6 address, not a domain');
    assert.equal(socks.seen.host, '0:0:0:0:0:0:0:1');

    // The counting proxy cannot dial this target and never answers; what it
    // was ASKED for is the whole assertion, so a short wait is enough.
    await connectThroughRouting(parseRoutingUrl(`http://127.0.0.1:${connectPort}`), { targetHost: '[::1]', targetPort: 9, timeout: 300 })
      .then((s) => s.destroy(), () => {});
    assert.deepEqual(connect.seen.targets, ['[::1]:9']);
  } finally { closeHard(socks.srv); closeHard(connect.srv); }
});

// ── Precedence: one account's proxy beats the fleet's ────────

// A CONNECT proxy that only counts how many tunnels it was asked for, then
// relays. Used to prove which proxy a request actually left through.
function makeCountingConnectProxy() {
  const seen = { targets: [] };
  const srv = net.createServer((client) => {
    client.once('data', (buf) => {
      const m = buf.toString('latin1').match(/^CONNECT (\S+) HTTP\/1\.1/);
      if (!m) { client.destroy(); return; }
      seen.targets.push(m[1]);
      const [host, port] = m[1].split(':');
      const up = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.pipe(client); client.pipe(up);
      });
      up.on('error', () => client.destroy());
    });
    client.on('error', () => {});
  });
  return { srv, seen };
}

test.afterEach(() => resetUpstreamProxy());

test('upstreamFetch prefers account routing over the fleet upstream proxy', T, async () => {
  const origin = jsonOrigin();
  const originPort = await listen(origin);
  const fleet = makeCountingConnectProxy();
  const fleetPort = await listen(fleet.srv);
  const { srv: socks, seen } = makeSocks5Server();
  const socksPort = await listen(socks);

  // The fleet proxy is configured and would happily serve — the account's own
  // routing must still win for this call. Explicit empty env: a developer shell
  // carrying HTTPS_PROXY/NO_PROXY must not leak into the assertion.
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: `127.0.0.1:${fleetPort}` }, {}));
  try {
    const res = await upstreamFetch(`http://127.0.0.1:${originPort}/routed`, {
      method: 'GET', headersTimeoutMs: 8000, routing: parseRoutingUrl(`socks5://127.0.0.1:${socksPort}`),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.host, '127.0.0.1', 'request left through the account proxy');
    assert.equal(seen.port, originPort);
    assert.deepEqual(fleet.seen.targets, [], 'fleet proxy was bypassed for the routed account');
  } finally { closeHard(socks); closeHard(fleet.srv); closeHard(origin); }
});

test('upstreamFetch prefers account routing over sx, even on a proxy retry', T, async () => {
  const origin = jsonOrigin();
  const originPort = await listen(origin);
  const fleet = makeCountingConnectProxy();
  const fleetPort = await listen(fleet.srv);
  const { srv: socks, seen } = makeSocks5Server();
  const socksPort = await listen(socks);

  // sx is provisioned and this attempt is the "route via sx" one (useProxy
  // true) — for a routed account that policy must not fire.
  const sx = {
    isProvisioned: () => true,
    getProxy: () => ({ host: '127.0.0.1', port: fleetPort, username: null, password: null }),
  };
  try {
    const res = await upstreamFetch(`http://127.0.0.1:${originPort}/retry`, {
      method: 'GET', headersTimeoutMs: 8000, routing: parseRoutingUrl(`socks5h://127.0.0.1:${socksPort}`),
    }, sx, true);
    assert.equal(res.status, 200);
    assert.equal(seen.port, originPort, 'request left through the account proxy');
    assert.deepEqual(fleet.seen.targets, [], 'sx was bypassed for the routed account');
  } finally { closeHard(socks); closeHard(fleet.srv); closeHard(origin); }
});

test('proxyFetch tunnels control-plane calls through account routing', T, async () => {
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'a' }));
  });
  const originPort = await listen(origin);
  const { srv, seen } = makeSocks5Server({ username: 'alice', password: 's3cret' });
  const proxyPort = await listen(srv);
  try {
    const res = await proxyFetch(`http://127.0.0.1:${originPort}/oauth/token`, {
      method: 'POST', body: '{}', headersTimeoutMs: 8000,
      routing: `socks5://alice:s3cret@127.0.0.1:${proxyPort}`, // the stored string form
    });
    assert.equal(res.ok, true);
    assert.deepEqual(await res.json(), { access_token: 'a' });
    assert.equal(seen.auth, 'alice:s3cret');
    assert.equal(seen.port, originPort);
  } finally { closeHard(srv); closeHard(origin); }
});
