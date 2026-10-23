import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  ArgonTextCallStream, argonTextCallTools, parseTextCall,
  repairArgonTextCallBody, toolsFromRequestBody,
} from '../src/plaintext-toolcall.js';

// Claude Code-shaped tool schemas (trimmed).
const TOOLS = [
  {
    name: 'Bash',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
        timeout: { type: 'number' },
        run_in_background: { type: 'boolean' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'Read',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
];
const REQ = { model: 'gemini-4-argon', tools: TOOLS, messages: [{ role: 'user', content: 'hi' }] };
const tools = toolsFromRequestBody(Buffer.from(JSON.stringify(REQ)));

function reply(text, extra = {}) {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'gemini-4-argon',
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 }, ...extra,
  };
}
const enc = o => Buffer.from(JSON.stringify(o));
const repaired = text => JSON.parse(repairArgonTextCallBody(enc(reply(text)), tools));

function assertToolUse(msg, name, input) {
  assert.equal(msg.stop_reason, 'tool_use');
  assert.equal(msg.content.length, 1);
  const b = msg.content[0];
  assert.equal(b.type, 'tool_use');
  assert.match(b.id, /^toolu_[A-Za-z0-9]{24}$/);
  assert.equal(b.name, name);
  assert.deepEqual(b.input, input);
}

// ── rewrite cases ───────────────────────────────────────────────────────────

test('JSON args are rewritten into a tool_use block', () => {
  const msg = repaired('call:default_api:Bash{"command":"ls -la","description":"list"}');
  assertToolUse(msg, 'Bash', { command: 'ls -la', description: 'list' });
  assert.equal(msg.usage.output_tokens, 20, 'usage untouched');
});

test('loose args as seen from Argon (unquoted values with quotes, commas, booleans)', () => {
  const text = 'call:default_api:Bash{command:sha256sum "/data/The Legend [01][BASE][v1.5.0](x).xci",'
    + 'description:Compute SHA256 of the file, quickly,run_in_background:true}';
  assertToolUse(repaired(text), 'Bash', {
    command: 'sha256sum "/data/The Legend [01][BASE][v1.5.0](x).xci"',
    description: 'Compute SHA256 of the file, quickly',
    run_in_background: true,
  });
});

test('loose args with quoted strings and a space after the comma', () => {
  assertToolUse(repaired('call:default_api:Bash{command:"ls", description:"list"}'), 'Bash',
    { command: 'ls', description: 'list' });
});

test('loose args: backslashes, sed ranges, trailing newline, integer typing', () => {
  assertToolUse(repaired("call:default_api:Bash{command:sed -n '850,1451p' /x/main.gd,description:Read lines 850-1451}\n"),
    'Bash', { command: "sed -n '850,1451p' /x/main.gd", description: 'Read lines 850-1451' });
  assertToolUse(repaired('call:default_api:Bash{command:grep -rn "a\\b\\|b\\b" src/ 2>/dev/null || true,description:Find refs}'),
    'Bash', { command: 'grep -rn "a\\b\\|b\\b" src/ 2>/dev/null || true', description: 'Find refs' });
  assertToolUse(repaired('call:default_api:Read{file_path:/a/b.js,offset:10,limit:5}'),
    'Read', { file_path: '/a/b.js', offset: 10, limit: 5 });
});

test('multiline command (heredoc / python -c with braces and colons) is kept verbatim', () => {
  const command = "python3 -c '\nimport json\nd = {\"a\": 1, \"b\": {\"c\": 2}}\nprint(d[\"a\"])\n'";
  const msg = repaired(`call:default_api:Bash{command:${command},description:Print a dict value}\n`);
  assertToolUse(msg, 'Bash', { command, description: 'Print a dict value' });
  const heredoc = "cat << 'EOF' > /tmp/x.ps1\nAdd-Type @\"\npublic class W { [DllImport(\"u\")] }\n\"@\nEOF";
  assertToolUse(repaired(`call:default_api:Bash{command:${heredoc},description:Write script}`),
    'Bash', { command: heredoc, description: 'Write script' });
});

