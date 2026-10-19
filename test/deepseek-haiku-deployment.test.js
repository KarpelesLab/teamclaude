import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve(s.address().port)));
const close = s => new Promise(resolve => { s.close(resolve); s.closeAllConnections(); });

for (const host of ['europa', 'win11']) {
  test(`${host}: Haiku 5.5 reaches DeepSeek as a supported model; unknown models never reach it`, async () => {
    const config = JSON.parse(await readFile(new URL(`../deploy/examples/${host}/teamclaude.json`, import.meta.url), 'utf8'));
    const seen = [];
    const upstream = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body); seen.push(input.model);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'test', type: 'message', role: 'assistant', model: input.model,
        content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    const upPort = await listen(upstream);
    const accounts = config.accounts.filter(a => a.name.startsWith('deepseek-v4-')).map(a => ({
      ...a, apiKey: 'test', upstream: `http://127.0.0.1:${upPort}`, disabled: false,
    }));
    const am = new AccountManager(accounts);
    const proxy = createProxyServer(am, { proxy: { apiKey: 'test' } });
    const port = await listen(proxy);
    const send = (name, model) => fetch(`http://127.0.0.1:${port}/tc-acct/${name}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test' },
      body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: 'user', content: 'Reply OK' }] }),
    });
    try {
      for (const account of accounts) {
        for (const model of ['claude-haiku-5-5', 'claude-haiku-5-5[1m]', account.name]) {
          const res = await send(account.name, model);
          assert.equal(res.status, 200); await res.json();
          assert.equal(seen.at(-1), account.name);
        }
        const before = seen.length;
        const rejected = await send(account.name, 'claude-haiku-future');
        assert.equal(rejected.status, 400); await rejected.text();
        assert.equal(seen.length, before, 'unsupported pin is refused before the adapter');
        assert.equal(am._acceptsModel(am.accounts.find(a => a.name === account.name), 'claude-haiku-future'), false);
      }
      assert.equal(am.getActiveAccount(null, 'claude-haiku-future'), null, 'normal selection excludes unsupported DeepSeek requests');
    } finally { await close(proxy); await close(upstream); }
  });
}
