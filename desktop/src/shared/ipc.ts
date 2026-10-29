// The whole renderer ↔ main contract. The preload exposes exactly two
// functions — `call(method, args)` and `onEvent(cb)` — over two channels; the
// main process validates every method name against METHODS and every argument
// against its validator before anything runs. Adding a capability means adding
// a row here, which keeps the privileged surface reviewable in one file.

import type { History, HistoryDelta } from './activity';
import type {
  ActionResult, AppUpdateState, BackendState, CoreUpdateState, IdeId, DesktopSettings, DistributionMode, IntegrationInfo, JobView, LogLine,
  SystemInfo, UpdateCheckResult,
} from './types';

export const CALL_CHANNEL = 'tc:call';
export const EVENT_CHANNEL = 'tc:event';

export interface BackendAccountInput {
  name: string;
  upstream: string;
  apiKey: string;
  auth: 'x-api-key' | 'bearer';
  modelMap: Record<string, string>;
  priority?: number;
}

/** Arguments and result of every callable method. */
export interface Methods {
  'backend.getState': { args: void; result: BackendState };
  'backend.start': { args: void; result: ActionResult };
  'backend.stop': { args: void; result: ActionResult };
  'backend.restart': { args: void; result: ActionResult };
  'backend.refresh': { args: void; result: BackendState };
  'backend.reload': { args: void; result: ActionResult };
  'backend.probe': { args: void; result: ActionResult };

  'accounts.switch': { args: { account: string }; result: ActionResult };
  'accounts.setDisabled': { args: { account: string; disabled: boolean }; result: ActionResult };
  'accounts.setPriority': { args: { account: string; priority: number }; result: ActionResult };
  'accounts.login': { args: { provider: 'claude' | 'codex'; name?: string }; result: JobView };
  'accounts.addApiKey': { args: { name?: string; apiKey: string; priority?: number }; result: JobView };
  'accounts.addBackend': { args: BackendAccountInput; result: JobView };
  'accounts.testBackend': { args: BackendAccountInput & { model: string }; result: { ok: boolean; code: 'ok' | 'http' | 'network' | 'invalid'; status?: number } };
  'accounts.import': { args: { name?: string }; result: JobView };
  'accounts.remove': { args: { account: string }; result: JobView };
  'accounts.rename': { args: { account: string; newName: string }; result: JobView };

  'routing.setThreshold': { args: { percent: number }; result: ActionResult };
  'routing.setDistribution': { args: { mode: DistributionMode }; result: JobView };
  'routing.setProbe': { args: { seconds: number }; result: JobView };
  'routing.setWarmup': { args: { seconds: number }; result: JobView };

  'jobs.list': { args: void; result: JobView[] };
  'jobs.cancel': { args: { id: number }; result: ActionResult };

  'logs.get': { args: void; result: LogLine[] };
  'logs.clear': { args: void; result: ActionResult };
  'logs.readCrashLog': { args: void; result: string | null };

  'history.get': { args: void; result: History };

  'settings.get': { args: void; result: DesktopSettings };
  'settings.update': { args: Partial<DesktopSettings>; result: DesktopSettings };

  'system.info': { args: void; result: SystemInfo };
  'system.integrations': { args: void; result: IntegrationInfo };
  'system.openDashboard': { args: void; result: ActionResult };
  'system.openConfigDir': { args: void; result: ActionResult };
  'system.openExternal': { args: { target: ExternalLink }; result: ActionResult };
  'system.copyText': { args: { text: string }; result: ActionResult };
  'system.exportDiagnostics': { args: void; result: ActionResult };
  'system.checkForUpdates': { args: void; result: UpdateCheckResult };
  'system.openTerminal': { args: void; result: ActionResult };

  'appUpdate.getState': { args: void; result: AppUpdateState };
  'appUpdate.check': { args: void; result: AppUpdateState };
  'appUpdate.download': { args: void; result: AppUpdateState };
  'appUpdate.install': { args: void; result: ActionResult };

  'coreUpdate.getState': { args: void; result: CoreUpdateState };
  'coreUpdate.check': { args: void; result: CoreUpdateState };
  'coreUpdate.install': { args: void; result: CoreUpdateState };
  'coreUpdate.revert': { args: void; result: ActionResult };

  'ide.connect': { args: { id: IdeId }; result: ActionResult };
  'ide.disconnect': { args: { id: IdeId }; result: ActionResult };
  'ide.openFolder': { args: { id: IdeId }; result: ActionResult };

  'profiles.apply': { args: { id: string }; result: ActionResult };
  'usage.exportCsv': { args: void; result: ActionResult };
  'backup.export': { args: { passphrase: string }; result: ActionResult };
  'backup.import': { args: { passphrase: string }; result: ActionResult };
}

/** Links the main process opens, by a fixed list. */
export type ExternalLink = 'repository' | 'issues' | 'docs' | 'releases' | 'license' | 'desktopReleases';

export type MethodName = keyof Methods;
export type MethodArgs<M extends MethodName> = Methods[M]['args'];
export type MethodResult<M extends MethodName> = Methods[M]['result'];

/** Events pushed from main to the renderer. */
export type DesktopEvent =
  | { type: 'backend'; state: BackendState }
  | { type: 'history'; delta: HistoryDelta }
  | { type: 'appUpdate'; state: AppUpdateState }
  | { type: 'coreUpdate'; state: CoreUpdateState }
  | { type: 'log'; lines: LogLine[] }
  | { type: 'job'; job: JobView }
  | { type: 'settings'; settings: DesktopSettings }
  | { type: 'navigate'; page: PageId };

export type PageId =
  | 'overview' | 'accounts' | 'sessions' | 'activity' | 'usage' | 'health' | 'routing'
  | 'integrations' | 'settings' | 'logs' | 'about';

/** The API the preload puts on `window.teamclaude`. */
export interface DesktopApi {
  call<M extends MethodName>(method: M, ...args: MethodArgs<M> extends void ? [] : [MethodArgs<M>]): Promise<MethodResult<M>>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
}
