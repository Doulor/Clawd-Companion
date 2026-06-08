export interface AppStats {
  toolUsage: Record<string, number>;
  eventTypeCounts: Record<string, number>;
  totalSessions: number;
  dailyStats: Record<string, { events: number; toolCalls: number; sessions: number }>;
  errorCount: number;
  permissionRequests: number;
  permissionApproved: number;
  permissionDenied: number;
  totalRuntime: number;
  hourlyActivity: number[];
  firstStartTime: number;
  lastEventTime: number;
}

export const defaultStats: AppStats = {
  toolUsage: {},
  eventTypeCounts: {},
  totalSessions: 0,
  dailyStats: {},
  errorCount: 0,
  permissionRequests: 0,
  permissionApproved: 0,
  permissionDenied: 0,
  totalRuntime: 0,
  hourlyActivity: new Array(24).fill(0),
  firstStartTime: Date.now(),
  lastEventTime: 0
};

export type ToolName =
  | "Read"
  | "Edit"
  | "Write"
  | "Bash"
  | "Grep"
  | "Glob"
  | "WebFetch"
  | "WebSearch"
  | "Notebook"
  | "Agent"
  | "Skill"
  | "Task"
  | "TaskCreate"
  | "TaskUpdate"
  | "AskUserQuestion"
  | "MCP"
  | "Unknown";

export type CompanionEventType =
  | "session_start"
  | "prompt_submit"
  | "tool_start"
  | "tool_end"
  | "notification"
  | "permission_wait"
  | "done"
  | "error"
  | "heartbeat"
  | "git_operation";

export type PetState =
  | "idle"
  | "thinking"
  | "tool_read"
  | "tool_edit"
  | "tool_bash"
  | "tool_search"
  | "tool_mcp"
  | "skill"
  | "task"
  | "agent"
  | "waiting_permission"
  | "done"
  | "error";

export type PrivacyMode = "safe" | "standard" | "detailed";
export type FeedbackMode = "thought" | "card" | "ribbon";

export type ClientType = "cli" | "desktop" | "vscode" | "unknown";

export type PermissionDecision = "allow" | "deny";

export interface PermissionRequest {
  id: string;
  toolName: ToolName;
  toolDetail?: string;
  sessionId?: string;
  timestamp: number;
  rawPayload: Record<string, unknown>;
}

export interface PermissionPollResult {
  status: "approved" | "denied" | "expired" | "error";
  decision?: PermissionDecision;
  reason?: string;
}

export interface PermissionResponse {
  id: string;
  decision: PermissionDecision;
  reason?: string;
}

export interface CompanionEvent {
  id: string;
  source: "claude-code" | "cc-haha" | "manual";
  event: CompanionEventType;
  sessionId?: string;
  clientType?: ClientType;
  clientLabel?: string;
  tool?: ToolName;
  cwd?: string;
  title: string;
  message: string;
  detail?: string;
  timestamp: number;
}

export interface CompanionSettings {
  port: number;
  token: string;
  privacyMode: PrivacyMode;
  showBubbles: boolean;
  editPosition: boolean;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  petEnabled: boolean;
  petScale: number;
  viewScale: number;
  petOpacity: number;
  clawdScale: number;
  clawdOpacity: number;
  thoughtScale: number;
  thoughtOpacity: number;
  cardScale: number;
  cardOpacity: number;
  bubbleScale: number;
  bubbleOpacity: number;
  bubbleDuration: number;
  permissionScale: number;
  permissionOpacity: number;
  toolStreamMinDuration: number;
  showStatusProp: boolean;
  multiSessionEnabled: boolean;
  showSessionTitle: boolean;
  companionScale: number;
  companionIdleAnimations: string[];
  mainClawdIdleAnimation: string;
  launchAtLogin: boolean;
  openSettingsOnStart: boolean;
  autoStartWithCli: boolean;
  doneSound: boolean;
  notificationsEnabled: boolean;
  theme: "light" | "dark" | "system";
  uiStyle: "classic" | "liquid";
  language: "auto" | "zh" | "en";
  autoStartDelay: number;
  autoStartMinimized: boolean;
  displayMonitorId: string;
  monitorPositions: MonitorPosition[];
  notificationRules: NotificationRule[];
  customPlugins: CustomPlugin[];
  pomodoroEnabled: boolean;
  pomodoroWorkMinutes: number;
  pomodoroBreakMinutes: number;
  sound: SoundSettings;
  eventHistoryLimit: number;
  position?: { x: number; y: number };
  positionOffsets?: {
    clawd?: { x: number; y: number };
    bubble?: { x: number; y: number };
    ribbon?: { x: number; y: number };
    permission?: { x: number; y: number };
    companion?: { x: number; y: number };
    companion0?: { x: number; y: number };
    companion1?: { x: number; y: number };
    companion2?: { x: number; y: number };
    pomodoro?: { x: number; y: number };
    view?: { x: number; y: number };
    gitToast?: { x: number; y: number };
  };
  zoneSizes?: {
    clawd?: { w: number; h: number };
    bubble?: { w: number; h: number };
    ribbon?: { w: number; h: number };
    permission?: { w: number; h: number };
  };
  zoneViewW?: number;
  zoneViewH?: number;
  idleAnim?: IdleAnimConfig;
  stateAnimations?: Record<string, string>;
}

