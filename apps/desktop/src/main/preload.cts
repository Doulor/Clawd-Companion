import { contextBridge, ipcRenderer } from "electron";
import type { CompanionConnectionStatus, CompanionEvent, CompanionSettings, PermissionRequest, PermissionResponse, UpdateStatus, DoctorReport, PluginMarketIndex, PluginRunRecord, SessionHistory } from "../shared/events.js";

interface HooksStatus {
  installed: boolean;
  configExists: boolean;
  hookCount: number;
  requiredCount: number;
  missingEvents: string[];
  commandMatches: boolean;
}

const companionApi = {
  getSettings: () => ipcRenderer.invoke("settings:get") as Promise<CompanionSettings>,
  saveSettings: (settings: Partial<CompanionSettings>) => ipcRenderer.invoke("settings:save", settings) as Promise<CompanionSettings>,
  getConnectionStatus: () => ipcRenderer.invoke("connection:get") as Promise<CompanionConnectionStatus>,
  sendTestEvent: (event: CompanionEvent) => ipcRenderer.invoke("event:test", event) as Promise<void>,
  checkHooks: (providerId: "claude-code" | "codex" = "claude-code") => ipcRenderer.invoke("hooks:check", providerId) as Promise<HooksStatus>,
  installHooks: (providerId: "claude-code" | "codex" = "claude-code") => ipcRenderer.invoke("hooks:install", providerId) as Promise<{ success: boolean; error?: string }>,
  repairHooks: (providerId: "claude-code" | "codex" = "claude-code") => ipcRenderer.invoke("hooks:repair", providerId) as Promise<{ success: boolean; fixed: string[]; error?: string }>,
  removeHooks: (providerId: "claude-code" | "codex" = "claude-code") => ipcRenderer.invoke("hooks:remove", providerId) as Promise<{ success: boolean; error?: string }>,
  openSettings: () => ipcRenderer.invoke("window:open-settings") as Promise<void>,
  minimizeSettings: () => ipcRenderer.invoke("window:minimize-settings") as Promise<void>,
  toggleMaximizeSettings: () => ipcRenderer.invoke("window:toggle-maximize-settings") as Promise<void>,
  closeSettings: () => ipcRenderer.invoke("window:close-settings") as Promise<void>,
  onEvent: (callback: (event: CompanionEvent) => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: CompanionEvent) => callback(event);
    ipcRenderer.on("companion:event", handler);
    return () => { ipcRenderer.off("companion:event", handler); };
  },
  onSettings: (callback: (settings: CompanionSettings) => void) => {
    const handler = (_: Electron.IpcRendererEvent, settings: CompanionSettings) => callback(settings);
    ipcRenderer.on("companion:settings", handler);
    return () => { ipcRenderer.off("companion:settings", handler); };
  },
  onConnection: (callback: (status: CompanionConnectionStatus) => void) => {
    const handler = (_: Electron.IpcRendererEvent, status: CompanionConnectionStatus) => callback(status);
    ipcRenderer.on("companion:connection", handler);
    return () => { ipcRenderer.off("companion:connection", handler); };
  },
  setPetInteractive: (interactive: boolean) => ipcRenderer.invoke("window:pet-interactive", interactive) as Promise<void>,
  dragPetTo: (x: number, y: number) => ipcRenderer.invoke("window:drag-pet", { x, y }) as Promise<void>,
  movePetBy: (dx: number, dy: number) => ipcRenderer.invoke("window:move-pet-by", { dx, dy }) as Promise<void>,
  onPermissionRequest: (callback: (request: PermissionRequest) => void) => {
    const handler = (_: Electron.IpcRendererEvent, request: PermissionRequest) => callback(request);
    ipcRenderer.on("companion:permission-request", handler);
    return () => { ipcRenderer.off("companion:permission-request", handler); };
  },
  onPermissionResolved: (callback: (result: { id: string; status: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, result: { id: string; status: string }) => callback(result);
    ipcRenderer.on("companion:permission-resolved", handler);
    return () => { ipcRenderer.off("companion:permission-resolved", handler); };
  },
  respondPermission: (response: PermissionResponse) =>
    ipcRenderer.invoke("permission:respond", response) as Promise<{ success: boolean }>,
  checkForUpdates: () => ipcRenderer.invoke("update:check") as Promise<{ ok: boolean; error?: string }>,
  installUpdate: () => ipcRenderer.invoke("update:install") as Promise<{ ok: boolean; error?: string }>,
  getUpdateStatus: () => ipcRenderer.invoke("update:get-status") as Promise<UpdateStatus>,
  getAppVersion: () => ipcRenderer.invoke("app:get-version") as Promise<string>,
  getTokenStats: (force?: boolean) => ipcRenderer.invoke("token-stats:get", force) as Promise<import("../shared/events.js").TokenStats>,
  previewSound: (name: "done" | "error" | "permission" | "session-start") => ipcRenderer.invoke("sound:preview", name) as Promise<{ ok: boolean; dataUrl?: string; error?: string }>,
  getDefaultSoundPaths: () => ipcRenderer.invoke("sound:get-default-paths") as Promise<Record<"done" | "error" | "permission" | "session-start", string>>,
  previewSoundFile: (filePath: string) => ipcRenderer.invoke("sound:preview-file", filePath) as Promise<{ ok: boolean; dataUrl?: string; error?: string }>,
  pickSoundFile: () => ipcRenderer.invoke("sound:pick-file") as Promise<string | null>,
  triggerIdleBubble: () => ipcRenderer.invoke("test:idle-bubble") as Promise<void>,
  syncIdleBubble: (sprite: string | null) => ipcRenderer.invoke("idle-bubble:sync", sprite) as Promise<void>,
  onIdleBubbleSync: (callback: (sprite: string | null) => void) => {
    const handler = (_: Electron.IpcRendererEvent, sprite: string | null) => callback(sprite);
    ipcRenderer.on("companion:idle-bubble-sync", handler);
    return () => { ipcRenderer.off("companion:idle-bubble-sync", handler); };
  },
  getEventHistory: () => ipcRenderer.invoke("events:get-history") as Promise<import("../shared/events.js").EventHistoryEntry[]>,
  getSessionHistory: () => ipcRenderer.invoke("sessions:get-history") as Promise<SessionHistory[]>,
  clearEventHistory: () => ipcRenderer.invoke("events:clear-history") as Promise<void>,
  exportEventHistoryFile: () => ipcRenderer.invoke("events:export-file") as Promise<{ ok: boolean; error?: string }>,
  getMonitors: () => ipcRenderer.invoke("display:get-monitors") as Promise<Array<{id: string; bounds: {x: number; y: number; width: number; height: number}; name: string; isPrimary: boolean}>>,
  getPlugins: () => ipcRenderer.invoke("plugins:get") as Promise<import("../shared/events.js").CustomPlugin[]>,
  getPluginRuns: () => ipcRenderer.invoke("plugins:get-runs") as Promise<PluginRunRecord[]>,
  runPluginNow: (pluginId: string) => ipcRenderer.invoke("plugins:run-now", pluginId) as Promise<{ ok: boolean; error?: string }>,
  openPluginDataDir: (pluginId: string) => ipcRenderer.invoke("plugins:open-data-dir", pluginId) as Promise<{ ok: boolean }>,
  getPluginMarket: () => ipcRenderer.invoke("plugins:market-get") as Promise<PluginMarketIndex>,
  installMarketPlugin: (pluginId: string) => ipcRenderer.invoke("plugins:market-install", pluginId) as Promise<{ ok: boolean; plugin?: import("../shared/events.js").CustomPlugin; error?: string }>,
  savePlugins: (plugins: import("../shared/events.js").CustomPlugin[]) => ipcRenderer.invoke("plugins:save", plugins) as Promise<import("../shared/events.js").CustomPlugin[]>,
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url) as Promise<{ ok: boolean; error?: string }>,
  getStats: () => ipcRenderer.invoke("stats:get") as Promise<import("../shared/events.js").AppStats>,
  resetStats: () => ipcRenderer.invoke("stats:reset") as Promise<void>,
  exportSettingsFile: () => ipcRenderer.invoke("settings:export-file") as Promise<{ ok: boolean; error?: string }>,
  importSettingsFile: () => ipcRenderer.invoke("settings:import-file") as Promise<{ ok: boolean; error?: string }>,
  exportStatsFile: () => ipcRenderer.invoke("stats:export-file") as Promise<{ ok: boolean; error?: string }>,
  importStatsFile: () => ipcRenderer.invoke("stats:import-file") as Promise<{ ok: boolean; error?: string }>,
  getDoctorReport: () => ipcRenderer.invoke("doctor:get-report") as Promise<DoctorReport>,
  onTriggerIdleBubble: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("companion:test-idle-bubble", handler);
    return () => { ipcRenderer.off("companion:test-idle-bubble", handler); };
  },
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => {
    const handler = (_: Electron.IpcRendererEvent, status: UpdateStatus) => callback(status);
    ipcRenderer.on("companion:update-status", handler);
    return () => { ipcRenderer.off("companion:update-status", handler); };
  },
  onPlaySound: (callback: (dataUrl: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, dataUrl: string) => callback(dataUrl);
    ipcRenderer.on("companion:play-sound", handler);
    return () => { ipcRenderer.off("companion:play-sound", handler); };
  },
  onOpenSection: (callback: (section: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, section: string) => callback(section);
    ipcRenderer.on("companion:open-section", handler);
    return () => { ipcRenderer.off("companion:open-section", handler); };
  }
};

export type CompanionApi = typeof companionApi;

contextBridge.exposeInMainWorld("companion", companionApi);

declare global {
  interface Window {
    companion: CompanionApi;
  }
}
