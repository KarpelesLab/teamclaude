import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionTitles } from '../src/session-titles.js';

const SID = '7fc09547-5aee-43e7-ac7d-a48246fb367a';
const SLUG = '-Volumes-Code-District-district';
const DEFAULT_DIR = join(homedir(), '.claude', 'projects');

// Build a projects directory the way Claude Code lays one out: a transcript
// named after the session id, and a sibling directory of the same name holding
// the rename sidecar.
async function projects({ transcript = null, sidecar = null, slug = SLUG, sid = SID } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-titles-'));
  await mkdir(join(dir, slug), { recursive: true });
  if (transcript != null) await writeFile(join(dir, slug, `${sid}.jsonl`), transcript);
  if (sidecar != null) {
    await mkdir(join(dir, slug, sid), { recursive: true });
    await writeFile(join(dir, slug, sid, 'custom-title.json'), sidecar);
  }
  return dir;
}

const record = (type, key, value, sid = SID) => `${JSON.stringify({ type, [key]: value, sessionId: sid })}\n`;
const customTitle = (v) => record('custom-title', 'customTitle', v);
const aiTitle = (v) => record('ai-title', 'aiTitle', v);
const noise = (n) => `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(n) } })}\n`;

test('reads the rename sidecar', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'adv-review-rewrite' }) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve(SID), 'adv-review-rewrite');
});

test('the sidecar wins over a title record in the transcript', async () => {
  const dir = await projects({
    sidecar: JSON.stringify({ customTitle: 'renamed' }),
    transcript: customTitle('older') + aiTitle('generated'),
  });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve(SID), 'renamed');
});

test('falls back to a custom-title record when there is no sidecar', async () => {
  const dir = await projects({ transcript: aiTitle('generated') + customTitle('typed by hand') });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve(SID), 'typed by hand');
});

test('a custom-title record wins over an ai-title record that follows it', async () => {
  const dir = await projects({ transcript: customTitle('typed by hand') + aiTitle('generated') });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve(SID), 'typed by hand');
});

test('falls back to the generated title when the session was never renamed', async () => {
  const dir = await projects({ transcript: noise(50) + aiTitle('Adversarial review system refactor') });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve(SID), 'Adversarial review system refactor');
});

test('takes the last record when the title changed during the session', async () => {
  const dir = await projects({ transcript: aiTitle('first guess') + noise(100) + aiTitle('second guess') });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve(SID), 'second guess');
});

test('a session with no title records has no title', async () => {
  const dir = await projects({ transcript: noise(200) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve(SID), null);
});

test('an unknown session id has no title and does not throw', async () => {
  const dir = await projects({ transcript: aiTitle('somebody else') });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve('00000000-0000-0000-0000-000000000000'), null);
});

test('a null session id has no title', async () => {
  const dir = await projects({});
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve(null), null);
});

test('only the tail is read, so a title beyond the window is not found', async () => {
  // Measured on 218 real transcripts: the last title record sits within 46 KB
  // of EOF. A title further back than the window belongs to a session that has
  // since written megabytes without one, and is not worth the read.
  const dir = await projects({ transcript: aiTitle('long ago') + noise(4000) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir, tailBytes: 1024 });
  assert.equal(await titles.resolve(SID), null);
});

test('a line cut in half by the tail window does not break the scan', async () => {
  const dir = await projects({ transcript: noise(4000) + aiTitle('after the cut') });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir, tailBytes: 1024 });
  assert.equal(await titles.resolve(SID), 'after the cut');
});

test('a corrupt sidecar falls through to the transcript', async () => {
  const dir = await projects({ sidecar: '{not json', transcript: aiTitle('generated') });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve(SID), 'generated');
});

test('an empty title is treated as no title', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: '   ' }), transcript: aiTitle('generated') });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve(SID), 'generated');
});

