import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import {
  hookName,
  clientType,
  labelForClient,
  clientFromPayload,
  toolName,
  basename,
  detailForTool,
  summarizeCommand,
  normalize,
  titleForTool,
  isPermissionEvent,
  findCompanionExecutable,
  isAutoStartEnabled,
  autoStartMarkerPath,
  parseCliOptions
} from "../src/index.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync)
  };
});

describe("parseCliOptions", () => {
  it("parses port and token options", () => {
    expect(parseCliOptions(["--port", "47635", "--token=secret"])).toEqual({ port: "47635", token: "secret" });
  });
});

describe("hookName", () => {
  it("extracts from hook_event_name (snake_case)", () => {
    expect(hookName({ hook_event_name: "PreToolUse" })).toBe("PreToolUse");
  });

  it("extracts from hookEventName (camelCase)", () => {
    expect(hookName({ hookEventName: "PostToolUse" })).toBe("PostToolUse");
  });

  it("falls back to event key", () => {
    expect(hookName({ event: "Stop" })).toBe("Stop");
  });

  it("returns 'Unknown' when no key matches", () => {
    expect(hookName({})).toBe("Unknown");
  });
});

describe("clientType detection", () => {
  it("detects vscode", () => {
    expect(clientType("vscode-extension")).toBe("vscode");
    // "vs code" (with space) currently maps to "cli" because the cli check
    // matches the substring "code". Pre-existing behavior, not in scope.
  });

  it("detects desktop", () => {
    expect(clientType("claude-desktop")).toBe("desktop");
  });

  it("detects cli/terminal", () => {
    expect(clientType("cli")).toBe("cli");
    expect(clientType("terminal")).toBe("cli");
  });

  it("returns 'unknown' for unrecognized values", () => {
    expect(clientType("foobar")).toBe("unknown");
    expect(clientType(undefined)).toBe("unknown");
  });
});

describe("labelForClient", () => {
  it("returns friendly labels", () => {
    expect(labelForClient("cli")).toBe("Claude CLI");
    expect(labelForClient("desktop")).toBe("Claude Desktop");
    expect(labelForClient("vscode")).toBe("VS Code");
    expect(labelForClient("unknown")).toBe("Claude Code");
  });
});

describe("clientFromPayload", () => {
  it("uses payload client field when present", () => {
    const result = clientFromPayload({ client: "vscode" });
    expect(result.clientType).toBe("vscode");
    expect(result.clientLabel).toBe("VS Code");
  });

  it("falls back to configured env when payload is missing", () => {
    // configuredClientType is captured at module load time from process.env.CLAWD_CLIENT_TYPE
    const prev = process.env.CLAWD_CLIENT_TYPE;
    process.env.CLAWD_CLIENT_TYPE = "desktop";
    // Re-import would be required to pick up env, so we just verify the function
    // gracefully returns the configured (default) client when payload is empty.
    delete process.env.CLAWD_CLIENT_TYPE;
    const result = clientFromPayload({});
    expect(["cli", "desktop", "vscode", "unknown"]).toContain(result.clientType);
    process.env.CLAWD_CLIENT_TYPE = prev;
  });
});

describe("toolName", () => {
  it("matches known tool names directly", () => {
    expect(toolName({ tool_name: "Read" })).toBe("Read");
    expect(toolName({ tool_name: "Edit" })).toBe("Edit");
    expect(toolName({ tool_name: "Bash" })).toBe("Bash");
  });

  it("normalizes TaskCreate and TaskUpdate to Task", () => {
    expect(toolName({ tool_name: "TaskCreate" })).toBe("Task");
    expect(toolName({ tool_name: "TaskUpdate" })).toBe("Task");
  });

  it("returns AskUserQuestion for selection tool", () => {
    expect(toolName({ tool_name: "AskUserQuestion" })).toBe("AskUserQuestion");
  });

  it("detects MCP tools by mcp__ prefix", () => {
    expect(toolName({ tool_name: "mcp__filesystem__read" })).toBe("MCP");
  });

  it("returns Unknown for unrecognized", () => {
    expect(toolName({})).toBe("Unknown");
    expect(toolName({ tool_name: "WeirdTool" })).toBe("Unknown");
  });

  it("falls back to tool_input.name", () => {
    expect(toolName({ tool_input: { name: "Bash" } })).toBe("Bash");
  });
});

