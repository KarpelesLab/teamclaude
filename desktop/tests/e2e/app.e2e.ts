// The built app end to end: Electron main process, renderer, IPC and the real
// backend from ../src. Placeholder API-key accounts and an upstream on port 1,
// which never listens, so nothing leaves the machine and no real account is
// touched. Every effect is checked against the backend's own status endpoint,
// not only against what the window shows.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import electronPath from 'electron';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DesktopApi } from '../../src/shared/ipc';

const desktop = resolve(__dirname, '..', '..');
const FAKE_KEY = 'test-key-not-real';

let dir: string;
let port: number;
let app: ElectronApplication;
let page: Page;

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = http.createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port: p } = server.address() as AddressInfo;
      server.close(() => done(p));
    });
  });
}

interface Status {
  accounts: Array<{ name: string; provider: string; disabled: boolean }>;
  switchThreshold: number;
  sessions: { mode: string };
}

async function status(): Promise<Status> {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
  return res.json() as Promise<Status>;
}

/** Polls the backend until `check` holds; the UI acts through it, so this is the real outcome. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  for (;;) {
    const value = await read().catch(() => null);
    if (value !== null && check(value)) return value;
    await new Promise(r => setTimeout(r, 250));
  }
}

const nav = (name: string) => page.getByRole('button', { name, exact: true }).first().click();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tc-desktop-e2e-'));
  port = await freePort();
  const configPath = join(dir, 'teamclaude.json');
  writeFileSync(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port },
    upstream: 'http://127.0.0.1:1',
    accounts: [
      { name: 'placeholder-a', type: 'apikey', apiKey: `${FAKE_KEY}-aaaa` },
      { name: 'placeholder-b', type: 'apikey', apiKey: `${FAKE_KEY}-bbbb`, priority: 1 },
    ],
  }, null, 2));
  const userData = join(dir, 'user-data');
  mkdirSync(userData);
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ language: 'en' }));

  const args = [desktop, `--user-data-dir=${userData}`];
  if (process.platform === 'linux') args.push('--no-sandbox');
  app = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args,
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMROUTER_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
  });
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Overview', exact: true }).first().waitFor();
});

afterAll(async () => {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

describe('TeamClaude Desktop', () => {
  it('renders with no Node APIs in the page', async () => {
    expect(await page.title()).toBe('TeamClaude Desktop');
    expect(await page.evaluate(() => [typeof (globalThis as { require?: unknown }).require, typeof (globalThis as { process?: unknown }).process])).toEqual(['undefined', 'undefined']);
  });

  it('starts the bundled backend from the Overview page', async () => {
    await nav('Overview');
    await page.getByRole('button', { name: 'Start', exact: true }).first().click();
    const s = await eventually(status, v => v.accounts.length === 2);
    expect(s.accounts.map(a => a.name).sort()).toEqual(['placeholder-a', 'placeholder-b']);
    await page.getByText('Running').first().waitFor();
  });

  it('takes an account out of rotation from the Accounts page', async () => {
    // Ctrl+2 is the second sidebar entry.
    await page.keyboard.press('Control+2');
    await page.getByRole('button', { name: 'Accounts', exact: true }).and(page.locator('[aria-current="page"]')).waitFor();
    const card = page.getByRole('heading', { name: 'placeholder-b', exact: true }).locator('xpath=ancestor::*[.//input[@role="switch"]][1]');
    // A controlled switch: it flips once the backend has answered, so the
    // outcome is read from the backend, not from the click.
    await card.getByRole('switch').first().click({ force: true });
    const s = await eventually(status, v => v.accounts.find(a => a.name === 'placeholder-b')?.disabled === true);
    expect(s.accounts.find(a => a.name === 'placeholder-a')?.disabled).toBe(false);
  });

  it('sets the switch threshold from the Routing page', async () => {
    await nav('Routing');
    const field = page.getByLabel('Percent (1–100)');
    await field.fill('80');
    await field.locator('xpath=ancestor::form[1]').getByRole('button', { name: 'Apply', exact: true }).click();
    await eventually(status, v => Math.abs(v.switchThreshold - 0.8) < 1e-9);
  });

  it('switches session distribution to the load mode', async () => {
    await nav('Routing');
    await page.getByRole('button', { name: 'By load', exact: true }).click();
    await eventually(status, v => v.sessions.mode === 'load');
    // The column the mode places by is shown, one count per account.
    await page.getByRole('columnheader', { name: 'Requests, 10 min' }).waitFor();
  });

  it('keeps the activity timeline across a window reload', async () => {
    await nav('Activity');
    const entry = page.getByText(/"placeholder-b":/).first();
    await entry.waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Activity', exact: true }).first().waitFor();
    await nav('Activity');
    await page.getByText(/"placeholder-b":/).first().waitFor();
  });

  it('adds a third-party service, tests its model and saves the backend configuration', async () => {
    let requests = 0;
    const service = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      expect(req.url).toBe('/anthropic/v1/messages');
      expect(req.headers['x-api-key']).toBe('demo-service-key');
      expect(JSON.parse(body)).toMatchObject({ model: 'vendor/sonnet', max_tokens: 1 });
      requests++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'Hi' }] }));
    });
    await new Promise<void>(done => service.listen(0, '127.0.0.1', done));
    try {
      await nav('Accounts');
      await page.getByRole('button', { name: 'Anthropic API key', exact: true }).click();
      const keyBox = await page.getByLabel(/^API key/).boundingBox();
      const priorityBox = await page.getByLabel(/^Priority/).boundingBox();
      expect(Math.abs(keyBox!.y - priorityBox!.y)).toBeLessThan(1);
      await page.getByRole('button', { name: 'Third-party service', exact: true }).click();
      await page.getByLabel('Service name', { exact: true }).fill('demo-service');
      const address = service.address() as AddressInfo;
      const upstream = `http://127.0.0.1:${address.port}/anthropic`;
      await page.getByLabel('API base URL', { exact: true }).fill(upstream);
      await page.getByLabel(/^API key/).last().fill('demo-service-key');
      await page.getByLabel(/^Models/).fill('claude-sonnet-4-6 = vendor/sonnet');
      await page.getByRole('button', { name: 'Test connection', exact: true }).click();
      await page.getByText('Connection verified: the model answered.', { exact: true }).waitFor();
      expect(requests).toBe(1);
      await page.getByRole('button', { name: 'Add service', exact: true }).click();
      await eventually(status, s => s.accounts.some(a => a.name === 'demo-service'));
      const config = JSON.parse(readFileSync(join(dir, 'teamclaude.json'), 'utf8'));
      expect(config.accounts.find((a: { name: string }) => a.name === 'demo-service')).toMatchObject({ upstream, apiKey: 'demo-service-key', priority: 100, modelMap: { 'claude-sonnet-4-6': 'vendor/sonnet' } });
    } finally { await new Promise<void>(done => service.close(() => done())); }
  });

  it('exports diagnostics without names or keys', async () => {
    const report = join(dir, 'diagnostics.md');
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
    }, report);
    await nav('Settings');
    await page.getByRole('button', { name: 'Export diagnostics', exact: true }).first().click();
    const text = await eventually(async () => readFileSync(report, 'utf8'), v => v.length > 0);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain('placeholder-a');
    expect(text).not.toContain('placeholder-b');
  });

  it('removes only the selected provider when Claude and Codex share an email', async () => {
    const path = join(dir, 'teamclaude.json');
    const email = 'same@example.com';
    const addPair = async () => {
      const config = JSON.parse(readFileSync(path, 'utf8'));
      config.accounts = config.accounts.filter((a: { name: string }) => a.name !== email);
      config.accounts.push(
        { name: email, type: 'apikey', apiKey: `${FAKE_KEY}-claude`, orgName: 'Example Org' },
        { name: email, type: 'apikey', provider: 'codex', apiKey: `${FAKE_KEY}-codex` },
      );
      writeFileSync(path, JSON.stringify(config));
      await page.evaluate(() => (window as unknown as { teamclaude: DesktopApi }).teamclaude.call('backend.reload'));
      await eventually(status, s => s.accounts.filter(a => a.name === email).length === 2);
    };
    for (const provider of ['codex', 'anthropic']) {
      await addPair();
      await nav('Accounts');
      const group = page.getByRole('region', { name: `${provider} accounts`, exact: true });
      const card = group.getByRole('article', { name: `Account ${email}`, exact: true });
      await card.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Remove account', exact: true }).click();
      const s = await eventually(status, s => s.accounts.filter(a => a.name === email).length === 1);
      expect(s.accounts.find(a => a.name === email)?.provider).toBe(provider === 'codex' ? 'anthropic' : 'codex');
      const disk = JSON.parse(readFileSync(path, 'utf8'));
      const survivor = disk.accounts.filter((a: { name: string }) => a.name === email);
      expect(survivor).toHaveLength(1);
      expect(survivor[0].apiKey).toBe(`${FAKE_KEY}-${provider === 'codex' ? 'claude' : 'codex'}`);
    }
  });

  it('stops the backend it started when the app quits', async () => {
    await app.close();
    await eventually(async () => fetch(`http://127.0.0.1:${port}/teamclaude/status`).then(() => false, () => true), gone => gone);
  });
});
