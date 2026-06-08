import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CompanionEvent, CompanionEventType, ToolName } from "./events.js";

/**
 * Raw hook payload as received on stdin from a CLI.
 *
 * Claude Code and Codex CLI both use JSON-on-stdin, but the field names
 * differ. Provider implementations are responsible for translating the raw
 * payload into a normalized `CompanionEvent`.
 */
export type HookPayload = Record<string, unknown>;

/**
 * The shape every CLI provider must expose.
 *
 * Each provider is self-contained: it knows where its config file lives,
 * which event names it emits, how to parse the raw payload, and how to
 * format permission decisions on stdout. The desktop app and the
 * forwarder core both consume this interface; adding a third CLI later
 * means implementing a new provider module — no other changes required.
 */
export interface Provider {
  readonly id: "claude-code" | "codex";
  readonly displayName: string;
  readonly defaultClientLabel: string;
  readonly format: "json" | "toml";
  /** Absolute path to the provider's config file. Resolved lazily. */
  readonly settingsPath: string;

  /** Hook event names we must register to receive a full event stream. */
  readonly requiredEvents: readonly string[];

  /** Hook events that represent a permission gate and need a decision. */
  readonly permissionEvents: readonly string[];

  /** Tool names this provider can emit (used by the event server allowlist). */
  readonly toolNames: readonly ToolName[];

  /** Pure: translate a raw hook payload into a normalized CompanionEvent. */
  normalize(payload: HookPayload, env: NormalizeEnv): CompanionEvent;

  /** Pure: true if the payload represents a permission gate. */
  isPermissionEvent(payload: HookPayload): boolean;

  /** Pure: format a permission decision for stdout (Codex vs Claude differ). */
  formatPermissionDecision(decision: "allow" | "deny", reason: string | undefined): string;
}

export interface NormalizeEnv {
  privacyMode?: "safe" | "standard" | "detailed";
  clientType?: string;
  clientLabel?: string;
}

// --- helpers shared by all providers ---------------------------------------

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function basename(pathLike: string | undefined): string | undefined {
  if (!pathLike) return undefined;
  const parts = pathLike.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1);
}

function summarizeCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const trimmed = command.replace(/\s+/g, " ").trim();
  return trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed;
}

function clientType(value: unknown): "cli" | "desktop" | "vscode" | "unknown" {
  const raw = typeof value === "string" ? value.toLowerCase() : "";
  if (raw.includes("vscode") || raw.includes("vs-code")) return "vscode";
  if (raw.includes("desktop")) return "desktop";
  if (raw.includes("cli") || raw.includes("terminal") || raw.includes("code")) return "cli";
  return "unknown";
}

function labelForClient(client: "cli" | "desktop" | "vscode" | "unknown"): string {
  if (client === "cli") return "Claude CLI";
  if (client === "desktop") return "Claude Desktop";
  if (client === "vscode") return "VS Code";
  return "Claude Code";
}

// --- Claude Code provider --------------------------------------------------

const CLAUDE_KNOWN_TOOLS = [
  "Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebFetch",
  "WebSearch", "Notebook", "Agent", "Skill",
  "TaskCreate", "TaskUpdate", "Task",
  "AskUserQuestion"
];

function claudeToolName(payload: HookPayload): ToolName {
  const input = asObject(payload.tool_input);
  const raw = text(payload.tool_name) ?? text(payload.toolName) ?? text(input.name) ?? "Unknown";
  if (CLAUDE_KNOWN_TOOLS.includes(raw)) {
    if (raw === "TaskCreate" || raw === "TaskUpdate") return "Task";
    return raw as ToolName;
  }
  if (raw.startsWith("mcp__")) return "MCP";
  return "Unknown";
}

function claudeHookName(payload: HookPayload): string {
  return text(payload.hook_event_name) ?? text(payload.hookEventName) ?? text(payload.event) ?? "Unknown";
}