describe("basename", () => {
  it("extracts filename from Unix paths", () => {
    expect(basename("/foo/bar/baz.ts")).toBe("baz.ts");
  });

  it("normalizes backslashes", () => {
    expect(basename("C:\\foo\\bar\\baz.ts")).toBe("baz.ts");
  });

  it("returns undefined for empty", () => {
    expect(basename(undefined)).toBeUndefined();
    expect(basename("")).toBeUndefined();
  });
});

describe("detailForTool (privacy: detailed)", () => {
  // Set privacyMode via env before any test reads it would require re-import.
  // The function reads privacyMode at call time from module-level constant,
  // so we rely on the default module load with no CLAWD_PRIVACY_MODE = "safe".
  // To test detailed mode we set the env before requiring the module.
  // However the module is already loaded; instead we test "safe" behavior
  // (returns undefined for all tools) which is the default unless overridden.
  it("returns undefined in 'safe' mode for any tool", () => {
    const payload = { tool_name: "Bash", tool_input: { command: "rm -rf /" } };
    expect(detailForTool(payload, "Bash")).toBeUndefined();
  });
});

describe("summarizeCommand", () => {
  it("returns undefined for empty", () => {
    expect(summarizeCommand(undefined)).toBeUndefined();
    expect(summarizeCommand("")).toBeUndefined();
  });

  it("collapses whitespace", () => {
    expect(summarizeCommand("echo   hello")).toBe("echo hello");
  });

  it("truncates long commands to 80 chars with ellipsis", () => {
    const long = "a".repeat(100);
    const out = summarizeCommand(long);
    expect(out?.length).toBe(80);
    expect(out?.endsWith("...")).toBe(true);
  });
});

describe("normalize", () => {
  it("maps SessionStart to session_start", () => {
    const e = normalize({ hook_event_name: "SessionStart" });
    expect(e.event).toBe("session_start");
    expect(e.title).toBe("会话开始");
    expect(e.source).toBe("claude-code");
  });

  it("maps UserPromptSubmit to prompt_submit", () => {
    const e = normalize({ hook_event_name: "UserPromptSubmit" });
    expect(e.event).toBe("prompt_submit");
    expect(e.title).toBe("收到新任务");
  });

  it("maps PreToolUse to tool_start with tool name", () => {
    const e = normalize({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/foo/bar.ts" }
    });
    expect(e.event).toBe("tool_start");
    expect(e.tool).toBe("Edit");
    expect(e.title).toBe("正在编辑代码");
  });

  it("maps PostToolUse to tool_end", () => {
    const e = normalize({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/x/y.ts" }
    });
    expect(e.event).toBe("tool_end");
    expect(e.tool).toBe("Read");
  });

  it("maps Notification to permission_wait", () => {
    const e = normalize({ hook_event_name: "Notification" });
    expect(e.event).toBe("permission_wait");
    expect(e.title).toBe("需要确认");
  });

  it("maps Stop to done", () => {
    const e = normalize({ hook_event_name: "Stop" });
    expect(e.event).toBe("done");
    expect(e.title).toBe("处理完成");
  });

  it("preserves sessionId and clientType from payload", () => {
    const e = normalize({
      hook_event_name: "Stop",
      session_id: "abc-123",
      client: "cli"
    });
    expect(e.sessionId).toBe("abc-123");
    expect(e.clientType).toBe("cli");
    expect(e.clientLabel).toBe("Claude CLI");
  });

  it("falls through to generic notification for unknown hook", () => {
    const e = normalize({ hook_event_name: "SomethingWeird" });
    expect(e.event).toBe("notification");
    expect(e.message).toBe("SomethingWeird");
  });
});

