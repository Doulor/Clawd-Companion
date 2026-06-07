import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, screen, shell, dialog, globalShortcut } from "electron";
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { CompanionConnectionStatus, CompanionEvent, CompanionSettings, PermissionPollResult, PermissionResponse, UpdateStatus, AppStats, TokenStats, EventHistoryEntry, NotificationRule, CustomPlugin } from "../shared/events.js";
import { defaultSettings, defaultStats } from "../shared/events.js";
import { scanTokenStats, setCachePath as setTokenCachePath } from "./token-stats.js";
import { setGitEventHandler, startGitWatcher, stopGitWatcher } from "./git-watcher.js";
import { getSoundDataUrl, previewSoundDataUrl } from "./sound.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const devIconPath = join(__dirname, "../../build/icon.ico");
const prodIconPath = join(process.resourcesPath, "build/icon.ico");
const iconPath = existsSync(devIconPath) ? devIconPath : prodIconPath;
const appDataDir = join(app.getPath("userData"), "clawd-companion");
const settingsPath = join(appDataDir, "settings.json");
const statsPath = join(appDataDir, "stats.json");
const logPath = join(appDataDir, "runtime.log");
const tokenCachePath = join(appDataDir, "token-stats-cache.json");
setTokenCachePath(tokenCachePath);
let lastKnownCwd: string | null = null;

let petWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: CompanionSettings = defaultSettings;
let eventServer: ReturnType<typeof createServer> | null = null;
let wsServer: WebSocketServer | null = null;
let serverListening = false;
let serverError: string | undefined;
let lastEvent: CompanionEvent | null = null;
let eventHistory: EventHistoryEntry[] = [];
let suppressPetMoveSave = false;
let saveDebounce: ReturnType<typeof setTimeout> | null = null;
let trackedPetPos = { x: 0, y: 0 };
let activeSessionId: string | undefined;
let activeClientType: CompanionEvent["clientType"] | undefined;
let activeClientLabel: string | undefined;

let updateStatus: UpdateStatus = {
  checking: false,
  available: false,
  upToDate: false,
  downloaded: false,
  downloading: false
};
let downloadedInstallerPath: string | undefined;
let appStats: AppStats = { ...defaultStats };
let appStartTime = Date.now();
let sessionStartRuntime = 0; // 本次启动前已累计的运行时间

function loadStats(): AppStats {
  ensureDataDir();
  if (!existsSync(statsPath)) {
    return { ...defaultStats, firstStartTime: Date.now() };
  }
  try {
    const stored = JSON.parse(readFileSync(statsPath, "utf8")) as Partial<AppStats>;
    // 保存上次的累计运行时间，用于本次启动后累加
        sessionStartRuntime = stored.totalRuntime ?? 0;
    const merged = { ...defaultStats, ...stored, hourlyActivity: stored.hourlyActivity ?? new Array(24).fill(0) };
    return pruneOldStats(merged);
  } catch {
    return { ...defaultStats, firstStartTime: Date.now() };
  }
}


function pruneOldStats(stats: AppStats): AppStats {
  const maxDays = 90;
  const dates = Object.keys(stats.dailyStats).sort();
  if (dates.length > maxDays) {
    const toDelete = dates.slice(0, dates.length - maxDays);
    for (const d of toDelete) delete stats.dailyStats[d];
  }
  return stats;
}

function saveStats() {
  ensureDataDir();
  writeFileSync(statsPath, JSON.stringify(appStats, null, 2));
}

function trackEvent(event: CompanionEvent) {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const hour = new Date(now).getHours();

  // 工具使用统计
  if (event.tool && event.tool !== "Unknown") {
    appStats.toolUsage[event.tool] = (appStats.toolUsage[event.tool] ?? 0) + 1;
  }

  // 事件类型统计
  appStats.eventTypeCounts[event.event] = (appStats.eventTypeCounts[event.event] ?? 0) + 1;

  // 每日统计
  if (!appStats.dailyStats[today]) {
    appStats.dailyStats[today] = { events: 0, toolCalls: 0, sessions: 0 };
  }
  appStats.dailyStats[today].events++;
  if (event.event === "tool_start") appStats.dailyStats[today].toolCalls++;
  if (event.event === "session_start") {
    appStats.dailyStats[today].sessions++;
    appStats.totalSessions++;
  }

  // 错误统计
  if (event.event === "error") appStats.errorCount++;

  // 权限统计
  if (event.event === "permission_wait") appStats.permissionRequests++;

  // 小时活跃度
  appStats.hourlyActivity[hour] = (appStats.hourlyActivity[hour] ?? 0) + 1;

  // 运行时间（累计所有启动的运行时间）
  appStats.totalRuntime = sessionStartRuntime + (now - appStartTime);

  // 最后事件时间
  appStats.lastEventTime = now;

  // 每 30 秒自动保存，避免频繁写入
  if (!saveStatsDebounce) {
    saveStatsDebounce = setTimeout(() => { saveStats(); saveStatsDebounce = null; }, 30_000);
  }
}

