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
  | "heartbeat";

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
  doneSound: boolean;
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
    view?: { x: number; y: number };
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
  clawdScale: 0.7964601769911505,
  clawdOpacity: 1,
  thoughtScale: 0.7641509433962264,
  thoughtOpacity: 1,
  cardScale: 0.7641509433962264,
  cardOpacity: 1,
  bubbleScale: 1,
  bubbleOpacity: 1,
  bubbleDuration: 8,
  permissionScale: 0.85,
  permissionOpacity: 1,
  toolStreamMinDuration: 0.8,
  showStatusProp: true,
  multiSessionEnabled: false,
  showSessionTitle: true,
  companionScale: 0.6,
  companionIdleAnimations: ["thinking", "idle", "waiting_permission"],
  mainClawdIdleAnimation: "random",
  launchAtLogin: false,
  openSettingsOnStart: true,
  doneSound: false,
  eventHistoryLimit: 40,
  positionOffsets: {
    clawd: { x: 707, y: -61 },
    bubble: { x: 727, y: -41 },
    ribbon: { x: 677, y: -80 },
    permission: { x: 560, y: -20 },
    companion: { x: 80, y: -120 },
    companion0: { x: 80, y: -120 },
    companion1: { x: 180, y: -200 },
    companion2: { x: 280, y: -280 },
    view: { x: 0, y: 0 }
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
