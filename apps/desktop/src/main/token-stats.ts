import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { DailyTokenEntry, SessionTokenInfo, TokenStats } from "../shared/events.js";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

interface CachedSession {
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
  fileMtime: number;
}

interface TokenStatsCacheFile {
  version: 1;
  lastScannedAt: number;
  sessions: Record<string, CachedSession>;
}

let cache: TokenStatsCacheFile | null = null;
let cachePath: string | null = null;
let scanning = false;

export function setCachePath(path: string) {
  cachePath = path;
}

function loadCache(): TokenStatsCacheFile {
  if (cache) return cache;
  if (cachePath && existsSync(cachePath)) {
    try {
      const raw = JSON.parse(readFileSync(cachePath, "utf8")) as TokenStatsCacheFile;
      if (raw.version === 1 && raw.sessions) {
        cache = raw;
        return cache;
      }
    } catch { /* fall through */ }
  }
  cache = { version: 1, lastScannedAt: 0, sessions: {} };
  return cache;
}

function saveCache() {
  if (!cache || !cachePath) return;
  try {
    writeFileSync(cachePath, JSON.stringify(cache));
  } catch { /* best effort */ }
}

interface AssistantMessage {
  type: string;
  message?: {
    role?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  timestamp?: string;
  cwd?: string;
  entrypoint?: string;
  gitBranch?: string;
  sessionId?: string;
}

function parseSessionFile(filePath: string): CachedSession | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split("\n");
  let sessionId = "";
  let cwd = "";
  let entrypoint = "";
  let model = "";
  let startTime = Number.MAX_SAFE_INTEGER;
  let endTime = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let messageCount = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: AssistantMessage;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
    if (!cwd && obj.cwd) cwd = obj.cwd;
    if (!entrypoint && obj.entrypoint) entrypoint = obj.entrypoint;

    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (!isNaN(ts)) {
      if (ts < startTime) startTime = ts;
      if (ts > endTime) endTime = ts;
    }

    if (obj.type === "assistant") {
      messageCount++;
      const msg = obj.message;
      if (msg?.model) model = msg.model;
      const usage = msg?.usage;
      if (usage) {
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
        cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
      }
    }
  }

  if (!sessionId) return null;
  if (startTime === Number.MAX_SAFE_INTEGER) startTime = 0;
  if (endTime === 0) endTime = startTime;

  const project = cwd || dirname(filePath);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  let mtime = 0;
  try { mtime = statSync(filePath).mtimeMs; } catch { /* ignore */ }

  return {
    sessionId,
    project,
    cwd,
    startTime,
    endTime,
    model: model || "unknown",
    entrypoint,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    messageCount,
    fileMtime: mtime
  };
}

function walkSessionFiles(): { path: string; mtime: number }[] {
  const out: { path: string; mtime: number }[] = [];
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return out;
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return out;
  }
  for (const projectDir of projectDirs) {
    const fullDir = join(CLAUDE_PROJECTS_DIR, projectDir);
    let stat;
    try { stat = statSync(fullDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let files: string[];
    try { files = readdirSync(fullDir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(fullDir, file);
      try {
        const mtime = statSync(filePath).mtimeMs;
        out.push({ path: filePath, mtime });
      } catch { /* skip */ }
    }
  }
  return out;
}

export async function scanTokenStats(force = false): Promise<TokenStats> {
  if (scanning) {
    return aggregate(loadCache());
  }
  scanning = true;
  try {
    const cacheData = loadCache();
    const files = walkSessionFiles();

    // Determine which files need re-parsing
    const toScan: typeof files = [];
    if (force) {
      cacheData.sessions = {};
    }
    for (const f of files) {
      const sessionId = f.path.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "");
      if (!sessionId) continue;
      const existing = cacheData.sessions[sessionId];
      if (!existing || existing.fileMtime < f.mtime - 100) {
        toScan.push(f);
      }
    }

    for (const f of toScan) {
      const sessionId = f.path.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "");
      if (!sessionId) continue;
      const parsed = parseSessionFile(f.path);
      if (parsed) {
        cacheData.sessions[sessionId] = parsed;
      }
    }
    cacheData.lastScannedAt = Date.now();
    saveCache();
    return aggregate(cacheData);
  } finally {
    scanning = false;
  }
}

function aggregate(cacheData: TokenStatsCacheFile): TokenStats {
  const sessions = Object.values(cacheData.sessions);
  const dailyMap = new Map<string, DailyTokenEntry>();
  const modelMap = new Map<string, { model: string; totalTokens: number; sessionCount: number; messageCount: number }>();
  const dailyTotalsMap = new Map<string, { date: string; totalTokens: number; sessionIds: Set<string>; messageCount: number }>();
  let totalTokens = 0;

  for (const s of sessions) {
    const date = new Date(s.startTime || s.endTime).toISOString().slice(0, 10);
    const key = `${date}|${s.model}`;
    let entry = dailyMap.get(key);
    if (!entry) {
      entry = {
        date,
        model: s.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        sessionCount: 0,
        messageCount: 0
      };
      dailyMap.set(key, entry);
    }
    entry.inputTokens += s.inputTokens;
    entry.outputTokens += s.outputTokens;
    entry.cacheReadTokens += s.cacheReadTokens;
    entry.cacheCreationTokens += s.cacheCreationTokens;
    entry.totalTokens += s.totalTokens;
    entry.messageCount += s.messageCount;
    entry.sessionCount += 1;

    const modelEntry = modelMap.get(s.model) ?? { model: s.model, totalTokens: 0, sessionCount: 0, messageCount: 0 };
    modelEntry.totalTokens += s.totalTokens;
    modelEntry.sessionCount += 1;
    modelEntry.messageCount += s.messageCount;
    modelMap.set(s.model, modelEntry);

    const dt = dailyTotalsMap.get(date) ?? { date, totalTokens: 0, sessionIds: new Set(), messageCount: 0 };
    dt.totalTokens += s.totalTokens;
    dt.sessionIds.add(s.sessionId);
    dt.messageCount += s.messageCount;
    dailyTotalsMap.set(date, dt);

    totalTokens += s.totalTokens;
  }

  const dailyTotals = Array.from(dailyTotalsMap.values())
    .map(d => ({ date: d.date, totalTokens: d.totalTokens, sessionCount: d.sessionIds.size, messageCount: d.messageCount }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const modelTotals = Array.from(modelMap.values()).sort((a, b) => b.totalTokens - a.totalTokens);

  const sortedSessions = sessions
    .sort((a, b) => b.endTime - a.endTime)
    .slice(0, 50)
    .map<SessionTokenInfo>(s => ({
      sessionId: s.sessionId,
      project: s.project,
      cwd: s.cwd,
      startTime: s.startTime,
      endTime: s.endTime,
      model: s.model,
      entrypoint: s.entrypoint,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheReadTokens: s.cacheReadTokens,
      cacheCreationTokens: s.cacheCreationTokens,
      totalTokens: s.totalTokens,
      messageCount: s.messageCount
    }));

  return {
    sessions: sortedSessions,
    daily: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model)),
    modelTotals,
    dailyTotals,
    totalTokens,
    totalSessions: sessions.length,
    lastScannedAt: cacheData.lastScannedAt,
    scanning: false
  };
}
