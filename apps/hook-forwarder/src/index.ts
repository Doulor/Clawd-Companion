#!/usr/bin/env node
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

type HookPayload = Record<string, unknown>;
type ToolName = "Read" | "Edit" | "Write" | "Bash" | "Grep" | "Glob" | "WebFetch" | "WebSearch" | "Notebook" | "Agent" | "Skill" | "Task" | "AskUserQuestion" | "MCP" | "Unknown";
type EventType = "session_start" | "prompt_submit" | "tool_start" | "tool_end" | "notification" | "permission_wait" | "done" | "error";
type ClientType = "cli" | "desktop" | "vscode" | "unknown";

export interface CompanionEvent {
  id: string;
  source: "claude-code";
  event: EventType;
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

interface ConnectionConfig {
  port?: number;
  token?: string;
}

export function parseCliOptions(args: string[]): { port?: string; token?: string } {
  const options: { port?: string; token?: string } = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--port") options.port = args[++index];
    else if (arg.startsWith("--port=")) options.port = arg.slice("--port=".length);
    else if (arg === "--token") options.token = args[++index];
    else if (arg.startsWith("--token=")) options.token = arg.slice("--token=".length);
  }
  return options;
}

export const connectionConfigPath = join(homedir(), ".clawd-companion", "connection.json");

