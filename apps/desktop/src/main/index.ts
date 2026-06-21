import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, screen, shell, dialog, globalShortcut, net } from "electron";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { appendFileSync, copyFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { CompanionConnectionStatus, CompanionEvent, CompanionSettings, PermissionResponse, UpdateStatus, AppStats, CustomPlugin, PluginMarketIndex, PluginRunRecord } from "../shared/events.js";
import { defaultSettings, defaultStats } from "../shared/events.js";
import { scanTokenStats, setCachePath as setTokenCachePath } from "./token-stats.js";
import { setGitEventHandler, startGitWatcher, stopGitWatcher } from "./git-watcher.js";
import { builtInPath, fileToDataUrl, getSoundDataUrl, previewSoundDataUrl } from "./sound.js";
import { loadSettings as loadManagedSettings, saveSettings as saveManagedSettings } from "./settingsManager.js";
import { appendEventHistory, loadEventHistory, saveEventHistory, type EventHistoryStore } from "./event-history.js";
import { appendPluginRun, canRunPlugin, normalizePlugin, resolvePluginAssets, runPlugin } from "./plugin-runner.js";
import { installMarketPlugin, parseMarketIndex, rawUrl, safeMarketPath } from "./plugin-market.js";
import { checkHooks as checkManagedHooks, installHooks as installManagedHooks, normalizeCommandPath, removeHooks as removeManagedHooks, repairHooks as repairManagedHooks } from "./hooks-manager.js";
import { getProvider, type Provider } from "../shared/providers.js";
import { createAutoUpdaterController } from "./auto-updater.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { PermissionBroker } from "./permission-broker.js";
import { bearerToken, isCompanionEvent, isPermissionRoute, isRoute, jsonBodyErrorStatus, parseJsonBody, parsePermissionRequestBody, streamToken, writeJson } from "./event-server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const devIconPath = join(__dirname, "../../build/icon.ico");
const prodIconPath = join(process.resourcesPath, "build/icon.ico");
const iconPath = existsSync(devIconPath) ? devIconPath : prodIconPath;
const appDataDir = join(app.getPath("userData"), "clawd-companion");
process.env.CLAWD_APP_VERSION = app.getVersion();
const settingsPath = join(appDataDir, "settings.json");
const statsPath = join(appDataDir, "stats.json");
const logPath = join(appDataDir, "runtime.log");
const historyPath = join(appDataDir, "event-history.json");
const tokenCachePath = join(appDataDir, "token-stats-cache.json");
const localPluginDir = join(appDataDir, "plugins");
const pluginDataDir = join(appDataDir, "plugin-data");
const marketBaseUrl = "https://raw.githubusercontent.com/Doulor/Clawd-Companion/main/plugin-market";
setTokenCachePath(tokenCachePath);
let lastKnownCwd: string | null = null;

let petWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: CompanionSettings = defaultSettings;
let eventServer: ReturnType<typeof createServer> | null = null;
let petWidgetHitTestTimer: NodeJS.Timeout | null = null;
let petWidgetHitTestInteractive = false;
let petWindowAlwaysOnTop = false;
let permissionCardRect: { x: number; y: number; width: number; height: number } | null = null;
let wsServer: WebSocketServer | null = null;
let serverListening = false;
let serverError: string | undefined;
let lastEvent: CompanionEvent | null = null;
let eventHistoryStore: EventHistoryStore = { events: [], sessions: [] };
let pluginRuns: PluginRunRecord[] = [];
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
  writeJsonAtomic(statsPath, appStats, 2);
}

function backupIfExists(path: string, suffix: string) {
  if (existsSync(path)) copyFileSync(path, `${path}.${suffix}.bak`);
}

function isSettingsImport(value: unknown): value is Partial<CompanionSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.port !== undefined) {
    if (typeof candidate.port !== "number" || !Number.isInteger(candidate.port) || candidate.port < 1024 || candidate.port > 65535) return false;
  }
  if (candidate.token !== undefined && (typeof candidate.token !== "string" || candidate.token.length < 8)) return false;
  if (candidate.privacyMode !== undefined && !["safe", "standard", "detailed"].includes(String(candidate.privacyMode))) return false;
  if (candidate.theme !== undefined && !["light", "dark", "system"].includes(String(candidate.theme))) return false;
  if (candidate.language !== undefined && !["auto", "zh", "en"].includes(String(candidate.language))) return false;
  return true;
}

