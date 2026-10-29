// The current time for relative labels ("in 2h 10m", "5s ago"). One shared
// one-second ticker, subscribed to only by the components that show such a
// label, so the rest of the window does not re-render every second. The timer
// runs only while something is subscribed.

import { useSyncExternalStore } from 'react';

export const TICK_MS = 1000;

const listeners = new Set<() => void>();
let current = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  current = Date.now();
  for (const listener of listeners) listener();
}

export function subscribeNow(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    // A label first drawn after an idle stretch would otherwise show the time
    // the ticker last stopped at.
    current = Date.now();
    timer = setInterval(tick, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function readNow(): number {
  return current;
}

export function useNow(): number {
  return useSyncExternalStore(subscribeNow, readNow);
}
