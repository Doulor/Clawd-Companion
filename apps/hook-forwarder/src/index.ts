#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";

type HookPayload = Record<string, unknown>;
type ToolName = "Read" | "Edit" | "Write" | "Bash" | "Grep" | "Glob" | "WebFetch" | "Task" | "Unknown";
type EventType = "session_start" | "prompt_submit" | "tool_start" | "tool_end" | "notification" | "permission_wait" | "done" | "error";
type ClientType = "cli" | "desktop" | "vscode" | "unknown";

interface CompanionEvent {
  id: string;
  source: "claude-code";
  event: EventType;
  sessionId?: string;
  clientType?: ClientType;
  clientLabel?: string;
  tool?: ToolName;
  title: string;
  message: string;
  detail?: string;
  timestamp: number;
}

const port = Number(process.env.CLAWD_COMPANION_PORT ?? "47634");
const token = process.env.CLAWD_COMPANION_TOKEN ?? "clawd-local";
const privacyMode = process.env.CLAWD_PRIVACY_MODE ?? "safe";
const configuredClientType = clientType(process.env.CLAWD_CLIENT_TYPE);
const configuredClientLabel = typeof process.env.CLAWD_CLIENT_LABEL === "string" && process.env.CLAWD_CLIENT_LABEL.trim() ? process.env.CLAWD_CLIENT_LABEL.trim() : labelForClient(configuredClientType);

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hookName(payload: HookPayload): string {
  return text(payload.hook_event_name) ?? text(payload.hookEventName) ?? text(payload.event) ?? "Unknown";
}

function clientType(value: unknown): ClientType {
  const raw = typeof value === "string" ? value.toLowerCase() : "";
  if (raw.includes("vscode") || raw.includes("vs-code")) return "vscode";
  if (raw.includes("desktop")) return "desktop";
  if (raw.includes("cli") || raw.includes("terminal") || raw.includes("code")) return "cli";
  return "unknown";
}

function labelForClient(client: ClientType) {
  if (client === "cli") return "Claude CLI";
  if (client === "desktop") return "Claude Desktop";
  if (client === "vscode") return "VS Code";
  return "Claude Code";
}

function clientFromPayload(payload: HookPayload): { clientType: ClientType; clientLabel: string } {
  const raw = text(payload.client) ?? text(payload.client_type) ?? text(payload.clientType) ?? text(payload.app) ?? text(payload.source);
  const detected = clientType(raw);
  if (detected !== "unknown") return { clientType: detected, clientLabel: labelForClient(detected) };
  return { clientType: configuredClientType, clientLabel: configuredClientLabel };
}

function toolName(payload: HookPayload): ToolName {
  const input = asObject(payload.tool_input);
  const raw = text(payload.tool_name) ?? text(payload.toolName) ?? text(input.name) ?? "Unknown";
  if (["Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebFetch", "Task", "TaskCreate", "TaskUpdate"].includes(raw)) {
    if (raw === "TaskCreate" || raw === "TaskUpdate") return "Task";
    return raw as ToolName;
  }
  return "Unknown";
}

function basename(pathLike: string | undefined): string | undefined {
  if (!pathLike) return undefined;
  const parts = pathLike.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1);
}

function detailForTool(payload: HookPayload, tool: ToolName): string | undefined {
  if (privacyMode === "safe") return undefined;
  const input = asObject(payload.tool_input);
  if (tool === "Read" || tool === "Edit" || tool === "Write") return basename(text(input.file_path) ?? text(input.path));
  if (tool === "Grep") return text(input.pattern) ? "pattern: " + text(input.pattern) : undefined;
  if (tool === "Glob") return text(input.pattern) ? "pattern: " + text(input.pattern) : undefined;
  if (tool === "Bash") return privacyMode === "detailed" ? summarizeCommand(text(input.command)) : undefined;
  return undefined;
}

function summarizeCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const trimmed = command.replace(/\s+/g, " ").trim();
  return trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed;
}

function normalize(payload: HookPayload): CompanionEvent {
  const hook = hookName(payload);
  const tool = toolName(payload);
  const sessionId = text(payload.session_id) ?? text(payload.sessionId);
  const detail = detailForTool(payload, tool);
  const client = clientFromPayload(payload);
  const base = {
    id: randomUUID(),
    source: "claude-code" as const,
    sessionId,
    clientType: client.clientType,
    clientLabel: client.clientLabel,
    timestamp: Date.now()
  };

  if (hook === "UserPromptSubmit") {
    return { ...base, event: "prompt_submit", title: "收到新任务", message: "Claude Code 开始处理新的消息。" };
  }

  if (hook === "PreToolUse") {
    return {
      ...base,
      event: "tool_start",
      tool,
      title: titleForTool(tool),
      message: detail ? `${tool} 正在处理 ${detail}` : `${tool} 工具已开始。`,
      detail
    };
  }

  if (hook === "PostToolUse") {
    return {
      ...base,
      event: "tool_end",
      tool,
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
}

function titleForTool(tool: ToolName): string {
  if (tool === "Read") return "正在读文件";
  if (tool === "Edit" || tool === "Write") return "正在编辑代码";
  if (tool === "Bash") return "正在执行命令";
  if (tool === "Grep" || tool === "Glob" || tool === "WebFetch") return "正在搜索";
  return "正在使用工具";
}

function postEvent(event: CompanionEvent): Promise<void> {
  const body = JSON.stringify(event);
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/events",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "authorization": `Bearer ${token}`
      },
      timeout: 3000
    }, (res: IncomingMessage) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

async function main() {
  const raw = readStdin();
  if (!raw.trim()) return;
  const payload = JSON.parse(raw) as HookPayload;
  await postEvent(normalize(payload));
}

main().catch((error) => {
  process.stderr.write(`[clawd] forward error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(0);
});