function claudeDetailForTool(payload: HookPayload, tool: ToolName, privacyMode: NormalizeEnv["privacyMode"]): string | undefined {
  if (privacyMode === "safe") return undefined;
  const input = asObject(payload.tool_input);
  if (tool === "Read" || tool === "Edit" || tool === "Write" || tool === "Notebook") return basename(text(input.file_path) ?? text(input.path));
  if (tool === "Grep") return text(input.pattern) ? "pattern: " + text(input.pattern) : undefined;
  if (tool === "Glob") return text(input.pattern) ? "pattern: " + text(input.pattern) : undefined;
  if (tool === "WebSearch") return text(input.query) ? "query: " + text(input.query) : undefined;
  if (tool === "Bash") return privacyMode === "detailed" ? summarizeCommand(text(input.command)) : undefined;
  if (tool === "Agent") {
    const prompt = text(input.prompt);
    return prompt ? (prompt.length > 40 ? prompt.slice(0, 37) + "..." : prompt) : undefined;
  }
  if (tool === "Skill") return text(input.skill) ?? text(input.name);
  if (tool === "AskUserQuestion") {
    const question = text(input.question) ?? text(input.prompt);
    return question ? (question.length > 40 ? question.slice(0, 37) + "..." : question) : undefined;
  }
  if (tool === "MCP") {
    const raw = text(payload.tool_name) ?? "";
    const parts = raw.split("__");
    if (parts.length >= 3) return `MCP: ${parts[1]}/${parts.slice(2).join("__")}`;
  }
  return undefined;
}

function claudeTitleForTool(tool: ToolName): string {
  if (tool === "Read" || tool === "Notebook") return "正在读文件";
  if (tool === "Edit" || tool === "Write") return "正在编辑代码";
  if (tool === "Bash") return "正在执行命令";
  if (tool === "Grep" || tool === "Glob" || tool === "WebFetch") return "正在搜索";
  if (tool === "WebSearch") return "正在搜索网络";
  if (tool === "Agent") return "正在调用子代理";
  if (tool === "Skill") return "正在使用技能";
  if (tool === "AskUserQuestion") return "等待选择";
  if (tool === "MCP") return "正在使用 MCP 工具";
  return "正在使用工具";
}

function claudeClientFromPayload(payload: HookPayload, env: NormalizeEnv): { clientType: "cli" | "desktop" | "vscode" | "unknown"; clientLabel: string } {
  const raw = text(payload.client) ?? text(payload.client_type) ?? text(payload.clientType) ?? text(payload.app) ?? text(payload.source);
  const detected = clientType(raw);
  if (detected !== "unknown") return { clientType: detected, clientLabel: labelForClient(detected) };
  const configured = clientType(env.clientType);
  return { clientType: configured, clientLabel: env.clientLabel ?? labelForClient(configured) };
}