function normalizeImportedStats(value: unknown): AppStats | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const imported = value as Partial<AppStats>;
  return {
    ...defaultStats,
    ...imported,
    toolUsage: isRecord(imported.toolUsage) ? imported.toolUsage as Record<string, number> : {},
    eventTypeCounts: isRecord(imported.eventTypeCounts) ? imported.eventTypeCounts as Record<string, number> : {},
    dailyStats: isRecord(imported.dailyStats) ? imported.dailyStats as AppStats["dailyStats"] : {},
    hourlyActivity: Array.isArray(imported.hourlyActivity) && imported.hourlyActivity.length === 24 ? imported.hourlyActivity.map(value => Number(value) || 0) : new Array(24).fill(0)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

const permissionBroker = new PermissionBroker();

function ensureDataDir() {
  if (!existsSync(appDataDir)) mkdirSync(appDataDir, { recursive: true });
}

function logRuntime(message: string) {
  ensureDataDir();
  appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}

const companionHomeDir = join(homedir(), ".clawd-companion");
const autoStartMarkerDir = companionHomeDir;
const autoStartMarkerPath = join(autoStartMarkerDir, "auto-start-with-cli.flag");
const connectionConfigPath = join(companionHomeDir, "connection.json");

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

function syncConnectionConfig() {
  try {
    if (!existsSync(companionHomeDir)) mkdirSync(companionHomeDir, { recursive: true });
    writeJsonAtomic(connectionConfigPath, { port: settings.port, token: settings.token });
  } catch { /* ignore */ }
}

function loadSettings(): CompanionSettings {
  return loadManagedSettings(appDataDir);
}

function saveSettings(next: Partial<CompanionSettings>) {
  const previousPort = settings.port;
  const previousViewScale = settings.viewScale ?? settings.petScale;
  settings = { ...settings, ...next };
  saveManagedSettings(appDataDir, settings);
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, path: process.execPath });
  syncAutoStartMarker(settings.autoStartWithCli);
  syncConnectionConfig();
  if (next.hooksGuardEnabled !== undefined) startHooksGuard();
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
  const shouldStayOnTop = settings.alwaysOnTop || permissionBroker.size > 0;
  if (petWindowAlwaysOnTop === shouldStayOnTop) return;
  petWindowAlwaysOnTop = shouldStayOnTop;
  petWindow.setAlwaysOnTop(shouldStayOnTop, "screen-saver");
  if (shouldStayOnTop) petWindow.moveTop();
}

function startPetWidgetHitTesting() {
  if (petWidgetHitTestTimer) clearInterval(petWidgetHitTestTimer);
  petWidgetHitTestTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || !settings.petEnabled) return;
    const shouldInteract = isMouseOverPluginWidget();
    if (shouldInteract && !petWidgetHitTestInteractive) {
      petWidgetHitTestInteractive = true;
      petWindow.setIgnoreMouseEvents(false, { forward: true });
    } else if (!shouldInteract && petWidgetHitTestInteractive) {
      petWidgetHitTestInteractive = false;
      petWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  }, 80);
}

