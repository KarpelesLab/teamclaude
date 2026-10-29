// Version comparison for the desktop ↔ backend compatibility check.

import { translator, type Translate } from '../shared/i18n';

/** Parse "1.2.3", "v1.2.3", "1.2.3-beta.1" into numbers; null when it is not a version. */
export function parseVersion(value: string | null | undefined): [number, number, number] | null {
  if (!value) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1, 0 or 1; null when either side is not a version. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const x = pa[i] as number;
    const y = pb[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Whether the desktop can drive this backend. An unknown version (a dev
 * checkout reporting a sha, a backend too old to report one) is allowed with a
 * warning: refusing it would lock out exactly the people testing new builds.
 */
export function checkCompatibility(
  backendVersion: string | null,
  minVersion: string,
  t: Translate = translator('en'),
): { ok: boolean; message: string | null } {
  if (!backendVersion) return { ok: true, message: t('v.noVersion') };
  const cmp = compareVersions(backendVersion, minVersion);
  if (cmp === null) return { ok: true, message: t('v.notRelease', { version: backendVersion }) };
  if (cmp < 0) return { ok: false, message: t('v.tooOld', { version: backendVersion, min: minVersion }) };
  return { ok: true, message: null };
}