let saveStatsDebounce: ReturnType<typeof setTimeout> | null = null;

interface PendingPermission {
  id: string;
  toolName: string;
  toolDetail?: string;
  sessionId?: string;
  timestamp: number;
  rawPayload: Record<string, unknown>;
  status: "pending" | "approved" | "denied" | "expired";
  decision?: "allow" | "deny";
  reason?: string;
  resolve: (result: PermissionPollResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const pendingPermissions = new Map<string, PendingPermission>();

function ensureDataDir() {
  if (!existsSync(appDataDir)) mkdirSync(appDataDir, { recursive: true });
}

function logRuntime(message: string) {
  ensureDataDir();
  appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}

const autoStartMarkerDir = join(homedir(), ".clawd-companion");
const autoStartMarkerPath = join(autoStartMarkerDir, "auto-start-with-cli.flag");

function syncAutoStartMarker(enabled: boolean) {
  try {
    if (enabled) {
      if (!existsSync(autoStartMarkerDir)) mkdirSync(autoStartMarkerDir, { recursive: true });
      if (!existsSync(autoStartMarkerPath)) writeFileSync(autoStartMarkerPath, "1");
    } else {
      if (existsSync(autoStartMarkerPath)) unlinkSync(autoStartMarkerPath);
    }
  } catch { /* ignore */ }
}

function loadSettings(): CompanionSettings {
  ensureDataDir();
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));
    return defaultSettings;
  }
  const stored = JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<CompanionSettings>;
  return {
    ...defaultSettings,
    ...stored,
    positionOffsets: { ...defaultSettings.positionOffsets, ...(stored.positionOffsets ?? {}) },
    zoneSizes: stored.zoneSizes ?? defaultSettings.zoneSizes
  };
}

function saveSettings(next: Partial<CompanionSettings>) {
  const previousPort = settings.port;
  const previousViewScale = settings.viewScale ?? settings.petScale;
  settings = { ...settings, ...next };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, path: process.execPath });
  syncAutoStartMarker(settings.autoStartWithCli);
  if (petWindow && (settings.viewScale ?? settings.petScale) !== previousViewScale) {
    const size = petWindowSize();
    petWindow.setSize(size.width, size.height);
    const [xNow, yNow] = petWindow.getPosition();
    const clamped = clampPetPosition(xNow, yNow);
    petWindow.setPosition(clamped.x, clamped.y);
  }
  if (petWindow) {
    if (settings.petEnabled) {
      petWindow.setOpacity(1);
      petWindow.show();
    } else {
      petWindow.setOpacity(0);
      petWindow.hide();
    }
  }
  keepPetOnTop();
  broadcastSettings();
  broadcastConnectionStatus();
  if (settings.port !== previousPort) restartEventServer();
  return settings;
}

function rendererUrl(route: "pet" | "settings") {
  if (isDev) return `${process.env.VITE_DEV_SERVER_URL}/#/${route}`;
  const url = pathToFileURL(join(__dirname, "../renderer/index.html"));
  url.hash = `/${route}`;
  return url.toString();
}

function petWindowSize() {
  const display = screen.getPrimaryDisplay().bounds;
  return {
    width: display.width,
    height: display.height
  };
}

function clampPetPosition(x: number, y: number) {
  const display = screen.getPrimaryDisplay().bounds;
  return {
    x: Math.round(Math.min(Math.max(x, display.x - display.width + 260), display.x + display.width - 260)),
    y: Math.round(Math.min(Math.max(y, display.y - display.height + 120), display.y + display.height - 120))
  };
}

function keepPetOnTop() {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!settings.petEnabled) return;
  if (settings.alwaysOnTop) {
    petWindow.setAlwaysOnTop(true, "screen-saver");
    petWindow.moveTop();
  } else {
    petWindow.setAlwaysOnTop(false);
  }
}

function createPetWindow() {
  const size = petWindowSize();
  // 窗口始终覆盖整个主屏幕，(0,0) 为基准，所有定位由 CSS view offset 控制
  trackedPetPos = { x: 0, y: 0 };

  petWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: settings.alwaysOnTop,
    backgroundColor: "#00000000",
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  wireWindowDiagnostics(petWindow, "pet");
  petWindow.setIgnoreMouseEvents(true, { forward: true });
  keepPetOnTop();
  petWindow.on("focus", keepPetOnTop);
  petWindow.on("show", keepPetOnTop);
  petWindow.on("blur", () => setTimeout(keepPetOnTop, 30));
  petWindow.loadURL(rendererUrl("pet"));
  if (!settings.petEnabled) petWindow.hide();
  petWindow.on("moved", () => {
    if (suppressPetMoveSave) {
      suppressPetMoveSave = false;
      return;
    }
    const [xNow, yNow] = petWindow?.getPosition() ?? [0, 0];
    const clamped = clampPetPosition(xNow, yNow);
    if (xNow !== clamped.x || yNow !== clamped.y) {
      suppressPetMoveSave = true;
      petWindow?.setPosition(clamped.x, clamped.y);
    }
    trackedPetPos = { x: clamped.x, y: clamped.y };
    settings = { ...settings, position: clamped };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  });
}

