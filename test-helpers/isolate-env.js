// Loaded before every test file by `npm test` (`node --test --import`), which
// passes the flag on to each file's child process.
//
// The tests point the CLI and the server at a throwaway config by setting the
// LEGACY variable names (`TEAMCLAUDE_CONFIG`, `TEAMCLAUDE_DISABLE_AUTOUPDATE`,
// ...), and spawn children with `{ ...process.env, TEAMCLAUDE_CONFIG: tmp }`.
// But `envVar` (src/brand.js) prefers the RENAMED spelling whenever it is set:
// a developer with `TEAMROUTER_CONFIG` exported for their own install had
// `npm test` write test accounts into that real config - the one holding
// every account's tokens - while the tests failed for a reason they could not
// see. Dropping every `TEAMROUTER_*` variable here leaves each test's legacy
// setting the one that wins, as it was written to.

for (const name of Object.keys(process.env)) {
  if (name.startsWith('TEAMROUTER_')) delete process.env[name];
}