export const claudeCodeProvider: Provider = {
  id: "claude-code",
  displayName: "Claude Code",
  defaultClientLabel: "Claude Code",
  format: "json",
  settingsPath: join(homedir(), ".claude", "settings.json"),
  requiredEvents: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"],
  permissionEvents: ["PreToolUse"],
  toolNames: [
    "Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "Notebook",
    "Agent", "Skill", "Task", "TaskCreate", "TaskUpdate", "AskUserQuestion", "MCP", "Unknown"
  ],
  normalize(payload, env) {
    const hook = claudeHookName(payload);
    const tool = claudeToolName(payload);
    const sessionId = text(payload.session_id) ?? text(payload.sessionId);
    const detail = claudeDetailForTool(payload, tool, env.privacyMode);
    const client = claudeClientFromPayload(payload, env);
    const cwd = text(payload.cwd) ?? text(payload.working_directory);
    const base: Omit<CompanionEvent, "event" | "title" | "message"> = {
      id: randomUUID(),
      source: "claude-code",
      sessionId,
      clientType: client.clientType,
      clientLabel: client.clientLabel,
      cwd,
      timestamp: Date.now()
    };

    if (hook === "UserPromptSubmit") {
      return { ...base, event: "prompt_submit", title: "收到新任务", message: "Claude Code 开始处理新的消息。" };
    }
    if (hook === "PreToolUse") {
      return {
        ...base, event: "tool_start", tool,
        title: claudeTitleForTool(tool),
        message: detail ? `${tool} 正在处理 ${detail}` : `${tool} 工具已开始。`,
        detail
      };
    }
    if (hook === "PostToolUse") {
      return {
        ...base, event: "tool_end", tool,
        title: "工具调用完成",
        message: detail ? `${tool} 已处理 ${detail}` : `${tool} 工具已结束。`,
        detail
      };
    }
    if (hook === "Notification") {
      return { ...base, event: "permission_wait", title: "需要确认", message: "Claude Code 正在等待你的操作。" };
    }
    if (hook === "Stop") {
      return { ...base, event: "done", title: "处理完成", message: "Claude Code 这一轮回复已经结束。" };
    }
    if (hook === "SessionStart") {
      return { ...base, event: "session_start", title: "会话开始", message: "Clawd 已连接到 Claude Code。" };
    }
    return { ...base, event: "notification", title: "Claude Code 事件", message: hook };
  },
  isPermissionEvent(payload) {
    if (claudeHookName(payload) !== "PreToolUse") return false;
    // permission_mode 字段缺失时（子 agent 派发场景），不介入权限流程
    const permMode = text(payload.permission_mode) ?? text(payload.permissionMode);
    if (permMode === undefined) return false;
    if (permMode === "bypassPermissions" || permMode === "dontAsk" || permMode === "auto") return false;
    return true;
  },
  formatPermissionDecision(decision, reason) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason ?? (decision === "allow" ? "Approved via Clawd Companion" : "Denied via Clawd Companion")
      },
      continue: true
    });
  }
};

// --- Codex provider --------------------------------------------------------

const CODEX_KNOWN_TOOLS = ["shell", "update_plan", "apply_patch", "view_image"];

function codexHookName(payload: HookPayload): string {
  return text(payload["event"]) ?? text(payload["hook_event_name"]) ?? text(payload["hookEventName"]) ?? "Unknown";
}

function codexToolName(payload: HookPayload): ToolName {
  const input = asObject(payload["tool_input"]);
  const raw = text(payload["tool_name"]) ?? text(payload.toolName) ?? text(input.name) ?? "Unknown";
  if (CODEX_KNOWN_TOOLS.includes(raw)) {
    if (raw === "shell") return "Shell";
    if (raw === "update_plan") return "UpdatePlan";
    if (raw === "apply_patch") return "ApplyPatch";
    if (raw === "view_image") return "ViewImage";
  }
  if (raw.startsWith("mcp__")) return "MCP";
  return "Unknown";
}

function codexTitleForTool(tool: ToolName): string {
  if (tool === "Shell") return "正在执行命令";
  if (tool === "UpdatePlan") return "正在更新计划";
  if (tool === "ApplyPatch") return "正在应用补丁";
  if (tool === "ViewImage") return "正在查看图像";
  if (tool === "MCP") return "正在使用 MCP 工具";
  return "正在使用工具";
}

function codexDetailForTool(payload: HookPayload, tool: ToolName, privacyMode: NormalizeEnv["privacyMode"]): string | undefined {
  if (privacyMode === "safe") return undefined;
  const input = asObject(payload["tool_input"]);
  if (tool === "Shell") return privacyMode === "detailed" ? summarizeCommand(text(input["command"])) : undefined;
  if (tool === "ApplyPatch") return text(input["patch"]) ? summarizeCommand(text(input["patch"])) : undefined;
  if (tool === "ViewImage") return text(input["path"]) ?? text(input["url"]);
  if (tool === "UpdatePlan") return text(input["plan"]);
  if (tool === "MCP") {
    const raw = text(payload["tool_name"]) ?? "";
    const parts = raw.split("__");
    if (parts.length >= 3) return `MCP: ${parts[1]}/${parts.slice(2).join("__")}`;
  }
  return undefined;
}

