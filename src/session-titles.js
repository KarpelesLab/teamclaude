/**
 * Session titles for the activity log.
 *
 * The proxy already knows which Claude Code session a request belongs to: the
 * client sends `x-claude-code-session-id`, and the TUI prints its first six hex
 * characters. That distinguishes concurrent sessions but does not name them.
 *
 * Claude Code stores the name on disk under `~/.claude/projects/<slug>/`. A
 * `/rename` writes `<session-id>/custom-title.json`; it also appends a
 * `custom-title` record to the transcript, which is the only copy for a session
 * renamed before the sidecar existed. Claude Code generates its own title as
 * well and appends it as an `ai-title` record, so most sessions have a usable
 * name without a rename.
 *
 * Lookups are cached and run off the render path: `get` returns what is cached
 * and schedules the read, so a frame never waits on the disk.
 */

import { readdir, readFile, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** A rename must reach the TUI without a restart, and a re-read costs one
 *  directory scan and one 64 KB read. */
const DEFAULT_TTL_MS = 30_000;

/** Measured across 218 transcripts: the last title record sits within 32.7 KB
 *  of EOF at p99 and 46.3 KB at the maximum. Reading more would only reach
 *  sessions that have written megabytes since their last title. */
const DEFAULT_TAIL_BYTES = 64 * 1024;

/** Columns the activity log gives the session label. Every row pays this width,
 *  named or not, so the columns after it stay aligned. A typed name fits: the
 *  longest in use is "adv-review-rewrite" at 18. A generated title is a sentence
 *  and is cut. */
const DEFAULT_WIDTH = 18;

/** The activity log falls back to this many hex characters of the session id,
 *  so a label can never be narrower. */
const SHORT_ID_LEN = 6;

export class SessionTitles {
  constructor({ projectsDir = DEFAULT_PROJECTS_DIR, ttlMs = DEFAULT_TTL_MS, tailBytes = DEFAULT_TAIL_BYTES, ...cfg } = {}) {
    this.projectsDir = projectsDir;
    this.ttlMs = ttlMs;
    this.tailBytes = tailBytes;
    /** @type {Map<string, {title: string|null, at: number}>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<string|null>>} */
    this.inflight = new Map();
    this.configure(cfg);
  }

  /** Apply a config change in place, so a reload takes effect without a
   *  restart. An absent key returns to its default. */
  configure(cfg) {
    const { enabled = true, width = DEFAULT_WIDTH } = cfg || {};
    this.enabled = enabled !== false;
    // A label narrower than the short id it falls back to would cut the id.
    this.width = Math.max(SHORT_ID_LEN, Math.trunc(width) || DEFAULT_WIDTH);
  }

  /** The settings in force, for the status readout. */
  settings() {
    return { enabled: this.enabled, width: this.width };
  }

  /** The cached title, or null. Never touches the disk: a miss or a stale entry
   *  schedules the read and the caller gets the previous answer until it lands. */
  get(sessionId, now = Date.now()) {
    if (!this.enabled || !sessionId) return null;
    const hit = this.cache.get(sessionId);
    if (!hit || now - hit.at >= this.ttlMs) this._schedule(sessionId, now);
    return hit ? hit.title : null;
  }

  /** Read the title now. Resolves to null when the session has none. */
  async resolve(sessionId, now = Date.now()) {
    if (!this.enabled || !sessionId) return null;
    return this._schedule(sessionId, now);
  }

  /** Number of reads in flight. */
  pending() {
    return this.inflight.size;
  }

  /** Settle every scheduled read. A resolve can schedule another, so this loops. */
  async idle() {
    while (this.inflight.size) await Promise.all([...this.inflight.values()]);
  }

  _schedule(sessionId, now) {
    const existing = this.inflight.get(sessionId);
    if (existing) return existing;
    // A missing title is cached like a found one: without that, every frame
    // would rescan the projects directory for a session that has no name.
    const read = this._read(sessionId)
      .catch(() => null)
      .then((title) => {
        this.cache.set(sessionId, { title, at: now });
        return title;
      })
      .finally(() => this.inflight.delete(sessionId));
    this.inflight.set(sessionId, read);
    return read;
  }

  /** The project directory is keyed by the session's cwd, which the proxy does
   *  not know, so each directory is tried until one holds the session. */
  async _read(sessionId) {
    const entries = await readdir(this.projectsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const project = join(this.projectsDir, entry.name);
      const renamed = await this._fromSidecar(join(project, sessionId, 'custom-title.json'));
      if (renamed) return renamed;
      const recorded = await this._fromTranscript(join(project, `${sessionId}.jsonl`));
      if (recorded) return recorded;
    }
    return null;
  }

  async _fromSidecar(path) {
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (raw == null) return null;
    try {
      return cleanTitle(JSON.parse(raw).customTitle);
    } catch {
      return null;
    }
  }

  async _fromTranscript(path) {
    const file = await open(path, 'r').catch(() => null);
    if (!file) return null;
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - this.tailBytes);
      const buffer = Buffer.alloc(Math.min(size, this.tailBytes));
      if (buffer.length) await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      // A window that does not start at byte 0 opens mid-line; that fragment is
      // not a JSON record.
      if (start > 0) lines.shift();
      return lastTitle(lines);
    } finally {
      await file.close();
    }
  }
}

/** A typed name wins wherever it sits in the file; otherwise the most recent
 *  generated one. Both are re-appended as a session runs, so the scan reads
 *  backwards and stops at the first match. */
function lastTitle(lines) {
  let generated = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Transcript lines are mostly multi-kilobyte messages; reject those on a
    // substring before paying for JSON.parse.
    if (!line || line[0] !== '{' || !line.includes('-title"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === 'custom-title') {
      const typed = cleanTitle(record.customTitle);
      if (typed) return typed;
    }
    if (record.type === 'ai-title' && !generated) generated = cleanTitle(record.aiTitle);
  }
  return generated;
}

function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}
