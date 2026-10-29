// The only bridge between the sandboxed renderer and the main process. It
// exposes two functions and no Node.js API; every call is validated again in
// the main process (main/ipc.ts), so this file grants nothing by itself.
//
// Self-contained on purpose: a sandboxed preload can require only 'electron',
// so the channel names are repeated here; tests/preload.spec.ts checks they
// match src/shared/ipc.ts.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const CALL_CHANNEL = 'tc:call';
const EVENT_CHANNEL = 'tc:event';

contextBridge.exposeInMainWorld('teamclaude', {
  call: (method: string, args?: unknown): Promise<unknown> => ipcRenderer.invoke(CALL_CHANNEL, method, args),
  onEvent: (listener: (event: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(EVENT_CHANNEL, handler); };
  },
});