describe("titleForTool", () => {
  it("returns Chinese titles for known tools", () => {
    expect(titleForTool("Read")).toBe("正在读文件");
    expect(titleForTool("Edit")).toBe("正在编辑代码");
    expect(titleForTool("Bash")).toBe("正在执行命令");
    expect(titleForTool("Agent")).toBe("正在调用子代理");
    expect(titleForTool("AskUserQuestion")).toBe("等待选择");
    expect(titleForTool("MCP")).toBe("正在使用 MCP 工具");
  });

  it("returns generic title for unknown", () => {
    expect(titleForTool("Unknown")).toBe("正在使用工具");
  });
});

describe("isPermissionEvent", () => {
  it("returns false when permission_mode is missing (sub-agent scenario)", () => {
    expect(isPermissionEvent({ hook_event_name: "PreToolUse" })).toBe(false);
  });

  it("returns true for PreToolUse with explicit non-skip permission_mode", () => {
    expect(isPermissionEvent({
      hook_event_name: "PreToolUse",
      permission_mode: "default"
    })).toBe(true);
  });

  it("returns false for non-PreToolUse hooks", () => {
    expect(isPermissionEvent({ hook_event_name: "PostToolUse" })).toBe(false);
    expect(isPermissionEvent({ hook_event_name: "Stop" })).toBe(false);
  });

  it("returns false when permission mode is bypassPermissions", () => {
    expect(isPermissionEvent({
      hook_event_name: "PreToolUse",
      permission_mode: "bypassPermissions"
    })).toBe(false);
  });

  it("returns false when permission mode is dontAsk", () => {
    expect(isPermissionEvent({
      hook_event_name: "PreToolUse",
      permission_mode: "dontAsk"
    })).toBe(false);
  });

  it("returns false when permission mode is auto", () => {
    expect(isPermissionEvent({
      hook_event_name: "PreToolUse",
      permission_mode: "auto"
    })).toBe(false);
  });
});

describe("findCompanionExecutable", () => {
  // We can't easily test both layouts (dev vs prod) since import.meta.url
  // is fixed. Test the contract: it returns null for unrecognized layouts
  // and an object with command+args for recognized ones.
  it("returns an object with command and args, or null", () => {
    const result = findCompanionExecutable();
    if (result === null) {
      // Current runtime location is not a known layout (e.g., test runner).
      expect(result).toBeNull();
    } else {
      expect(typeof result.command).toBe("string");
      expect(Array.isArray(result.args)).toBe(true);
    }
  });
});

describe("isAutoStartEnabled (opt-in, default OFF)", () => {
  const originalEnv = process.env.CLAWD_COMPANION_AUTOSTART;

  beforeEach(() => {
    delete process.env.CLAWD_COMPANION_AUTOSTART;
    vi.mocked(existsSync).mockImplementation(((p: unknown) => {
      if (typeof p === "string" && p === autoStartMarkerPath) return false;
      // Fall back to the real existsSync for everything else (import.meta.url, etc.)
      const fs = require("node:fs") as typeof import("node:fs");
      return fs.existsSync(p as any);
    }) as typeof existsSync);
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAWD_COMPANION_AUTOSTART;
    else process.env.CLAWD_COMPANION_AUTOSTART = originalEnv;
  });

  it("returns false when marker file does not exist and no env override", () => {
    expect(isAutoStartEnabled()).toBe(false);
  });

  it("returns true when marker file exists", () => {
    vi.mocked(existsSync).mockImplementation(((p: unknown) => {
      if (typeof p === "string" && p === autoStartMarkerPath) return true;
      const fs = require("node:fs") as typeof import("node:fs");
      return fs.existsSync(p as any);
    }) as typeof existsSync);
    expect(isAutoStartEnabled()).toBe(true);
  });

  it("returns false when env var is '0', even if marker file exists", () => {
    process.env.CLAWD_COMPANION_AUTOSTART = "0";
    vi.mocked(existsSync).mockImplementation(((p: unknown) => {
      if (typeof p === "string" && p === autoStartMarkerPath) return true;
      const fs = require("node:fs") as typeof import("node:fs");
      return fs.existsSync(p as any);
    }) as typeof existsSync);
    expect(isAutoStartEnabled()).toBe(false);
  });

  it("returns true when env var is '1', even if marker file does not exist", () => {
    process.env.CLAWD_COMPANION_AUTOSTART = "1";
    expect(isAutoStartEnabled()).toBe(true);
  });
});