test('thinking before the call is kept; the call block becomes the tool_use', () => {
  const body = reply('call:default_api:Bash{command:ls,description:list}');
  body.content.unshift({ type: 'thinking', thinking: 'hmm', signature: 'sig' });
  const msg = JSON.parse(repairArgonTextCallBody(enc(body), tools));
  assert.equal(msg.stop_reason, 'tool_use');
  assert.deepEqual(msg.content[0], { type: 'thinking', thinking: 'hmm', signature: 'sig' });
  assert.equal(msg.content[1].type, 'tool_use');
  assert.deepEqual(msg.content[1].input, { command: 'ls', description: 'list' });
});

// ── no-rewrite cases (same Buffer object back) ──────────────────────────────

function assertUntouched(body, t = tools) {
  const buf = Buffer.isBuffer(body) ? body : enc(body);
  assert.equal(repairArgonTextCallBody(buf, t), buf);
}

test('unknown tool is not rewritten', () => {
  assertUntouched(reply('call:default_api:Delete{path:/}'));
  assertUntouched(reply('call:default_api:Bash{command:ls}'), null); // request had no tools
});

test('unparsable or schema-violating args are not rewritten', () => {
  for (const text of [
    'call:default_api:Bash{"command": "ls"',            // no closing brace
    'call:default_api:Bash{"command": ls}',             // broken JSON
    'call:default_api:Bash{description:no command}',    // required key missing
    'call:default_api:Bash{cmd:ls}',                    // unknown first key
    'call:default_api:Bash{command:ls,run_in_background:maybe}', // bad boolean
    'call:default_api:Bash{command:ls,timeout:soon}',   // bad number
    'call:default_api:Read{file_path:/a,offset:1.5}',   // non-integer
    'call:default_api:Bash{command:echo ,description:x,description:y}', // repeated key = ambiguous
    'call:default_api:Bash{"command":"ls","extra":1}',  // additionalProperties false
    'call:default_api:Bash{command:ls}\ncall:default_api:Bash{command:pwd}', // two calls
    'call:default_api:Bash{command:ls} and then some prose', // trailing text
  ]) assertUntouched(reply(text));
});

test('a reply that already has a real tool_use is not rewritten', () => {
  const body = reply('call:default_api:Bash{command:ls}');
  body.content.push({ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } });
  body.stop_reason = 'tool_use';
  assertUntouched(body);
  const body2 = reply('call:default_api:Bash{command:ls}');
  body2.content.unshift({ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'pwd' } });
  assertUntouched(body2);
});

test('stop_reason other than end_turn (e.g. max_tokens truncation) is not rewritten', () => {
  assertUntouched(reply('call:default_api:Bash{command:ls}', { stop_reason: 'max_tokens' }));
});

test('normal prose mentioning call: is not rewritten', () => {
  for (const text of [
    'You can call: default_api to list files.',
    'The model wrote call:default_api:Bash{command:ls} in its reply last time.',
    'Here is the plan.\ncall:default_api:Bash{command:ls}', // prose before the call
    'call: me later {ok}',
  ]) assertUntouched(reply(text));
  assert.equal(parseTextCall('see call:default_api:Bash{command:ls}', tools), null);
});

test('prose after the call that happens to end in } is not folded into the last value', () => {
  for (const text of [
    'call:default_api:Bash{command:ls}\n\nThat lists files. Next I will check {config}',
    'call:default_api:Bash{command:echo {a}} then {b}',
  ]) assertUntouched(reply(text));
});

