# TeamClaude Desktop — architecture

TeamClaude Desktop is a graphical control panel for the local TeamClaude
proxy on Windows 10/11 x64 and Linux x64. It lives in `desktop/` as a separate
package. It is another way to drive the proxy you already run, not a new
client for subscription quota: model traffic flows through the backend. The
desktop does not persist account credentials; a user-entered API key exists
temporarily in the form and main process for saving or testing a service.

## Principles

- **The backend stays the source of truth.** Routing, OAuth, quota tracking
  and the config file belong to TeamClaude. The desktop reads state from the
  control API and changes it through the control API or the CLI. It keeps no
  second routing config.
- **No runtime dependencies added to the core.** The proposal adds an
  `add-backend` CLI command accepting validated JSON on stdin, saving through
  the existing config lock and notifying a running server. Existing CLI
  commands work the same with or without the desktop app installed.
- **Stored account credentials stay out of the renderer.** The renderer never
  reads OAuth tokens, existing account keys or the config file. User-entered
  API keys are passed through validated IPC and CLI stdin, never command-line
  arguments; connection testing happens only in the main process. The main process reads four proxy
  fields from the config (host, port, `proxy.apiKey`, `trustLoopback`) and the
  number of accounts, and nothing else.
- **Connection tests are explicit.** A short request is sent to the selected
  service/model with a 20-second timeout, redirects disabled and a bounded
  response size. Only a success category or HTTP status returns to the UI,
  never upstream response text or exceptions that might echo a key. The form
  says a service may bill the request. Local HTTP services are supported.
- **Nothing runs on its own until the user turns it on.** Launch at login,
  starting the proxy on launch and restart after a crash are all off by
  default. The app sends no telemetry and starts no quota probes to produce
  notifications. App and proxy-core update checks are also off by default.

## Process model

```
┌──────────────── Electron main process ─────────────────┐
│ main/index.ts      lifecycle, single instance, window  │
│ main/tray.ts       tray icon and menu                  │
│ main/ipc.ts        one channel; validates every call   │
│ main/handlers.ts   the allow-listed methods            │
│ main/notifications.ts                                  │
│                                                        │
│ services/  (no Electron imports; unit-tested)          │
│   backend-manager  attach / start / stop / crash policy│
│   backend-client   HTTP to /teamclaude/* (node:http)   │
│   job-runner       CLI jobs: login, import, remove …   │
│   normalize        status payload → view models        │
│   sanitize         redaction of logs and errors        │
│   validate         IPC argument validation             │
└───────┬────────────────────────────┬───────────────────┘
        │ contextBridge (2 functions) │ spawn, no shell
┌───────▼──────────┐         ┌───────▼───────────────────────────┐
│ Renderer (React) │         │ TeamClaude backend                 │
│ sandboxed, CSP,  │         │ src/index.js server --headless     │
│ no Node APIs     │         │ run by Electron's Node             │
└──────────────────┘         │ (ELECTRON_RUN_AS_NODE=1)           │
                             └────────────────────────────────────┘
```

### What the desktop uses from the backend

| Need | Mechanism |
| --- | --- |
| State, accounts, quota, sessions, routes | `GET /teamclaude/status` |
| Switch preferred account | `POST /teamclaude/switch` |
| Priority, enable/disable | `POST /teamclaude/priority`, `POST /teamclaude/disable` |
| Switch threshold | `POST /teamclaude/threshold` |
| Re-read config, quota probe | `POST /teamclaude/reload`, `POST /teamclaude/probe` |
| Sign in (Claude OAuth, Codex), import, API key, remove, rename | CLI: `login --oauth`, `login --codex`, `import`, `login --api`, `remove`, `rename` |
| Distribution, background probe, warm-up | CLI: `distribute`, `probe`, `warmup` |
| Browser dashboard | opens `GET /teamclaude/dashboard` in the system browser |

The legacy `/teamclaude/` prefix is used on purpose: every backend version
answers to it, while `/teamrouter/` exists only from the rename onward.
Config and environment resolution mirror the backend (`TEAMROUTER_*` first,
then `TEAMCLAUDE_*`; `teamrouter.json` when it exists, else
`teamclaude.json`).

The control API refuses requests that look like they come from a web page
(`Origin`, `Sec-Fetch-Site`). The desktop client is built on `node:http`, so
it sends exactly the headers it sets and none of those. When the config sets
`proxy.apiKey`, the main process sends it as `x-api-key`; it never leaves the
main process.

CLI jobs run with a fixed argument array and no shell. Account names are
validated so they cannot start with `-`. An API key is written to the child's
stdin, never placed in argv. Job output is sanitized before the renderer sees
it. The CLI owns the OAuth flow: it opens the system browser and receives the
callback itself; the desktop never handles a token.

## Backend lifecycle

`services/backend-manager.ts` is a state machine with these phases:
`stopped`, `starting`, `running`, `stopping`, `unreachable`, `port-conflict`,
`error`, `crash-loop`. Ownership is `owned` (this app started it), `external`
(started elsewhere — a terminal, `systemd --user`, another desktop) or `none`.