function wireWindowDiagnostics(window: BrowserWindow, name: string) {
  window.webContents.on("did-fail-load", (_, code, description, url) => {
    logRuntime(`${name} failed to load ${url}: ${code} ${description}`);
  });
  window.webContents.on("console-message", (_, level, message) => {
    logRuntime(`${name} console(${level}): ${message}`);
  });
  window.webContents.on("did-finish-load", async () => {
    const rootLength = await window.webContents.executeJavaScript("document.getElementById('root')?.children.length ?? -1").catch(() => -1);
    logRuntime(`${name} loaded with root children: ${rootLength}`);
  });
}

function showExistingWindows() {
  if (settings.petEnabled && petWindow && !petWindow.isDestroyed()) petWindow.show();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  if (app.isReady()) createSettingsWindow();
}

function createSettingsWindow() {
  Menu.setApplicationMenu(null);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 860,
    minHeight: 620,
    title: "Clawd Companion",
    frame: false,
    backgroundColor: "#f5efe3",
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  wireWindowDiagnostics(settingsWindow, "settings");
  settingsWindow.loadURL(rendererUrl("settings"));
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function makeTrayIcon() {
  tray = new Tray(iconPath);
  tray.setToolTip("Clawd Companion");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开配置", click: createSettingsWindow },
    { label: "显示/隐藏桌宠", click: () => petWindow?.isVisible() ? petWindow.hide() : petWindow?.show() },
    { type: "separator" },
    { label: "退出", click: () => app.quit() }
  ]));
}

function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function getConnectionStatus(): CompanionConnectionStatus {
  const connected = Boolean(serverListening && lastEvent && Date.now() - lastEvent.timestamp < 90_000);
  return {
    port: settings.port,
    serverListening,
    tokenSet: settings.token.length > 0,
    privacyMode: settings.privacyMode,
    connected,
    activeSessionId,
    activeClientType,
    activeClientLabel,
    lastEventAt: lastEvent?.timestamp,
    lastEventTitle: lastEvent?.title,
    lastEventType: lastEvent?.event,
    lastEventSource: lastEvent?.source,
    error: serverError
  };
}

function broadcastConnectionStatus() {
  const status = getConnectionStatus();
  petWindow?.webContents.send("companion:connection", status);
  settingsWindow?.webContents.send("companion:connection", status);
  wsServer?.clients.forEach(client => client.send(JSON.stringify({ type: "connection", payload: status })));
  if (tray) {
    tray.setToolTip(status.connected ? "Clawd Companion — 已连接" : "Clawd Companion — 等待连接");
  }
}

function broadcastUpdateStatus() {
  petWindow?.webContents.send("companion:update-status", updateStatus);
  settingsWindow?.webContents.send("companion:update-status", updateStatus);
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // 设置 GitHub provider 配置
  autoUpdater.setFeedURL({
    provider: "github",
    owner: "Doulor",
    repo: "Clawd-Companion",
    releaseType: "release"
  });

  autoUpdater.on("checking-for-update", () => {
    logRuntime("autoUpdater: checking-for-update");
    updateStatus = { ...updateStatus, checking: true, upToDate: false, error: undefined };
    broadcastUpdateStatus();
  });

  autoUpdater.on("update-available", info => {
    logRuntime(`autoUpdater: update-available v${info.version}`);
    updateStatus = { ...updateStatus, checking: false, available: true, version: info.version };
    broadcastUpdateStatus();
  });

  autoUpdater.on("update-not-available", () => {
    logRuntime("autoUpdater: update-not-available");
    updateStatus = { checking: false, available: false, upToDate: true, downloaded: false, downloading: false, version: undefined };
    broadcastUpdateStatus();
  });

  autoUpdater.on("download-progress", progress => {
    updateStatus = { ...updateStatus, downloading: true, progress: progress.percent };
    broadcastUpdateStatus();
  });

  autoUpdater.on("update-downloaded", info => {
    // 尝试从 info 获取路径，fallback 到缓存目录搜索
    downloadedInstallerPath = (info as any).downloadedFile;
    logRuntime(`update-downloaded: info.downloadedFile = ${downloadedInstallerPath}`);
    if (!downloadedInstallerPath) {
      // fs and path are already imported at top
      // 尝试多个可能的缓存目录
      const possibleDirs = [
        join(app.getPath("userData"), "..", "Cache", "Clawd Companion", "pending"),
        join(app.getPath("userData"), "Cache", "pending"),
        join(app.getPath("temp"), "Clawd Companion", "pending"),
        join(app.getPath("appData"), "Cache", "Clawd Companion", "pending")
      ];
      for (const cacheDir of possibleDirs) {
        try {
          logRuntime(`update-downloaded: searching ${cacheDir}`);
          const files = readdirSync(cacheDir)
            .filter((f: string) => f.endsWith(".exe"))
            .map((f: string) => ({ name: f, time: statSync(join(cacheDir, f)).mtimeMs }))
            .sort((a: any, b: any) => b.time - a.time);
          if (files.length > 0) {
            downloadedInstallerPath = join(cacheDir, files[0].name);
            logRuntime(`update-downloaded: found ${downloadedInstallerPath}`);
            break;
          }
        } catch (e) {
          logRuntime(`update-downloaded: search failed for ${cacheDir}: ${e}`);
        }
      }
    }
    if (!downloadedInstallerPath) {
      logRuntime("update-downloaded: FAILED to find installer path");
    }
    updateStatus = { checking: false, available: true, upToDate: false, downloading: false, downloaded: true, version: info.version, progress: 100 };
    broadcastUpdateStatus();
  });

  autoUpdater.on("error", error => {
    updateStatus = { ...updateStatus, checking: false, downloading: false, error: error.message };
    broadcastUpdateStatus();
    logRuntime(`autoUpdater error: ${error.message}`);
  });
}

