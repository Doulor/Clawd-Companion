/// <reference types="vite/client" />

import type { CompanionConnectionStatus, CompanionEvent, CompanionSettings, PermissionRequest, PermissionResponse, UpdateStatus } from "../shared/events";

interface HooksStatus {
  installed: boolean;
  configExists: boolean;
  hookCount: number;
  requiredCount: number;
  missingEvents: string[];
  commandMatches: boolean;
}

declare global {
  interface ViewTransition {
    finished: Promise<void>;
    ready: Promise<void>;
    updateCallbackDone: Promise<void>;
    skipTransition: () => void;
  }

  interface Document {
    startViewTransition?: (callback: () => void) => ViewTransition;
  }

  interface Window {
    companion: {
      getSettings: () => Promise<CompanionSettings>;
      saveSettings: (settings: Partial<CompanionSettings>) => Promise<CompanionSettings>;
      getConnectionStatus: () => Promise<CompanionConnectionStatus>;
      sendTestEvent: (event: CompanionEvent) => Promise<void>;
      checkHooks: () => Promise<HooksStatus>;
      installHooks: () => Promise<{ success: boolean; error?: string }>;
      repairHooks: () => Promise<{ success: boolean; fixed: string[]; error?: string }>;
      removeHooks: () => Promise<{ success: boolean; error?: string }>;
      openSettings: () => Promise<void>;
      minimizeSettings: () => Promise<void>;
      toggleMaximizeSettings: () => Promise<void>;
      closeSettings: () => Promise<void>;
      onEvent: (callback: (event: CompanionEvent) => void) => () => void;
      onSettings: (callback: (settings: CompanionSettings) => void) => () => void;
      onConnection: (callback: (status: CompanionConnectionStatus) => void) => () => void;
      setPetInteractive: (interactive: boolean) => Promise<void>;
      dragPetTo: (x: number, y: number) => Promise<void>;
      movePetBy: (dx: number, dy: number) => Promise<void>;
      onPermissionRequest: (callback: (request: PermissionRequest) => void) => () => void;
      onPermissionResolved: (callback: (result: { id: string; status: string }) => void) => () => void;
      respondPermission: (response: PermissionResponse) => Promise<{ success: boolean }>;
      checkForUpdates: () => Promise<{ ok: boolean; error?: string }>;
      installUpdate: () => Promise<{ ok: boolean; error?: string }>;
      getUpdateStatus: () => Promise<UpdateStatus>;
      getAppVersion: () => Promise<string>;
      getTokenStats: (force?: boolean) => Promise<import("../shared/events").TokenStats>;
      previewSound: (name: "done" | "error" | "permission" | "session-start") => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
      pickSoundFile: () => Promise<string | null>;
      triggerIdleBubble: () => Promise<void>;
      onTriggerIdleBubble: (callback: () => void) => () => void;
      syncIdleBubble: (sprite: string | null) => Promise<void>;
      onIdleBubbleSync: (callback: (sprite: string | null) => void) => () => void;
      getEventHistory: () => Promise<import("../shared/events").EventHistoryEntry[]>;
      clearEventHistory: () => Promise<void>;
      exportEventHistoryFile: () => Promise<{ ok: boolean; error?: string }>;
      getMonitors: () => Promise<Array<{id: string; bounds: {x: number; y: number; width: number; height: number}; name: string; isPrimary: boolean}>>;
      recordGif: () => Promise<{ok: boolean; message?: string}>;
      saveGif: (dataUrl: string) => Promise<{ok: boolean; error?: string}>;
      getPlugins: () => Promise<import("../shared/events").CustomPlugin[]>;
      savePlugins: (plugins: import("../shared/events").CustomPlugin[]) => Promise<import("../shared/events").CustomPlugin[]>;
      openExternal: (url: string) => Promise<void>;
      getStats: () => Promise<import("../shared/events").AppStats>;
      resetStats: () => Promise<void>;
      exportSettingsFile: () => Promise<{ ok: boolean; error?: string }>;
      importSettingsFile: () => Promise<{ ok: boolean; error?: string }>;
      exportStatsFile: () => Promise<{ ok: boolean; error?: string }>;
      importStatsFile: () => Promise<{ ok: boolean; error?: string }>;
      onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void;
      onPlaySound: (callback: (dataUrl: string) => void) => () => void;
    };
  }
}

export {};
