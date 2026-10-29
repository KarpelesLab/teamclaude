// Records a real service-addition and routing walkthrough from the built app (`npm run build`
// first). The window is never shown: it starts minimized and frames come from
// the renderer over CDP. Placeholder API-key accounts, an upstream on port 1
// that never listens and quota readings seeded through the backend's own state
// file, so nothing leaves the machine and no real account appears. Notifications
// and updates are off. Needs ffmpeg on PATH.
//
//   node scripts/capture-demo.mjs --discover
//   node scripts/capture-demo.mjs --rehearse
//   node scripts/capture-demo.mjs [out.gif]

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron } from 'playwright-core';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? join(desktop, '..', 'docs', 'assets', 'desktop-demo.gif'));
const WIDTH = 1280;
const HEIGHT = 720;
const DISCOVER = process.argv.includes('--discover');
const REHEARSE = process.argv.includes('--rehearse');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function freePort() {
  return new Promise((done, fail) => {
    const server = http.createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** One account's saved quota, as exportQuotaState writes it. */
function saved(name, now, { fiveHour, weekly, fiveHourResetIn, weeklyResetIn, weeklySeenAgo = 2 * MIN }) {
  return {
    name,
    provider: 'anthropic',
    profile: {},
    quota: {
      unified5h: fiveHour,
      unified5hReset: now + fiveHourResetIn,
      unified5hSeenAt: now - 2 * MIN,
      unified7d: weekly,
      unified7dReset: now + weeklyResetIn,
      unified7dSeenAt: now - weeklySeenAgo,
    },
  };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'tc-desktop-demo-'));
  let service;
  try {
    service = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      assert.equal(req.url, '/anthropic/v1/messages');
      assert.equal(req.headers['x-api-key'], 'demo-key-not-real-service');
      assert.equal(JSON.parse(body).model, 'demo/claude-sonnet');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'Hi' }] }));
    });
    await new Promise(done => service.listen(0, '127.0.0.1', done));
    const serviceUrl = `http://127.0.0.1:${service.address().port}/anthropic`;
    const port = await freePort();
    const now = Date.now();
    const configPath = join(dir, 'teamclaude.json');
    const accounts = ['work@example.com', 'personal@example.com', 'backup@example.com'];
    writeFileSync(configPath, JSON.stringify({
      proxy: { host: '127.0.0.1', port },
      upstream: 'http://127.0.0.1:1',
      accounts: accounts.map((name, i) => ({ name, type: 'apikey', apiKey: `demo-key-not-real-${i}`, priority: i === 2 ? 1 : 0 })),
    }, null, 2));
    writeFileSync(join(dir, 'teamclaude.state.json'), JSON.stringify({
      quota: [
        saved(accounts[0], now, { fiveHour: 0.62, weekly: 0.41, fiveHourResetIn: 2 * HOUR + 14 * MIN, weeklyResetIn: 3 * DAY + 5 * HOUR }),
        saved(accounts[1], now, { fiveHour: 0.18, weekly: 0.73, fiveHourResetIn: 4 * HOUR + 2 * MIN, weeklyResetIn: 1 * DAY + 9 * HOUR }),
        // An idle account whose weekly reading is days old: drawn as a floor.
        saved(accounts[2], now, { fiveHour: 0.05, weekly: 0.2, fiveHourResetIn: 3 * HOUR, weeklyResetIn: 5 * DAY, weeklySeenAgo: 2 * DAY }),
      ],
    }));

    const userData = join(dir, 'user-data');
    mkdirSync(userData);
    const off = { proxyCrashed: false, authExpired: false, allUnavailable: false, quotaExhausted: false, backendRecovered: false, updateAvailable: false, appUpdateReady: false };
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({
      language: 'en', theme: 'dark', autoUpdateCore: false, startMinimized: true, startProxyOnLaunch: true, autoUpdate: false, notifications: off,
    }));

    // An occluded window stops painting; this one sits off every monitor.
    const args = [desktop, `--user-data-dir=${userData}`, '--disable-features=CalculateNativeWinOcclusion'];
    if (process.platform === 'linux') args.push('--no-sandbox');
    const app = await _electron.launch({
      executablePath: electronPath,
      args,
      env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMROUTER_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    });
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(15_000);
      // A hidden window does not paint, so it is shown where no screen is:
      // off every monitor, without focus or a taskbar button.
      await app.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setSkipTaskbar(true);
        win.webContents.setBackgroundThrottling(false);
        win.setBounds({ x: -20000, y: -20000, width: size.width, height: size.height });
        win.showInactive();
        win.setBounds({ x: -20000, y: -20000, width: size.width, height: size.height });
      }, { width: WIDTH, height: HEIGHT });
      // Wait until the managed proxy answers and its accounts are drawn.
      await page.getByText('work@example.com').first().waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1500);

      const nav = name => page.getByRole('button', { name, exact: true }).first();
      await nav('Accounts').click();
      await page.getByRole('button', { name: 'Third-party service', exact: true }).click();
      // Discover the real controls before rehearsing or recording a scenario.
      if (DISCOVER) {
        process.stdout.write(JSON.stringify(await page.locator('input,select,textarea,button').evaluateAll(els => els.filter(el => el.offsetParent !== null).map(el => ({ tag: el.tagName, type: el.type, text: el.textContent?.trim().slice(0, 70), placeholder: el.placeholder }))), null, 2) + '\n');
        await page.screenshot({ path: join(desktop, 'build', 'demo-discovery.png') });
        return;
      }
      for (const label of ['Service name', 'API base URL']) { process.stdout.write(`Check ${label}\n`); await page.getByLabel(label, { exact: true }).waitFor({ state: 'visible' }); }
      await page.getByLabel(/^Authentication/).waitFor();
      assert.ok(await page.getByLabel(/^Models/).isVisible());
      await nav('Overview').click();
      // Cursor and captions belong only to this isolated recording window.
      await page.evaluate(() => {
        const cursor = globalThis.document.createElement('div'); cursor.id = 'demo-cursor';
        cursor.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 3L19 12L12 13L9 20Z" fill="white" stroke="black" stroke-width="1.5"/></svg>';
        cursor.style.cssText = 'position:fixed;left:500px;top:300px;z-index:999999;pointer-events:none';
        globalThis.document.body.append(cursor);
        globalThis.document.addEventListener('mousemove', e => { cursor.style.left = `${e.clientX}px`; cursor.style.top = `${e.clientY}px`; });
        const caption = globalThis.document.createElement('div'); caption.id = 'demo-caption';
        caption.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:999998;background:#10141fee;color:white;text-align:center;padding:10px;font:14px Segoe UI;pointer-events:none;border-top:1px solid #354055';
        globalThis.document.body.append(caption);
      });
      const pause = ms => page.waitForTimeout(REHEARSE ? 30 : ms);
      const caption = async text => { process.stdout.write(`${text}\n`); await page.locator('#demo-caption').evaluate((el, text) => { el.textContent = text; }, text); await pause(800); };
      const click = async locator => {
        await locator.scrollIntoViewIfNeeded();
        assert.ok(await locator.isVisible());
        const box = await locator.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
        await pause(250); await locator.click();
        if (await locator.evaluate(el => !!el.closest('nav'))) await page.locator('main').evaluate(el => el.scrollTo({ top: 0, behavior: 'smooth' }));
        await pause(700);
      };
      const type = async (locator, text) => {
        await click(locator); await locator.fill(''); await locator.pressSequentially(text, { delay: REHEARSE ? 0 : 22 }); await pause(300);
      };
      const frames = join(dir, 'frames'); mkdirSync(frames);
      let recording = !REHEARSE;
      let frame = 0;
      const capture = async () => {
        while (recording) {
          const start = Date.now();
          await page.screenshot({ path: join(frames, `${String(frame++).padStart(5, '0')}.png`) });
          await sleep(Math.max(0, 125 - (Date.now() - start)));
        }
      };
      const captured = capture();
      try {
        await caption('1 · Live account quotas — isolated demo profile'); await pause(1800);
        await click(nav('Accounts'));
        await caption('2 · Add any Anthropic-compatible API service');
        await click(page.getByRole('button', { name: 'Third-party service', exact: true }));
        await type(page.getByLabel('Service name', { exact: true }), 'Local Claude demo');
        await type(page.getByLabel('API base URL', { exact: true }), serviceUrl);
        await type(page.getByLabel(/^API key/), 'demo-key-not-real-service');
        await type(page.getByLabel(/^Models/), 'claude-sonnet-4-6 = demo/claude-sonnet');
        await caption('3 · Test a model before saving — local fixture API');
        await click(page.getByRole('button', { name: 'Test connection', exact: true }));
        await page.getByText('Connection verified: the model answered.', { exact: true }).waitFor(); await pause(1700);
        await click(page.getByRole('button', { name: 'Add service', exact: true }));
        await page.getByRole('heading', { name: 'Local Claude demo', exact: true }).waitFor();
        const account = JSON.parse(readFileSync(configPath, 'utf8')).accounts.find(a => a.name === 'Local Claude demo');
        assert.equal(account.upstream, serviceUrl); assert.deepEqual(account.modelMap, { 'claude-sonnet-4-6': 'demo/claude-sonnet' });
        await page.getByRole('heading', { name: 'Local Claude demo', exact: true }).scrollIntoViewIfNeeded(); await pause(1300);
        await caption('4 · Change routing without editing a config file');
        await click(nav('Routing'));
        await click(page.getByRole('button', { name: 'Adaptive', exact: true }));
        await page.getByText('Settings applied successfully.', { exact: false }).first().waitFor(); await pause(1700);
        await caption('5 · Nine languages, including Russian');
        await click(nav('Settings'));
        await page.getByLabel('Language', { exact: false }).selectOption('ru'); await pause(1300);
        await click(nav('Маршрутизация'));
        await page.getByText('Настройки успешно применены.', { exact: false }).first().waitFor();
        await pause(2000);
        await page.screenshot({ path: join(desktop, 'build', 'demo-final.png') });
      } finally { recording = false; await captured; }
      if (REHEARSE) { process.stdout.write('Rehearsal passed: service tested, saved and reloaded; Russian UI verified.\n'); return; }
      mkdirSync(dirname(out), { recursive: true });
      execFileSync('ffmpeg', ['-y', '-framerate', '8', '-i', join(frames, '%05d.png'), '-filter_complex', '[0:v]scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none', '-loop', '0', out], { stdio: 'ignore' });
      process.stdout.write(`Wrote ${out} (${frame} frames)\n`);
    } catch (err) {
      const p = await app.firstWindow();
      await p.screenshot({ path: join(desktop, 'build', 'demo-error.png') });
      process.stdout.write(await p.locator('main').innerText());
      throw err;
    } finally {
      await app.close();
    }
  } finally {
    if (service) await new Promise(done => service.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