function isCompanionEvent(value: unknown): value is CompanionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.id === "string" && typeof event.event === "string" && typeof event.title === "string" && typeof event.message === "string";
}

function startEventServer() {
  serverListening = false;
  serverError = undefined;
  broadcastConnectionStatus();
  eventServer = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      writeJson(res, 200, { ok: true, ...getConnectionStatus() });
      return;
    }

    // 权限请求端点
    if (req.url?.startsWith("/permission")) {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
      if (token !== settings.token) {
        writeJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      // POST /permission - 创建权限请求
      if (req.method === "POST" && req.url === "/permission") {
        try {
          const body = await parseJsonBody(req);
          const { randomUUID } = await import("node:crypto");
          const id = randomUUID();

          let resolve!: (result: PermissionPollResult) => void;
          const promise = new Promise<PermissionPollResult>(r => { resolve = r; });

          const pending: PendingPermission = {
            id,
            toolName: String((body as any).toolName ?? "Unknown"),
            toolDetail: (body as any).toolDetail ? String((body as any).toolDetail) : undefined,
            sessionId: (body as any).sessionId ? String((body as any).sessionId) : undefined,
            timestamp: Date.now(),
            rawPayload: (body as any).rawPayload ?? {},
            status: "pending",
            resolve,
            timeout: setTimeout(() => {
              const p = pendingPermissions.get(id);
              if (p && p.status === "pending") {
                p.status = "expired";
                p.resolve({ status: "expired", reason: "Timeout" });
                pendingPermissions.delete(id);
                petWindow?.webContents.send("companion:permission-resolved", { id, status: "expired" });
                settingsWindow?.webContents.send("companion:permission-resolved", { id, status: "expired" });
              }
            }, 120_000)
          };

          pendingPermissions.set(id, pending);

          // 广播给渲染进程
          petWindow?.webContents.send("companion:permission-request", {
            id,
            toolName: pending.toolName,
            toolDetail: pending.toolDetail,
            sessionId: pending.sessionId,
            timestamp: pending.timestamp,
            rawPayload: pending.rawPayload
          });
          settingsWindow?.webContents.send("companion:permission-request", {
            id,
            toolName: pending.toolName,
            toolDetail: pending.toolDetail,
            sessionId: pending.sessionId,
            timestamp: pending.timestamp,
            rawPayload: pending.rawPayload
          });

          writeJson(res, 200, { id, status: "pending" });
        } catch {
          writeJson(res, 400, { ok: false, error: "bad_json" });
        }
        return;
      }

      // GET /permission/:id - 长轮询等待决策
      if (req.method === "GET" && req.url.startsWith("/permission/")) {
        const id = req.url.slice("/permission/".length);
        const pending = pendingPermissions.get(id);

        if (!pending) {
          writeJson(res, 404, { ok: false, error: "not_found" });
          return;
        }

        if (pending.status !== "pending") {
          writeJson(res, 200, { status: pending.status, decision: pending.decision, reason: pending.reason });
          return;
        }

        // 长轮询：等待 resolve
        try {
          const result = await Promise.race([
            new Promise<PermissionPollResult>(r => {
              const origResolve = pending.resolve;
              pending.resolve = (result) => { origResolve(result); r(result); };
            }),
            new Promise<PermissionPollResult>(r => setTimeout(() => r({ status: "expired", reason: "Poll timeout" }), 120_000))
          ]);
          writeJson(res, 200, result);
        } catch {
          writeJson(res, 500, { ok: false, error: "internal_error" });
        }
        return;
      }

      writeJson(res, 404, { ok: false, error: "not_found" });
      return;
    }

    if (req.method !== "POST" || req.url !== "/events") {
      writeJson(res, 404, { ok: false, error: "not_found" });
      return;
    }

    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (token !== settings.token) {
      writeJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    try {
      const body = await parseJsonBody(req);
      if (!isCompanionEvent(body)) {
        writeJson(res, 400, { ok: false, error: "invalid_event" });
        return;
      }
      emitEvent(body);
      writeJson(res, 200, { ok: true });
    } catch {
      writeJson(res, 400, { ok: false, error: "bad_json" });
    }
  });

  wsServer = new WebSocketServer({ noServer: true });
  eventServer.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/stream")) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const tokenParam = url.searchParams.get("token") || "";
    if (tokenParam !== settings.token) { socket.destroy(); return; }
    wsServer?.handleUpgrade(req, socket, head, ws => {
      ws.send(JSON.stringify({ type: "settings", payload: settings }));
      ws.send(JSON.stringify({ type: "connection", payload: getConnectionStatus() }));
    });
  });
  eventServer.on("error", error => {
    const nodeError = error as NodeJS.ErrnoException;
    serverListening = false;
    serverError = nodeError.code === "EADDRINUSE" ? `端口 ${settings.port} 已被占用` : nodeError.message;
    if (nodeError.code === "EADDRINUSE") {
      logRuntime(`event server port ${settings.port} is already in use; keeping UI alive without event listener`);
      broadcastConnectionStatus();
      return;
    }
    logRuntime(`event server error: ${nodeError.message}`);
    broadcastConnectionStatus();
  });

  eventServer.listen(settings.port, "127.0.0.1", () => {
    serverListening = true;
    serverError = undefined;
    logRuntime(`event server listening on 127.0.0.1:${settings.port}`);
    broadcastConnectionStatus();
  });
}

