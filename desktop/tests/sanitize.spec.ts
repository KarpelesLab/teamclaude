import { describe, expect, it } from 'vitest';
import { describeError, sanitizeText } from '../src/services/sanitize';

describe('sanitizeText', () => {
  it.each([
    ['anthropic oauth token', 'token sk-ant-oat01-AbCdEfGhIjKlMnOp done', 'sk-ant-oat01'],
    ['anthropic api key', 'key=sk-ant-api03-ZZZZZZZZZZZZZZZZ', 'sk-ant-api03'],
    ['openai project key', 'using sk-proj-abcdefghijklmnopqrstuv', 'abcdefghijklmnop'],
    ['jwt', 'id eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', 'eyJhbGci'],
    ['bearer header', 'Authorization: Bearer abcdef1234567890', 'abcdef1234567890'],
    ['x-api-key header', 'x-api-key: secret-value-123', 'secret-value-123'],
    ['cookie header', 'cookie=sessionid=abc123xyz', 'abc123xyz'],
    ['json refresh token', '{"refreshToken":"rt-very-secret"}', 'rt-very-secret'],
    ['query string code', 'GET /callback?code=oauthcode123&state=x', 'oauthcode123'],
    ['url password', 'proxy http://user:hunter2@10.0.0.1:8080', 'hunter2'],
  ])('redacts %s', (_label, input, secret) => {
    const out = sanitizeText(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('strips ANSI colour and OSC title sequences', () => {
    expect(sanitizeText('\u001b[31mred\u001b[0m \u001b]0;title\u0007ok')).toBe('red ok');
  });

  it('leaves ordinary text alone', () => {
    const line = 'Listening on http://127.0.0.1:3456 with 3 accounts';
    expect(sanitizeText(line)).toBe(line);
  });

  it('keeps the query parameter name and the rest of the URL', () => {
    expect(sanitizeText('/cb?code=abc&state=s1')).toBe('/cb?code=[redacted]&state=s1');
  });
});

describe('describeError', () => {
  it('sanitizes Error messages and non-Error values', () => {
    expect(describeError(new Error('bad key sk-ant-api03-XXXXXXXXXXXX'))).toBe('bad key [redacted]');
    expect(describeError('plain')).toBe('plain');
  });
});
