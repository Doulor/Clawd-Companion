export type ToolName =
  | "Read"
  | "Edit"
  | "Write"
  | "Bash"
  | "Grep"
  | "Glob"
  | "WebFetch"
  | "Task"
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
  | "waiting_permission"
  | "done"
  | "error";

export type PrivacyMode = "safe" | "standard" | "detailed";
export type FeedbackMode = "thought" | "card" | "ribbon";

export type ClientType = "cli" | "desktop" | "vscode" | "unknown";

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
  feedbackModes: Partial<Record<PetState, FeedbackMode>>;
  toolFeedbackModes: Partial<Record<ToolName, FeedbackMode>>;
  showStatusProp: boolean;
  launchAtLogin: boolean;
  openSettingsOnStart: boolean;
  doneSound: boolean;
  eventHistoryLimit: number;
  position?: { x: number; y: number };
  positionOffsets?: {
    clawd?: { x: number; y: number };
    bubble?: { x: number; y: number };
    ribbon?: { x: number; y: number };
  };
  zoneSizes?: {
    clawd?: { w: number; h: number };
    bubble?: { w: number; h: number };
    ribbon?: { w: number; h: number };
  };
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
  privacyMode: "safe",
  showBubbles: true,
  editPosition: false,
  alwaysOnTop: true,
  clickThrough: false,
  petEnabled: true,
  petScale: 1,
  petOpacity: 1,
  clawdScale: 1,
  clawdOpacity: 1,
  thoughtScale: 1,
  thoughtOpacity: 1,
  cardScale: 1,
  cardOpacity: 1,
  bubbleScale: 1,
  bubbleOpacity: 1,
  bubbleDuration: 8,
  feedbackModes: {
    thinking: "thought",
    tool_read: "ribbon",
    tool_edit: "ribbon",
    tool_bash: "ribbon",
    tool_search: "ribbon",
    waiting_permission: "card",
    done: "card",
    error: "card"
  },
  toolFeedbackModes: {},
  showStatusProp: true,
  launchAtLogin: false,
  openSettingsOnStart: true,
  doneSound: false,
  eventHistoryLimit: 40
};

export function stateFromEvent(event: CompanionEvent): PetState {
  if (event.event === "error") return "error";
  if (event.event === "permission_wait") return "waiting_permission";
  if (event.event === "done") return "done";
  if (event.event === "prompt_submit" || event.event === "session_start") return "thinking";
  if (event.event === "tool_start") {
    if (event.tool === "Read") return "tool_read";
    if (event.tool === "Edit" || event.tool === "Write") return "tool_edit";
    if (event.tool === "Bash") return "tool_bash";
    if (event.tool === "Grep" || event.tool === "Glob" || event.tool === "WebFetch") return "tool_search";
    return "thinking";
  }
  if (event.event === "notification") return "waiting_permission";
  return "idle";
}
