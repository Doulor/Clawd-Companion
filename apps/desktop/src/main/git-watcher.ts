import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { CompanionEvent } from "../shared/events.js";

const execFileAsync = promisify(execFile);

interface GitState {
  cwd: string;
  lastCommit: string | null;
  lastBranch: string | null;
  lastStatus: string | null;
  watchers: FSWatcher[];
  throttle: ReturnType<typeof setTimeout> | null;
  debounce: NodeJS.Timeout | null;
}

let state: GitState | null = null;

function readHead(cwd: string): { ref: string | null; commit: string | null; branch: string | null } {
  const headPath = join(cwd, ".git", "HEAD");
  if (!existsSync(headPath)) return { ref: null, commit: null, branch: null };
  const head = readFileSync(headPath, "utf8").trim();
  if (head.startsWith("ref: ")) {
    const ref = head.slice(5);
    const branch = ref.replace(/^refs\/heads\//, "");
    const refPath = join(cwd, ".git", ref);
    if (existsSync(refPath)) {
      const commit = readFileSync(refPath, "utf8").trim();
      return { ref, commit, branch };
    }
    return { ref, commit: null, branch };
  }
  // Detached HEAD
  return { ref: null, commit: head, branch: null };
}

async function gitLog(cwd: string, n = 1): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["log", "-1", `--pretty=%h %s`, "-n", String(n)], { cwd, windowsHide: true, timeout: 3000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function gitStatusShort(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "-sb"], { cwd, windowsHide: true, timeout: 3000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

function detectOp(prev: GitState | null, current: { commit: string | null; branch: string | null; status: string }, log: string, status: string): CompanionEvent | null {
  if (!log) return null;
  if (!prev) {
    // First time we see this repo — just record state, don't emit.
    return null;
  }

  // Branch changed → checkout
  if (current.branch && prev.lastBranch && current.branch !== prev.lastBranch) {
    return {
      id: randomUUID(),
      source: "claude-code",
      event: "git_operation",
      title: "↔ checkout",
      message: `已切换到 ${current.branch}`,
      timestamp: Date.now()
    };
  }

  // New commit
  if (current.commit && current.commit !== prev.lastCommit) {
    if (log.toLowerCase().includes("merge")) {
      return {
        id: randomUUID(),
        source: "claude-code",
        event: "git_operation",
        title: "✓ merge",
        message: log,
        timestamp: Date.now()
      };
    }
    return {
      id: randomUUID(),
      source: "claude-code",
      event: "git_operation",
      title: "✓ commit",
      message: log,
      timestamp: Date.now()
    };
  }

  // Status went from dirty to clean but no new commit detected (rare race) — still useful
  if (prev.lastStatus && current.status && prev.lastStatus.length > 0 && current.status === `## ${current.branch ?? "HEAD"}\n`) {
    return {
      id: randomUUID(),
      source: "claude-code",
      event: "git_operation",
      title: "✓ committed",
      message: log,
      timestamp: Date.now()
    };
  }

  return null;
}

async function pollAndDetect() {
  if (!state) return;
  const prev = state;
  const head = readHead(prev.cwd);
  if (!head.commit && !head.branch) return;

  const log = await gitLog(prev.cwd);
  const status = await gitStatusShort(prev.cwd);
  const next = {
    commit: head.commit,
    branch: head.branch,
    status
  };

  const event = detectOp(prev, next, log, status);
  if (event) {
    state.lastCommit = next.commit;
    state.lastBranch = next.branch;
    state.lastStatus = next.status;
    if (onEvent) onEvent(event);
    return;
  }

  // Update state even if no event so we have a baseline
  state.lastCommit = next.commit;
  state.lastBranch = next.branch;
  state.lastStatus = next.status;
}

let onEvent: ((e: CompanionEvent) => void) | null = null;

export function setGitEventHandler(handler: (e: CompanionEvent) => void) {
  onEvent = handler;
}

export function startGitWatcher(cwd: string | null | undefined) {
  stopGitWatcher();
  if (!cwd) return;
  const gitDir = join(cwd, ".git");
  if (!existsSync(gitDir)) return;

  const watchers: FSWatcher[] = [];
  // Watch HEAD and refs/heads. Use try/catch because some git operations
  // (e.g., rebase) move files around and we may not be able to attach.
  try {
    watchers.push(watch(join(gitDir, "HEAD"), { persistent: true }, () => schedulePoll()));
  } catch { /* ignore */ }
  try {
    watchers.push(watch(join(gitDir, "index"), { persistent: true }, () => schedulePoll()));
  } catch { /* ignore */ }

  // Watch refs/heads/<branch> once we know the branch
  state = {
    cwd,
    lastCommit: null,
    lastBranch: null,
    lastStatus: null,
    watchers,
    throttle: null,
    debounce: null
  };

  // Initial baseline
  void (async () => {
    const head = readHead(cwd);
    state!.lastCommit = head.commit;
    state!.lastBranch = head.branch;
    state!.lastStatus = await gitStatusShort(cwd);
  })();
}

function schedulePoll() {
  if (!state) return;
  if (state.throttle) return;
  state.throttle = setTimeout(() => {
    if (state) state.throttle = null;
    void pollAndDetect();
  }, 800);
}

export function stopGitWatcher() {
  if (!state) return;
  state.watchers.forEach(w => { try { w.close(); } catch { /* ignore */ } });
  if (state.throttle) clearTimeout(state.throttle);
  state = null;
}
