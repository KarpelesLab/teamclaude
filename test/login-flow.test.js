import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { isRemoteSession, codeRace, pasteFromTerminal } from '../src/login-flow.js';

// The pieces both OAuth logins share: whether a browser opened here would be
// one anybody sees, and the race between the browser's redirect and a paste.
// Every race here is driven by hand: a listener is a promise the test settles,
// so nothing waits on a clock.

test('remote session: an SSH environment is remote on any platform', () => {
  assert.equal(isRemoteSession({ SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' }, 'darwin'), true);
  assert.equal(isRemoteSession({ SSH_TTY: '/dev/pts/3', DISPLAY: ':0' }, 'linux'), true);
});

test('remote session: Linux with no display server is remote, with one it is not', () => {
  assert.equal(isRemoteSession({}, 'linux'), true);
  assert.equal(isRemoteSession({ DISPLAY: ':0' }, 'linux'), false);
  assert.equal(isRemoteSession({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), false);
});

test('remote session: the override wins over what the environment shows, in either spelling', () => {
  // A server a service started inside tmux, attached over SSH later.
  assert.equal(isRemoteSession({ TEAMCLAUDE_REMOTE: '1' }, 'darwin'), true);
  assert.equal(isRemoteSession({ TEAMROUTER_REMOTE: '0', SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' }, 'linux'), false);
  // Anything else leaves it to the environment.
  assert.equal(isRemoteSession({ TEAMCLAUDE_REMOTE: '', SSH_TTY: '/dev/pts/3' }, 'darwin'), true);
  assert.equal(isRemoteSession({ TEAMCLAUDE_REMOTE: 'yes' }, 'darwin'), false);
});

test('remote session: macOS and Windows without SSH are local, display or not', () => {
  assert.equal(isRemoteSession({}, 'darwin'), false);
  assert.equal(isRemoteSession({}, 'win32'), false);
});

/** A listener the test settles itself. */
function manualListener() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const parseCode = text => {
  const t = text.trim();
  if (!t) return null;
  if (t === 'bad') throw new Error('not a code');
  return { code: t, via: 'paste' };
};

test('race: a paste wins while the listener waits, and the listener is closed once', async () => {
  const listener = manualListener();
  let closed = 0;
  const race = codeRace({ listener: listener.promise, parse: parseCode, timeoutMs: 0, onSettle: () => closed++ });
  assert.equal(race.submit('abc'), true);
  assert.deepEqual(await race.result, { code: 'abc', via: 'paste' });
  assert.equal(closed, 1);
  // The browser arriving late changes nothing, and nor does a second paste.
  listener.resolve({ code: 'late', via: 'listener' });
  await race.settled;
  assert.equal(race.submit('again'), false);
  assert.equal(closed, 1);
});

test('race: the listener wins, and a paste after it is ignored', async () => {
  const listener = manualListener();
  let closed = 0;
  const race = codeRace({ listener: listener.promise, parse: parseCode, timeoutMs: 0, onSettle: () => closed++ });
  listener.resolve({ code: 'abc', via: 'listener' });
  assert.deepEqual(await race.result, { code: 'abc', via: 'listener' });
  assert.equal(race.submit('xyz'), false);
  assert.equal(closed, 1);
});

test('race: a paste that cannot be used throws and leaves the race running', async () => {
  const race = codeRace({ listener: null, parse: parseCode, timeoutMs: 0 });
  assert.throws(() => race.submit('bad'), /not a code/);
  assert.equal(race.submit('   '), false, 'an empty paste is nothing, not an error');
  assert.equal(race.submit('good'), true);
  assert.deepEqual(await race.result, { code: 'good', via: 'paste' });
});

test('race: cancelling rejects as AbortError and closes the listener', async () => {
  const listener = manualListener();
  const controller = new AbortController();
  let closed = 0;
  const race = codeRace({ listener: listener.promise, parse: parseCode, signal: controller.signal, timeoutMs: 0, onSettle: () => closed++ });
  controller.abort();
  await assert.rejects(race.result, err => err.name === 'AbortError' && /cancelled/.test(err.message));
  assert.equal(closed, 1);
  assert.equal(race.submit('abc'), false);
});

test('race: an abort with a reason rejects with that reason', async () => {
  const controller = new AbortController();
  const race = codeRace({ parse: parseCode, signal: controller.signal, timeoutMs: 0 });
  controller.abort(new Error('No authorization code provided'));
  await assert.rejects(race.result, /No authorization code provided/);
});

test('race: a signal aborted before the race starts settles it at once', async () => {
  const controller = new AbortController();
  controller.abort();
  let closed = 0;
  const race = codeRace({ parse: parseCode, signal: controller.signal, timeoutMs: 0, onSettle: () => closed++ });
  assert.equal(closed, 1, 'the listener is closed before the race is even returned');
  await assert.rejects(race.result, { name: 'AbortError' });
});

test('race: a listener that fails (the browser reported an OAuth error) fails the race', async () => {
  const listener = manualListener();
  const race = codeRace({ listener: listener.promise, parse: parseCode, timeoutMs: 0 });
  listener.reject(new Error('OAuth error: access_denied'));
  await assert.rejects(race.result, /access_denied/);
});

test('paste prompt: a refused paste is reported and asked for again', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let said = '';
  output.on('data', d => { said += d; });
  const race = codeRace({ parse: parseCode, timeoutMs: 0 });
  let ended = 0;
  pasteFromTerminal({ submit: race.submit, settled: race.settled, prompt: 'code: ', onEnd: () => ended++, input, output });
  input.write('bad\n');
  input.write('\n');
  input.write('good\n');
  assert.deepEqual(await race.result, { code: 'good', via: 'paste' });
  assert.match(said, /not a code/);
  assert.equal((said.match(/code: /g) || []).length, 3, 'asked once per line until one was taken');
  assert.equal(ended, 0, 'a taken paste is not the end of input');
});

test('paste prompt: the end of input is handed to the caller, who cancels', async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  const race = codeRace({ parse: parseCode, signal: controller.signal, timeoutMs: 0 });
  pasteFromTerminal({ submit: race.submit, settled: race.settled, prompt: '', onEnd: () => controller.abort(), input, output: new PassThrough() });
  input.end();
  await assert.rejects(race.result, { name: 'AbortError' });
});

test('paste prompt: closes when the browser wins, without calling onEnd', async () => {
  const input = new PassThrough();
  const listener = manualListener();
  const race = codeRace({ listener: listener.promise, parse: parseCode, timeoutMs: 0 });
  let ended = 0;
  pasteFromTerminal({ submit: race.submit, settled: race.settled, prompt: '', onEnd: () => ended++, input, output: new PassThrough() });
  listener.resolve({ code: 'abc', via: 'listener' });
  await race.settled;
  await new Promise(r => setImmediate(r));
  assert.equal(ended, 0);
  // A line typed after the close reaches nobody.
  input.write('late\n');
  assert.deepEqual(await race.result, { code: 'abc', via: 'listener' });
});
