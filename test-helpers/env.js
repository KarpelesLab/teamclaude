// Run a test body under environment settings, and put the environment back.
//
// The proxy reads its TEAMCLAUDE_* tuning per call rather than at import, so
// that a test can shrink a bound (a 64 MiB hold limit, a two-minute deadline)
// to something it can cross in a few KiB or a few hundred milliseconds. The
// environment is the whole process's, though, and a value left behind by a
// failed assertion changes every test after it in the file: hence the restore
// in `finally`, in one place instead of once per test.

/**
 * @template T
 * @param {Record<string, string|number|null|undefined>} vars  null or undefined unsets
 * @param {() => T|Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withEnv(vars, fn) {
  /** @type {Record<string, string|undefined>} */
  const previous = {};
  for (const [name, value] of Object.entries(vars)) {
    previous[name] = process.env[name];
    if (value == null) delete process.env[name];
    else process.env[name] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