- **Readiness is an answer, not a timer.** After spawning, the manager polls
  `/teamclaude/status` until a TeamClaude status payload arrives, with a
  45-second deadline. A payload whose `server.pid` is another process means a
  different TeamClaude took the port.
- **Attach before start.** Start first probes the port. A TeamClaude server is
  attached to; something else on the port is reported as `port-conflict` and
  left alone. The app never kills a process it did not start.
- **Stop only what we own.** An external server is never stopped; the UI says
  where to stop it (including `systemctl --user stop teamclaude` when the
  `systemd --user` unit is installed).
- **Shutdown.** On Linux, SIGTERM, which the backend handles by saving its
  quota state, then SIGKILL after 6 seconds. On Windows `kill()` ends the
  process at once; the backend writes its config atomically.
- **Crash policy.** A crash is shown with the exit code and the last lines of
  output. Restart is opt-in (`restartOnCrash`) with backoff (2 s, 4 s, 8 s); a
  fourth crash within five minutes stops retrying (`crash-loop`).
- **Adoption.** The pid of an owned backend is kept in `runtime.json` in the
  app's user data directory. If the app restarts and finds that pid serving,
  it treats the server as its own again.
- **Polling.** Every 2 s while the window is visible, every 10 s while it is
  hidden. Status polling is a local request; it costs no quota.
- **History.** The main process diffs successive readings into the activity
  timeline, the overview chart's samples and each account's quota
  utilization (`shared/activity.ts`, last 500 events, 180 samples and 12
  hours of one-a-minute quota points, memory only). The window gets the whole history
  when it loads and each reading's additions after that, so a window reloaded
  or first opened from the tray still shows what happened while it was
  hidden. Entries hold raw values and are worded in the renderer.

## Bundled runtime

The packaged app ships a copy of the backend's `src/` (zero runtime
dependencies) as an extra resource outside `app.asar`
(`resources/backend/`). It runs with Electron's own Node runtime through
`ELECTRON_RUN_AS_NODE=1`, so the user needs neither Node.js nor npm, and no
PATH lookup is involved. The backend's self-updater is turned off for this
copy (`TEAMCLAUDE_DISABLE_AUTOUPDATE=1`); it is updated with the app.

In development (`npm run dev`), the desktop runs the repository's own
`src/index.js` instead.

## Security

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  no `webview`, no permissions granted to the page.
- Content Security Policy: `default-src 'none'; script-src 'self'; …;
  connect-src 'none'`. The renderer cannot make network requests at all.
- Navigation away from the bundled page and new windows are refused.
- The preload exposes two functions, `call(method, args)` and
  `onEvent(listener)`. Every method name is checked against an allow-list and
  every argument against a validator (`services/validate.ts`); calls from any
  other page URL are refused.
- External links go through the main process by a fixed list (repository,
  issues, docs, releases, license).
- Log lines, job output, errors and diagnostic reports pass through
  `services/sanitize.ts` (tokens, keys, JWTs, auth headers, cookies, URL
  passwords, OAuth codes). Diagnostic reports number accounts instead of
  naming them and never include the config file.
- The backend's own defaults are untouched: loopback bind, Origin checks,
  `proxy.apiKey`.

## Desktop preferences

Kept in Electron's user data directory (`settings.json`, `runtime.json`),
written atomically with mode `0600`, separate from the TeamClaude config.
Uninstalling the app does not remove the TeamClaude config or accounts.

## Versioning

| Version | Where |
| --- | --- |
| Desktop version | `desktop/package.json` |
| Bundled backend version | root `package.json` at build time, copied into `resources/backend/package.json` |
| Minimum compatible backend | `MIN_BACKEND_VERSION` in `desktop/src/main/index.ts` (1.1.0) |

A backend older than the minimum is reported in the UI with a clear message
instead of failing; a backend that reports no release version (a development
checkout) is allowed with a warning.

## Distribution

Builds are unsigned and produced with `--publish never`. Per `SECURITY.md`,
third-party installers must not be presented as official releases. The
`desktop` workflow builds artifacts for review only; a release workflow and
code signing wait for agreement with the maintainers. Automatic app and core
update checks are off by default. Manual registry checks can compare the bundled
and attached backend versions; installing an npm core is an explicit action or
requires opting into automatic core updates. The desktop app has no release
feed in this proposal, so its updater reports that it is unavailable.

## Known limitations

- Wayland: the tray depends on the desktop environment's StatusNotifier
  support. Without a tray the app keeps working; closing the window then
  quits the app.
- The VS Code extension integration is documented, not verified by this app.
- The Windows libuv assertion
  (`!(handle->flags & UV_HANDLE_CLOSING)`, `src\win\async.c`) has not been
  reproduced with the bundled Electron runtime. If it occurs, the backend's
  exit code and last output are shown and the crash log can be opened from
  the Logs page; it is not hidden.
- Sessions are listed individually only when the server reports per-session
  detail; otherwise the app shows the aggregate counts the API provides.