test('a `,key:` inside a value never splits it wrongly', () => {
  // Space after the comma inside an unquoted value: not a key boundary.
  assertToolUse(repaired('call:default_api:Bash{command:git commit -m "docs: tidy, description: wording"}'),
    'Bash', { command: 'git commit -m "docs: tidy, description: wording"' });
  // Inside a JSON-quoted value: decoded whole.
  assertToolUse(repaired('call:default_api:Bash{command:"echo a, description: b"}'),
    'Bash', { command: 'echo a, description: b' });
  // No space, inside an open quote: we cannot tell, so no rewrite.
  assertUntouched(reply('call:default_api:Bash{command:echo "a,description:b"}'));
  // A half-quoted value that is not a JSON string: no rewrite.
  assertUntouched(reply('call:default_api:Bash{command:"grep \\d+ f.txt"}'));
});

test('untyped, enum-only, anyOf and __proto__ properties are handled safely', () => {
  const t = toolsFromRequestBody(JSON.stringify({ tools: [{
    name: 'Search',
    input_schema: { type: 'object', required: ['q'], properties: {
      q: { type: 'string' }, mode: { enum: ['a', 'b'] },
      limit: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      ref: { $ref: '#/defs/x' },
    } },
  }] }));
  const fix = text => JSON.parse(repairArgonTextCallBody(enc(reply(text)), t));
  assert.deepEqual(fix('call:default_api:Search{q:x,limit:10}').content[0].input, { q: 'x', limit: 10 });
  for (const text of [
    'call:default_api:Search{q:x,mode:zzz}',     // untyped enum: refuse
    'call:default_api:Search{q:x,limit:ten}',    // anyOf integer|null
    'call:default_api:Search{q:x,ref:y}',        // $ref: unknown type
    'call:default_api:Search{"q":"x","extra":1}', // key not in schema
    'call:default_api:Search{"q":"x","__proto__":{"a":1}}',
  ]) assertUntouched(reply(text), t);
});

test('unquoted string values are trimmed (space after the colon, newline before })', () => {
  assertToolUse(repaired('call:default_api:Read{file_path: /etc/hosts}'), 'Read', { file_path: '/etc/hosts' });
  assertToolUse(repaired('call:default_api:Read{file_path:/etc/hosts\n}'), 'Read', { file_path: '/etc/hosts' });
});

test('native Anthropic, other paths, and error statuses get no repair at all', () => {
  const body = Buffer.from(JSON.stringify(REQ));
  assert.equal(argonTextCallTools({ model: 'gemini-4-argon', native: true, pathClass: 'messages', status: 200, requestBody: body }), null);
  assert.equal(argonTextCallTools({ model: 'gemini-4-argon', native: false, pathClass: 'count_tokens', status: 200, requestBody: body }), null);
  assert.equal(argonTextCallTools({ model: 'gemini-4-argon', native: false, pathClass: 'messages', status: 400, requestBody: body }), null);
  assert.equal(argonTextCallTools({ model: 'openrouter/free', native: false, pathClass: 'messages', status: 200, requestBody: '{}' }), null);
  for (const model of ['gemini-4-argon', 'gemini-4-argon-high', 'openrouter/free', 'op-free-1/openrouter/free', 'deepseek-v4-pro']) {
    assert.ok(argonTextCallTools({ model, native: false, pathClass: 'messages', status: 200, requestBody: body }));
  }
  const orTools = argonTextCallTools({
    model: 'op-free-1/openrouter/free', native: false, pathClass: 'messages', status: 200, requestBody: body,
    accountName: 'op-free-1',
  });
  assert.equal(orTools.holdAllText, true);
});

// ── streaming ───────────────────────────────────────────────────────────────

