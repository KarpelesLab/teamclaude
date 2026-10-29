// Smoke test of a packaged build: launch the unpacked app, connect over the
// Chrome DevTools protocol, and check that the window rendered, that the
// renderer has no Node APIs, and that the IPC bridge refuses an unknown
// method. The app reads an empty temporary config, so it starts nothing and
// touches no real account.
// Usage: node scripts/smoke.mjs win|linux

/* global fetch, WebSocket, setTimeout */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.argv[2];
const EXECUTABLE = {
  win: join(desktop, 'dist', 'win-unpacked', 'TeamClaude Desktop.exe'),
  linux: join(desktop, 'dist', 'linux-unpacked', 'teamclaude-desktop'),
};
if (!EXECUTABLE[platform]) {
  console.error('usage: node scripts/smoke.mjs win|linux');
  process.exit(2);
}

const PORT = 9555;
const TIMEOUT_MS = 60_000;
const home = mkdtempSync(join(tmpdir(), 'tc-smoke-'));
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${join(home, 'user-data')}`];
if (platform === 'linux') args.push('--no-sandbox');
const app = spawn(EXECUTABLE[platform], args, {
  env: { ...process.env, TEAMCLAUDE_CONFIG: join(home, 'teamclaude.json'), TEAMROUTER_CONFIG: join(home, 'teamclaude.json') },
  stdio: ['ignore', 'inherit', 'inherit'],
});
let exited = null;
app.on('exit', code => { exited = code; });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function page() {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`the app exited early with code ${exited}`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const target = list.find(t => t.type === 'page' && t.url.endsWith('index.html'));
      if (target) return target.webSocketDebuggerUrl;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error('no renderer page appeared');
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onerror = () => reject(new Error('devtools connection failed'));
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      ws.close();
      if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
      else resolve(message.result?.result?.value);
    };
  });
}

const CHECK = `(async () => {
  for (let i = 0; i < 100 && !document.querySelector('nav button, aside button'); i++) await new Promise(r => setTimeout(r, 100));
  let ipc = 'accepted';
  try { await window.teamclaude.call('shell.exec', {}); } catch (e) { ipc = String(e.message); }
  const state = await window.teamclaude.call('backend.getState');
  return {
    title: document.title,
    navButtons: document.querySelectorAll('nav button, aside button').length,
    require: typeof require,
    process: typeof process,
    bridge: Object.keys(window.teamclaude || {}).sort().join(','),
    ipc,
    phase: state.phase,
  };
})()`;

let failed = false;
try {
  const result = await evaluate(await page(), CHECK);
  process.stdout.write(`smoke: ${JSON.stringify(result)}\n`);
  const problems = [];
  if (result.title !== 'TeamClaude Desktop') problems.push(`unexpected title "${result.title}"`);
  if (result.navButtons < 8) problems.push('navigation did not render');
  if (result.require !== 'undefined' || result.process !== 'undefined') problems.push('renderer has Node APIs');
  if (result.bridge !== 'call,onEvent') problems.push(`unexpected bridge API: ${result.bridge}`);
  if (!/unknown method/.test(result.ipc)) problems.push('IPC accepted an unknown method');
  if (problems.length) {
    failed = true;
    console.error(problems.map(p => `FAIL ${p}`).join('\n'));
  } else {
    process.stdout.write('smoke: packaged app OK\n');
  }
} catch (err) {
  failed = true;
  console.error(`FAIL ${err.message}`);
} finally {
  app.kill();
  await sleep(1000);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
process.exit(failed ? 1 : 0);