test('get() reports nothing until the resolve it schedules completes', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'renamed' }) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(titles.get(SID), null);
  await titles.idle();
  assert.equal(titles.get(SID), 'renamed');
});

test('a resolved title is served from cache while it is fresh', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'renamed' }) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir, ttlMs: 60_000 });
  await titles.resolve(SID);
  await writeFile(join(dir, SLUG, SID, 'custom-title.json'), JSON.stringify({ customTitle: 'renamed again' }));
  assert.equal(titles.get(SID), 'renamed');
  await titles.idle();
  assert.equal(titles.get(SID), 'renamed');
});

test('a stale entry refreshes in the background and keeps serving the old title meanwhile', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'renamed' }) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir, ttlMs: 1000 });
  await titles.resolve(SID, 0);
  await writeFile(join(dir, SLUG, SID, 'custom-title.json'), JSON.stringify({ customTitle: 'renamed again' }));
  assert.equal(titles.get(SID, 5000), 'renamed');
  await titles.idle();
  assert.equal(titles.get(SID, 5000), 'renamed again');
});

test('a session with no title is cached too, so the miss is not re-read every frame', async () => {
  const dir = await projects({ transcript: noise(50) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir, ttlMs: 60_000 });
  await titles.resolve(SID);
  await writeFile(join(dir, SLUG, `${SID}.jsonl`), noise(50) + aiTitle('appeared later'));
  assert.equal(titles.get(SID), null);
  await titles.idle();
  assert.equal(titles.get(SID), null);
});

test('concurrent gets for the same session run one resolve', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'renamed' }) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  titles.get(SID);
  titles.get(SID);
  titles.get(SID);
  assert.equal(titles.pending(), 1);
  await titles.idle();
  assert.equal(titles.get(SID), 'renamed');
});

test('disabled titles never touch the disk', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'renamed' }) });
  const titles = new SessionTitles({ enabled: false, projectsDir: dir });
  assert.equal(titles.get(SID), null);
  assert.equal(titles.pending(), 0);
  assert.equal(await titles.resolve(SID), null);
});

// --- client input ----------------------------------------------------------

// The id is a request header. Only a UUID is looked up, so a path in the
// header cannot walk out of the projects directory.
test('a session id that is not a UUID never reaches the filesystem', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'renamed' }) });
  // A sidecar one level above the projects directory, reachable only by traversal.
  await mkdir(join(dir, '..', 'escaped'), { recursive: true });
  await writeFile(join(dir, '..', 'escaped', 'custom-title.json'), JSON.stringify({ customTitle: 'leaked' }));
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  for (const bad of ['../../escaped', '..\\..\\escaped', `${SID}/..`, `${SID}\0`, SID.toUpperCase().repeat(2), '', 42]) {
    assert.equal(titles.get(bad), null, `get(${JSON.stringify(bad)})`);
    assert.equal(titles.pending(), 0, `pending after get(${JSON.stringify(bad)})`);
    assert.equal(await titles.resolve(bad), null, `resolve(${JSON.stringify(bad)})`);
  }
  assert.equal(titles.cache.size, 0);
  assert.equal(await titles.resolve(SID), 'renamed');
});

test('an upper-case UUID is still a session id', async () => {
  const sid = SID.toUpperCase();
  const dir = await projects({ sid, sidecar: JSON.stringify({ customTitle: 'renamed' }) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve(sid), 'renamed');
});

// A title is printed inside a colour escape and written to the activity log
// file, so it must not carry an escape of its own.
test('control characters in a title become spaces', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'adv\x1b[31m-review\r\nrewrite\x00\x7f\x9b!' }) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve(SID), 'adv [31m-review rewrite !');
});

test('a title made only of control characters is no title', async () => {
  const dir = await projects({ transcript: customTitle('\x1b\x1b\n') + aiTitle('\tgenerated\t') });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve(SID), 'generated');
});

// --- cache bounds ----------------------------------------------------------