function ev(type, data) { return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`; }

function sseReply(textPieces, { stop = 'end_turn', thinking = false, extraBlock = null } = {}) {
  let s = ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'gemini-4-argon', content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 1 } } });
  let i = 0;
  if (thinking) {
    s += ev('content_block_start', { index: i, content_block: { type: 'thinking', thinking: '' } });
    s += ev('content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking: 'plan' } });
    s += ev('content_block_stop', { index: i });
    i++;
  }
  s += ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
  s += ev('ping', {});
  for (const p of textPieces) s += ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: p } });
  s += ev('content_block_stop', { index: i });
  if (extraBlock) {
    i++;
    s += ev('content_block_start', { index: i, content_block: extraBlock });
    s += ev('content_block_stop', { index: i });
  }
  s += ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 42 } });
  s += ev('message_stop', {});
  return s;
}

// Feed `input` in chunks of `size` bytes; return { out, firstWriteAt } where
// firstWriteAt is the index of the first chunk that produced output.
function runStream(input, size, t = tools) {
  const bytes = Buffer.from(input);
  const st = new ArgonTextCallStream(t);
  const outs = [];
  for (let i = 0; i < bytes.length; i += size) outs.push(...st.push(bytes.subarray(i, i + size)));
  outs.push(...st.end());
  return { out: Buffer.concat(outs), stream: st };
}

function parseSse(buf) {
  return buf.toString('utf8').split('\n\n').filter(Boolean).map(e => {
    const line = e.split('\n').find(l => l.startsWith('data: '));
    return JSON.parse(line.slice(6));
  });
}

test('SSE round trip: a split text-form call becomes a tool_use stream', () => {
  const input = sseReply(['call:def', 'ault_api:Bash{command:ls -la,', 'description:List files}\n'], { thinking: true });
  for (const size of [1, 7, 64, 100000]) {
    const { out, stream } = runStream(input, size);
    assert.equal(stream.rewrote, true);
    const evs = parseSse(out);
    assert.deepEqual(evs.map(e => e.type), [
      'message_start',
      'content_block_start', 'content_block_delta', 'content_block_stop', // thinking, untouched
      'ping', // keepalive that arrived inside the text block, bytes kept
      'content_block_start', 'content_block_delta', 'content_block_stop', // tool_use
      'message_delta', 'message_stop',
    ]);
    const start = evs[5];
    assert.equal(start.index, 1);
    assert.equal(start.content_block.type, 'tool_use');
    assert.equal(start.content_block.name, 'Bash');
    assert.match(start.content_block.id, /^toolu_/);
    assert.deepEqual(start.content_block.input, {});
    assert.equal(evs[6].delta.type, 'input_json_delta');
    assert.deepEqual(JSON.parse(evs[6].delta.partial_json), { command: 'ls -la', description: 'List files' });
    assert.equal(evs[8].delta.stop_reason, 'tool_use');
    assert.equal(evs[8].usage.output_tokens, 42);
    // Everything before the text block is byte-identical to upstream.
    const prefixEnd = input.indexOf('event: content_block_start', input.indexOf('thinking_delta'));
    assert.equal(out.toString().slice(0, prefixEnd), input.slice(0, prefixEnd));
  }
});

test('SSE: prose, unknown tools, real tool_use and max_tokens all pass through byte-identical', () => {
  const cases = [
    sseReply(['Sure, ', 'here is the answer: call: me maybe.']),
    sseReply(['call:default_api:Delete{path:/}']),
    sseReply(['call:default_api:Bash{command:ls}'], { stop: 'max_tokens' }),
    sseReply(['call:default_api:Bash{command:ls}'], { extraBlock: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } }),
    sseReply(['call:default_api:Bash{"command": ls}']),
    sseReply(['ca']), // short text that only looked like the start of a call
  ];
  for (const input of cases) {
    for (const size of [1, 5, 4096]) {
      const { out, stream } = runStream(input, size);
      assert.equal(stream.rewrote, false);
      assert.equal(out.toString('utf8'), input);
    }
  }
});

test('SSE: ordinary prose is released as soon as it diverges from the call prefix', () => {
  const input = sseReply(['Hello ', 'world']);
  const st = new ArgonTextCallStream(tools);
  const start = input.indexOf('event: content_block_delta');
  const firstDeltaEnd = input.indexOf('\n\n', start) + 2;
  const out = Buffer.concat(st.push(Buffer.from(input.slice(0, firstDeltaEnd)))).toString();
  assert.equal(out, input.slice(0, firstDeltaEnd), 'nothing held once "Hello " rules out a call');
});

test('SSE: CRLF framing streams through and is still repaired', () => {
  const crlf = s => s.replace(/\n/g, '\r\n');
  const prose = crlf(sseReply(['Hello ', 'world']));
  const st = new ArgonTextCallStream(tools);
  const half = Buffer.from(prose).subarray(0, Math.floor(prose.length / 2));
  assert.ok(Buffer.concat(st.push(half)).length > 0, 'bytes flow before the end');
  assert.equal(runStream(prose, 13).out.toString(), prose);
  const call = crlf(sseReply(['call:default_api:Bash{command:ls}']));
  const { out, stream } = runStream(call, 13);
  assert.equal(stream.rewrote, true);
  assert.equal(parseSse(Buffer.from(out.toString().replace(/\r\n/g, '\n'))).find(e => e.type === 'content_block_start').content_block.type, 'tool_use');
});

test('SSE: keepalive comments are kept and do not block the repair', () => {
  const input = sseReply(['call:default_api:Bash{command:ls}'])
    .replace('event: ping', ': keepalive\n\nevent: ping');
  const { out, stream } = runStream(input, 11);
  assert.equal(stream.rewrote, true);
  assert.ok(out.toString().includes(': keepalive\n\n'));
});

test('SSE: a last event without its closing blank line still allows the repair', () => {
  const input = sseReply(['call:default_api:Bash{command:ls}']).replace(/\n\n$/, '\n');
  assert.equal(runStream(input, 17).stream.rewrote, true);
});

test('SSE: once a rewrite is ruled out, held bytes are released right away', () => {
  const input = sseReply(['call:default_api:Bash{command:ls}'], { extraBlock: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } });
  const cut = input.indexOf('"tool_use"');
  const cutEnd = input.indexOf('\n\n', cut) + 2;
  const st = new ArgonTextCallStream(tools);
  const out = Buffer.concat(st.push(Buffer.from(input.slice(0, cutEnd)))).toString();
  assert.equal(out, input.slice(0, cutEnd));
});

// ── end-to-end through the real proxy ───────────────────────────────────────

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function viaProxy(upstreamBody, contentType, reqBody, chunkSize = 0) {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': contentType });
      if (!chunkSize) return res.end(upstreamBody);
      const b = Buffer.from(upstreamBody);
      for (let i = 0; i < b.length; i += chunkSize) {
        res.write(b.subarray(i, i + chunkSize));
        await new Promise(r => setImmediate(r));
      }
      res.end();
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([{ name: 'argon', type: 'apikey', apiKey: 'provider-k' }]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}` });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqBody),
    });
    return Buffer.from(await res.arrayBuffer());
  } finally {
    proxy.close(); upstream.close();
  }
}

