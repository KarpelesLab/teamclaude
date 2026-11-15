import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// Preloaded into a CLI child (`node --import <this file> src/index.js ...`) to
// stage, without any timing, the race a config-changing command has with a
// running server: the server saving a rotated refresh token after the command
// has loaded the config and before the command writes it.
//
// Every config write takes the advisory lock first, by creating
// `<config>.lock`, and a command's opening read takes no lock. So the first
// attempt to create that lock file is a point that is always after the read
// and before the write. Right there, before the lock is taken, the file named
// by TEAMCLAUDE_TEST_RACE_WITH is renamed over the config: the "server's" save,
// landing in exactly the window the command leaves open.
//
// The rename consumes the staged file, which is how a test knows the race was
// actually run: a command that never reached the lock leaves it behind.
//
// Lives outside test/ because node's default test glob runs everything there.

const configPath = process.env.TEAMCLAUDE_CONFIG;
const racePath = process.env.TEAMCLAUDE_TEST_RACE_WITH;

if (configPath && racePath) {
  const lockPath = `${configPath}.lock`;
  const openSync = fs.openSync;
  let staged = false;
  fs.openSync = /** @type {typeof fs.openSync} */ (function (path, ...rest) {
    if (!staged && path === lockPath) {
      staged = true;
      fs.renameSync(racePath, configPath);
    }
    return openSync.call(fs, path, ...rest);
  });
  // config.js imports openSync by name; this is what makes that binding the
  // wrapper above.
  syncBuiltinESMExports();
}