test('an entry no row has refreshed within the window is dropped', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'renamed' }) });
  const other = '0b3f8e2a-1c4d-4e5f-8a9b-0c1d2e3f4a5b';
  const titles = new SessionTitles({ enabled: true, projectsDir: dir, ttlMs: 1000, maxAgeMs: 5000 });
  await titles.resolve(SID, 0);
  await titles.resolve(other, 0);
  assert.equal(titles.cache.size, 2);
  // SID stays on screen: get() at t=4s re-reads it, so its entry is refreshed.
  titles.get(SID, 4000);
  await titles.idle();
  // At t=6s the other session has not been asked about since t=0 and is gone.
  titles.get(SID, 6000);
  await titles.idle();
  assert.equal(titles.cache.has(SID), true);
  assert.equal(titles.cache.has(other), false);
});

test('the sweep runs at most once per TTL', () => {
  const titles = new SessionTitles({ enabled: true, projectsDir: '/nonexistent', ttlMs: 1000, maxAgeMs: 5000 });
  titles.cache.set('stale', { title: 'x', at: 0 });
  titles.get(SID, 5000);
  assert.equal(titles.cache.has('stale'), false);
  titles.cache.set('stale', { title: 'x', at: 0 });
  titles.get(SID, 5500);
  assert.equal(titles.cache.has('stale'), true, 'not swept again within the TTL');
  titles.get(SID, 6000);
  assert.equal(titles.cache.has('stale'), false);
});

// --- live configuration ----------------------------------------------------

test('settings() reports what is in force', () => {
  const titles = new SessionTitles({ enabled: true, width: 20 });
  assert.deepEqual(titles.settings(), { enabled: true, width: 20, projectsDir: DEFAULT_DIR });
});

test('configure turns lookups off without a restart', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'renamed' }) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  await titles.resolve(SID);
  titles.configure({ enabled: false });
  assert.equal(titles.get(SID), null);
  assert.equal(titles.pending(), 0);
});

test('configure turns lookups back on and re-reads', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'renamed' }) });
  const titles = new SessionTitles({ enabled: false, projectsDir: dir });
  titles.configure({ enabled: true, projectsDir: dir });
  assert.equal(await titles.resolve(SID), 'renamed');
});

test('configure moves the projects directory and forgets titles read from the old one', async () => {
  const before = await projects({ sidecar: JSON.stringify({ customTitle: 'old' }) });
  const after = await projects({ sidecar: JSON.stringify({ customTitle: 'new' }) });
  const titles = new SessionTitles({ enabled: true, projectsDir: before, ttlMs: 60_000 });
  assert.equal(await titles.resolve(SID), 'old');
  titles.configure({ enabled: true, projectsDir: after });
  assert.equal(titles.get(SID), null);
  assert.equal(await titles.resolve(SID), 'new');
});

test('configure changes the label width', () => {
  const titles = new SessionTitles({ width: 16 });
  titles.configure({ width: 24 });
  assert.equal(titles.width, 24);
});

test('configure with nothing set restores the defaults, which is off', () => {
  const titles = new SessionTitles({ enabled: true, width: 30, projectsDir: '/elsewhere' });
  titles.configure(undefined);
  assert.equal(titles.enabled, false);
  assert.equal(titles.width, 18);
  assert.equal(titles.projectsDir, DEFAULT_DIR);
});

test('a store built without config is off', () => {
  assert.equal(new SessionTitles().enabled, false);
  assert.equal(new SessionTitles(undefined).enabled, false);
});

test('the label is never narrower than the short id it falls back to', () => {
  const titles = new SessionTitles({ width: 2 });
  assert.equal(titles.width, 6);
});

// --- TUI activity column ---------------------------------------------------

