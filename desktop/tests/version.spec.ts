import { describe, expect, it } from 'vitest';
import { checkCompatibility, compareVersions, parseVersion } from '../src/services/version';

describe('version', () => {
  it('parses release, prefixed and pre-release versions', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('v10.0.1')).toEqual([10, 0, 1]);
    expect(parseVersion('1.2.3-beta.1')).toEqual([1, 2, 3]);
    expect(parseVersion('abc1234')).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  it('compares numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.1.25', '1.1.25')).toBe(0);
    expect(compareVersions('0.9.0', '1.0.0')).toBe(-1);
    expect(compareVersions('dev', '1.0.0')).toBeNull();
  });

  it('refuses a backend older than the minimum, warns on unknown versions', () => {
    expect(checkCompatibility('1.1.25', '1.1.0')).toEqual({ ok: true, message: null });
    expect(checkCompatibility('1.0.0', '1.1.0').ok).toBe(false);
    const unknown = checkCompatibility(null, '1.1.0');
    expect(unknown.ok).toBe(true);
    expect(unknown.message).toBeTruthy();
    const sha = checkCompatibility('abc1234', '1.1.0');
    expect(sha.ok).toBe(true);
    expect(sha.message).toContain('abc1234');
  });
});
