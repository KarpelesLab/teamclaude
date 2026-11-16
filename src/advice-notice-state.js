// The Stop hook's per-session notice state: one small JSON file per session
// under a private temp directory, so a notice fires once per transition
// rather than on every turn. Files are left for the OS's temp cleanup.

import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_ID_SHAPE } from './server.js';
import { stopHookOutput } from './claude-code-surface.js';

/** @typedef {import('./claude-code-surface.js').SessionAdviceReply} SessionAdviceReply */
/** @typedef {import('./claude-code-surface.js').NoticeState} NoticeState */
/** @typedef {import('./claude-code-surface.js').StopHookJson} StopHookJson */

export const NOTICE_DIR = join(tmpdir(), 'teamclaude-advice');

/** @param {unknown} raw @returns {NoticeState|null} */
function parseState(raw) {
  const s = /** @type {any} */ (raw);
  if (!s || typeof s !== 'object') return null;
  return {
    outOfBand: s.outOfBand === true,
    pinnedAnnounced: typeof s.pinnedAnnounced === 'string' ? s.pinnedAnnounced : null,
  };
}

/**
 * One Stop-hook turn for one session: read its state, decide, write the new
 * state, and return what to print (null: nothing). With the feature off, or an
 * id that is not a plain session id, nothing is read or written.
 * @param {string} dir
 * @param {string} sessionId
 * @param {SessionAdviceReply|null} advice
 * @returns {Promise<StopHookJson|null>}
 */
export async function stopHookTurn(dir, sessionId, advice) {
  if (!advice?.advice?.enabled || !SESSION_ID_SHAPE.test(sessionId)) return null;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // A directory someone else made (a shared /tmp) could hold planted symlinks.
  const st = await lstat(dir);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) return null;
  // The suffix keeps an id such as `..` a plain file name inside `dir`.
  const file = join(dir, `${sessionId}.json`);
  /** @type {NoticeState|null} */
  let state = null;
  try {
    state = parseState(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    state = null;
  }
  const { output, nextState } = stopHookOutput(advice, state);
  if (JSON.stringify(nextState) !== JSON.stringify(state)) {
    await writeFile(file, JSON.stringify(nextState), { mode: 0o600 });
  }
  return output;
}
