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
import { SESSION_KNOWN_TTL_MS } from './session-tracker.js';

const DEFAULT_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** A rename must reach the TUI without a restart, and a re-read costs one
 *  directory scan and one 64 KB read. */
const DEFAULT_TTL_MS = 30_000;

/** An entry that no visible row has refreshed for this long is dropped, so the
 *  cache holds the sessions the tracker still knows and not every id the
 *  process has ever seen. Same window as the tracker's known list. */
const DEFAULT_MAX_AGE_MS = SESSION_KNOWN_TTL_MS;

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

/** The session id is a request header, so it is client input. Claude Code sends
 *  a UUID; anything else never reaches the filesystem, where `path.join` would
 *  follow a `..` out of the projects directory. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SessionTitles {
  constructor({ ttlMs = DEFAULT_TTL_MS, tailBytes = DEFAULT_TAIL_BYTES, maxAgeMs = DEFAULT_MAX_AGE_MS, ...cfg } = {}) {
    this.ttlMs = ttlMs;
    this.tailBytes = tailBytes;
    this.maxAgeMs = maxAgeMs;
    this.sweptAt = 0;
    /** @type {Map<string, {title: string|null, at: number}>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<string|null>>} */
    this.inflight = new Map();
    this.projectsDir = null;
    this.configure(cfg);
  }

  /** Apply a config change in place, so a reload takes effect without a
   *  restart. An absent key returns to its default. Off unless asked for: this
   *  reads the transcripts of every session the proxy sees, which is further
   *  than the proxy reaches for anything else by default. */
  configure(cfg) {
    const { enabled = false, width = DEFAULT_WIDTH, projectsDir = DEFAULT_PROJECTS_DIR } = cfg || {};
    this.enabled = enabled === true;
    // A label narrower than the short id it falls back to would cut the id.
    this.width = Math.max(SHORT_ID_LEN, Math.trunc(width) || DEFAULT_WIDTH);
    // Titles cached from one directory say nothing about another.
    if (projectsDir !== this.projectsDir) this.cache.clear();
    this.projectsDir = projectsDir;
  }

  /** The settings in force, for the status readout. */
  settings() {
    return { enabled: this.enabled, width: this.width, projectsDir: this.projectsDir };
  }

  /** The cached title, or null. Never touches the disk: a miss or a stale entry
   *  schedules the read and the caller gets the previous answer until it lands. */
  get(sessionId, now = Date.now()) {
    if (!this.enabled || !isSessionId(sessionId)) return null;
    this._evict(now);
    const hit = this.cache.get(sessionId);
    if (!hit || now - hit.at >= this.ttlMs) this._schedule(sessionId, now);
    return hit ? hit.title : null;
  }

  /** Read the title now. Resolves to null when the session has none. */
  async resolve(sessionId, now = Date.now()) {
    if (!this.enabled || !isSessionId(sessionId)) return null;
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

  /** Drop entries no row has refreshed within the window. A visible session is
   *  re-read every TTL, which keeps its entry young; one that left the screen
   *  ages out. Runs at most once per TTL, so a frame does not pay for it. */
  _evict(now) {
    if (now - this.sweptAt < this.ttlMs) return;
    this.sweptAt = now;
    for (const [sessionId, { at }] of this.cache) {
      if (now - at >= this.maxAgeMs) this.cache.delete(sessionId);
    }
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

function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** A title is printed inside a terminal escape and written to the activity log
 *  file, so a control character in it (an ESC, a newline) is not a title, it
 *  is an injection. Each becomes a space and runs of whitespace collapse. */
function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}
