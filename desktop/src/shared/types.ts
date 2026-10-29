// View models shared by the main process and the renderer. The renderer never
// sees the backend's raw /teamclaude/status payload: services/normalize.ts maps
// it onto these shapes, so a React component never depends on the server's
// internal field names and a field the server drops reads as `null`, not as a
// crash.

/** Lifecycle of the proxy as the desktop app sees it. */
export type ProxyPhase =
  | 'stopped' // nothing answers on the configured port
  | 'starting' // we spawned a backend and wait for it to answer
  | 'running' // a TeamClaude server answers /teamclaude/status
  | 'stopping'
  | 'unreachable' // it answered before, and stopped answering
  | 'port-conflict' // something that is not TeamClaude holds the port
  | 'error' // the backend we spawned exited or never became ready
  | 'crash-loop'; // automatic restart gave up after repeated crashes

/** Who started the server that answers on the port. */
export type Ownership = 'owned' | 'external' | 'none';

export interface QuotaWindow {
  /** 0..1 as reported upstream, or null when no reading exists. */
  utilization: number | null;
  /** Epoch ms of the next reset, or null when unknown. */
  resetAt: number | null;
  /** Epoch ms when upstream last stated this value, or null when unknown. */
  seenAt: number | null;
}

export interface NamedQuotaWindow extends QuotaWindow {
  label: string;
}

export interface AccountErrorView {
  code: string;
  detail: string;
  remedy: string | null;
}