function restartEventServer() {
  wsServer?.close();
  eventServer?.close(() => startEventServer());
}

function runPluginsForEvent(event: CompanionEvent) {
  const plugins = settings.customPlugins ?? [];
  for (const plugin of plugins) {
    if (!plugin.enabled || !plugin.scriptPath || !plugin.events.includes(event.event)) continue;
    if (!existsSync(plugin.scriptPath)) {
      logRuntime(`Plugin skipped, script not found: ${plugin.name} (${plugin.scriptPath})`);
      continue;
    }
    const child = spawn(process.execPath, [plugin.scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const timeout = setTimeout(() => {
      child.kill();
      logRuntime(`Plugin timed out: ${plugin.name}`);
    }, 3000);

    child.stdout.on("data", data => logRuntime(`[plugin:${plugin.name}:stdout] ${String(data).trim()}`));
    child.stderr.on("data", data => logRuntime(`[plugin:${plugin.name}:stderr] ${String(data).trim()}`));
    child.on("error", err => logRuntime(`Plugin failed: ${plugin.name}: ${err.message}`));
    child.on("close", code => {
      clearTimeout(timeout);
      logRuntime(`Plugin exited: ${plugin.name} code=${code}`);
    });
    child.stdin.end(JSON.stringify(event));
  }
}

function emitEvent(event: CompanionEvent) {
  trackEvent(event);
  // Event History
  eventHistory.push({ id: event.id, event, timestamp: Date.now() });
  const historyLimit = settings.eventHistoryLimit ?? 40;
  if (eventHistory.length > historyLimit) {
    eventHistory = eventHistory.slice(eventHistory.length - historyLimit);
  }
  lastEvent = event;
  activeSessionId = event.sessionId ?? activeSessionId;
  activeClientType = event.clientType ?? activeClientType;
  activeClientLabel = event.clientLabel ?? activeClientLabel;
  if (event.cwd && event.cwd !== lastKnownCwd) {
    lastKnownCwd = event.cwd;
    startGitWatcher(event.cwd);
  }
  if (settings.petEnabled && petWindow && !petWindow.isDestroyed()) {
    if (!petWindow.isVisible()) { petWindow.setOpacity(1); petWindow.show(); }
  }
  petWindow?.webContents.send("companion:event", event);
  settingsWindow?.webContents.send("companion:event", event);
  wsServer?.clients.forEach(client => client.send(JSON.stringify({ type: "event", payload: event })));
  broadcastConnectionStatus();
  runPluginsForEvent(event);

  const rule = settings.notificationRules?.find(r => r.eventType === event.event && r.enabled);
  const shouldNotify = rule ? rule.systemNotification : settings.doneSound && event.event === "done";
  const shouldPlaySound = rule ? rule.playSound : true;

  if (shouldNotify && Notification.isSupported()) {
    new Notification({ title: event.title, body: event.message }).show();
  }

  if (shouldPlaySound) {
    const soundDataUrl = getSoundDataUrl(event.event, settings.sound);
    if (soundDataUrl) {
      petWindow?.webContents.send("companion:play-sound", soundDataUrl);
      settingsWindow?.webContents.send("companion:play-sound", soundDataUrl);
    }
  }
}

function broadcastSettings() {
  petWindow?.webContents.send("companion:settings", settings);
  settingsWindow?.webContents.send("companion:settings", settings);
  wsServer?.clients.forEach(client => client.send(JSON.stringify({ type: "settings", payload: settings })));
}

// Hooks 管理
const claudeSettingsPath = join(homedir(), ".claude", "settings.json");
const backupPath = join(homedir(), ".claude", "settings.clawd-backup.json");
const REQUIRED_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"] as const;

interface HooksStatus {
  installed: boolean;
  configExists: boolean;
  hookCount: number;
  requiredCount: number;
  missingEvents: string[];
  commandMatches: boolean;
}

function normalizeCommandPath(pathLike: string): string {
  return pathLike.replaceAll(String.fromCharCode(92), "/");
}

function getHookCommand(): string {
  const devPath = normalizeCommandPath(join(__dirname, "../../dist/hook-forwarder/index.js"));
  if (!app.isPackaged && existsSync(devPath)) {
    return `node "${devPath}"`;
  }
  const prodPath = normalizeCommandPath(join(process.resourcesPath, "hook-forwarder/index.js"));
  return `node "${prodPath}"`;
}

function checkHooks(): HooksStatus {
  if (!existsSync(claudeSettingsPath)) {
    return { installed: false, configExists: false, hookCount: 0, requiredCount: 6, missingEvents: [...REQUIRED_HOOK_EVENTS], commandMatches: false };
  }

  let settingsJson: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(claudeSettingsPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { installed: false, configExists: true, hookCount: 0, requiredCount: 6, missingEvents: [...REQUIRED_HOOK_EVENTS], commandMatches: false };
    }
    settingsJson = parsed as Record<string, unknown>;
  } catch {
    return { installed: false, configExists: true, hookCount: 0, requiredCount: 6, missingEvents: [...REQUIRED_HOOK_EVENTS], commandMatches: false };
  }
  const hooks = (settingsJson.hooks ?? {}) as Record<string, unknown[]>;
  const expectedCommand = getHookCommand();
  const missing: string[] = [];
  let commandOk = true;
  let count = 0;

  for (const eventName of REQUIRED_HOOK_EVENTS) {
    const entries = hooks[eventName];
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      missing.push(eventName);
    } else {
      count++;
      const hookCmd = (entries[0] as any)?.hooks?.[0]?.command;
      if (hookCmd !== expectedCommand) commandOk = false;
    }
  }

  return {
    installed: missing.length === 0 && commandOk,
    configExists: true,
    hookCount: count,
    requiredCount: 6,
    missingEvents: missing,
    commandMatches: commandOk
  };
}

