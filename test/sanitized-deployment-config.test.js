import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AccountManager } from '../src/account-manager.js';
for (const host of ['europa', 'win11']) {
  test(`${host} example uses supported policy fields and placeholder credentials`, async () => {
    const config = JSON.parse(await readFile(new URL(`../deploy/examples/${host}/teamclaude.json`, import.meta.url), 'utf8'));
    const am = new AccountManager(config.accounts, config.switchThreshold, { routes: config.routes });
    assert.equal(config.proxy.apiKey, 'SET_LOCALLY');
    for (const a of config.accounts) {
      for (const key of ['apiKey', 'accessToken', 'refreshToken']) {
        if (a[key]) assert.equal(a[key], 'SET_LOCALLY');
      }
      assert.equal(a.expiresAt, undefined);
    }
    for (const route of config.routes) {
      for (const name of route.accounts || []) assert.ok(config.accounts.some(a => a.name === name));
    }
    assert.equal(am.accounts.find(a => a.name === 'antigravity').usageDisplay, 'session');
    for (const a of am.accounts.filter(a => a.name.startsWith('deepseek-v4-'))) {
      assert.equal(a.usageDisplay, 'balance');
      assert.equal(a.balanceSource.type, 'deepseek-balance');
      assert.ok(a.balanceSource.tokenFile);
    }
  });
}