export interface AccountView {
  /** Position in the server's account list (status order). */
  index: number;
  name: string;
  /** 'oauth' | 'apikey' | backend-specific type, as the server names it. */
  type: string;
  /** 'claude' | 'codex' | … — the pool the account belongs to. */
  provider: string;
  orgName: string | null;
  priority: number;
  disabled: boolean;
  /** Server's own state word: 'active' | 'exhausted' | 'error' | … */
  status: string;
  /** Why rotation will not use it right now; null = it can serve. */
  unavailable: string | null;
  error: AccountErrorView | null;
  isCurrent: boolean;
  sessions: number;
  knownSessions: number;
  fiveHour: QuotaWindow;
  /**
   * Whether the last reading that stated a window stated a 5-hour one: false
   * = the plan meters no session window, null = not reported. The server
   * clears `fiveHour` when its window ends, so this is what tells "ended,
   * waiting for the next request" apart from "never existed".
   */
  sessionWindowStated: boolean | null;
  weekly: QuotaWindow;
  /**
   * The same for the shared weekly window: false = the plan meters none (a
   * Team seat), null = not reported (also by backends from before it was added).
   */
  weeklyWindowStated: boolean | null;
  /** Model-scoped weekly buckets (Sonnet, Fable, …) when the server reports them. */
  modelWindows: NamedQuotaWindow[];
  onExtraUsage: boolean;
  allowExtraUsage: boolean;
  rateLimitedUntil: string | null;
  pausedUntil: string | null;
  credentialRejectedUntil: string | null;
  totalRequests: number | null;
  /**
   * Requests forwarded to the account in the last ten minutes, the input of
   * the `load` distribution mode. null = the backend does not report it,
   * i.e. it predates that mode.
   */
  recentRequests: number | null;
  /** Token totals the server has counted for this account; null = not reported. */
  usage: TokenUsage | null;
  /** The server's burn-rate forecast, one per weekly bucket it has a rate for. */
  forecast: ForecastView[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ForecastView {
  /** Server bucket key: 'unified7d' (shared weekly) or a model-scoped one. */
  bucket: string;
  /** null for the shared weekly window, else the model family ("Sonnet"). */
  family: string | null;
  ratePerHour: number | null;
  /** 0–1: the utilization at which rotation moves off the account. */
  threshold: number;
  /** Epoch ms when the threshold is reached at the learned rate, or null. */
  reachesThresholdAt: number | null;
  resetAt: number | null;
}

/** The argument of `teamclaude distribute`; `on` is the even mode. */
export type DistributionMode = 'on' | 'off' | 'adaptive' | 'load';

export interface SessionView {
  id: string;
  active: boolean;
  inFlight: number;
  requests: number;
  lastSeen: number | null;
  client: string | null;
  conversation: string | null;
  /** Weekly bucket → account name, resolved from the server's index pins. */
  accounts: Record<string, string>;
}

export interface RouteView {
  name: string;
  match: string[];
  provider: string;
  autocreated: boolean;
  pinned: string | null;
  target: string | null;
}

export interface ServerInfo {
  version: string | null;
  pid: number | null;
  port: number | null;
  uptimeSeconds: number | null;
  startedAt: string | null;
  updateAvailable: string | null;
  upstream: string | null;
}

export interface BackgroundJobView {
  enabled: boolean;
  intervalSeconds: number;
}

export interface StatusView {
  server: ServerInfo;
  accounts: AccountView[];
  /** provider → current account name */
  currentAccounts: Record<string, string | null>;
  switchThreshold: number | null;
  perBucketThresholds: boolean;
  sessions: {
    active: number;
    known: number;
    distribution: string | null;
    draining: number;
    starvedMax: number;
    /** null when the server runs without proxy.sessionDetail. */
    items: SessionView[] | null;
  };
  routes: RouteView[];
  probe: BackgroundJobView;
  warm: BackgroundJobView;
  blockedModels: string[];
  /** true when this caller holds a client key and may not change settings. */
  readOnly: boolean;
}

export interface BackendState {
  phase: ProxyPhase;
  ownership: Ownership;
  host: string;
  port: number;
  endpoint: string;
  /** pid of the process we spawned, when we own it. */
  childPid: number | null;
  lastError: string | null;
  restartCount: number;
  /** A `systemd --user` unit for TeamClaude is installed on this machine. */
  serviceInstalled: boolean;
  compatibility: { ok: boolean; message: string | null };
  status: StatusView | null;
  /** Epoch ms of the last successful status read. */
  statusAt: number | null;
  configPath: string;
  configExists: boolean;
  /** How long the last status read took, in ms; the proxy's own responsiveness. */
  statusLatencyMs?: number | null;
}

export type LogStream = 'stdout' | 'stderr' | 'desktop';

export interface LogLine {
  seq: number;
  at: number;
  stream: LogStream;
  text: string;
}

export type Theme = 'dark' | 'light' | 'system';

export interface NotificationPrefs {
  proxyCrashed: boolean;
  authExpired: boolean;
  allUnavailable: boolean;
  quotaExhausted: boolean;
  backendRecovered: boolean;
  updateAvailable: boolean;
  /** A new version of this app has been downloaded and installs on restart. */
  appUpdateReady: boolean;
  /** The proxy core was switched to a newer TeamClaude from npm. */
  coreUpdated: boolean;
  /** An account is forecast to run out of quota within the hour. */
  quotaSoon: boolean;
}

/** A saved set of routing choices, applied in one click (Routing page, tray). */
export interface RoutingProfile {
  id: string;
  name: string;
  /** Switch threshold in percent, or null to leave it as it is. */
  threshold: number | null;
  distribution: DistributionMode | null;
}

export interface DesktopSettings {
  theme: Theme;
  language: string;
  launchAtLogin: boolean;
  startProxyOnLaunch: boolean;
  startMinimized: boolean;
  minimizeToTray: boolean;
  keepProxyOnWindowClose: boolean;
  restartOnCrash: boolean;
  /** Check the releases for a new app version, download it and install it on quit. */
  autoUpdate: boolean;
  /** Fetch new TeamClaude releases from npm and run the proxy on them. */
  autoUpdateCore: boolean;
  notifications: NotificationPrefs;
  profiles: RoutingProfile[];
  /** The small always-on-top quota window. */
  widget: boolean;
  /** A system-wide shortcut that switches to the next account. */
  hotkeyEnabled: boolean;
  /** Electron accelerator, e.g. "CommandOrControl+Alt+Shift+N". */
  hotkey: string;
}

/** Where the TeamClaude the app runs comes from. */
export type CoreSource = 'bundled' | 'downloaded' | 'checkout';

export interface CoreUpdateState {
  /** Set when this copy never replaces its core (a development run). */
  unsupported: 'development' | 'no-backend' | null;
  phase: 'idle' | 'checking' | 'up-to-date' | 'available' | 'installing' | 'error';
  /** The version new proxy starts use, and where it comes from. */
  active: string | null;
  source: CoreSource | null;
  bundled: string | null;
  latest: string | null;
  error: string | null;
  /** A version that failed to start and was taken back out. */
  rolledBack: { version: string; previous: string } | null;
  checkedAt: number | null;
}

/** Why this copy of the app cannot update itself. */
export type AppUpdateUnsupported = 'development' | 'portable' | 'package-manager' | 'no-feed';

export interface AppUpdateState {
  unsupported: AppUpdateUnsupported | null;
  phase: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error';
  current: string;
  latest: string | null;
  /** Download progress, 0–100, while downloading. */
  progress: number | null;
  error: string | null;
  checkedAt: number | null;
  releasesUrl: string;
}

export interface CliToolInfo {
  name: string;
  found: boolean;
  path: string | null;
}

export interface IntegrationInfo {
  endpoint: string;
  proxyReady: boolean;
  claude: CliToolInfo;
  codex: CliToolInfo;
  /** Shell snippets that point a client at the proxy. No secrets. */
  env: { posix: string; powershell: string; cmd: string };
  vscodeSettingsSnippet: string;
  ides: IdeTarget[];
}

export type IdeId = 'claude' | 'vscode' | 'vscode-insiders' | 'cursor' | 'windsurf' | 'vscodium' | 'zed' | 'jetbrains';

export interface IdeTarget {
  id: IdeId;
  name: string;
  installed: boolean;
  /** `other`: ANTHROPIC_BASE_URL is set, to something else. */
  status: 'connected' | 'other' | 'not-connected' | 'unreadable';
  current: string | null;
  settingsPath: string;
  /** Set when the editor has no setting of its own and follows another target (JetBrains → Claude Code). */
  via: IdeId | null;
  /** The editor's command-line launcher on PATH, for "Open a folder with the proxy". */
  launcher: string | null;
}

export interface SystemInfo {
  os: string;
  arch: string;
  desktopVersion: string;
  electronVersion: string;
  nodeVersion: string;
  backendVersion: string | null;
  bundledBackendVersion: string | null;
  proxyPhase: ProxyPhase;
  lastError: string | null;
  configDir: string;
  userDataDir: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** A CLI job the desktop runs on the user's behalf (login, remove, …). */
export interface JobView {
  id: number;
  kind: string;
  label: string;
  state: 'running' | 'succeeded' | 'failed';
  output: string[];
  exitCode: number | null;
}

export interface VersionVerdict {
  current: string;
  updateAvailable: boolean;
}

export interface UpdateCheckResult {
  /** Latest published @karpeleslab/teamclaude, or null when the check failed. */
  latest: string | null;
  /** The backend shipped inside the app; updated with the app. */
  bundled: VersionVerdict | null;
  /** An attached TeamClaude the app did not start; updated with npm. */
  external: VersionVerdict | null;
  url: string;
  error: string | null;
}
