import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { generateCertChain } from '../src/x509.js';
import { parseRoutingUrl, routingToUrl, describeRouting, connectThroughRouting, routingAgent } from '../src/account-routing.js';

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