function isMouseOverPluginWidget(): boolean {
  if (!petWindow || petWindow.isDestroyed()) return false;
  if (settings.editPosition) return false;
  const point = screen.getCursorScreenPoint();
  const display = screen.getPrimaryDisplay().bounds;
  const view = settings.positionOffsets?.view ?? { x: 0, y: 0 };
  const scale = settings.petScale ?? 1;
  const anchorLeft = display.x + display.width / 2 - (226 * scale) / 2 + view.x * scale;
  const anchorBottom = display.y + display.height + view.y * scale;
  for (const plugin of settings.customPlugins ?? []) {
    if (!plugin.enabled) continue;
    for (const widget of plugin.manifest?.widgets ?? []) {
      if (widget.type !== "pomodoro") continue;
      const key = widget.positionKey ?? widget.type;
      const offset = plugin.widgetOffsets?.[key] ?? settings.positionOffsets?.pomodoro ?? { x: 735, y: -5 };
      const width = (widget.width ?? 172) * scale;
      const height = (widget.height ?? 78) * scale;
      const left = anchorLeft + offset.x * scale;
      const top = anchorBottom - height + offset.y * scale;
      if (point.x >= left - 12 && point.x <= left + width + 12 && point.y >= top - 18 && point.y <= top + height + 12) return true;
    }
  }
  if (permissionCardRect) {
    const r = permissionCardRect;
    const pad = 8;
    if (point.x >= r.x - pad && point.x <= r.x + r.width + pad && point.y >= r.y - pad && point.y <= r.y + r.height + pad) return true;
  }
  return false;
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
  startPetWidgetHitTesting();
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
    saveManagedSettings(appDataDir, settings);
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
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const status = getConnectionStatus();
  tray.setToolTip(status.connected ? "Clawd Companion — 已连接" : "Clawd Companion — 等待连接");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status.connected ? `已连接：${status.activeClientLabel ?? "Claude Code"}` : status.serverListening ? `等待连接：127.0.0.1:${status.port}` : "本地服务未监听", enabled: false },
    { label: `最近事件：${status.lastEventTitle ?? "暂无"}`, enabled: false },
    { type: "separator" },
    { label: "打开配置", click: createSettingsWindow },
    { label: "打开诊断中心", click: () => { createSettingsWindow(); settingsWindow?.webContents.send("companion:open-section", "doctor"); } },
    { label: petWindow?.isVisible() ? "隐藏桌宠" : "显示桌宠", click: () => { petWindow?.isVisible() ? petWindow.hide() : petWindow?.show(); refreshTrayMenu(); } },
    { label: settings.alwaysOnTop ? "关闭置顶" : "开启置顶", click: () => saveSettings({ alwaysOnTop: !settings.alwaysOnTop }) },
    { label: settings.clickThrough ? "关闭点击穿透" : "开启点击穿透", click: () => saveSettings({ clickThrough: !settings.clickThrough }) },
    { type: "separator" },
    { label: `隐私模式：${settings.privacyMode}`, submenu: [
      { label: "safe", type: "radio", checked: settings.privacyMode === "safe", click: () => saveSettings({ privacyMode: "safe" }) },
      { label: "standard", type: "radio", checked: settings.privacyMode === "standard", click: () => saveSettings({ privacyMode: "standard" }) },
      { label: "detailed", type: "radio", checked: settings.privacyMode === "detailed", click: () => saveSettings({ privacyMode: "detailed" }) }
    ] },
    { type: "separator" },
    { label: "退出", click: () => app.quit() }
  ]));
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
  refreshTrayMenu();
}

function broadcastUpdateStatus() {
  petWindow?.webContents.send("companion:update-status", updateStatus);
  settingsWindow?.webContents.send("companion:update-status", updateStatus);
}

const autoUpdateController = createAutoUpdaterController({
  app,
  getStatus: () => updateStatus,
  setStatus: status => { updateStatus = status; },
  broadcastStatus: broadcastUpdateStatus,
  log: logRuntime
});

