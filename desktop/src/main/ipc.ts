// The single IPC entry point. A call is served only when it comes from the
// app's own page in the top frame, names a known method, and its arguments
// pass that method's validator (services/validate.ts).

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { CALL_CHANNEL, type MethodArgs, type MethodName, type MethodResult } from '../shared/ipc';
import { validateCall } from '../services/validate';
import { isTrustedUrl } from './window';

export type Handlers = { [M in MethodName]: (args: MethodArgs<M>) => Promise<MethodResult<M>> | MethodResult<M> };

function trustedSender(event: IpcMainInvokeEvent, expectedUrl: string): boolean {
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  return isTrustedUrl(frame.url, expectedUrl);
}

export function registerIpc(handlers: Handlers, expectedUrl: string): void {
  ipcMain.handle(CALL_CHANNEL, async (event, method: unknown, args: unknown) => {
    if (!trustedSender(event, expectedUrl)) throw new Error('refused: call from an untrusted frame');
    const checked = validateCall(method, args);
    if (!checked.ok) throw new Error(`refused: ${checked.error}`);
    const handler = handlers[checked.method] as (a: unknown) => unknown;
    return handler(checked.args);
  });
}
