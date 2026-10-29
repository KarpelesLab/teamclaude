// Typed access to the preload bridge. The renderer has no other way to reach
// the system.

import type { DesktopApi, MethodArgs, MethodName, MethodResult } from '../shared/ipc';

declare global {
  interface Window {
    teamclaude?: DesktopApi;
  }
}

export function bridge(): DesktopApi | null {
  return window.teamclaude ?? null;
}

/** Call a main-process method; IPC errors come back as a rejected promise with a readable message. */
export async function call<M extends MethodName>(method: M, ...args: MethodArgs<M> extends void ? [] : [MethodArgs<M>]): Promise<MethodResult<M>> {
  const api = bridge();
  if (!api) throw new Error('The desktop bridge is not available.');
  try {
    return await api.call(method, ...args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Electron prefixes "Error invoking remote method 'tc:call': Error: ".
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
}
