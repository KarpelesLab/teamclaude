// A point a test holds something at until the test itself says to go on.
//
// A stub that has to be "slow" (an upstream that answers after the client has
// left, a stream whose next chunk comes after the proxy released its head) is
// not slow by a timer here: it awaits a gate, and the test opens the gate once
// it has seen the event the stub was to come after. The order is then the
// test's to state, whatever the machine is doing, where a timer only makes the
// order likely (CONTRIBUTING.md, "assert the mechanism rather than the clock").
//
// Not Promise.withResolvers: the suite runs on Node 20, which lacks it.
//
// Lives outside test/ because node's default test glob runs everything there.

/**
 * @typedef {object} Gate
 * @property {Promise<void>} opened settles once `open` has been called
 * @property {() => void} open let whatever awaits `opened` go on; calling it again does nothing
 * @property {() => boolean} isOpen whether `open` has been called
 */

/**
 * @param {AbortSignal} [signal] opens the gate when it aborts. Pass a test's
 *   `t.signal` so that a stub still held when the test has ended (it failed
 *   before reaching its `open`) is let go, and the servers behind it can close.
 * @returns {Gate}
 */
export function gate(signal) {
  let open = () => {};
  let isOpen = false;
  /** @type {Promise<void>} */
  const opened = new Promise((resolve) => { open = () => { isOpen = true; resolve(); }; });
  if (signal?.aborted) open();
  else signal?.addEventListener('abort', open, { once: true });
  return { opened, open, isOpen: () => isOpen };
}