export interface IdleAnimConfig {
  enabled: boolean;
  selectedSprites: string[];
  intervalMin: number;
  intervalMax: number;
  repeatMin: number;
  repeatMax: number;
}

export interface SoundSettings {
  enabled: boolean;
  volume: number;
  onDone: boolean;
  onError: boolean;
  onPermission: boolean;
  onSessionStart: boolean;
  fileDone: string | null;
  fileError: string | null;
  filePermission: string | null;
  fileSessionStart: string | null;
  eventFiles?: Partial<Record<CompanionEventType, string | null>>;
}

export interface SessionTokenInfo {
  sessionId: string;
  project: string;
  cwd: string;
  startTime: number;
  endTime: number;
  model: string;
  entrypoint: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  messageCount: number;
}

export interface DailyTokenEntry {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  sessionCount: number;
  messageCount: number;
}

export interface TokenStats {
  sessions: SessionTokenInfo[];
  daily: DailyTokenEntry[];
  modelTotals: { model: string; totalTokens: number; sessionCount: number; messageCount: number }[];
  dailyTotals: { date: string; totalTokens: number; sessionCount: number; messageCount: number }[];
  totalTokens: number;
  totalSessions: number;
  lastScannedAt: number;
  scanning: boolean;
}

export interface UpdateStatus {
  checking: boolean;
  available: boolean;
  upToDate: boolean;
  version?: string;
  downloaded: boolean;
  downloading: boolean;
  progress?: number;
  error?: string;
}

export interface CompanionSession {
  sessionId: string;
  title: string;
  state: PetState;
  lastEvent: CompanionEvent | null;
  lastEventTime: number;
  isActive: boolean;
  eventCount: number;
}

export interface EventHistoryEntry {
  id: string;
  event: CompanionEvent;
  timestamp: number;
}

export interface NotificationRule {
  eventType: CompanionEventType;
  enabled: boolean;
  systemNotification: boolean;
  playSound: boolean;
  showBubble: boolean;
}

export type PluginPermission = "event" | "network" | "filesystem" | "shell";

export interface PluginManifest {
  name?: string;
  description?: string;
  events: string[];
  permissions: PluginPermission[];
  timeoutMs?: number;
}