const { AccountManager } = await import('../src/account-manager.js');
const { TUI, displayWidth } = await import('../src/tui.js');

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// A TUI wired to a titles store, rendering into a captured buffer instead of
// the terminal.
function tuiFor(titles) {
  const am = new AccountManager([{ name: 'a@b.c', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }]);
  const tui = new TUI({
    accountManager: am,
    config: { proxy: { port: 1 }, accounts: [], routes: [] },
    sx: null,
    saveConfig: async () => {},
    syncAccounts: async () => 0,
    onQuit: () => {},
    probeQuota: () => {},
    sessionTitles: titles,
  });
  tui.render = () => {};
  const frames = [];
  tui._paint = (buf) => frames.push(plain(buf));
  return { tui, frames };
}

function activityRow(frames, needle) {
  const last = frames[frames.length - 1] || '';
  return last.split(/\r?\n|\x1b\[\d+;\d+H/).find((l) => l.includes(needle)) || '';
}

test('an in-flight request shows the session title instead of the hex id', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'adv-review-rewrite' }) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  await titles.resolve(SID);
  const { tui, frames } = tuiFor(titles);
  tui.active.set(1, { method: 'POST', path: '/v1/messages', sessionId: SID, t: '17:42:57', started: Date.now(), account: 'a@b.c' });
  tui._render(true);
  const row = activityRow(frames, '/v1/messages');
  assert.match(row, /adv-review-rewrite/);
  assert.doesNotMatch(row, /7fc095/);
});

test('a session with no known title keeps its hex id', async () => {
  const dir = await projects({ transcript: noise(50) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  await titles.resolve(SID);
  const { tui, frames } = tuiFor(titles);
  tui.active.set(1, { method: 'POST', path: '/v1/messages', sessionId: SID, t: '17:42:57', started: Date.now(), account: 'a@b.c' });
  tui._render(true);
  assert.match(activityRow(frames, '/v1/messages'), /7fc095/);
});

test('the session column is a fixed width whether or not a title is known', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'adv-review-rewrite-that-runs-long' }) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  await titles.resolve(SID);
  const { tui, frames } = tuiFor(titles);
  tui.active.set(1, { method: 'POST', path: '/v1/messages', sessionId: SID, t: '17:42:57', started: Date.now(), account: 'a@b.c' });
  tui.active.set(2, { method: 'POST', path: '/v1/count_tokens', sessionId: null, t: '17:42:58', started: Date.now(), account: 'a@b.c' });
  tui._render(true);
  const named = activityRow(frames, '/v1/messages');
  const anonymous = activityRow(frames, '/v1/count_tokens');
  assert.equal(named.indexOf(' POST '), anonymous.indexOf(' POST '));
});

test('a CJK title takes the same columns as an ASCII one', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: '日本語のセッション名です' }) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  await titles.resolve(SID);
  const { tui, frames } = tuiFor(titles);
  tui.active.set(1, { method: 'POST', path: '/v1/messages', sessionId: SID, t: '17:42:57', started: Date.now(), account: 'a@b.c' });
  tui.active.set(2, { method: 'POST', path: '/v1/count_tokens', sessionId: null, t: '17:42:58', started: Date.now(), account: 'a@b.c' });
  tui._render(true);
  const named = activityRow(frames, '/v1/messages');
  const anonymous = activityRow(frames, '/v1/count_tokens');
  // Nine double-width glyphs fill the 18-column label; the tenth is cut, not split.
  assert.match(named, /日本語のセッション /);
  assert.doesNotMatch(named, /名/);
  assert.equal(displayWidth(named.slice(0, named.indexOf(' POST '))), displayWidth(anonymous.slice(0, anonymous.indexOf(' POST '))));
});

test('a completed request is logged under its session title', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'emmy-merge' }) });
  const titles = new SessionTitles({ enabled: true, projectsDir: dir });
  await titles.resolve(SID);
  const { tui } = tuiFor(titles);
  tui.onRequestEnd(1, { method: 'POST', path: '/v1/messages', account: 'a@b.c', status: 200, sessionId: SID });
  assert.match(plain(tui.log[0].msg), /emmy-merge/);
});

