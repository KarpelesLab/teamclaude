# Test conventions

Short list. Each entry is here because breaking it produced a test that passed
while checking nothing.

## A network-shaped test must not be able to reach a proxy

Any test that expects a **connection-level** outcome — refused, unresolvable,
reset, timed out — has to opt out of the ambient proxy configuration:

```js
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());
```

Both halves matter. `upstreamProxy: false` is the explicit opt-out, and the
empty second argument stops `resolveUpstreamProxy` falling back to
`process.env`.

Without it, a developer with `HTTPS_PROXY` or `ALL_PROXY` exported — common, and
the default on plenty of corporate machines — has the request tunneled rather
than refused. The proxy answers, the test asserts against a completely different
error shape, and it still passes. It fails to check the thing it was written
for, silently, and only on some machines.

`NO_PROXY=127.0.0.1` is the same hazard pointing the other way: it makes a test
that *wants* to go through a mock proxy quietly go direct. That is what
`87a7f78` fixed for the upstream-proxy e2e tests.

**A test that spawns a child process must scrub the variables too** — the child
inherits the shell, so the in-process guard does not reach it. See
`connect-error-message.test.js`.

## Run the suite through `npm test`

The tests point the CLI and the server at a throwaway config with the legacy
variable names (`TEAMCLAUDE_CONFIG`, `TEAMCLAUDE_DISABLE_AUTOUPDATE`, ...), and
`envVar` prefers the renamed spelling whenever it is set. A developer with
`TEAMROUTER_CONFIG` exported for their own install had the CLI tests write test
accounts into that real config. `npm test` loads `test-helpers/isolate-env.js`
first, which drops every `TEAMROUTER_*` variable; running one file directly,
pass the same flag, and the runner's timeout `npm test` sets:

```sh
node --test --import ./test-helpers/isolate-env.js --test-timeout=120000 test/cli-rename.test.js
```

The timeout is how a test that waits on the mechanism it checks, rather than
on the clock (see CONTRIBUTING.md), reports that mechanism broken: the test
hangs, and the timeout fails it (Node 20 and 22 fail its whole file at it; see
"Clean up in `finally`" below). `node --test` has none of its own. When nothing
else keeps the event loop alive, Node 20 and 22 still fail such a test
("Promise resolution is still pending but the event loop has already
resolved"; Node 20 read from its source), and Node 24 and later do not; a test
that holds a server or a socket open while it waits, as the end-to-end tests
here do, keeps the loop alive on any of them, and without the flag never
reports at all.

## Spawn the real server through `test-helpers/spawn-server.js`

A test that runs `src/index.js server --headless` as a child must not pick a
port itself and poll until "something answers". Files run in parallel, so the
port a probe just released can be taken before the child's `listen()` — and
if what took it was another test's in-process `createProxyServer`, its
`/teamclaude/status` answers 200, the poll is satisfied, and the test drives
the wrong server (a `POST /teamclaude/reload` there is a 501). `spawnServer()`
treats a status reply as readiness only when its `server.pid` is the child's
own, and respawns on a fresh port when the child lost the race. `closedPort()`
from the same module is still right for a *dead* upstream, where a port nothing
listens on is the point.

The helper lives outside `test/` because node's default test glob is
`**/test/**/*.js`: anything under this directory is run as a test file.

## Clean up in `finally`

A failed assertion must not leave a server listening. A leaked handle keeps the
child's event loop alive, and on Node 24 and later that hangs the whole
`node --test` run, even under `npm test`'s `--test-timeout`, not just the file
that leaked it — so one broken test costs the entire suite rather than one red
line (Node 20 and 22 kill the file at that timeout instead: one red line for
the file). `remote-control-relay.test.js` has the pattern, including
`closeAllConnections()` for a server whose response deliberately never ends.

A `finally` runs only once the wait above it settles. When the failure under
test leaves that wait pending (a request never answered, say), node:test fails
the test, on the error that escaped or on its timeout, but does not unwind it,
and the `finally` never runs. On Node 24 and later the servers the test opened
then keep the file from ever exiting. Node 20 and 22 also apply the runner's
timeout (see above) to each file as a whole and kill the file at it instead: a
test that fails sooner, on an escaped error, is named and the tests after it
run, but nothing after a test stuck until the runner's timeout reports. Ending the wait is what lets the `finally` run:
listen on `t.signal`, which node:test aborts once the test has ended however it
ended, and destroy the socket the wait is on or pass the signal to `fetch`, as
the relayRaw tests in `overage-headers.test.js` do. A cleanup with no wait of
its own to end can be registered with `t.after`, which runs at that point too,
as `withFleet` in `stream-failure-failover.test.js` does.

## Do not pin a date that will pass

A fixture asserting a timestamp is in the future stops testing anything the day
it goes stale, and the failure lands on whoever happens to run the suite next
rather than on whoever wrote it. Derive the value from `Date.now()`, or assert
the parse rather than the ordering. Both forms are in `quota-probe.test.js` and
`scoped-weekly.test.js` after #260.
