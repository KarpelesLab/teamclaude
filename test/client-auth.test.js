import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsProxyClientCredential } from '../src/oauth.js';

test('proxy client credential is needed without a local access token', () => {
  assert.equal(needsProxyClientCredential(null, 2_000_000_000_000), true);
  assert.equal(needsProxyClientCredential({}, 2_000_000_000_000), true);
});

// Claude Code refreshes an expired access token itself at startup, so only a
// login that cannot be refreshed counts as unavailable.

test('an expired local access token with a refresh token keeps subscription mode', () => {
  assert.equal(needsProxyClientCredential({
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAt: 1_999_999_999_999,
  }, 2_000_000_000_000), false);
  assert.equal(needsProxyClientCredential({
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAt: 1_999_999_999_999,
    refreshTokenExpiresAt: 2_000_000_000_001,
  }, 2_000_000_000_000), false);
});

test('proxy client credential is needed for an expired local access token with no refresh token', () => {
  assert.equal(needsProxyClientCredential({
    accessToken: 'token',
    expiresAt: 1_999_999_999_999,
  }, 2_000_000_000_000), true);
});

test('proxy client credential is needed when the refresh token has expired too', () => {
  assert.equal(needsProxyClientCredential({
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAt: 1_999_999_999_999,
    refreshTokenExpiresAt: 1_999_999_999_999,
  }, 2_000_000_000_000), true);
  // Seconds-based expiry is normalised the same way as expiresAt.
  assert.equal(needsProxyClientCredential({
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAt: 1_999_999_999,
    refreshTokenExpiresAt: 1_999_999_999,
  }, 2_000_000_000_000), true);
});

test('valid local OAuth keeps Claude Code in subscription mode', () => {
  assert.equal(needsProxyClientCredential({
    accessToken: 'token',
    expiresAt: 2_000_000_000_001,
  }, 2_000_000_000_000), false);
  assert.equal(needsProxyClientCredential({ accessToken: 'token' }, 2_000_000_000_000), false);
});
