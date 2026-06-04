#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";

type HookPayload = Record<string, unknown>;
type ToolName = "Read" | "Edit" | "Write" | "Bash" | "Grep" | "Glob" | "WebFetch" | "WebSearch" | "Notebook" | "Agent" | "Skill" | "Task" | "AskUserQuestion" | "MCP" | "Unknown";
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

  // 精确匹配已知内置工具
  const KNOWN_TOOLS = [
    "Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebFetch",
    "WebSearch", "Notebook", "Agent", "Skill",
    "TaskCreate", "TaskUpdate", "Task",
    "AskUserQuestion" // Claude Code 桌面端选择选项
  ];
  if (KNOWN_TOOLS.includes(raw)) {
    if (raw === "TaskCreate" || raw === "TaskUpdate") return "Task";
    return raw as ToolName;
  }

  // MCP 工具前缀匹配
  if (raw.startsWith("mcp__")) {
    return "MCP";
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

function isPermissionEvent(payload: HookPayload): boolean {
  const hook = hookName(payload);
  if (hook !== "PreToolUse") return false;
  // 权限已跳过时不介入：bypassPermissions / dontAsk / auto 模式下 Claude Code 不需要外部确认
  const permMode = text(payload.permission_mode) ?? text(payload.permissionMode) ?? "";
  if (permMode === "bypassPermissions" || permMode === "dontAsk" || permMode === "auto") return false;
  return true;
}

interface PermissionPollResult {
  status: "approved" | "denied" | "expired" | "error";
  decision?: "allow" | "deny";
  reason?: string;
}

function requestPermission(payload: HookPayload): Promise<PermissionPollResult> {
  const tool = toolName(payload);
  const detail = detailForTool(payload, tool);
  const sessionId = text(payload.session_id) ?? text(payload.sessionId);
  const permissionTimeout = Number(process.env.CLAWD_PERMISSION_TIMEOUT ?? "120000");

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      toolName: tool,
      toolDetail: detail,
      sessionId,
      rawPayload: payload
    });

    const req = request({
      host: "127.0.0.1",
      port,
      path: "/permission",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "authorization": `Bearer ${token}`
      },
      timeout: 5000
    }, (res: IncomingMessage) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          const id = result.id;
          if (!id) {
            resolve({ status: "error", reason: "No permission ID" });
            return;
          }
          longPollPermission(id, permissionTimeout).then(resolve).catch(reject);
        } catch {
          resolve({ status: "error", reason: "Invalid response" });
        }
      });
    });

    req.on("error", () => resolve({ status: "error", reason: "Server unavailable" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: "error", reason: "Request timeout" });
    });
    req.write(body);
    req.end();
  });
}

function longPollPermission(id: string, timeout: number): Promise<PermissionPollResult> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: `/permission/${id}`,
      method: "GET",
      headers: {
        "authorization": `Bearer ${token}`
      },
      timeout
    }, (res: IncomingMessage) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          resolve(result as PermissionPollResult);
        } catch {
          resolve({ status: "error", reason: "Invalid poll response" });
        }
      });
    });

    req.on("error", () => resolve({ status: "error", reason: "Poll error" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: "expired", reason: "Poll timeout" });
    });
    req.end();
  });
}

function writeStdoutDecision(result: PermissionPollResult, payload: HookPayload): void {
  if (result.decision === "allow" || result.decision === "deny") {
    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: result.decision,
        permissionDecisionReason: result.reason ?? (result.decision === "allow" ? "Approved via Clawd Companion" : "Denied via Clawd Companion")
      },
      continue: true
    };
    process.stdout.write(JSON.stringify(output));
  }
}

async function main() {
  const raw = readStdin();
  if (!raw.trim()) return;
  const payload = JSON.parse(raw) as HookPayload;

  if (isPermissionEvent(payload)) {
    try {
      const result = await requestPermission(payload);
      writeStdoutDecision(result, payload);
    } catch {
      // 出错时不写 stdout，Claude Code 会使用原生权限流程
    }
    return;
  }

  await postEvent(normalize(payload));
}

main().catch((error) => {
  process.stderr.write(`[clawd] forward error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(0);
});
