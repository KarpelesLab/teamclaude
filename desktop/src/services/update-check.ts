// Manual update check (MVP): asks the npm registry for the latest published
// @karpeleslab/teamclaude and compares it with the bundled backend. Nothing is
// downloaded or installed — automatic updates wait for an agreed signing and
// release scheme (see docs/desktop-architecture.md).

import https from 'node:https';
import type { UpdateCheckResult } from '../shared/types';
import { compareVersions } from './version';

export const REGISTRY_URL = 'https://registry.npmjs.org/@karpeleslab%2fteamclaude/latest';
export const RELEASES_URL = 'https://github.com/KarpelesLab/teamclaude/releases';

export type JsonGetter = (url: string, timeoutMs: number) => Promise<unknown>;

export const httpsJson: JsonGetter = (url, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { accept: 'application/json' }, timeout: timeoutMs }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`registry answered HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 1_000_000) req.destroy(new Error('registry response too large'));
        else chunks.push(c);
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('registry response was not JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('registry request timed out')));
    req.on('error', reject);
  });

export interface InstalledVersions {
  /** The backend copy inside this app, or null in a development run. */
  bundled: string | null;
  /** A TeamClaude this app did not start (terminal, service), when one is attached. */
  external: string | null;
}

const verdict = (current: string | null, latest: string | null) =>
  current === null ? null : { current, updateAvailable: latest !== null && compareVersions(current, latest) === -1 };

/**
 * The bundled and an attached external backend are judged apart: the first is
 * updated with the app, the second with npm, so each gets its own answer.
 */
export async function checkForUpdates(installed: InstalledVersions, get: JsonGetter = httpsJson): Promise<UpdateCheckResult> {
  try {
    const body = await get(REGISTRY_URL, 10_000);
    const latest = body && typeof body === 'object' ? (body as { version?: unknown }).version : null;
    if (typeof latest !== 'string') throw new Error('registry response had no version');
    return { latest, bundled: verdict(installed.bundled, latest), external: verdict(installed.external, latest), url: RELEASES_URL, error: null };
  } catch (err) {
    return { latest: null, bundled: verdict(installed.bundled, null), external: verdict(installed.external, null), url: RELEASES_URL, error: (err as Error).message };
  }
}
