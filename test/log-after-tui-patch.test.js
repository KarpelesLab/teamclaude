import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { Prober } from '../src/prober.js';
import { Warmer } from '../src/warmer.js';

// `tui.start()` swaps `console.log`/`console.error` for the activity log and
// moves the terminal to the alternate screen. Everything the proxy reports
// after that has to go through the replacements, or it lands on a terminal the
// next repaint covers — written, flushed, and never seen.
//
// Both ways of naming a console bind it at construction. An argument is the
// function that existed when it was passed; a constructor's `log = console.log`
// default is evaluated when the constructor runs, which is no later. Every
// component below is built before the TUI starts and speaks afterwards — at
// request time, on a reload, or on a sweep — so each one addressed the pre-TUI
// console for the life of the process.
//
// These tests replace the console AFTER construction, exactly as the TUI does,
// and assert the replacement is what receives the message.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Stand in for the TUI: take the console over, collect, hand it back.
async function withReplacedConsole(fn) {
  /** @type {string[]} */
  const seen = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => seen.push(a.join(' '));
  console.error = (...a) => seen.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return seen.join('\n');
}

// Raw CONNECT, resolving with the proxy's status line. No tunnel is expected:
// the target below is refused by name before anything is dialled.
function connectRaw(port, target) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    sock.on('error', reject);
    sock.once('connect', () => sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('close', () => resolve(buf.split('\r\n')[0]));
  });
}

// The cloud metadata address: link-local, so the tunnel policy refuses it by
// name and the handler reports the refusal through its `log` option.
test('a CONNECT refused after the console is replaced is reported to the replacement', async () => {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: 'http://127.0.0.1:1' });
  const port = await listen(proxy);

  try {
    const logged = await withReplacedConsole(async () => {
      const status = await connectRaw(port, '169.254.169.254:80');
      assert.match(status, /^HTTP\/1\.1 403 Forbidden/, 'the refusal itself still reaches the client');
    });
    assert.match(logged, /CONNECT 169\.254\.169\.254:80 refused: .*link-local/);
  } finally {
    proxy.close();
  }
});

// The egress guard is built in the same breath as the connect handler and has
// the same problem: `pin: 'auto'` makes it announce the address it latched
// onto, and that announcement is produced by the first request, not by
// construction.
test('an egress announcement after the console is replaced reaches the replacement', async () => {
  const ipService = http.createServer((_req, res) => { res.writeHead(200); res.end('203.0.113.7'); });
  const ipPort = await listen(ipService);
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
  const proxy = createProxyServer(am, {
    proxy: {},
    upstream: `http://127.0.0.1:${upstreamPort}`,
    egress: { pin: 'auto', checkUrl: `http://127.0.0.1:${ipPort}` },
  });
  const port = await listen(proxy);

  try {
    const logged = await withReplacedConsole(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [] }),
      });
      assert.equal(res.status, 200);
    });
    assert.match(logged, /Egress pinned to 203\.0\.113\.7/);
  } finally {
    proxy.close();
    upstream.close();
    ipService.close();
  }
});

// The prober and the warmer are handed no logger at all: their constructors
// default `log` to `console.log`, which binds at construction just as firmly as
// an argument would. `serverCommand` builds both in the same tick as
// `server.listen()`, so the bind happens before the listen callback reaches
// `tui.start()`. The notices below are produced later, by a reload. Both tests
// therefore construct the component the way `serverCommand` does — with no
// `log` option — and leave the default to do the work.

test('a quota-probe notice after the console is replaced reaches the replacement', async () => {
  // An API-key account is not a probe target, so the immediate probe that an
  // off→on reschedule fires finds nothing to reach for and stays offline.
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
  const prober = new Prober(am, { intervalMs: 0 });

  try {
    const logged = await withReplacedConsole(async () => {
      // What a reload does when `quotaProbeSeconds` has changed on disk.
      prober.reschedule(3_600_000);
    });
    assert.match(logged, /Quota probe enabled \(every 3600s\)/);
  } finally {
    prober.stop();
  }
});

test('a keep-warm notice after the console is replaced reaches the replacement', async () => {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
  // `spawnFn` is a stub so nothing can launch `claude` under any timing; the
  // option this deliberately does not pass is `log`.
  const warmer = new Warmer(am, { intervalMs: 0, port: 1, spawnFn: async () => 0 });

  try {
    const logged = await withReplacedConsole(async () => {
      // What a reload does when `warmupSchedule` has changed on disk. Arms the
      // next run and announces it; sweeps nothing now.
      warmer.rescheduleSchedule({ resetTime: '16:30', timezone: 'Europe/Moscow' });
    });
    assert.match(logged, /Keep-warm scheduled for /);
  } finally {
    warmer.stop();
  }
});

// A source-shape assertion, not a runtime one — and it says so in its name
// because it cannot be anything else. `src/index.js` exports nothing, so
// `serverCommand` and the sx.org manager it builds cannot be reached without
// standing the whole server up, which is far more machinery than this one
// construction is worth. So this reads the construction line and checks the
// logger is an arrow rather than a bare console. It proves the source says the
// right thing; it never calls the manager. If the construction moves, the first
// assertion fails with a pointer to where the check has to follow it.
test('src/index.js names the sx.org logger as a call-time arrow (source shape, not runtime)', async () => {
  const src = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const line = src.split('\n').find(l => l.includes('new SxManager('));
  assert.ok(line, 'the sx.org manager is no longer constructed here — move this assertion with it');
  assert.doesNotMatch(line, /log:\s*console\.(error|log)\s*[,}]/, 'a captured console is the pre-TUI one');
  assert.match(line, /log:.*=>\s*console\.error\(/);
});