test('proxy: argon stream with a text-form call reaches the client as tool_use', { timeout: 20000 }, async () => {
  const input = sseReply(['call:default_api:Bash{command:echo hi,', 'description:Say hi}']);
  const out = await viaProxy(input, 'text/event-stream', REQ, 9);
  const evs = parseSse(out);
  const start = evs.find(e => e.type === 'content_block_start');
  assert.equal(start.content_block.type, 'tool_use');
  assert.equal(evs.find(e => e.type === 'message_delta').delta.stop_reason, 'tool_use');
});

test('proxy: argon non-stream reply with a text-form call reaches the client as tool_use', { timeout: 20000 }, async () => {
  const out = await viaProxy(JSON.stringify(reply('call:default_api:Bash{command:pwd}')), 'application/json', REQ);
  const msg = JSON.parse(out);
  assertToolUse(msg, 'Bash', { command: 'pwd' });
});

test('proxy: prose and no-tools traffic stay byte-identical (stream and non-stream)', { timeout: 20000 }, async () => {
  const noTools = { model: 'openrouter/free', messages: [{ role: 'user', content: 'hi' }] };
  const sse = sseReply(['call:default_api:Bash{command:ls}']);
  assert.equal((await viaProxy(sse, 'text/event-stream', noTools, 5)).toString(), sse);
  const json = JSON.stringify(reply('call:default_api:Bash{command:ls}'));
  assert.equal((await viaProxy(json, 'application/json', noTools)).toString(), json);
  const prose = sseReply(['Just prose.']);
  assert.equal((await viaProxy(prose, 'text/event-stream', REQ, 3)).toString(), prose);
});

