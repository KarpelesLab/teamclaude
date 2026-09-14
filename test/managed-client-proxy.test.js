import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, relayUpgrade } from '../src/server.js';

const KEY = 'test-proxy-key-never-an-upstream-token';
function credential(id = 'identity-a', key = KEY) {
  const payload = `tc-managed-v1.${Buffer.from(id).toString('base64url')}`;
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

async function fixture(t, options = {}) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, auth: req.headers.authorization, apiKey: req.headers['x-api-key'], body: Buffer.concat(chunks).toString() });
    res.writeHead(typeof options.upstreamStatus === 'function' ? options.upstreamStatus(req, seen) : options.upstreamStatus || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const accounts = ['a', 'b'].map((name) => ({
    id: `identity-${name}`, name, type: 'oauth', provider: 'anthropic',
    accountUuid: `user-${name}`, orgUuid: `org-${name}`,
    accessToken: `upstream-${name}`, refreshToken: `refresh-${name}`,
    expiresAt: Date.now() + 3600_000,
  }));
  const am = new AccountManager(accounts, 0.98, { refreshFn: options.refreshFn });
  const config = { accounts, proxy: { port: 0, apiKey: KEY, managedClientAuth: true }, upstream: `http://127.0.0.1:${upstream.address().port}` };
  const proxy = createProxyServer(am, config);
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const request = async (path, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}${path}`, {
      ...init, headers: { authorization: `Bearer ${credential()}`, ...init.headers },
    });
    return { status: response.status, body: await response.json() };
  };
  const upgrade = (token = credential()) => new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1',port:proxy.address().port,path:'/v1/session_ingress/ws/test',headers:{connection:'Upgrade',upgrade:'websocket',authorization:`Bearer ${token}`}},res=>{
      res.resume(); res.on('end',()=>resolve(res.statusCode));
    });
    req.on('error',reject);req.end();
  });
  return { am, config, seen, request, upgrade };
}

test('managed identity keeps its launch account while inference rotates', async (t) => {
  const { am, seen, request } = await fixture(t);
  am.accounts[0].quota.unified7d = 1;
  am.accounts[0].quota.unified7dReset = Date.now() + 3600_000;
  for (const path of ['/api/oauth/profile', '/api/oauth/usage', '/api/oauth/files/abc', '/v1/code/sessions', '/%61pi/oauth/profile', '/api/oauth%2fprofile', '/tc-acct/b/api/oauth/profile']) {
    assert.equal((await request(path)).status, 200);
    assert.equal(seen.at(-1).auth, 'Bearer upstream-a', path);
  }
  assert.equal((await request('/v1/messages', { method: 'POST', body: JSON.stringify({model:'claude-sonnet-4',max_tokens:1,messages:[]}) })).status, 200);
  assert.equal(seen.at(-1).auth, 'Bearer upstream-b');
  assert.equal(seen.some(x => x.auth?.includes('tc-managed-v1')), false);
});

test('same managed session survives pool refresh; concurrent identity reads coalesce', async (t) => {
  let refreshes = 0;
  const { am, seen, request } = await fixture(t, { refreshFn: async () => {
    refreshes++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return {accessToken:'upstream-rotated',refreshToken:'refresh-rotated',expiresAt:Date.now()+3600_000};
  } });
  assert.equal((await request('/api/oauth/profile')).status, 200);
  assert.equal(seen.at(-1).auth, 'Bearer upstream-a');
  am.accounts[0].expiresAt = 1;
  const results = await Promise.all(Array.from({length:4}, () => request('/api/oauth/profile')));
  assert.equal(results.every(x=>x.status===200),true);
  assert.equal(refreshes,1);
  assert.equal(seen.slice(1).every(x=>x.auth==='Bearer upstream-rotated'),true);
  assert.equal((await request('/v1/messages', {method:'POST',body:'{}'})).status,200);
  assert.equal(seen.at(-1).auth,'Bearer upstream-rotated');
});

test('identity 401 refreshes and retries safely without sending a login error to Claude',async(t)=>{
  let refreshes=0;
  const {request,seen}=await fixture(t,{
    upstreamStatus:req=>req.headers.authorization==='Bearer upstream-a'?401:200,
    refreshFn:async()=>{refreshes++;return {accessToken:'upstream-new',refreshToken:'new-refresh',expiresAt:Date.now()+3600_000};},
  });
  assert.equal((await request('/api/oauth/profile')).status,200);
  assert.equal(refreshes,1);
  assert.deepEqual(seen.map(x=>x.auth),['Bearer upstream-a','Bearer upstream-new']);
});

test('identity 401 after a concurrent rotation reuses newer pool token without rotating it again',async(t)=>{
  let refreshes=0;let manager;
  const {request,am,seen}=await fixture(t,{
    upstreamStatus:(req)=>{
      if(req.headers.authorization==='Bearer upstream-a') {
        manager.accounts[0].credential='upstream-newer';
        return 401;
      }
      return 200;
    },
    refreshFn:async()=>{refreshes++;throw new Error('must reuse newer token');},
  });
  manager=am;
  assert.equal((await request('/api/oauth/profile')).status,200);
  assert.equal(refreshes,0);
  assert.deepEqual(seen.map(x=>x.auth),['Bearer upstream-a','Bearer upstream-newer']);
});

test('a persistent identity 401 reports a pool failure; never repeats mutations or exposes 401',async(t)=>{
  const {request,seen}=await fixture(t,{upstreamStatus:401,refreshFn:async()=>({accessToken:'new',refreshToken:'new-r',expiresAt:Date.now()+3600_000})});
  assert.equal((await request('/api/oauth/profile')).status,503);
  assert.equal(seen.length,2);
  assert.equal((await request('/api/oauth/file_upload',{method:'POST',body:'file'})).status,503);
  assert.equal(seen.length,3);
});

for (const path of ['/api/oauth/profile','/v1/code/sessions','/v1/oauth/token','/v1/messages']) {
  test(`invalid managed signature cannot reach upstream: ${path}`, async (t) => {
    const {seen,request}=await fixture(t);
    const result=await request(path,{method:'POST',headers:{authorization:`Bearer ${credential('identity-a','wrong-key')}`},body:'{}'});
    assert.equal(result.status,403);
    assert.equal(seen.length,0);
  });
}

test('managed clients cannot independently rotate provider refresh tokens', async(t)=>{
  const {seen,request}=await fixture(t);
  const result=await request('/v1/oauth/token',{method:'POST',body:'{"refresh_token":"client-copy"}'});
  assert.equal(result.status,409);
  assert.equal(seen.length,0);
});

test('dead identity is a visible pool failure, never another account or a personal login instruction', async(t)=>{
  const {am,seen,request}=await fixture(t,{refreshFn:async()=>{throw Object.assign(new Error('invalid_grant'),{status:400});}});
  am.accounts[0].expiresAt=1;
  const result=await request('/api/oauth/profile');
  assert.equal(result.status,503);
  assert.equal(seen.length,0);
  assert.doesNotMatch(JSON.stringify(result.body),/Please run \/login/);
  const status=await request('/teamclaude/status');
  assert.equal(status.body.managedClientAuth.enabled,true);
  assert.equal(status.body.managedClientAuth.lastFailure.reason,'identity_unavailable');
});

test('revocation and account removal take effect in an already running proxy',async(t)=>{
  const {config,request,seen}=await fixture(t);
  assert.equal((await request('/api/oauth/profile')).status,200);
  config.proxy.apiKey='rotated-proxy-key';
  assert.equal((await request('/api/oauth/profile')).status,403);
  config.proxy.apiKey=KEY;
  config.accounts.shift();
  assert.equal((await request('/api/oauth/profile')).status,403);
  assert.equal(seen.length,1);
});

test('personal OAuth identity relay retains its existing contract',async(t)=>{
  const {request,seen}=await fixture(t);
  assert.equal((await request('/api/oauth/profile',{headers:{authorization:'Bearer personal-token','x-api-key':KEY}})).status,200);
  assert.equal(seen.at(-1).auth,'Bearer personal-token');
  assert.equal(seen.at(-1).apiKey,undefined);
});

test('upstream entitlement rejection remains a rejection',async(t)=>{
  const {request}=await fixture(t,{upstreamStatus:403});
  assert.equal((await request('/api/oauth/profile')).status,403);
});

test('managed websocket handshake uses fixed identity and never leaks facade',async(t)=>{
  const {upgrade,seen}=await fixture(t);
  assert.equal(await upgrade(),200);
  assert.equal(seen.at(-1).auth,'Bearer upstream-a');
  const before=seen.length;
  assert.equal(await upgrade(credential('identity-a','invalid')),403);
  assert.equal(seen.length,before);
});

test('managed websocket cannot send Anthropic identity to another provider',async(t)=>{
  const {config,am,seen}=await fixture(t);
  let reply='';
  relayUpgrade({url:'/backend-api/codex/responses',headers:{authorization:`Bearer ${credential()}`}},
    {end:value=>{reply=value;}},Buffer.alloc(0),'https://chatgpt.com',null,{managedConfig:config,accountManager:am});
  assert.match(reply,/403 Forbidden/);
  assert.equal(seen.length,0);
});