test('the TUI renders without a titles store', () => {
  const { tui, frames } = tuiFor(undefined);
  tui.active.set(1, { method: 'POST', path: '/v1/messages', sessionId: SID, t: '17:42:57', started: Date.now(), account: 'a@b.c' });
  tui._render(true);
  assert.match(activityRow(frames, '/v1/messages'), /7fc095/);
});

// --- attach mode -----------------------------------------------------------

const { createAttachSession, RemoteControl } = await import('../src/tui-remote.js');

test('attach mode names its message log from the same on-disk titles', async () => {
  const dir = await projects({ sidecar: JSON.stringify({ customTitle: 'emmy-merge' }) });
  const session = createAttachSession({
    control: new RemoteControl({ port: 1, apiKey: 'k' }),
    config: { proxy: { port: 1 }, sessionTitles: { enabled: true, width: 16, projectsDir: dir } },
    onQuit: () => {},
  });
  session.stop();
  session.tui.render = () => {};
  await session.tui.sessionTitles.resolve(SID);
  session.tui.onRequestEnd(1, { method: 'POST', path: '/v1/messages', account: 'a@b.c', status: 200, sessionId: SID });
  assert.match(plain(session.tui.log[0].msg), /emmy-merge/);
});

// --- settings screen -------------------------------------------------------

// The settings screen is driven by a shared config object the server reads
// live, so a toggle must change the store AND persist, not one or the other.
function settingsTui({ enabled = true } = {}) {
  const dir = '/nonexistent-projects';
  const saved = [];
  const am = {
    accounts: [{ name: 'a', index: 0, type: 'oauth', credential: 't' }],
    currentIndex: 0,
    switchThreshold: 0.98,
    getRoutes() { return []; },
  };
  const config = {
    proxy: { port: 1 }, accounts: [{ name: 'a', type: 'oauth' }], routes: [], blockedModels: [],
    sessionTitles: { enabled, width: 18, projectsDir: dir },
  };
  const titles = new SessionTitles(config.sessionTitles);
  const tui = new TUI({
    accountManager: am, config, sx: null, sessionTitles: titles,
    saveConfig: async (c) => { saved.push({ ...c.sessionTitles }); },
    syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  return { tui, titles, config, saved };
}

const field = (tui) => tui._settingsFields().find((f) => f.id === 'sessionTitles');

test('settings: the session-titles row reports the state in force', () => {
  assert.match(plain(field(settingsTui({ enabled: true }).tui).value()), /on/);
  assert.match(plain(field(settingsTui({ enabled: false }).tui).value()), /off/);
});

test('settings: toggling stops the lookups without a restart', async () => {
  const { tui, titles } = settingsTui({ enabled: true });
  await field(tui).right();
  assert.equal(titles.enabled, false);
  assert.match(plain(field(tui).value()), /off/);
});

test('settings: toggling persists the change', async () => {
  const { tui, saved } = settingsTui({ enabled: true });
  await field(tui).right();
  assert.deepEqual(saved.at(-1)?.enabled, false);
});

test('settings: toggling back turns the lookups on again', async () => {
  const { tui, titles } = settingsTui({ enabled: false });
  await field(tui).enter();
  assert.equal(titles.enabled, true);
  assert.match(plain(field(tui).value()), /on/);
});

test('settings: the toggle keeps the configured width and projects directory', async () => {
  const { tui, titles, config, saved } = settingsTui({ enabled: true });
  config.sessionTitles.width = 24;
  await field(tui).right();
  await field(tui).right();
  assert.equal(titles.enabled, true);
  assert.equal(titles.width, 24);
  assert.equal(titles.projectsDir, '/nonexistent-projects');
  assert.deepEqual(saved.at(-1), { enabled: true, width: 24, projectsDir: '/nonexistent-projects' });
});
