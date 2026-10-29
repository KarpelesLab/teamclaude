// Renderer state: the latest BackendState pushed by the main process, the
// settings, log lines, CLI jobs, and the activity timeline and chart samples
// the main process keeps (shared/activity.ts): the whole history once at
// load, then each reading's additions.

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import {
  appendHistory, EMPTY_HISTORY, freshPart, mergeSnapshot,
  type ActivityEvent, type History, type HistoryDelta, type QuotaPoint, type Sample,
} from '../shared/activity';
import type { DesktopEvent, PageId } from '../shared/ipc';
import type { ActionResult, AppUpdateState, BackendState, CoreUpdateState, DesktopSettings, JobView, LogLine } from '../shared/types';
import { bridge, call } from './api';
import { setLanguage, t } from './i18n';

interface Data {
  backend: BackendState | null;
  settings: DesktopSettings | null;
  logs: LogLine[];
  jobs: JobView[];
  activity: ActivityEvent[];
  samples: Sample[];
  quota: QuotaPoint[];
  appUpdate: AppUpdateState | null;
  coreUpdate: CoreUpdateState | null;
  loadError: string | null;
}

type Action =
  | { type: 'backend'; state: BackendState }
  | { type: 'history'; history: History }
  | { type: 'historyDelta'; delta: HistoryDelta }
  | { type: 'appUpdate'; state: AppUpdateState }
  | { type: 'coreUpdate'; state: CoreUpdateState }
  | { type: 'settings'; settings: DesktopSettings }
  | { type: 'logs'; lines: LogLine[]; replace?: boolean }
  | { type: 'job'; job: JobView }
  | { type: 'jobs'; jobs: JobView[] }
  | { type: 'loadError'; message: string };

const MAX_LOGS = 5000;

function reduce(data: Data, action: Action): Data {
  switch (action.type) {
    case 'backend':
      return { ...data, backend: action.state };
    case 'history':
      return { ...data, ...mergeSnapshot(action.history, data) };
    case 'historyDelta':
      return { ...data, ...appendHistory(data, freshPart(data, action.delta)) };
    case 'appUpdate':
      return { ...data, appUpdate: action.state };
    case 'coreUpdate':
      return { ...data, coreUpdate: action.state };
    case 'settings':
      return { ...data, settings: action.settings };
    case 'logs': {
      const merged = action.replace ? action.lines : [...data.logs, ...action.lines];
      return { ...data, logs: merged.slice(-MAX_LOGS) };
    }
    case 'job': {
      const exists = data.jobs.some(j => j.id === action.job.id);
      return { ...data, jobs: exists ? data.jobs.map(j => (j.id === action.job.id ? action.job : j)) : [...data.jobs, action.job] };
    }
    case 'jobs':
      return { ...data, jobs: action.jobs };
    case 'loadError':
      return { ...data, loadError: action.message };
  }
}

export interface Toast {
  id: number;
  ok: boolean;
  message: string;
}

interface Store extends Data {
  page: PageId;
  setPage: (page: PageId) => void;
  toasts: Toast[];
  toast: (ok: boolean, message: string) => void;
  /** Run an action and toast its outcome; never throws. */
  run: (action: () => Promise<ActionResult>) => Promise<ActionResult>;
  clearLogs: () => void;
}

const StoreContext = createContext<Store | null>(null);

const INITIAL: Data = { backend: null, settings: null, logs: [], jobs: [], ...EMPTY_HISTORY, appUpdate: null, coreUpdate: null, loadError: null };

let toastSeq = 0;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, dispatch] = useReducer(reduce, INITIAL);
  const [page, setPage] = useState<PageId>('overview');
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const api = bridge();
    if (!api) {
      dispatch({ type: 'loadError', message: t('app.bridgeMissing') });
      return;
    }
    const off = api.onEvent((event: DesktopEvent) => {
      switch (event.type) {
        case 'backend': dispatch({ type: 'backend', state: event.state }); break;
        case 'history': dispatch({ type: 'historyDelta', delta: event.delta }); break;
        case 'appUpdate': dispatch({ type: 'appUpdate', state: event.state }); break;
        case 'coreUpdate': dispatch({ type: 'coreUpdate', state: event.state }); break;
        case 'log': dispatch({ type: 'logs', lines: event.lines }); break;
        case 'job': dispatch({ type: 'job', job: event.job }); break;
        case 'settings': dispatch({ type: 'settings', settings: event.settings }); break;
        case 'navigate': setPage(event.page); break;
      }
    });
    Promise.all([call('backend.getState'), call('settings.get'), call('logs.get'), call('jobs.list'), call('history.get'), call('appUpdate.getState'), call('coreUpdate.getState')])
      .then(([state, settings, logs, jobs, history, appUpdate, coreUpdate]) => {
        dispatch({ type: 'backend', state });
        dispatch({ type: 'history', history });
        dispatch({ type: 'appUpdate', state: appUpdate });
        dispatch({ type: 'coreUpdate', state: coreUpdate });
        dispatch({ type: 'settings', settings });
        dispatch({ type: 'logs', lines: logs, replace: true });
        dispatch({ type: 'jobs', jobs });
      })
      .catch((err: Error) => dispatch({ type: 'loadError', message: err.message }));
    return off;
  }, []);

  // Set during render, not in an effect: the pages below read t() in this
  // same render pass, so the switch takes effect without a second render.
  if (data.settings) setLanguage(data.settings.language);

  // Theme follows the settings.
  useEffect(() => {
    const s = data.settings;
    if (!s) return;
    const apply = () => {
      const dark = s.theme === 'dark' || (s.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    if (s.theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [data.settings]);

  const toast = useCallback((ok: boolean, message: string) => {
    const id = ++toastSeq;
    setToasts(list => [...list.slice(-3), { id, ok, message }]);
    setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), ok ? 3500 : 7000);
  }, []);

  const run = useCallback(async (action: () => Promise<ActionResult>) => {
    try {
      const result = await action();
      toast(result.ok, result.message);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast(false, message);
      return { ok: false, message };
    }
  }, [toast]);

  const clearLogs = useCallback(() => {
    void call('logs.clear').then(() => dispatch({ type: 'logs', lines: [], replace: true }));
  }, []);

  const value = useMemo<Store>(() => ({ ...data, page, setPage, toasts, toast, run, clearLogs }), [data, page, toasts, toast, run, clearLogs]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore outside StoreProvider');
  return store;
}
