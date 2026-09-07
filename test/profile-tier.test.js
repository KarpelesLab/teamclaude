import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as oauth from '../src/oauth.js';

test('OAuth module exposes profile normalization for persisted tier metadata', () => {
  assert.equal(typeof oauth.normalizeProfile, 'function');
});

test('profile normalization retains the fields needed for quota weighting', () => {
  assert.deepEqual(oauth.normalizeProfile({
    account: {
      uuid: 'account-1', email: 'team@example.com', display_name: 'Team User',
      has_claude_max: true, has_claude_pro: false,
    },
    organization: {
      uuid: 'org-1', name: 'Acme', organization_type: 'claude_team',
      rate_limit_tier: 'default_raven', seat_tier: 'team_standard',
    },
  }), {
    accountUuid: 'account-1',
    email: 'team@example.com',
    name: 'Team User',
    orgUuid: 'org-1',
    orgName: 'Acme',
    organizationType: 'claude_team',
    rateLimitTier: 'default_raven',
    seatTier: 'team_standard',
    hasClaudeMax: true,
    hasClaudePro: false,
  });
});
