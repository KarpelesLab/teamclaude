// How the backend is launched. The packaged app carries a copy of the
// backend's src/ (zero runtime dependencies) as an extra resource outside the
// ASAR archive and runs it with Electron's own Node runtime
// (ELECTRON_RUN_AS_NODE=1) — so the user needs neither Node.js nor npm, and no
// PATH lookup is involved for anything the app requires.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface BackendLocation {
  /** Path of the backend's src/index.js. */
  entry: string;
  /** Package root (holds package.json); the child's working directory. */
  root: string;
  source: 'bundled' | 'checkout';
}

export function resolveBackendLocation(opts: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  exists?: (path: string) => boolean;
}): BackendLocation | null {
  const exists = opts.exists ?? existsSync;
  if (opts.packaged) {
    const root = join(opts.resourcesPath, 'backend');
    const entry = join(root, 'src', 'index.js');
    return exists(entry) ? { entry, root, source: 'bundled' } : null;
  }
  // Development: desktop/ sits inside the repository, so run the checkout's
  // own backend. Its .git directory also keeps the backend's self-updater off.
  const root = resolve(opts.appPath, '..');
  const entry = join(root, 'src', 'index.js');
  return exists(entry) ? { entry, root, source: 'checkout' } : null;
}

export function readBackendVersion(root: string, read: (p: string) => string = p => readFileSync(p, 'utf8')): string | null {
  try {
    const pkg: unknown = JSON.parse(read(join(root, 'package.json')));
    const version = pkg && typeof pkg === 'object' ? (pkg as { version?: unknown }).version : null;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * The child's command line and environment. Arguments are an array handed to
 * spawn() without a shell, so nothing in them is ever interpreted.
 */
export function backendSpawnSpec(execPath: string, location: BackendLocation, cliArgs: string[], baseEnv: NodeJS.ProcessEnv): SpawnSpec {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: '1',
    // The bundled backend is updated with the desktop app, never by npm.
    // Both prefixes: the new one wins when set, even to the empty string.
    TEAMROUTER_DISABLE_AUTOUPDATE: '1',
    TEAMCLAUDE_DISABLE_AUTOUPDATE: '1',
    TEAMROUTER_NO_TITLE: '1',
    TEAMCLAUDE_NO_TITLE: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  // The CLI opens the login URL with `start` through cmd on Windows (fixed
  // arguments, URL quoted); Node 24 flags every shell spawn with args as
  // DEP0190, which then shows up in the job output as if it were an error.
  return { command: execPath, args: ['--disable-warning=DEP0190', location.entry, ...cliArgs], cwd: location.root, env };
}
