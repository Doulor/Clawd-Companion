import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, screen } from "electron";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CompanionConnectionStatus, CompanionEvent, CompanionSettings } from "../shared/events.js";
import { defaultSettings } from "../shared/events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const devIconPath = join(__dirname, "../../build/icon.ico");
const prodIconPath = join(process.resourcesPath, "build/icon.ico");
const iconPath = existsSync(devIconPath) ? devIconPath : prodIconPath;
const appDataDir = join(app.getPath("userData"), "clawd-companion");
const settingsPath = join(appDataDir, "settings.json");
const logPath = join(appDataDir, "runtime.log");

let petWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: CompanionSettings = defaultSettings;
let eventServer: ReturnType<typeof createServer> | null = null;
let wsServer: WebSocketServer | null = null;
let serverListening = false;
let serverError: string | undefined;
let lastEvent: CompanionEvent | null = null;
let suppressPetMoveSave = false;
let activeSessionId: string | undefined;
let activeClientType: CompanionEvent["clientType"] | undefined;
let activeClientLabel: string | undefined;

function ensureDataDir() {
  if (!existsSync(appDataDir)) mkdirSync(appDataDir, { recursive: true });
}

function logRuntime(message: string) {
  ensureDataDir();
  appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
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
    feedbackModes: { ...defaultSettings.feedbackModes, ...(stored.feedbackModes ?? {}) },
    toolFeedbackModes: { ...defaultSettings.toolFeedbackModes, ...(stored.toolFeedbackModes ?? {}) },
    zoneSizes: stored.zoneSizes ?? defaultSettings.zoneSizes
  };
}

function saveSettings(next: Partial<CompanionSettings>) {
  const previousPort = settings.port;
  const previousViewScale = settings.viewScale ?? settings.petScale;
  settings = { ...settings, ...next };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, path: process.execPath });
  if (petWindow && (settings.viewScale ?? settings.petScale) !== previousViewScale) {
    const size = petWindowSize();
    petWindow.setSize(size.width, size.height);
    const [xNow, yNow] = petWindow.getPosition();
    const clamped = clampPetPosition(xNow, yNow);
    petWindow.setPosition(clamped.x, clamped.y);
  }
  if (petWindow) {
    if (settings.petEnabled) petWindow.show();
    else petWindow.hide();
  }
  keepPetOnTop();
  petWindow?.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
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
  const vs = settings.viewScale ?? settings.petScale;
  return {
    width: Math.round(260 * vs),
    height: Math.round(392 * vs)
  };
}

function clampPetPosition(x: number, y: number) {
  const display = screen.getPrimaryDisplay().workArea;
  const size = petWindowSize();
  return {
    x: Math.min(Math.max(Math.round(x), display.x + 8), display.x + display.width - size.width - 8),
    y: Math.min(Math.max(Math.round(y), display.y + 8), display.y + display.height - size.height - 8)
  };
}

function keepPetOnTop() {
  if (!petWindow || petWindow.isDestroyed() || !settings.alwaysOnTop) return;
  petWindow.setAlwaysOnTop(true, "screen-saver");
  petWindow.moveTop();
}

function createPetWindow() {
  const display = screen.getPrimaryDisplay().workArea;
  const size = petWindowSize();
  const defaultX = display.x + display.width - size.width - 72;
  const defaultY = display.y + display.height - size.height - 260;
  const position = clampPetPosition(settings.position?.x ?? defaultX, settings.position?.y ?? defaultY);

  petWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: position.x,
    y: position.y,
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
  petWindow.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
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
    const [xNow, yNow] = petWindow?.getPosition() ?? [position.x, position.y];
    const clamped = clampPetPosition(xNow, yNow);
    if (xNow !== clamped.x || yNow !== clamped.y) {
      suppressPetMoveSave = true;
      petWindow?.setPosition(clamped.x, clamped.y);
    }
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

function emitEvent(event: CompanionEvent) {
  lastEvent = event;
  activeSessionId = event.sessionId ?? activeSessionId;
  activeClientType = event.clientType ?? activeClientType;
  activeClientLabel = event.clientLabel ?? activeClientLabel;
  if (settings.petEnabled && petWindow && !petWindow.isDestroyed() && !petWindow.isVisible()) petWindow.show();
  petWindow?.webContents.send("companion:event", event);
  settingsWindow?.webContents.send("companion:event", event);
  wsServer?.clients.forEach(client => client.send(JSON.stringify({ type: "event", payload: event })));
  broadcastConnectionStatus();

  if (settings.doneSound && event.event === "done" && Notification.isSupported()) {
    new Notification({ title: event.title, body: event.message }).show();
  }
}

function broadcastSettings() {
  petWindow?.webContents.send("companion:settings", settings);
  settingsWindow?.webContents.send("companion:settings", settings);
  wsServer?.clients.forEach(client => client.send(JSON.stringify({ type: "settings", payload: settings })));
}

ipcMain.handle("settings:get", () => settings);
ipcMain.handle("settings:save", (_, next: Partial<CompanionSettings>) => saveSettings(next));
ipcMain.handle("connection:get", () => getConnectionStatus());
ipcMain.handle("event:test", (_, event: CompanionEvent) => emitEvent(event));
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
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, path: process.execPath });
    createPetWindow();
    if (settings.openSettingsOnStart) createSettingsWindow();
    makeTrayIcon();
    startEventServer();
  });

  app.on("window-all-closed", () => {
    // 桌宠应用关闭配置面板后继续留在托盘，不让 Electron 默认退出。
  });

  app.on("before-quit", () => {
    wsServer?.close();
    eventServer?.close();
  });
}