function readConnectionConfig(): ConnectionConfig {
  try {
    const parsed = JSON.parse(readFileSync(connectionConfigPath, "utf8")) as ConnectionConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const cliOptions = parseCliOptions(process.argv.slice(2));
const fileConfig = readConnectionConfig();
const port = Number(cliOptions.port ?? process.env.CLAWD_COMPANION_PORT ?? fileConfig.port ?? "47634");
const token = cliOptions.token ?? process.env.CLAWD_COMPANION_TOKEN ?? fileConfig.token ?? "clawd-local";
const privacyMode = process.env.CLAWD_PRIVACY_MODE ?? "safe";
const configuredClientType = clientType(process.env.CLAWD_CLIENT_TYPE);
const configuredClientLabel = typeof process.env.CLAWD_CLIENT_LABEL === "string" && process.env.CLAWD_CLIENT_LABEL.trim() ? process.env.CLAWD_CLIENT_LABEL.trim() : labelForClient(configuredClientType);

// Auto-start is opt-in. The main app writes/clears this marker file when the
// user toggles the "Claude Code 启动时自动启动本应用" switch in the config panel.
// Env var override: CLAWD_COMPANION_AUTOSTART=1 forces on, =0 forces off.
export const autoStartMarkerPath = join(homedir(), ".clawd-companion", "auto-start-with-cli.flag");
const forwarderLogPath = join(homedir(), ".clawd-companion", "forwarder.log");

function forwarderLog(msg: string): void {
  try {
    const dir = dirname(forwarderLogPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(forwarderLogPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // ignore — logging must never break the hook
  }
}

export function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function hookName(payload: HookPayload): string {
  return text(payload.hook_event_name) ?? text(payload.hookEventName) ?? text(payload.event) ?? "Unknown";
}

export function clientType(value: unknown): ClientType {
  const raw = typeof value === "string" ? value.toLowerCase() : "";
  if (raw.includes("vscode") || raw.includes("vs-code")) return "vscode";
  if (raw.includes("desktop")) return "desktop";
  if (raw.includes("cli") || raw.includes("terminal") || raw.includes("code")) return "cli";
  return "unknown";
}

export function labelForClient(client: ClientType) {
  if (client === "cli") return "Claude CLI";
  if (client === "desktop") return "Claude Desktop";
  if (client === "vscode") return "VS Code";
  return "Claude Code";
}

export function clientFromPayload(payload: HookPayload): { clientType: ClientType; clientLabel: string } {
  const raw = text(payload.client) ?? text(payload.client_type) ?? text(payload.clientType) ?? text(payload.app) ?? text(payload.source);
  const detected = clientType(raw);
  if (detected !== "unknown") return { clientType: detected, clientLabel: labelForClient(detected) };
  return { clientType: configuredClientType, clientLabel: configuredClientLabel };
}

export function toolName(payload: HookPayload): ToolName {
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

export function basename(pathLike: string | undefined): string | undefined {
  if (!pathLike) return undefined;
  const parts = pathLike.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1);
}

export function detailForTool(payload: HookPayload, tool: ToolName): string | undefined {
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

export function summarizeCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const trimmed = command.replace(/\s+/g, " ").trim();
  return trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed;
}

export function normalize(payload: HookPayload): CompanionEvent {
  const hook = hookName(payload);
  const tool = toolName(payload);
  const sessionId = text(payload.session_id) ?? text(payload.sessionId);
  const detail = detailForTool(payload, tool);
  const client = clientFromPayload(payload);
  const cwd = text(payload.cwd) ?? text(payload.working_directory);
  const base = {
    id: randomUUID(),
    source: "claude-code" as const,
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

export function titleForTool(tool: ToolName): string {
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

export function postEvent(event: CompanionEvent): Promise<void> {
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

export function isPermissionEvent(payload: HookPayload): boolean {
  const hook = hookName(payload);
  if (hook !== "PreToolUse") return false;
  // permission_mode 字段缺失时（子 agent 派发场景），不介入权限流程
  const permMode = text(payload.permission_mode) ?? text(payload.permissionMode);
  if (permMode === undefined) return false;
  // 权限已跳过时不介入：bypassPermissions / dontAsk / auto 模式下 Claude Code 不需要外部确认
  if (permMode === "bypassPermissions" || permMode === "dontAsk" || permMode === "auto") return false;
  return true;
}

interface PermissionPollResult {
  status: "approved" | "denied" | "expired" | "error";
  decision?: "allow" | "deny";
  reason?: string;
}

export function requestPermission(payload: HookPayload): Promise<PermissionPollResult> {
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

export function longPollPermission(id: string, timeout: number): Promise<PermissionPollResult> {
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

export function writeStdoutDecision(result: PermissionPollResult, payload: HookPayload): void {
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

/**
 * Detect how to launch the Clawd Companion main app based on where this
 * forwarder lives. Returns null if we cannot determine a launch path.
 *
 * Dev layout:   <project>/dist/hook-forwarder/index.js  →  npm start in <project>
 * Prod layout:  <install>/resources/hook-forwarder/index.js  →  <install>/Clawd Companion.exe
 */
export function findCompanionExecutable(): { command: string; args: string[]; cwd?: string } | null {
  // In tests or other contexts __filename may be undefined; use fileURLToPath on import.meta.url
  let here: string;
  try {
    here = fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
  const norm = here.replaceAll("\\", "/");

  if (norm.endsWith("/dist/hook-forwarder/index.js")) {
    const projectRoot = norm.slice(0, -"/dist/hook-forwarder/index.js".length);
    // 直接 spawn electron.exe 而非 npm.cmd —— Node 22 在 Windows 上禁止
    // 直接 spawn .cmd 文件（会抛 EINVAL），绕开 npm 是最简单的修法
    const electronExe = process.platform === "win32"
      ? `${projectRoot}/node_modules/electron/dist/electron.exe`
      : `${projectRoot}/node_modules/electron/dist/electron`;
    return { command: electronExe, args: [projectRoot] };
  }

  if (norm.endsWith("/resources/hook-forwarder/index.js")) {
    // 字符串切片更可靠：直接砍掉 "/resources/hook-forwarder/index.js" 后缀就是 install dir
    const installDir = norm.slice(0, -"/resources/hook-forwarder/index.js".length);
    const exeName = process.platform === "win32" ? "Clawd Companion.exe" : "Clawd Companion";
    return { command: `${installDir}/${exeName}`, args: [] };
  }

  return null;
}

/** Quick TCP-level ping: returns true if Clawd Companion is already serving /health. */
export function pingHealth(timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/health",
      method: "GET",
      timeout: timeoutMs
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Resolve whether the user has enabled CLI auto-start. Default is OFF.
 *
 * Resolution order:
 * 1. CLAWD_COMPANION_AUTOSTART=0 → force off
 * 2. CLAWD_COMPANION_AUTOSTART=1 → force on
 * 3. Otherwise: read the marker file written by the main app's settings panel
 *
 * Exported for testability.
 */
export function isAutoStartEnabled(): boolean {
  const envOverride = process.env.CLAWD_COMPANION_AUTOSTART;
  if (envOverride === "0") return false;
  if (envOverride === "1") return true;
  return existsSync(autoStartMarkerPath);
}

/**
 * Wake up Clawd Companion. Best-effort, never throws. Returns true if the
 * app is reachable after the call (either it was already running, or we
 * spawned it successfully).
 */
export async function wakeupCompanion(log: (msg: string) => void = () => {}): Promise<boolean> {
  const envOverride = process.env.CLAWD_COMPANION_AUTOSTART ?? "(unset)";
  const markerExists = existsSync(autoStartMarkerPath);
  log(`[clawd] auto-start: env=${envOverride} marker=${autoStartMarkerPath} exists=${markerExists}`);

  if (!isAutoStartEnabled()) {
    log("[clawd] auto-start: disabled");
    return false;
  }

  if (await pingHealth()) {
    log("[clawd] auto-start: companion already running on /health");
    return true;
  }

  const target = findCompanionExecutable();
  if (!target) {
    log("[clawd] auto-start: cannot determine companion path (forwarder location unrecognized)");
    return false;
  }
  log(`[clawd] auto-start: spawning ${target.command} ${target.args.join(" ")}`);

  try {
    const child = spawn(target.command, target.args, {
      detached: true,
      stdio: "ignore",
      cwd: target.cwd,
      windowsHide: true
    });
    child.on("error", err => log(`[clawd] auto-start: spawn error: ${err.message}`));
    child.unref();
    log(`[clawd] auto-start: spawned (pid=${child.pid})`);
    return true;
  } catch (err) {
    log(`[clawd] auto-start: failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main() {
  const raw = readStdin();
  if (!raw.trim()) return;
  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    process.stderr.write("[clawd] forward error: invalid JSON from stdin\n");
    return;
  }

  if (isPermissionEvent(payload)) {
    try {
      const result = await requestPermission(payload);
      writeStdoutDecision(result, payload);
    } catch {
      // 出错时不写 stdout，Claude Code 会使用原生权限流程
    }
    return;
  }

  // CLI 启动时自动唤起主程序：仅在 SessionStart 时执行
  if (hookName(payload) === "SessionStart") {
    forwarderLog("SessionStart received, attempting auto-start");
    // await wakeupCompanion so the spawn has time to complete before process exits
    await wakeupCompanion(msg => {
      process.stderr.write(msg + "\n");
      forwarderLog(msg);
    });
  }

  await postEvent(normalize(payload));
}

// Only run main() when executed directly (not when imported by tests).
const invokedDirectly = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[clawd] forward error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(0);
  });
}
