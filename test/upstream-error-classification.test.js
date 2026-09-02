import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientUpstreamError } from '../src/server.js';

// An upstream failure is either about the socket or about the host, and the
// difference decides whether the fleet gets walked. A socket failure is about
// this connection, so another account cannot mend it. A host failure would
// reach every account identically, unless one of them dials somewhere else.
//
// The fleet-level consequence of getting this wrong is in
// test/unreachable-upstream.test.js.

const withCode = (code) => Object.assign(new Error(code), { code });

test('a socket failure is transient whatever else the fleet could dial', () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    'TEAMCLAUDE_HEADERS_TIMEOUT', 'TEAMCLAUDE_BODY_TIMEOUT']) {
    assert.equal(isTransientUpstreamError(withCode(code)), true, code);
    assert.equal(isTransientUpstreamError(withCode(code), { otherHostAvailable: true }), true,
      `${code} is about this connection, and another host cannot mend a broken one`);
  }
});

test('a host failure is transient only when no other host could be dialled', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN']) {
    assert.equal(isTransientUpstreamError(withCode(code)), true, code);
    assert.equal(isTransientUpstreamError(withCode(code), { otherHostAvailable: true }), false,
      `${code} says nothing about an account that dials somewhere else`);
  }
});

// Stated as an assertion so a later edit cannot quietly move this code into the
// host set. What that move costs is measured in unreachable-upstream.test.js.
test('a refused connection stays transient even when another host is available', () => {
  assert.equal(isTransientUpstreamError(withCode('ECONNREFUSED')), true);
  assert.equal(isTransientUpstreamError(withCode('ECONNREFUSED'), { otherHostAvailable: true }), true,
    'a refused connection became conditional, which reopens every gap in the condition');
});

test('the timeout and abort names are transient without a code', () => {
  assert.equal(isTransientUpstreamError(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
  assert.equal(isTransientUpstreamError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
});

// The shape the global-fetch transport really produces, which is every failure
// on that path: a TypeError saying "fetch failed" with the code on `cause`. The
// message is enough on its own to call a failure transient, so it has to be read
// after the codes; read first, it answers for the whole transport and the
// host-scoped arm never runs there.
test('a global-fetch wrapper is classified by the code it carries, not by its message', () => {
  const wrapped = Object.assign(new TypeError('fetch failed'), { cause: withCode('ENOTFOUND') });
  assert.equal(isTransientUpstreamError(wrapped), true);
  assert.equal(isTransientUpstreamError(wrapped, { otherHostAvailable: true }), false,
    'the message decided this before the code was read, so the conditional arm never ran');
  // And the fallback the message check exists for: a wrapper carrying nothing.
  assert.equal(isTransientUpstreamError(new TypeError('fetch failed')), true);
});

// Asserted in the direction where reading the children changes the answer. The
// other direction returns false whether the children were read or not, since an
// error carrying no recognised code is not transient either, so it would be
// satisfied by a version that never looked.
test('the code is read from a wrapper and from an aggregate', () => {
  const child = withCode('ENOTFOUND');
  assert.equal(isTransientUpstreamError(Object.assign(new Error('boom'), { cause: child })), true,
    'the real error sits on `cause` when global fetch is the transport');

  const aggregate = new AggregateError([child]);
  assert.equal(isTransientUpstreamError(aggregate), true,
    'an aggregate carries no top-level code, so the children have to be read');
  assert.equal(isTransientUpstreamError(aggregate, { otherHostAvailable: true }), false,
    'and once read, the code is host-scoped like any other');

  const wrappedAggregate = Object.assign(new Error('boom'), { cause: new AggregateError([child]) });
  assert.equal(isTransientUpstreamError(wrappedAggregate), true,
    'global fetch wraps the aggregate, so the children sit two levels down');
});

test('an unrecognised failure is not transient, and neither is a non-Error', () => {
  assert.equal(isTransientUpstreamError(withCode('EACCES')), false);
  assert.equal(isTransientUpstreamError(new Error('something else')), false);
  assert.equal(isTransientUpstreamError({ code: 'ENOTFOUND' }), false, 'not an Error');
  assert.equal(isTransientUpstreamError(undefined), false);
});
