import { describe, expect, it } from "vitest";
import { claudeCodeProvider, codexProvider, getProvider, providers } from "../src/shared/providers.js";
import { stateFromEvent } from "../src/shared/events.js";

describe("provider registry", () => {
  it("exposes both built-in providers in a stable order", () => {
    expect(Object.keys(providers)).toEqual(["claude-code", "codex"]);
  });

  it("returns the same provider instance by id", () => {
    expect(getProvider("claude-code")).toBe(claudeCodeProvider);
    expect(getProvider("codex")).toBe(codexProvider);
  });
});

describe("claudeCodeProvider.normalize", () => {
  it("maps PreToolUse Read to a tool_start event", () => {
    const event = claudeCodeProvider.normalize(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/a.ts" }, session_id: "s1", cwd: "/tmp" },
      { privacyMode: "detailed" }
    );
    expect(event.source).toBe("claude-code");
    expect(event.event).toBe("tool_start");
    expect(event.tool).toBe("Read");
    expect(event.detail).toBe("a.ts");
    expect(stateFromEvent(event)).toBe("tool_read");
  });

  it("respects privacyMode safe by stripping details", () => {
    const event = claudeCodeProvider.normalize(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" } },
      { privacyMode: "safe" }
    );
    expect(event.detail).toBeUndefined();
  });

  it("skips permission flow when permission_mode is auto", () => {
    expect(claudeCodeProvider.isPermissionEvent({ hook_event_name: "PreToolUse", permission_mode: "auto" })).toBe(false);
    expect(claudeCodeProvider.isPermissionEvent({ hook_event_name: "PreToolUse", permission_mode: "default" })).toBe(true);
  });

  it("skips permission flow when permission_mode is missing (sub-agent scenario)", () => {
    expect(claudeCodeProvider.isPermissionEvent({ hook_event_name: "PreToolUse" })).toBe(false);
  });

  it("formats permission decisions in Claude's wire format", () => {
    const stdout = claudeCodeProvider.formatPermissionDecision("allow", "user said yes");
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "user said yes"
      },
      continue: true
    });
  });
});

describe("codexProvider.normalize", () => {
  it("maps SessionStart to a session_start event with codex source", () => {
    const event = codexProvider.normalize(
      { event: "SessionStart", session_id: "c-1", cwd: "/repo" },
      {}
    );
    expect(event.source).toBe("codex");
    expect(event.event).toBe("session_start");
    expect(event.clientLabel).toBe("OpenAI Codex CLI");
    expect(stateFromEvent(event)).toBe("thinking");
  });

  it("maps PreToolUse shell to tool_bash via the new Shell ToolName", () => {
    const event = codexProvider.normalize(
      { event: "PreToolUse", tool_name: "shell", tool_input: { command: "ls -la" } },
      { privacyMode: "detailed" }
    );
    expect(event.event).toBe("tool_start");
    expect(event.tool).toBe("Shell");
    expect(stateFromEvent(event)).toBe("tool_bash");
  });

  it("maps update_plan to task pet state", () => {
    const event = codexProvider.normalize(
      { event: "PreToolUse", tool_name: "update_plan" },
      {}
    );
    expect(event.tool).toBe("UpdatePlan");
    expect(stateFromEvent(event)).toBe("task");
  });

  it("maps apply_patch to tool_edit and view_image to tool_read", () => {
    expect(stateFromEvent(codexProvider.normalize({ event: "PreToolUse", tool_name: "apply_patch" }, {}))).toBe("tool_edit");
    expect(stateFromEvent(codexProvider.normalize({ event: "PreToolUse", tool_name: "view_image" }, {}))).toBe("tool_read");
  });

  it("treats PermissionRequest as a permission event with the Codex wire format", () => {
    expect(codexProvider.isPermissionEvent({ event: "PermissionRequest", tool_name: "shell" })).toBe(true);
    expect(codexProvider.isPermissionEvent({ event: "PreToolUse" })).toBe(false);
    const stdout = codexProvider.formatPermissionDecision("deny", "blocked by user");
    expect(JSON.parse(stdout)).toEqual({ continue: true, decision: "deny", reason: "blocked by user" });
  });

  it("maps Stop to done and SubagentStart to agent", () => {
    expect(stateFromEvent(codexProvider.normalize({ event: "Stop" }, {}))).toBe("done");
    expect(stateFromEvent(codexProvider.normalize({ event: "SubagentStart" }, {}))).toBe("agent");
  });

  it("falls back to a notification for unknown events", () => {
    const event = codexProvider.normalize({ event: "SomethingNew" }, {});
    expect(event.event).toBe("notification");
  });
});