export const codexProvider: Provider = {
  id: "codex",
  displayName: "OpenAI Codex",
  defaultClientLabel: "OpenAI Codex CLI",
  format: "toml",
  settingsPath: join(process.env.CODEX_HOME ?? homedir(), ".codex", "config.toml"),
  requiredEvents: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"],
  permissionEvents: ["PermissionRequest"],
  toolNames: ["Shell", "UpdatePlan", "ApplyPatch", "ViewImage", "MCP", "Unknown"],
  normalize(payload, env) {
    const hook = codexHookName(payload);
    const tool = codexToolName(payload);
    const sessionId = text(payload["session_id"]) ?? text(payload["sessionId"]) ?? text(payload["conversation_id"]);
    const detail = codexDetailForTool(payload, tool, env.privacyMode);
    const cwd = text(payload["cwd"]) ?? text(payload["working_directory"]);
    const base: Omit<CompanionEvent, "event" | "title" | "message"> = {
      id: randomUUID(),
      source: "codex",
      sessionId,
      clientType: "cli",
      clientLabel: env.clientLabel ?? "OpenAI Codex CLI",
      cwd,
      timestamp: Date.now()
    };

    if (hook === "UserPromptSubmit") {
      return { ...base, event: "prompt_submit", title: "收到新任务", message: "Codex 开始处理新的消息。" };
    }
    if (hook === "PreToolUse") {
      return {
        ...base, event: "tool_start", tool,
        title: codexTitleForTool(tool),
        message: detail ? `${tool} 正在处理 ${detail}` : `${tool} 工具已开始。`,
        detail
      };
    }
    if (hook === "PostToolUse") {
      return {
        ...base, event: "tool_end", tool,
        title: "工具调用完成",
        message: detail ? `${tool} 已处理 ${detail}` : `${tool} 工具已结束。`,
        detail
      };
    }
    if (hook === "PermissionRequest") {
      return { ...base, event: "permission_wait", title: "需要确认", message: "Codex 正在等待你的操作。" };
    }
    if (hook === "PreCompact") {
      return { ...base, event: "notification", title: "压缩上下文", message: "Codex 即将压缩上下文。" };
    }
    if (hook === "PostCompact") {
      return { ...base, event: "notification", title: "压缩完成", message: "Codex 已完成上下文压缩。" };
    }
    if (hook === "SubagentStart") {
      return { ...base, event: "tool_start", tool: "Agent", title: "子代理开始", message: "Codex 启动了子代理。" };
    }
    if (hook === "SubagentStop") {
      return { ...base, event: "tool_end", tool: "Agent", title: "子代理结束", message: "Codex 子代理已完成。" };
    }
    if (hook === "Stop") {
      return { ...base, event: "done", title: "处理完成", message: "Codex 这一轮回复已经结束。" };
    }
    if (hook === "SessionStart") {
      return { ...base, event: "session_start", title: "会话开始", message: "Clawd 已连接到 Codex。" };
    }
    return { ...base, event: "notification", title: "Codex 事件", message: hook };
  },
  isPermissionEvent(payload) {
    return codexHookName(payload) === "PermissionRequest";
  },
  formatPermissionDecision(decision, reason) {
    return JSON.stringify({
      continue: true,
      decision,
      reason: reason ?? (decision === "allow" ? "Approved via Clawd Companion" : "Denied via Clawd Companion")
    });
  }
};

// --- registry --------------------------------------------------------------

export const providers: Record<Provider["id"], Provider> = {
  "claude-code": claudeCodeProvider,
  "codex": codexProvider
};

export function getProvider(id: Provider["id"]): Provider {
  return providers[id];
}