export interface PluginRunRecord {
  id: string;
  pluginId: string;
  pluginName: string;
  eventType: CompanionEventType;
  startedAt: number;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface CustomPlugin {
  id: string;
  name: string;
  scriptPath: string;
  enabled: boolean;
  events: string[];
  trusted?: boolean;
  permissions?: PluginPermission[];
  manifest?: PluginManifest;
}

export interface PluginMarketItem {
  id: string;
  name: string;
  nameZh?: string;
  description: string;
  descriptionZh?: string;
  detailsZh?: string;
  author: string;
  version: string;
  entry: string;
  manifest: string;
  events: string[];
  permissions: PluginPermission[];
  tags: string[];
}

export interface PluginMarketIndex {
  version: number;
  updatedAt?: string;
  plugins: PluginMarketItem[];
}

export interface SessionHistory {
  sessionId: string;
  title: string;
  cwd?: string;
  clientLabel?: string;
  startedAt: number;
  endedAt?: number;
  lastEventAt: number;
  eventCount: number;
  status: "active" | "done" | "error";
  events: EventHistoryEntry[];
}

export interface DoctorReport {
  generatedAt: number;
  appVersion: string;
  connection: CompanionConnectionStatus;
  hooks: {
    installed: boolean;
    configExists: boolean;
    hookCount: number;
    requiredCount: number;
    missingEvents: string[];
    commandMatches: boolean;
  };
  forwarder: {
    expectedPath: string;
    exists: boolean;
    autoStartMarkerPath: string;
    autoStartMarkerExists: boolean;
  };
  recent: {
    lastEventAt?: number;
    lastEventTitle?: string;
    lastError?: string;
  };
}

export interface MonitorPosition {
  displayId: string;
  position: { x: number; y: number };
}

export interface CompanionConnectionStatus {
  port: number;
  serverListening: boolean;
  tokenSet: boolean;
  privacyMode: PrivacyMode;
  connected: boolean;
  activeSessionId?: string;
  activeClientType?: ClientType;
  activeClientLabel?: string;
  lastEventAt?: number;
  lastEventTitle?: string;
  lastEventType?: CompanionEventType;
  lastEventSource?: CompanionEvent["source"];
  error?: string;
}

export const defaultSettings: CompanionSettings = {
  port: 47634,
  token: "clawd-local",
  privacyMode: "detailed",
  showBubbles: true,
  editPosition: false,
  alwaysOnTop: true,
  clickThrough: false,
  petEnabled: true,
  petScale: 1,
  viewScale: 1,
  petOpacity: 1,
  clawdScale: 0.8,
  clawdOpacity: 1,
  thoughtScale: 0.75,
  thoughtOpacity: 1,
  cardScale: 0.75,
  cardOpacity: 1,
  bubbleScale: 1,
  bubbleOpacity: 1,
  bubbleDuration: 8,
  permissionScale: 0.9,
  permissionOpacity: 1,
  toolStreamMinDuration: 0.8,
  showStatusProp: true,
  multiSessionEnabled: false,
  showSessionTitle: true,
  companionScale: 0.5,
  companionIdleAnimations: ["thinking", "idle", "waiting_permission"],
  mainClawdIdleAnimation: "random",
  launchAtLogin: false,
  openSettingsOnStart: true,
  autoStartWithCli: false,
  doneSound: false,
  notificationsEnabled: true,
  theme: "system",
  uiStyle: "classic",
  language: "auto",
  autoStartDelay: 0,
  autoStartMinimized: false,
  displayMonitorId: "",
  monitorPositions: [],
  notificationRules: [
    { eventType: "session_start", enabled: true, systemNotification: false, playSound: true, showBubble: true },
    { eventType: "done", enabled: true, systemNotification: false, playSound: true, showBubble: true },
    { eventType: "error", enabled: true, systemNotification: false, playSound: true, showBubble: true },
    { eventType: "permission_wait", enabled: true, systemNotification: false, playSound: true, showBubble: true }
  ],
  customPlugins: [],
  pomodoroEnabled: false,
  pomodoroWorkMinutes: 25,
  pomodoroBreakMinutes: 5,
  sound: {
    enabled: true,
    volume: 0.5,
    onDone: true,
    onError: true,
    onPermission: true,
    onSessionStart: true,
    fileDone: null,
    fileError: null,
    filePermission: null,
    fileSessionStart: null,
    eventFiles: {}
  },
  eventHistoryLimit: 40,
  positionOffsets: {
    clawd: { x: 707, y: -61 },
    bubble: { x: 682, y: -71 },
    ribbon: { x: 677, y: -80 },
    permission: { x: 407, y: 83 },
    companion: { x: 80, y: -120 },
    companion0: { x: 587, y: -18 },
    companion1: { x: 500, y: -17 },
    companion2: { x: 413, y: -17 },
    pomodoro: { x: 735, y: -5 },
    view: { x: 41, y: -13 },
    gitToast: { x: 676, y: 39 }
  },
  zoneSizes: {},
  idleAnim: {
    enabled: true,
    selectedSprites: ["idle", "thinking", "tool_read", "tool_edit", "waiting_permission", "done", "error", "skill", "agent"],
    intervalMin: 15,
    intervalMax: 40,
    repeatMin: 2,
    repeatMax: 3
  },
  stateAnimations: {
    skill: "skill",
    task: "task",
    agent: "agent"
  }
};

export function stateFromEvent(event: CompanionEvent): PetState {
  if (event.event === "error") return "error";
  if (event.event === "permission_wait") return "waiting_permission";
  if (event.event === "done") return "done";
  if (event.event === "git_operation") return "thinking";
  if (event.event === "prompt_submit" || event.event === "session_start") return "thinking";
  if (event.event === "tool_start") {
    if (event.tool === "Read" || event.tool === "Notebook") return "tool_read";
    if (event.tool === "Edit" || event.tool === "Write") return "tool_edit";
    if (event.tool === "Bash") return "tool_bash";
    if (event.tool === "Grep" || event.tool === "Glob" || event.tool === "WebFetch" || event.tool === "WebSearch") return "tool_search";
    if (event.tool === "MCP") return "tool_mcp";
    if (event.tool === "Skill") return "skill";
    if (event.tool === "Task" || event.tool === "TaskCreate" || event.tool === "TaskUpdate") return "task";
    if (event.tool === "Agent") return "agent";
    return "thinking";
  }
  if (event.event === "notification") return "waiting_permission";
  return "idle";
}
