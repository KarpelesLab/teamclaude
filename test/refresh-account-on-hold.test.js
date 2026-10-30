import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { refreshAccessToken } from '../src/oauth.js';
import { unavailableLine } from '../src/status-renderer.js';
import { problems } from '../src/dashboard.js';

// A refresh refused because the account is on hold is not a dead token: a
// re-login does not lift it, so status says on hold and where to appeal.

const paint = new Proxy({}, { get: () => (v => String(v)) });
const HOLD = { error: 'invalid_grant', error_description: 'account_on_hold', error_uri: 'https://claude.ai/restricted' };
const HOLD_TEXT = "Your account is on hold and can't use Claude Code. View details or appeal: https://claude.ai/restricted";

async function tokenServer(status, body) {
  const srv = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, endpoint: `http://127.0.0.1:${srv.address().port}/token` };
}

async function refreshError(status, body) {
  const { srv, endpoint } = await tokenServer(status, body);
  try {
    return await refreshAccessToken('r', endpoint).catch((e) => e);
  } finally {
    srv.close();
  }
}

function onHold() {
  const e = /** @type {Error & { status?: number, appealUrl?: string }} */ (new Error(`Token refresh failed (400): ${JSON.stringify(HOLD)}`));
  e.status = 400;
  e.appealUrl = 'https://claude.ai/restricted';
  return e;
}

async function heldManager(refreshFn = async () => { throw onHold(); }) {
  const am = new AccountManager([expiring()], 0.98, { refreshFn });
  await am.ensureTokenFresh(0);
  return am;
}

function expiring() {
  return { name: 'a', type: 'oauth', accessToken: 'at-old', refreshToken: 'rt-a', expiresAt: Date.now() - 1000 };
}

test('refreshAccessToken reports an account on hold with its appeal link', async () => {
  const err = await refreshError(400, HOLD);
  assert.equal(err.status, 400);
  assert.equal(err.appealUrl, 'https://claude.ai/restricted');
});

test('the hold is recognised under access_denied and a 403 as well', async () => {
  const err = await refreshError(403, { ...HOLD, error: 'access_denied' });
  assert.equal(err.appealUrl, 'https://claude.ai/restricted');
});

test('an appeal link off claude.ai or anthropic.com is replaced by the default one', async () => {
  for (const uri of [
    undefined, 'http://claude.ai/restricted', 'https://claude.ai.example.com/x', 'https://user@claude.ai/x',
    'https://claude.ai:8443/x', 'https://claude.ai/x#y', `https://claude.ai/${'a'.repeat(2048)}`,
  ]) {
    const err = await refreshError(400, { ...HOLD, error_uri: uri });
    assert.equal(err.appealUrl, 'https://claude.ai/restricted', String(uri));
  }
  const kept = await refreshError(400, { ...HOLD, error_uri: 'https://support.anthropic.com/appeal' });
  assert.equal(kept.appealUrl, 'https://support.anthropic.com/appeal');
});

test('an ordinary invalid_grant is not a hold', async () => {
  for (const [status, body] of [
    [400, { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' }],
    [400, { error: 'invalid_request', error_description: 'account_on_hold' }],
  ]) {
    const err = await refreshError(status, body);
    assert.equal(err.appealUrl, undefined, JSON.stringify(body));
  }
});

test('a refresh refused for a hold reports account_on_hold with Anthropic\'s text', async () => {
  let calls = 0;
  const am = await heldManager(async () => { calls++; throw onHold(); });
  const row = am.getStatus().accounts[0];
  assert.equal(row.status, 'error');
  assert.equal(row.errorReason.code, 'account_on_hold');
  assert.equal(row.errorReason.detail, HOLD_TEXT);
  assert.equal(row.errorReason.remedy, 'teamclaude login');
  await am.ensureTokenFresh(0, true);
  assert.equal(calls, 1, 'the refused token is not sent again');
  assert.equal(am.getStatus().accounts[0].errorReason.code, 'account_on_hold');
});

test('a re-import that brings back the refused refresh token keeps the hold', async () => {
  const am = await heldManager();
  am.updateAccountTokens(0, { accessToken: 'at-new', refreshToken: 'rt-a', expiresAt: Date.now() + 3600_000 });
  await am.ensureTokenFresh(0, true);
  const row = am.getStatus().accounts[0];
  assert.equal(row.status, 'error');
  assert.equal(row.errorReason.code, 'account_on_hold');
  assert.equal(row.errorReason.detail, HOLD_TEXT);
});

test('status says the account is on hold, not that it needs a re-login', async () => {
  const am = await heldManager();
  const line = unavailableLine(am.getStatus().accounts[0], paint) ?? '';
  assert.match(line, /Your account is on hold and can't use Claude Code\. View details or appeal: https:\/\/claude\.ai\/restricted/);
  assert.doesNotMatch(line, /needs a re-login/);
});

test('status prints a long appeal link whole', async () => {
  const url = `https://support.anthropic.com/appeal?case=${'c'.repeat(200)}`;
  const am = await heldManager(async () => { throw Object.assign(onHold(), { appealUrl: url }); });
  assert.ok((unavailableLine(am.getStatus().accounts[0], paint) ?? '').includes(url));
});

test('the dashboard banner and a switch say upstream refused the account', async () => {
  const am = await heldManager();
  assert.equal(problems(am.getStatus())[0].text, 'Account a was refused by upstream.');
  assert.equal(am.eligibility(0).reason, 'refused by upstream');
});

test('a disabled account on hold reads as disabled', async () => {
  const am = await heldManager();
  am.setDisabled(0, true);
  assert.equal(problems(am.getStatus())[0].text, 'Account a is disabled.');
});