function startEventServer() {
  serverListening = false;
  serverError = undefined;
  broadcastConnectionStatus();
  eventServer = createServer(async (req, res) => {
    if (isRoute(req, "GET", "/health")) {
      writeJson(res, 200, { ok: true, ...getConnectionStatus() });
      return;
    }

    // 权限请求端点
    if (isPermissionRoute(req.url)) {
      const token = bearerToken(req);
      if (token !== settings.token) {
        writeJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      // POST /permission - 创建权限请求
      if (isRoute(req, "POST", "/permission")) {
        try {
          // 权限弹窗关闭时自动允许，不弹卡片
          if (!settings.permissionDialogEnabled) {
            await parseJsonBody(req); // consume body
            writeJson(res, 200, { id: "auto", status: "approved" });
            return;
          }

          const body = parsePermissionRequestBody(await parseJsonBody(req));
          if (!body) {
            writeJson(res, 400, { ok: false, error: "invalid_permission_request" });
            return;
          }

          const { id } = permissionBroker.create({
            toolName: body.toolName,
            toolDetail: body.toolDetail,
            sessionId: body.sessionId,
            rawPayload: body.rawPayload
          });
          const created = permissionBroker.get(id);
          const timestamp = created?.timestamp ?? Date.now();

          // 广播给渲染进程
          petWindow?.webContents.send("companion:permission-request", {
            id,
            toolName: body.toolName,
            toolDetail: body.toolDetail,
            sessionId: body.sessionId,
            timestamp,
            rawPayload: body.rawPayload
          });
          keepPetOnTop();
          settingsWindow?.webContents.send("companion:permission-request", {
            id,
            toolName: body.toolName,
            toolDetail: body.toolDetail,
            sessionId: body.sessionId,
            timestamp,
            rawPayload: body.rawPayload
          });

          const permRule = settings.notificationRules?.find(r => r.eventType === "permission_wait" && r.enabled);
          if (permRule?.playSound && settings.notificationsEnabled) {
            const soundDataUrl = getSoundDataUrl("permission_wait", settings.sound);
            if (soundDataUrl) playSoundDataUrl(soundDataUrl);
          }

          writeJson(res, 200, { id, status: "pending" });
        } catch (error) {
          const bodyError = jsonBodyErrorStatus(error);
          writeJson(res, bodyError.status, { ok: false, error: bodyError.error });
        }
        return;
      }

      // GET /permission/:id - 长轮询等待决策
      const requestUrl = req.url ?? "";
      if (req.method === "GET" && requestUrl.startsWith("/permission/")) {
        const id = requestUrl.slice("/permission/".length);
        const found = permissionBroker.get(id);
        if (!found) {
          writeJson(res, 404, { ok: false, error: "not_found" });
          return;
        }
        try {
          const result = await permissionBroker.wait(id);
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

    const token = bearerToken(req);
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
    } catch (error) {
      const bodyError = jsonBodyErrorStatus(error);
      writeJson(res, bodyError.status, { ok: false, error: bodyError.error });
    }
  });

  wsServer = new WebSocketServer({ noServer: true });
  eventServer.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/stream")) {
      socket.destroy();
      return;
    }
    if (streamToken(req.url) !== settings.token) { socket.destroy(); return; }
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
  const plugins = (settings.customPlugins ?? []).map(normalizePlugin);
  for (const plugin of plugins) {
    const runnable = canRunPlugin(plugin, event);
    if (!runnable.ok) {
      if (plugin.enabled && plugin.events.includes(event.event)) logRuntime(`Plugin skipped: ${plugin.name}: ${runnable.reason}`);
      continue;
    }
    runPlugin(plugin, event, record => {
      pluginRuns = appendPluginRun(pluginRuns, record);
      logRuntime(`Plugin exited: ${record.pluginName} code=${record.exitCode} duration=${record.durationMs}ms${record.timedOut ? " timed-out" : ""}`);
      settingsWindow?.webContents.send("companion:plugin-run", record);
    }, pluginDataDir);
  }
}

function playSoundDataUrl(soundDataUrl: string) {
  petWindow?.webContents.send("companion:play-sound", soundDataUrl);
  settingsWindow?.webContents.send("companion:play-sound", soundDataUrl);
}

function emitEvent(event: CompanionEvent) {
  trackEvent(event);
  eventHistoryStore = appendEventHistory(eventHistoryStore, event, settings.eventHistoryLimit ?? 40);
  saveEventHistory(historyPath, eventHistoryStore);
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
  const notificationsEnabled = settings.notificationsEnabled || settings.doneSound;
  const shouldNotify = notificationsEnabled && (rule ? rule.systemNotification : settings.doneSound && event.event === "done");
  const shouldPlaySound = notificationsEnabled && (rule ? rule.playSound : false);

  if (shouldNotify && Notification.isSupported()) {
    new Notification({ title: event.title, body: event.message }).show();
  }

  if (shouldPlaySound) {
    const soundDataUrl = getSoundDataUrl(event.event, settings.sound);
    if (soundDataUrl) playSoundDataUrl(soundDataUrl);
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

function getForwarderPath(providerId: "claude-code" | "codex"): string {
  const dir = providerId === "codex" ? "hook-forwarder-codex" : "hook-forwarder";
  const devPath = normalizeCommandPath(join(__dirname, `../../dist/${dir}/index.js`));
  if (!app.isPackaged && existsSync(devPath)) return devPath;
  return normalizeCommandPath(join(process.resourcesPath, `${dir}/index.js`));
}

function getHookCommand(providerId: "claude-code" | "codex"): string {
  return `node "${getForwarderPath(providerId)}"`;
}

function checkHooksFor(providerId: "claude-code" | "codex") {
  const provider = getProvider(providerId);
  return checkProviderHooks(provider);
}

function checkProviderHooks(provider: Provider) {
  return checkManagedHooks(provider.settingsPath, getHookCommand(provider.id), provider);
}

function installProviderHooks(provider: Provider) {
  return installManagedHooks(provider.settingsPath, backupPathFor(provider), getHookCommand(provider.id), provider);
}

function repairProviderHooks(provider: Provider) {
  return repairManagedHooks(provider.settingsPath, backupPathFor(provider), getHookCommand(provider.id), provider);
}

function removeProviderHooks(provider: Provider) {
  return removeManagedHooks(provider.settingsPath, backupPathFor(provider), getHookCommand(provider.id), provider);
}

function backupPathFor(provider: Provider): string {
  // 与原 Claude hooks 共用一个 backup 路径以避免污染用户配置；
  // Codex 使用独立 backup，避免和 Claude 互相覆盖。
  if (provider.id === "claude-code") return backupPath;
  return join(homedir(), ".codex", "settings.clawd-backup.toml");
}

let hooksGuardTimer: ReturnType<typeof setInterval> | null = null;

function runHooksGuardCheck() {
  if (!settings.hooksGuardEnabled) return;
  for (const providerId of settings.enabledSources ?? []) {
    try {
      const status = checkHooksFor(providerId);
      if (!status.installed) {
        logRuntime(`[HooksGuard] ${providerId}: hooks missing (${status.missingEvents.join(", ")}), auto-repairing`);
        const result = repairProviderHooks(getProvider(providerId));
        if (result.success) {
          logRuntime(`[HooksGuard] ${providerId}: repaired ${result.fixed.length} events`);
        } else {
          logRuntime(`[HooksGuard] ${providerId}: repair failed: ${result.error}`);
        }
      }
    } catch (e) {
      logRuntime(`[HooksGuard] ${providerId}: check error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function startHooksGuard() {
  if (hooksGuardTimer) clearInterval(hooksGuardTimer);
  if (!settings.hooksGuardEnabled) return;
  const interval = Math.max(5_000, Math.min(60_000, settings.hooksGuardIntervalMs ?? 30_000));
  // First check after 10s (let app fully start), then at configured interval
  setTimeout(() => {
    runHooksGuardCheck();
    hooksGuardTimer = setInterval(runHooksGuardCheck, interval);
  }, 10_000);
}

function stopHooksGuard() {
  if (hooksGuardTimer) { clearInterval(hooksGuardTimer); hooksGuardTimer = null; }
}

ipcMain.handle("settings:get", () => settings);
ipcMain.handle("settings:save", (_, next: Partial<CompanionSettings>) => saveSettings(next));
ipcMain.handle("connection:get", () => getConnectionStatus());
ipcMain.handle("event:test", (_, event: CompanionEvent) => emitEvent(event));
ipcMain.handle("hooks:check", (_, providerId: "claude-code" | "codex" = "claude-code") => checkHooksFor(providerId));
ipcMain.handle("hooks:install", (_, providerId: "claude-code" | "codex" = "claude-code") => installProviderHooks(getProvider(providerId)));
ipcMain.handle("hooks:repair", (_, providerId: "claude-code" | "codex" = "claude-code") => repairProviderHooks(getProvider(providerId)));
ipcMain.handle("hooks:remove", (_, providerId: "claude-code" | "codex" = "claude-code") => removeProviderHooks(getProvider(providerId)));
ipcMain.handle("doctor:get-report", () => {
  const plugins = (settings.customPlugins ?? []).map(normalizePlugin);
  const providersReport: Record<string, { hooks: ReturnType<typeof checkProviderHooks>; forwarder: { expectedPath: string; exists: boolean } }> = {};
  for (const id of ["claude-code", "codex"] as const) {
    const provider = getProvider(id);
    const fp = getForwarderPath(id);
    providersReport[id] = {
      hooks: checkProviderHooks(provider),
      forwarder: { expectedPath: fp, exists: existsSync(fp) }
    };
  }
  return {
    generatedAt: Date.now(),
    appVersion: app.getVersion(),
    connection: getConnectionStatus(),
    providers: providersReport,
    forwarder: {
      autoStartMarkerPath,
      autoStartMarkerExists: existsSync(autoStartMarkerPath)
    },
    update: {
      ...updateStatus,
      autoUpdateEnabled: settings.autoUpdateEnabled
    },
    plugins: {
      total: plugins.length,
      enabled: plugins.filter(plugin => plugin.enabled).length,
      trusted: plugins.filter(plugin => plugin.trusted).length,
      manifestErrors: plugins.filter(plugin => plugin.manifestError).length
    },
    recent: {
      lastEventAt: lastEvent?.timestamp,
      lastEventTitle: lastEvent?.title,
      lastError: serverError
    }
  };
});
ipcMain.handle("permission:respond", async (_, response: PermissionResponse) => {
  const pending = permissionBroker.get(response.id);
  if (!pending || pending.status !== "pending") return { success: false };
  const result = permissionBroker.respond(response);
  if (!result.ok) return { success: false };
  if (response.decision === "allow") appStats.permissionApproved++;
  else appStats.permissionDenied++;
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
  keepPetOnTop();
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
ipcMain.handle("window:permission-card-rect", (_, rect: { x: number; y: number; width: number; height: number } | null) => {
  if (!rect || !petWindow || petWindow.isDestroyed()) {
    permissionCardRect = null;
    return;
  }
  const bounds = petWindow.getBounds();
  permissionCardRect = { ...rect, x: bounds.x + rect.x, y: bounds.y + rect.y };
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
    saveManagedSettings(appDataDir, settings);
    saveDebounce = null;
  }, 400);
});

ipcMain.handle("update:check", async () => {
  if (!app.isPackaged) {
    return { ok: false, error: "开发模式下无法检查更新，请打包安装后使用自动更新功能。" };
  }
  try {
    const result = await autoUpdateController.checkForUpdates();
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
    autoUpdateController.quitAndInstall();
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
ipcMain.handle("sound:get-default-paths", () => ({
  done: builtInPath("done"),
  error: builtInPath("error"),
  permission: builtInPath("permission"),
  "session-start": builtInPath("session-start")
}));
ipcMain.handle("sound:preview-file", (_, filePath: string) => {
  const dataUrl = fileToDataUrl(filePath);
  return dataUrl ? { ok: true, dataUrl } : { ok: false, error: "读取文件失败" };
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
  try {
    const parsed = new URL(url);
    const allowedHosts = new Set(["github.com", "raw.githubusercontent.com"]);
    if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) return { ok: false, error: "blocked_url" };
    shell.openExternal(parsed.toString());
    return { ok: true };
  } catch {
    return { ok: false, error: "invalid_url" };
  }
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
      if (!isSettingsImport(parsed)) {
        return { ok: false, error: "配置文件格式错误：设置字段类型无效" };
      }
      backupIfExists(settingsPath, "import");
      saveSettings(parsed);
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
      const imported = normalizeImportedStats(JSON.parse(json));
      if (!imported) return { ok: false, error: "统计文件格式错误：期望 JSON 对象" };
      backupIfExists(statsPath, "import");
      appStats = imported;
      saveStats();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false };
});

// Event History
ipcMain.handle("events:get-history", () => eventHistoryStore.events);
ipcMain.handle("sessions:get-history", () => eventHistoryStore.sessions);
ipcMain.handle("events:clear-history", () => {
  eventHistoryStore = { events: [], sessions: [] };
  saveEventHistory(historyPath, eventHistoryStore);
});
ipcMain.handle("events:export-file", async () => {
  const result = await dialog.showSaveDialog({
    defaultPath: `clawd-events-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (!result.canceled && result.filePath) {
    writeFileSync(result.filePath, JSON.stringify({ exportedAt: Date.now(), ...eventHistoryStore }, null, 2));
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
function marketRootPath(): string {
  const devPath = join(__dirname, "../../plugin-market");
  if (!app.isPackaged && existsSync(devPath)) return devPath;
  return join(process.resourcesPath, "plugin-market");
}

function readBundledMarketFile(path: string): string {
  const safePath = path === "index.json" ? path : safeMarketPath(path);
  return readFileSync(join(marketRootPath(), safePath), "utf8");
}

async function fetchText(url: string): Promise<string> {
  const response = await net.fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response.text();
}

async function fetchMarketFile(path: string): Promise<string> {
  if (!app.isPackaged) {
    try { return readBundledMarketFile(path); } catch { /* fall through to remote */ }
  }
  try {
    return await fetchText(path === "index.json" ? `${marketBaseUrl}/index.json` : rawUrl(marketBaseUrl, path));
  } catch (error) {
    logRuntime(`Plugin market network fetch failed for ${path}: ${error instanceof Error ? error.message : String(error)}; using bundled market`);
    return readBundledMarketFile(path);
  }
}

async function fetchMarketIndex(): Promise<PluginMarketIndex> {
  const text = await fetchMarketFile("index.json");
  return parseMarketIndex(JSON.parse(text));
}

ipcMain.handle("plugins:get", () => (settings.customPlugins ?? []).map(p => {
  const normalized = normalizePlugin(p);
  normalized.resolvedAssets = resolvePluginAssets(normalized);
  normalized.resolvedDataDir = join(pluginDataDir, normalized.id);
  return normalized;
}));
ipcMain.handle("plugins:get-runs", () => pluginRuns);
ipcMain.handle("plugins:run-now", (_, pluginId: string, action?: string) => {
  const plugin = (settings.customPlugins ?? []).find(p => p.id === pluginId);
  if (!plugin) return { ok: false, error: "Plugin not found" };
  if (!plugin.trusted) return { ok: false, error: "Plugin not trusted" };
  if (!plugin.scriptPath || !existsSync(plugin.scriptPath)) return { ok: false, error: "Script not found" };
  const dummyEvent: CompanionEvent = { id: `manual-${Date.now()}`, source: "manual", event: "done", title: "Manual run", message: "Triggered by user", timestamp: Date.now() };
  return new Promise<{ ok: boolean; runId?: string; error?: string }>(resolve => {
    runPlugin(normalizePlugin(plugin), dummyEvent, record => {
      pluginRuns = appendPluginRun(pluginRuns, record);
      settingsWindow?.webContents.send("companion:plugin-run", record);
      resolve({ ok: record.exitCode === 0 && !record.timedOut, runId: record.id, error: record.stderr || undefined });
    }, pluginDataDir, true, action);
  });
});
ipcMain.handle("plugins:open-data-dir", (_, pluginId: string) => {
  const dir = join(pluginDataDir, pluginId);
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
  shell.openPath(dir);
  return { ok: true };
});
ipcMain.handle("plugins:save", (_, plugins: CustomPlugin[]) => {
  saveSettings({ customPlugins: plugins.map(normalizePlugin) });
  return settings.customPlugins;
});
ipcMain.handle("plugins:market-get", async () => fetchMarketIndex());
ipcMain.handle("plugins:market-install", async (_, pluginId: string) => {
  const market = await fetchMarketIndex();
  const item = market.plugins.find(plugin => plugin.id === pluginId);
  if (!item) return { ok: false, error: "Plugin not found in market" };
  const entry = await fetchMarketFile(item.entry);
  const manifest = await fetchMarketFile(item.manifest);
  const assets: Record<string, string> = {};
  try {
    const parsedManifest = JSON.parse(manifest);
    if (parsedManifest.assets?.sprites) {
      assets[parsedManifest.assets.sprites] = await fetchMarketFile(`plugins/${item.id}/${parsedManifest.assets.sprites}`);
    }
  } catch { /* ignore asset fetch errors */ }
  const previous = (settings.customPlugins ?? []).find(plugin => plugin.id === `market-${item.id}`);
  const installed = installMarketPlugin(localPluginDir, item, { entry, manifest, assets: Object.keys(assets).length > 0 ? assets : undefined }, previous);
  const next = [...(settings.customPlugins ?? []).filter(plugin => plugin.id !== installed.id), installed];
  saveSettings({ customPlugins: next });
  return { ok: true, plugin: installed };
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
    eventHistoryStore = loadEventHistory(historyPath);
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
    autoUpdateController.setup();
    if (settings.autoUpdateEnabled) {
      setTimeout(() => {
        autoUpdateController.checkForUpdates().catch(e => logRuntime("AutoUpdate check failed: " + e));
      }, 5000);
    }
    startHooksGuard();
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
    stopHooksGuard();
    permissionBroker.shutdown("App quitting");
  });
}

