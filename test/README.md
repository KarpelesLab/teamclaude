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

## Clean up in `finally`

A failed assertion must not leave a server listening. A leaked handle keeps the
child's event loop alive and hangs the whole `node --test` run, not just the
file that leaked it — so one broken test costs the entire suite rather than one
red line. `remote-control-relay.test.js` has the pattern, including
`closeAllConnections()` for a server whose response deliberately never ends.

## Do not pin a date that will pass

A fixture asserting a timestamp is in the future stops testing anything the day
it goes stale, and the failure lands on whoever happens to run the suite next
rather than on whoever wrote it. Derive the value from `Date.now()`, or assert
the parse rather than the ordering. Both forms are in `quota-probe.test.js` and
`scoped-weekly.test.js` after #260.