// ── OpenRouter / XML plaintext tool calls ───────────────────────────────────

const OR_REQ = { ...REQ, model: 'openrouter/free' };

test('dots XML with name+JSON arguments is rewritten into a tool_use block', () => {
  const text = '<dots_function_call>\n<name>Bash</name>\n<arguments>{"command":"ls -la","description":"list"}</arguments>\n</dots_function_call>';
  assertToolUse(repaired(text), 'Bash', { command: 'ls -la', description: 'list' });
});

test('empty dots tags are not rewritten', () => {
  assertUntouched(reply('<dots_function_call>\n<dots_function_call>\n<dots_function_call>'));
});

test('invoke XML is rewritten', () => {
  const text = '<invoke name="Read"><parameter name="file_path">/tmp/a.txt</parameter></invoke>';
  assertToolUse(repaired(text), 'Read', { file_path: '/tmp/a.txt' });
});

test('slash-command XML is not rewritten', () => {
  assertUntouched(reply('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>'));
});

test('command-name XML with a command arg falls through to Bash', () => {
  const text = [
    'Reading the first one:',
    '<command-name>read</command-name>',
    '<command-args>10431</command-args>',
    '<command-message>read 10431</command-message>',
    '<arg_key>db</arg_key>',
    '<arg_value>/tmp/a.db</arg_value>',
    '<arg_key>command</arg_key>',
    '<arg_value>python3 /tmp/a2a_queue.py read 10431</arg_value>',
  ].join('\n');
  const msg = repaired(text);
  assert.equal(msg.stop_reason, 'tool_use');
  assert.equal(msg.content[0].type, 'text');
  assert.equal(msg.content[0].text, 'Reading the first one:');
  assert.equal(msg.content[1].type, 'tool_use');
  assert.equal(msg.content[1].name, 'Bash');
  assert.equal(msg.content[1].input.command, 'python3 /tmp/a2a_queue.py read 10431');
});

test('SSE: OpenRouter mixed XML after prose is held then rewritten', () => {
  const input = sseReply(['Reading now:\n', '<command-name>read</command-name>\n<arg_key>command</arg_key>\n<arg_value>ls -la</arg_value>']);
  const st = new ArgonTextCallStream(tools, { holdAllText: true });
  const outs = [];
  outs.push(...st.push(Buffer.from(input)));
  outs.push(...st.end());
  assert.equal(st.rewrote, true);
  const evs = parseSse(Buffer.concat(outs));
  const start = evs.find(e => e.content_block?.type === 'tool_use');
  assert.equal(start.content_block.name, 'Bash');
  assert.equal(evs.find(e => e.type === 'message_delta').delta.stop_reason, 'tool_use');
});

test('proxy: OpenRouter dots XML stream reaches the client as tool_use', { timeout: 20000 }, async () => {
  const input = sseReply(['<dots_function_call>\n<name>Bash</name>\n', '<arguments>{"command":"pwd"}</arguments>\n</dots_function_call>']);
  const out = await viaProxy(input, 'text/event-stream', OR_REQ, 9);
  const evs = parseSse(out);
  const start = evs.find(e => e.content_block?.type === 'tool_use');
  assert.equal(start.content_block.name, 'Bash');
  assert.equal(evs.find(e => e.type === 'message_delta').delta.stop_reason, 'tool_use');
});