function installHooks(): { success: boolean; error?: string } {
  try {
    let settingsJson: Record<string, unknown> = {};
    if (existsSync(claudeSettingsPath)) {
      const parsed = JSON.parse(readFileSync(claudeSettingsPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { success: false, error: "settings.json 格式错误：期望对象" };
      }
      settingsJson = parsed as Record<string, unknown>;
      copyFileSync(claudeSettingsPath, backupPath);
    }

    const command = getHookCommand();
    const hookEntry = { matcher: "*", hooks: [{ type: "command", command }] };

    const hooks = (settingsJson.hooks ?? {}) as Record<string, unknown[]>;
    settingsJson.hooks = hooks;
    for (const eventName of REQUIRED_HOOK_EVENTS) {
      hooks[eventName] = [hookEntry];
    }

    const dir = join(homedir(), ".claude");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(claudeSettingsPath, JSON.stringify(settingsJson, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function repairHooks(): { success: boolean; fixed: string[]; error?: string } {
  try {
    if (!existsSync(claudeSettingsPath)) {
      const result = installHooks();
      return { ...result, fixed: result.success ? [...REQUIRED_HOOK_EVENTS] : [] };
    }

    const parsed = JSON.parse(readFileSync(claudeSettingsPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { success: false, fixed: [], error: "settings.json 格式错误：期望对象" };
    }
    const settingsJson = parsed as Record<string, unknown>;
    copyFileSync(claudeSettingsPath, backupPath);

    const command = getHookCommand();
    const hookEntry = { matcher: "*", hooks: [{ type: "command", command }] };
    const fixed: string[] = [];

    const hooks = (settingsJson.hooks ?? {}) as Record<string, unknown[]>;
    settingsJson.hooks = hooks;
    for (const eventName of REQUIRED_HOOK_EVENTS) {
      const entries = hooks[eventName];
      const needsFix = !entries || !Array.isArray(entries) || entries.length === 0 ||
        (entries[0] as any)?.hooks?.[0]?.command !== command;

      if (needsFix) {
        hooks[eventName] = [hookEntry];
        fixed.push(eventName);
      }
    }

    writeFileSync(claudeSettingsPath, JSON.stringify(settingsJson, null, 2));
    return { success: true, fixed };
  } catch (error) {
    return { success: false, fixed: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function removeHooks(): { success: boolean; error?: string } {
  try {
    if (!existsSync(claudeSettingsPath)) return { success: true };

    const parsed = JSON.parse(readFileSync(claudeSettingsPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { success: false, error: "settings.json 格式错误：期望对象" };
    }
    const settingsJson = parsed as Record<string, unknown>;
    copyFileSync(claudeSettingsPath, backupPath);

    if (settingsJson.hooks && typeof settingsJson.hooks === "object") {
      const hooks = settingsJson.hooks as Record<string, unknown>;
      for (const eventName of REQUIRED_HOOK_EVENTS) {
        delete hooks[eventName];
      }
      if (Object.keys(hooks).length === 0) {
        delete settingsJson.hooks;
      }
    }

    writeFileSync(claudeSettingsPath, JSON.stringify(settingsJson, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

ipcMain.handle("settings:get", () => settings);
ipcMain.handle("settings:save", (_, next: Partial<CompanionSettings>) => saveSettings(next));
ipcMain.handle("connection:get", () => getConnectionStatus());
ipcMain.handle("event:test", (_, event: CompanionEvent) => emitEvent(event));
ipcMain.handle("hooks:check", () => checkHooks());
ipcMain.handle("hooks:install", () => installHooks());
ipcMain.handle("hooks:repair", () => repairHooks());
ipcMain.handle("hooks:remove", () => removeHooks());
ipcMain.handle("permission:respond", async (_, response: PermissionResponse) => {
  const pending = pendingPermissions.get(response.id);
  if (!pending || pending.status !== "pending") return { success: false };
  clearTimeout(pending.timeout);
  pending.status = response.decision === "allow" ? "approved" : "denied";
  if (response.decision === "allow") appStats.permissionApproved++;
  else appStats.permissionDenied++;
  pending.decision = response.decision;
  pending.reason = response.reason ?? (response.decision === "allow" ? "Approved via Clawd" : "Denied via Clawd");
  pending.resolve({
    status: pending.status,
    decision: pending.decision,
    reason: pending.reason
  });
  pendingPermissions.delete(response.id);
  petWindow?.webContents.send("companion:permission-resolved", { id: response.id, status: pending.status });
  settingsWindow?.webContents.send("companion:permission-resolved", { id: response.id, status: pending.status });
  const { randomUUID } = await import("node:crypto");
  emitEvent({
    id: randomUUID(),
    source: "claude-code",
    event: "notification",
    title: response.decision === "allow" ? "权限已授予" : "权限已拒绝",
    message: `${pending.toolName}: ${response.decision === "allow" ? "已允许" : "已拒绝"}`,
    detail: pending.toolDetail,
    timestamp: Date.now()
  });
  return { success: true };
});
ipcMain.handle("window:open-settings", () => createSettingsWindow());
ipcMain.handle("window:minimize-settings", () => settingsWindow?.minimize());
ipcMain.handle("window:toggle-maximize-settings", () => {
  if (!settingsWindow) return;
  if (settingsWindow.isMaximized()) settingsWindow.unmaximize();
  else settingsWindow.maximize();
});
ipcMain.handle("window:close-settings", () => settingsWindow?.close());
ipcMain.handle("window:pet-interactive", (_, interactive: boolean) => {
  petWindow?.setIgnoreMouseEvents(!interactive, { forward: true });
});
ipcMain.handle("window:drag-pet", (_, position: { x: number; y: number }) => {
  const clamped = clampPetPosition(position.x, position.y);
  petWindow?.setPosition(clamped.x, clamped.y);
  trackedPetPos = { x: clamped.x, y: clamped.y };
});
ipcMain.handle("window:move-pet-by", (_, delta: { dx: number; dy: number }) => {
  if (!petWindow) return;
  suppressPetMoveSave = true;
  const clamped = clampPetPosition(trackedPetPos.x + delta.dx, trackedPetPos.y + delta.dy);
  petWindow.setPosition(clamped.x, clamped.y);
  trackedPetPos = { x: clamped.x, y: clamped.y };
  settings = { ...settings, position: clamped };
  if (saveDebounce) clearTimeout(saveDebounce);
  saveDebounce = setTimeout(() => {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    saveDebounce = null;
  }, 400);
});

ipcMain.handle("update:check", async () => {
  if (!app.isPackaged) {
    return { ok: false, error: "开发模式下无法检查更新，请打包安装后使用自动更新功能。" };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) {
      return { ok: false, error: "未找到更新信息，请确认 GitHub Release 已发布。" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle("update:install", () => {
  if (!updateStatus.downloaded) {
    return { ok: false, error: "没有已下载的更新。" };
  }
  // 使用 electron-updater 标准方式重启安装
  try {
    autoUpdater.quitAndInstall();
    return { ok: true };
  } catch (e) {
    logRuntime("update:install: quitAndInstall failed: " + e);
    return { ok: false, error: "安装启动失败，请尝试手动下载。" };
  }
});
ipcMain.handle("update:get-status", () => updateStatus);
ipcMain.handle("app:get-version", () => app.getVersion());
ipcMain.handle("stats:get", () => appStats);
ipcMain.handle("token-stats:get", async (_, force?: boolean) => {
  return scanTokenStats(force === true);
});
ipcMain.handle("sound:preview", (_, name: "done" | "error" | "permission" | "session-start") => {
  return previewSoundDataUrl(name);
});
ipcMain.handle("sound:pick-file", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "音频", extensions: ["wav", "mp3", "ogg", "flac"] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
ipcMain.handle("stats:reset", () => {
  appStats = { ...defaultStats, firstStartTime: Date.now() };
  saveStats();
});
ipcMain.handle("idle-bubble:sync", (_, sprite: string | null) => {
  settingsWindow?.webContents.send("companion:idle-bubble-sync", sprite);
});
ipcMain.handle("open-external", (_, url: string) => {
  shell.openExternal(url);
});
ipcMain.handle("settings:export-file", async () => {
  const result = await dialog.showSaveDialog({
    defaultPath: "clawd-settings.json",
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (!result.canceled && result.filePath) {
    writeFileSync(result.filePath, JSON.stringify(settings, null, 2));
    return { ok: true };
  }
  return { ok: false };
});
ipcMain.handle("settings:import-file", async () => {
  const result = await dialog.showOpenDialog({
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    try {
      const json = readFileSync(result.filePaths[0], "utf8");
      const parsed = JSON.parse(json);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: "配置文件格式错误：期望 JSON 对象" };
      }
      const imported = parsed as Partial<CompanionSettings>;
      saveSettings(imported);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false };
});
ipcMain.handle("stats:export-file", async () => {
  const result = await dialog.showSaveDialog({
    defaultPath: "clawd-stats.json",
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (!result.canceled && result.filePath) {
    writeFileSync(result.filePath, JSON.stringify(appStats, null, 2));
    return { ok: true };
  }
  return { ok: false };
});
ipcMain.handle("stats:import-file", async () => {
  const result = await dialog.showOpenDialog({
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    try {
      const json = readFileSync(result.filePaths[0], "utf8");
      const imported = JSON.parse(json) as Partial<AppStats>;
      appStats = { ...defaultStats, ...imported, hourlyActivity: imported.hourlyActivity ?? new Array(24).fill(0) };
      saveStats();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false };
});

// Event History
ipcMain.handle("events:get-history", () => eventHistory);
ipcMain.handle("events:clear-history", () => { eventHistory = []; });
ipcMain.handle("events:export-file", async () => {
  const result = await dialog.showSaveDialog({
    defaultPath: `clawd-events-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (!result.canceled && result.filePath) {
    writeFileSync(result.filePath, JSON.stringify({ exportedAt: Date.now(), events: eventHistory }, null, 2));
    return { ok: true };
  }
  return { ok: false };
});

// Display / Monitor
ipcMain.handle("display:get-monitors", () => {
  const displays = screen.getAllDisplays();
  return displays.map(d => ({
    id: String(d.id),
    bounds: d.bounds,
    name: `Monitor ${d.id} (${d.bounds.width}x${d.bounds.height})`,
    isPrimary: d === screen.getPrimaryDisplay()
  }));
});

// Plugins
ipcMain.handle("plugins:get", () => settings.customPlugins ?? []);
ipcMain.handle("plugins:save", (_, plugins: CustomPlugin[]) => {
  saveSettings({ customPlugins: plugins });
  return settings.customPlugins;
});

// Animation recording: renderer records WebM, main process saves it to disk.
ipcMain.handle("gif:record", () => ({ ok: true, message: "Recording started in renderer" }));
ipcMain.handle("gif:save", async (_, dataUrl: string) => {
  const result = await dialog.showSaveDialog({
    defaultPath: "clawd-animation.webm",
    filters: [{ name: "WebM Video", extensions: ["webm"] }]
  });
  if (!result.canceled && result.filePath) {
    const base64Data = dataUrl.replace(/^data:video\/webm[^,]*,/, "");
    writeFileSync(result.filePath, Buffer.from(base64Data, "base64"));
    return { ok: true };
  }
  return { ok: false };
});
ipcMain.handle("test:idle-bubble", () => {
  petWindow?.webContents.send("companion:test-idle-bubble");
  settingsWindow?.webContents.send("companion:test-idle-bubble");
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showExistingWindows();
  });

  app.whenReady().then(() => {
    settings = loadSettings();
    appStats = loadStats();
    appStartTime = Date.now();
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, path: process.execPath });
    syncAutoStartMarker(settings.autoStartWithCli);
    setGitEventHandler(emitEvent);
    createPetWindow();
    if (settings.openSettingsOnStart) createSettingsWindow();
    makeTrayIcon();
    startEventServer();
    try {
      globalShortcut.register("CommandOrControl+Alt+C", () => { createSettingsWindow(); });
    } catch (e) {
      logRuntime("Failed to register global shortcut: " + e);
    }
    setupAutoUpdater();
    // 延迟 5 秒后检查更新，确保应用完全初始化
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(e => logRuntime("AutoUpdate check failed: " + e));
    }, 5000);
  });

  app.on("window-all-closed", () => {
    // 桌宠应用关闭配置面板后继续留在托盘，不让 Electron 默认退出。
  });

  app.on("before-quit", () => {
    globalShortcut.unregisterAll();
    appStats.totalRuntime = sessionStartRuntime + (Date.now() - appStartTime);
    if (saveStatsDebounce) { clearTimeout(saveStatsDebounce); saveStatsDebounce = null; }
    saveStats();
    wsServer?.close();
    eventServer?.close();
    stopGitWatcher();
    pendingPermissions.forEach(p => {
      clearTimeout(p.timeout);
      p.resolve({ status: "expired", reason: "App quitting" });
    });
    pendingPermissions.clear();
  });
}

