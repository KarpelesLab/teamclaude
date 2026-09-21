import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `teamclaude routing` and `login --routing` drive the real CLI as a subprocess
// against a throwaway TEAMCLAUDE_CONFIG, so the user's real config is never
// touched. The port here is one nothing listens on: both commands notify a
// running server after a write, and that notification has to be a no-op for
// the test to be about the config file.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function writeConfig(accounts) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-routing-'));
  const path = join(dir, 'config.json');
  const config = {
    proxy: { port: 3, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    accounts,
  };
  await writeFile(path, JSON.stringify(config));
  return path;
}

function runCli(configPath, cliArgs, { stdin } = {}) {
  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  if (stdin != null) child.stdin.write(stdin);
  child.stdin.end();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not exit')); }, 10_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const readAccounts = async (configPath) => JSON.parse(await readFile(configPath, 'utf8')).accounts;

// ── teamclaude routing ───────────────────────────────────────

test('routing with no account prints usage and fails', async () => {
  const configPath = await writeConfig([{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }]);
  const res = await runCli(configPath, ['routing']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Usage: teamclaude routing/);
});

test('routing <name> shows the fleet path when the account has none', async () => {
  const configPath = await writeConfig([{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }]);
  const res = await runCli(configPath, ['routing', 'a@example.com']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /a@example\.com: no routing — the account uses the fleet egress/);
});

test('routing <name> <url> stores the canonical URL and shows it masked', async () => {
  const configPath = await writeConfig([{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }]);

  const set = await runCli(configPath, ['routing', 'a@example.com', 'socks5h://alice:s3cret@proxy.example.com:1080']);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /Routing "a@example\.com" via socks5h:\/\/alice:\*\*\*@proxy\.example\.com:1080/);
  assert.doesNotMatch(set.stdout, /s3cret/, 'the password never reaches the screen');

  const [acct] = await readAccounts(configPath);
  assert.equal(acct.routing, 'socks5h://alice:s3cret@proxy.example.com:1080', 'stored canonical, credentials intact');

  const show = await runCli(configPath, ['routing', 'a@example.com']);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /a@example\.com: socks5h:\/\/alice:\*\*\*@proxy\.example\.com:1080/);
  assert.doesNotMatch(show.stdout, /s3cret/);
});

test('routing <name> none clears the field', async () => {
  const configPath = await writeConfig([
    { name: 'a@example.com', type: 'apikey', apiKey: 'k1', routing: 'socks5://proxy.example.com:1080' },
  ]);
  const res = await runCli(configPath, ['routing', 'a@example.com', 'none']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Cleared routing for "a@example\.com"/);
  const [acct] = await readAccounts(configPath);
  assert.equal(acct.routing, undefined, 'the key is gone, not null');
});

test('routing <name> <bad-url> fails and changes nothing', async () => {
  const configPath = await writeConfig([{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }]);
  const res = await runCli(configPath, ['routing', 'a@example.com', 'https://proxy.example.com:3128']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /unsupported routing protocol "https"/);
  const [acct] = await readAccounts(configPath);
  assert.equal(acct.routing, undefined);
});

test('routing <name> with a bare host:port stores http and the default port', async () => {
  const configPath = await writeConfig([{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }]);
  const res = await runCli(configPath, ['routing', 'a@example.com', 'proxy.example.com:3128']);
  assert.equal(res.code, 0, res.stderr);
  const [acct] = await readAccounts(configPath);
  assert.equal(acct.routing, 'http://proxy.example.com:3128');
});

test('routing for an unknown account fails', async () => {
  const configPath = await writeConfig([{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }]);
  const res = await runCli(configPath, ['routing', 'nobody@example.com', 'proxy.example.com:3128']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Account "nobody@example\.com" not found/);
});

// ── login --api --routing ────────────────────────────────────

test('login --api --routing stores the routing on the new account', async () => {
  const configPath = await writeConfig([]);
  const res = await runCli(configPath,
    ['login', '--api', '--name', 'routed@example.com', '--routing', 'socks5h://alice:s3cret@proxy.example.com:1080'],
    { stdin: 'sk-ant-test\n' });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /routed via socks5h:\/\/alice:\*\*\*@proxy\.example\.com:1080/);
  const accounts = await readAccounts(configPath);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].routing, 'socks5h://alice:s3cret@proxy.example.com:1080');
});

test('login --api without --routing stores no routing key', async () => {
  const configPath = await writeConfig([]);
  const res = await runCli(configPath, ['login', '--api', '--name', 'plain@example.com'], { stdin: 'sk-ant-test\n' });
  assert.equal(res.code, 0, res.stderr);
  const [acct] = await readAccounts(configPath);
  assert.equal('routing' in acct, false);
});

test('login --api --routing with an invalid URL refuses before prompting', async () => {
  const configPath = await writeConfig([]);
  const res = await runCli(configPath, ['login', '--api', '--routing', 'https://proxy.example.com:3128'], { stdin: 'sk-ant-test\n' });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Invalid --routing value:.*unsupported routing protocol/);
  const accounts = await readAccounts(configPath);
  assert.equal(accounts.length, 0, 'no half-added account');
});

// ── teamclaude api ───────────────────────────────────────────

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// No-auth SOCKS5 relay that records each CONNECT target.
function startSocks5(connects) {
  return net.createServer((client) => {
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    client.on('error', () => {});
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
        if (buf.length < 10) return;
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
  });
}

test('api sends the account\'s credential through that account\'s routing, and only that account\'s', async () => {
  const seen = [];
  const origin = http.createServer((req, res) => {
    seen.push(req.headers['x-api-key']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const originPort = await listen(origin);
  const connects = [];
  const socks = startSocks5(connects);
  const socksPort = await listen(socks);
  try {
    const configPath = await writeConfig([
      { name: 'routed', type: 'apikey', apiKey: 'sk-routed', routing: `socks5://alice:s3cret@127.0.0.1:${socksPort}` },
      { name: 'direct', type: 'apikey', apiKey: 'sk-direct' },
    ]);
    const url = `http://127.0.0.1:${originPort}/v1/models`;

    const routed = await runCli(configPath, ['api', url, '--account', 'routed']);
    assert.equal(routed.code, 0, routed.stderr);
    assert.deepEqual(JSON.parse(routed.stdout), { ok: true });
    assert.deepEqual(connects, [`127.0.0.1:${originPort}`], 'the call left through the account\'s proxy');
    assert.match(routed.stderr, /^\(via socks5:\/\/alice:\*\*\*@127\.0\.0\.1:\d+\)$/m, 'it says so, password masked');
    // The node:http path has no Response of its own; the status line must still read properly.
    assert.match(routed.stderr, /^200 OK$/m, routed.stderr);

    const direct = await runCli(configPath, ['api', url, '--account', 'direct']);
    assert.equal(direct.code, 0, direct.stderr);
    assert.equal(connects.length, 1, 'an account without routing does not touch the proxy');
    assert.equal(/via socks5/.test(direct.stderr), false);
    assert.deepEqual(seen, ['sk-routed', 'sk-direct']);
  } finally {
    origin.close(); socks.close();
    origin.closeAllConnections?.();
  }
});
