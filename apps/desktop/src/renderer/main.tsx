import React, { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  Bell,
  Bot,
  Check,
  Clipboard,
  Code2,
  Eye,
  EyeOff,
  FileText,
  Gauge,
  MonitorCheck,
  MousePointer2,
  Play,
  PlugZap,
  Radio,
  Search,
  Shield,
  Sparkles,
  Terminal,
  Timer,
  Wand2,
  Wrench,
  X
} from "lucide-react";
import type { CompanionConnectionStatus, CompanionEvent, CompanionSettings, CompanionSession, FeedbackMode, IdleAnimConfig, PetState, PrivacyMode, PermissionRequest, ToolName, UpdateStatus } from "../shared/events";
import { defaultSettings, stateFromEvent, type EventHistoryEntry, type NotificationRule, type CustomPlugin, type MonitorPosition } from "../shared/events";
import clawdImage from "./clawd.png";
import "./clawd-sprites/sprites.css";
import "./styles.css";
import { I18nProvider, useI18n, detectLocale } from "./useI18n";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { HistoryPanel } from "./components/HistoryPanel";
import { SessionStatsDashboard } from "./components/SessionStatsDashboard";
import { TimelinePanel } from "./components/TimelinePanel";
import { PluginManagerPanel } from "./components/PluginManagerPanel";
import { PluginMarketPanel } from "./components/PluginMarketPanel";
import { NotificationRulesPanel } from "./components/NotificationRulesPanel";
import { MonitorSettings } from "./components/MonitorSettings";
import { DoctorPanel } from "./components/DoctorPanel";

const clawdGifName: Record<PetState, string> = {
  idle: "clawd_png_idle",
  thinking: "thinking_speech",
  tool_read: "thinking_speech",
  tool_edit: "working_hardhat",
  tool_bash: "headset_focus",
  tool_search: "thinking_speech",
  tool_mcp: "thinking_speech",
  skill: "idea_bulb",
  task: "idea_bulb",
  agent: "welding_work",
  waiting_permission: "permission_prompt",
  done: "celebrate_bunny",
  error: "error_dead"
};

const stateCopy: Record<PetState, { label: string; line: string; tone: string }> = {
  idle: { label: "待机", line: "Clawd 在桌面边缘小憩", tone: "sand" },
  thinking: { label: "思考中", line: "正在整理上下文", tone: "blue" },
  tool_read: { label: "读取", line: "正在看文件", tone: "green" },
  tool_edit: { label: "编辑", line: "正在改代码", tone: "coral" },
  tool_bash: { label: "终端", line: "正在执行命令", tone: "ink" },
  tool_search: { label: "搜索", line: "正在检索线索", tone: "blue" },
  tool_mcp: { label: "MCP", line: "正在调用 MCP 工具", tone: "blue" },
  skill: { label: "技能", line: "正在使用技能", tone: "honey" },
  task: { label: "任务", line: "正在处理任务", tone: "steel" },
  agent: { label: "子代理", line: "正在调用子代理", tone: "steel" },
  waiting_permission: { label: "等待确认", line: "需要你处理一个确认", tone: "honey" },
  done: { label: "完成", line: "这一轮已经处理完", tone: "green" },
  error: { label: "出错", line: "刚才有一步失败了", tone: "coral" }
};

const stateFeedbackMode: Record<PetState, FeedbackMode> = {
  idle: "card",
  thinking: "card",
  tool_read: "thought",
  tool_edit: "card",
  tool_bash: "thought",
  tool_search: "thought",
  tool_mcp: "thought",
  skill: "thought",
  task: "thought",
  agent: "thought",
  waiting_permission: "card",
  done: "card",
  error: "card"
};

function getFeedbackMode(event: CompanionEvent): FeedbackMode {
  if (event.tool && event.tool !== "Unknown") return "ribbon";
  return stateFeedbackMode[stateFromEvent(event)] ?? "card";
}

function applyTheme(theme: CompanionSettings["theme"]) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
    return;
  }
  if (theme === "system") {
    document.documentElement.setAttribute("data-theme", window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    return;
  }
  document.documentElement.setAttribute("data-theme", "light");
}

function applyUiStyle(uiStyle: CompanionSettings["uiStyle"]) {
  document.documentElement.setAttribute("data-ui-style", uiStyle);
}

const mappingRows: Array<{ source: string; tool?: string; state: PetState; title: string }> = [
  { source: "SessionStart", state: "thinking", title: "会话开始" },
  { source: "UserPromptSubmit", state: "thinking", title: "收到用户输入" },
  { source: "PreToolUse", tool: "Read / Notebook", state: "tool_read", title: "读取文件" },
  { source: "PreToolUse", tool: "Edit / Write", state: "tool_edit", title: "修改文件" },
  { source: "PreToolUse", tool: "Bash", state: "tool_bash", title: "执行命令" },
  { source: "PreToolUse", tool: "Grep / Glob / WebFetch / WebSearch", state: "tool_search", title: "搜索资料" },
  { source: "PreToolUse", tool: "MCP", state: "tool_mcp", title: "MCP 工具" },
  { source: "PreToolUse", tool: "Skill", state: "skill", title: "技能调用" },
  { source: "PreToolUse", tool: "Task", state: "task", title: "任务处理" },
  { source: "PreToolUse", tool: "Agent", state: "agent", title: "子代理调用" },
  { source: "PreToolUse", tool: "AskUserQuestion", state: "thinking", title: "等待选择" },
  { source: "Notification", state: "waiting_permission", title: "等待确认" },
  { source: "Stop", state: "done", title: "处理完成" },
  { source: "转发失败", state: "error", title: "异常提示" }
];

function makeEvent(event: CompanionEvent["event"], source: CompanionEvent["source"], title: string, message: string, tool?: CompanionEvent["tool"]): CompanionEvent {
  return {
    id: crypto.randomUUID(),
    source,
    event,
    tool,
    title,
    message,
    timestamp: Date.now()
  };
}

interface ToolStream {
  event: CompanionEvent;
  exiting: boolean;
  slot: number;
  exitSlot?: number;
}

function useCompanion() {
  const [settings, setSettings] = useState<CompanionSettings>(defaultSettings);
  const [connection, setConnection] = useState<CompanionConnectionStatus>({
    port: defaultSettings.port,
    serverListening: false,
    tokenSet: true,
    privacyMode: defaultSettings.privacyMode,
    connected: false
  });
  const [events, setEvents] = useState<CompanionEvent[]>([]);
  const [currentEvent, setCurrentEvent] = useState<CompanionEvent | null>(null);
  const [petState, setPetState] = useState<PetState>("idle");
  const [toolStreams, setToolStreams] = useState<ToolStream[]>([]);
  const [activePermissions, setActivePermissions] = useState<PermissionRequest[]>([]);
  const [sessions, setSessions] = useState<CompanionSession[]>([]);
  const [exitingSessions, setExitingSessions] = useState<Set<string>>(new Set());
  const [mainSessionId, setMainSessionId] = useState<string | null>(null);
  const sessionsRef = useRef<Map<string, CompanionSession>>(new Map());
  const ribbonTimers = useRef<Map<string, number>>(new Map());
  const ribbonTimestamps = useRef<Map<string, number>>(new Map());
  const eventThrottleRef = useRef<{ timer: number | null; lastFlush: number }>({ timer: null, lastFlush: 0 });
  const pendingEventsRef = useRef<CompanionEvent[]>([]);
  const companionSlotRef = useRef<Map<string, number>>(new Map());

  function scheduleStreamRemoval(eventId: string) {
    window.setTimeout(() => {
      setToolStreams(previous => previous.filter(s => s.event.id !== eventId));
      ribbonTimers.current.delete(eventId);
      ribbonTimestamps.current.delete(eventId);
    }, 780);
  }

  function markExiting(eventId: string) {
    setToolStreams(previous => {
      const target = previous.find(s => s.event.id === eventId);
      if (!target) return previous;
      const exitSlot = target.slot;
      return previous.map(s => {
        if (s.event.id === eventId) return { ...s, exiting: true, exitSlot };
        if (!s.exiting && s.slot > exitSlot) return { ...s, slot: s.slot - 1 };
        return s;
      });
    });
    scheduleStreamRemoval(eventId);
  }

  function removeSatellite(eventId: string) {
    setToolStreams(previous => previous.filter(s => s.event.id !== eventId));
    ribbonTimers.current.delete(eventId);
    ribbonTimestamps.current.delete(eventId);
  }

  useEffect(() => {
    void window.companion.getSettings().then(setSettings);
    void window.companion.getConnectionStatus().then(setConnection);
    const offSettings = window.companion.onSettings(setSettings);
    const offConnection = window.companion.onConnection(setConnection);
    const offEvent = window.companion.onEvent(event => {
      // 多会话追踪
      const sid = event.sessionId;
      const isDone = event.event === "done" || event.event === "error";
      if (sid) {
        const existing = sessionsRef.current.get(sid);
        // 第一个会话自动成为主 Clawd
        if (!mainSessionId && sessionsRef.current.size === 0) {
          setMainSessionId(sid);
        }
        let title = existing?.title ?? "";
        // 标题提取逻辑：detail > title > message > clientLabel
        const raw = event.detail || event.title || event.message || "";
        const clean = raw.length > 25 ? raw.slice(0, 25) + "…" : raw;
        if (!title && clean) {
          title = clean;
        }
        // 每次 prompt_submit 都更新标题（用户输入是最具代表性的内容）
        if (event.event === "prompt_submit") {
          const prompt = event.detail || event.message || "";
          if (prompt) {
            title = prompt.length > 25 ? prompt.slice(0, 25) + "…" : prompt;
          }
        }
        const wasActive = existing?.isActive ?? true;
        const session: CompanionSession = {
          sessionId: sid,
          title: title || (existing?.title) || sid.slice(0, 6),
          state: stateFromEvent(event),
          lastEvent: event,
          lastEventTime: Date.now(),
          isActive: !isDone,
          eventCount: (existing?.eventCount ?? 0) + 1
        };
        sessionsRef.current.set(sid, session);
        setSessions(Array.from(sessionsRef.current.values()));
        // 会话复活：之前处于退出状态但新事件使会话重新活跃，立即移出 exitingSessions
        if (!wasActive && !isDone) {
          setExitingSessions(prev => { const next = new Set(prev); next.delete(sid); return next; });
        }
        if (wasActive && isDone) {
          setExitingSessions(prev => new Set(prev).add(sid));
          const exitId = sid;
          setTimeout(() => {
            // 检查会话是否已被后续事件复活，如是则跳过清理
            const revived = sessionsRef.current.get(exitId);
            if (revived?.isActive) return;
            setExitingSessions(prev => { const next = new Set(prev); next.delete(exitId); return next; });
            sessionsRef.current.delete(exitId);
            setSessions(Array.from(sessionsRef.current.values()));
          }, 700);
        }
      } else if (isDone) {
        // done 事件无 sessionId → 标记所有活跃会话为退出
        for (const [id, s] of sessionsRef.current) {
          if (s.isActive) {
            sessionsRef.current.set(id, { ...s, isActive: false });
            setExitingSessions(prev => new Set(prev).add(id));
            const exitId = id;
            setTimeout(() => {
              const revived = sessionsRef.current.get(exitId);
              if (revived?.isActive) return;
              setExitingSessions(prev => { const next = new Set(prev); next.delete(exitId); return next; });
              sessionsRef.current.delete(exitId);
              setSessions(Array.from(sessionsRef.current.values()));
            }, 700);
          }
        }
        setSessions(Array.from(sessionsRef.current.values()));
      }

      // 单会话空闲检测：伴生会话超过 60 秒无事件则渐出消失，主会话不受影响
      for (const [id, s] of sessionsRef.current) {
        if (id !== mainSessionId && s.isActive && Date.now() - s.lastEventTime > 60_000 && !exitingSessions.has(id)) {
          sessionsRef.current.set(id, { ...s, isActive: false });
          setExitingSessions(prev => new Set(prev).add(id));
          const exitId = id;
          setTimeout(() => {
            const revived = sessionsRef.current.get(exitId);
            if (revived?.isActive) return;
            setExitingSessions(prev => { const next = new Set(prev); next.delete(exitId); return next; });
            sessionsRef.current.delete(exitId);
            setSessions(Array.from(sessionsRef.current.values()));
          }, 700);
        }
      }
      setSessions(Array.from(sessionsRef.current.values()));
      let silentCleanup = false;
      for (const [id, s] of sessionsRef.current) {
        if (Date.now() - s.lastEventTime > 300_000) {
          sessionsRef.current.delete(id);
          setExitingSessions(prev => { const next = new Set(prev); next.delete(id); return next; });
          silentCleanup = true;
        }
      }
      if (silentCleanup) {
        setSessions(Array.from(sessionsRef.current.values()));
      }

      // 节流：100ms 内只刷新一次事件列表和 petState，减少高频事件时的渲染
      // tool_end 不改变 petState —— 工具状态由 bubbleDuration 超时回退到 idle
      const now = Date.now();
      if (now - eventThrottleRef.current.lastFlush < 100) {
        pendingEventsRef.current.push(event);
        if (!eventThrottleRef.current.timer) {
          eventThrottleRef.current.timer = window.setTimeout(() => {
            const pending = pendingEventsRef.current;
            pendingEventsRef.current = [];
            eventThrottleRef.current.timer = null;
            eventThrottleRef.current.lastFlush = Date.now();
            setEvents(previous => [...pending.reverse(), ...previous].slice(0, settings.eventHistoryLimit));
            // pending 已被 reverse()（最新在前）
            // 优先取 tool_start（工具动画优先级最高），否则取最近的非 tool_end / git_operation 事件
            const stateEvent = pending.find(e => e.event === "tool_start") ?? pending.find(e => e.event !== "tool_end" && e.event !== "git_operation");
            if (stateEvent) {
              setPetState(stateFromEvent(stateEvent));
              setCurrentEvent(stateEvent);
            }
          }, 100 - (now - eventThrottleRef.current.lastFlush));
        }
      } else {
        eventThrottleRef.current.lastFlush = now;
        setEvents(previous => [event, ...previous].slice(0, settings.eventHistoryLimit));
        // git_operation 只触发胶囊（git-toast listener），不切 Pet 状态 / 卡片
        if (event.event !== "tool_end" && event.event !== "git_operation") {
          setPetState(stateFromEvent(event));
          setCurrentEvent(event);
        }
      }

      // tool_end 处理：找到匹配的 tool_start 并标记退出
      if (event.event === "tool_end") {
        setToolStreams(previous => {
          const matching = previous.find(
            s => s.event.event === "tool_start" && s.event.tool === event.tool && !s.exiting
          );
          if (!matching) return previous;

          const addedAt = ribbonTimestamps.current.get(matching.event.id) ?? Date.now();
          const elapsed = Date.now() - addedAt;
          const minDisplayMs = Math.max(300, settings.toolStreamMinDuration * 1000);

          // 清除保底超时
          const fallbackId = ribbonTimers.current.get(matching.event.id);
          if (fallbackId) window.clearTimeout(fallbackId);
          ribbonTimers.current.delete(matching.event.id);

          if (elapsed >= minDisplayMs) {
            // 已显示够久，立即标记退出
            markExiting(matching.event.id);
          } else {
            // 还没到最少显示时间，延迟标记退出
            const delay = minDisplayMs - elapsed;
            const delayTimeout = window.setTimeout(() => {
              markExiting(matching.event.id);
            }, delay);
            ribbonTimers.current.set(matching.event.id, delayTimeout);
          }
          return previous;
        });
        // tool_end 不改变 petState 和 currentEvent（由节流器统一处理）
      }

      // tool_start 处理：添加到工具流列表并设置保底超时
      if (event.event === "tool_start") {
        let overflowId: string | undefined;
        setToolStreams(previous => {
          const active = previous.filter(s => !s.exiting);
          const overflow = active.length >= 5 ? active.at(-1) : undefined;
          if (overflow) {
            overflowId = overflow.event.id;
            const fallbackId = ribbonTimers.current.get(overflow.event.id);
            if (fallbackId) window.clearTimeout(fallbackId);
            ribbonTimers.current.delete(overflow.event.id);
          }
          const next = previous.map(s => {
            const exiting = overflow && s.event.id === overflow.event.id ? true : s.exiting;
            return exiting ? { ...s, exiting } : { ...s, slot: Math.min(s.slot + 1, 4) };
          });
          return [{ event, exiting: false, slot: 0 }, ...next].slice(0, 8);
        });
        if (overflowId) scheduleStreamRemoval(overflowId);
        ribbonTimestamps.current.set(event.id, Date.now());

        // 设置保底超时：如果 tool_end 一直不来，最长显示 10 秒
        const fallbackTimeout = window.setTimeout(() => {
          markExiting(event.id);
        }, 10_000);
        ribbonTimers.current.set(event.id, fallbackTimeout);
      }

      // 状态回退定时器
      const timeout = (event.event === "done" || event.event === "error" ? 5.2 : settings.bubbleDuration) * 1000;
      window.setTimeout(() => {
        setPetState(current => current === stateFromEvent(event) ? "idle" : current);
        setCurrentEvent(current => current?.id === event.id ? null : current);
      }, timeout);
    });
    const offPermissionRequest = window.companion.onPermissionRequest(request => {
      setActivePermissions(prev => [...prev, request]);
      setPetState("waiting_permission");
    });

    const offPermissionResolved = window.companion.onPermissionResolved(({ id }) => {
      setActivePermissions(prev => prev.filter(p => p.id !== id));
    });

    return () => {
      offSettings();
      offConnection();
      offEvent();
      offPermissionRequest();
      offPermissionResolved();
      // 清理所有 ribbon 定时器
      ribbonTimers.current.forEach(id => window.clearTimeout(id));
      ribbonTimers.current.clear();
      ribbonTimestamps.current.clear();
    };
  }, [settings.bubbleDuration, settings.eventHistoryLimit, settings.toolStreamMinDuration]);

  // 维护 mainSessionId：主会话退出时仅在所有会话都消失后才置 null
  // 不做自动升级（避免伴生 Clawd 无动画消失），伴生会话保持在自己的位置
  useEffect(() => {
    if (mainSessionId && !sessionsRef.current.has(mainSessionId)) {
      if (sessionsRef.current.size === 0) {
        setMainSessionId(null);
      }
    }
  }, [sessions, exitingSessions, mainSessionId]);

  // 维护伴生 Clawd 的稳定 slot 分配，避免会话退出时 index 重排导致位置/动画跳变
  useEffect(() => {
    const companionIds = sessions
      .filter(s => s.sessionId !== mainSessionId && (s.isActive || exitingSessions.has(s.sessionId)))
      .slice(0, 3)
      .map(s => s.sessionId);
    // 清理已不存在的会话的 slot
    for (const [sid] of companionSlotRef.current) {
      if (!companionIds.includes(sid)) {
        companionSlotRef.current.delete(sid);
      }
    }
    // 为新会话分配最小可用 slot
    const usedSlots = new Set(companionSlotRef.current.values());
    for (const sid of companionIds) {
      if (!companionSlotRef.current.has(sid)) {
        let slot = 0;
        while (usedSlots.has(slot)) slot++;
        companionSlotRef.current.set(sid, slot);
        usedSlots.add(slot);
      }
    }
  }, [sessions, exitingSessions, mainSessionId]);

  async function updateSettings(next: Partial<CompanionSettings>) {
    const saved = await window.companion.saveSettings(next);
    setSettings(saved);
    if (next.theme) applyTheme(next.theme);
    if (next.uiStyle) applyUiStyle(next.uiStyle);
  }

  async function respondToPermission(id: string, decision: "allow" | "deny") {
    await window.companion.respondPermission({
      id,
      decision,
      reason: decision === "allow" ? "Approved via Clawd" : "Denied via Clawd"
    });
    setActivePermissions(prev => prev.filter(p => p.id !== id));
  }

  return { settings, updateSettings, connection, events, currentEvent, petState, toolStreams, activePermissions, sessions, exitingSessions, mainSessionId, companionSlotRef, respondToPermission };
}

function PetApp() {
  const { settings, updateSettings, currentEvent, petState, toolStreams, activePermissions, sessions, exitingSessions, mainSessionId, companionSlotRef, connection, respondToPermission } = useCompanion();
  const editMode = settings.editPosition;
  const dragging = useRef<string | null>(null);
  const dragStart = useRef<{ mx: number; my: number; ox: number; oy: number }>({ mx: 0, my: 0, ox: 0, oy: 0 });
  const offRef = useRef(settings.positionOffsets ?? {});
  const [randomBubble, setRandomBubble] = useState<string | null>(null);
  const idleTimers = useRef<number[]>([]);

  // Git 操作气泡：触发时在 Clawd 头顶弹出，2.2 秒后自动消失
  const [gitToast, setGitToast] = useState<{ id: string; title: string; message: string } | null>(null);
  const gitToastTimer = useRef<number | null>(null);
  useEffect(() => {
    const off = window.companion.onEvent(event => {
      if (event.event !== "git_operation") return;
      if (gitToastTimer.current) window.clearTimeout(gitToastTimer.current);
      setGitToast({ id: event.id, title: event.title, message: event.message });
      gitToastTimer.current = window.setTimeout(() => setGitToast(null), 2200);
    });
    return () => {
      off();
      if (gitToastTimer.current) window.clearTimeout(gitToastTimer.current);
    };
  }, []);

  // 响应测试按钮
  useEffect(() => {
    const off = window.companion.onTriggerIdleBubble(() => {
      setRandomBubble("idle");
      setTimeout(() => setRandomBubble(null), 2500);
    });
    return () => off();
  }, []);

  // HTML5 Audio 播放音效
  useEffect(() => {
    const off = window.companion.onPlaySound((dataUrl) => {
      try { const a = new Audio(dataUrl); a.volume = settings.sound.volume; a.play(); } catch { /* ignore */ }
    });
    return () => off();
  }, []);

  // 同步计算有效待机气泡（渲染时直接计算，避免 useEffect 时序问题）
  const mainIdle = (settings as any).mainClawdIdleAnimation ?? "random";
  // 只检查非退出中的活跃会话，避免 exitingSessions 残留导致 hasActiveSession 误判
  const hasActiveSession = sessions.some(s => s.isActive && !exitingSessions.has(s.sessionId));
  const isToolState = petState.startsWith("tool_") || petState === "waiting_permission";
  const isTerminalState = petState === "done" || petState === "error";

  let effectiveIdleBubble: string | null = null;
  if (!isToolState && !isTerminalState && !editMode) {
    if (mainIdle !== "random" && hasActiveSession) {
      effectiveIdleBubble = mainIdle;
    } else if (settings.idleAnim?.enabled && petState === "idle") {
      effectiveIdleBubble = randomBubble;
    }
  }

  // 随机动画定时器（仅管理随机模式的定时播放）
  useEffect(() => {
    const cfg = settings.idleAnim;
    if (!cfg?.enabled || petState !== "idle" || editMode || mainIdle !== "random") {
      setRandomBubble(null);
      idleTimers.current.forEach(clearTimeout);
      idleTimers.current = [];
      return;
    }
    const pool = cfg.selectedSprites.length > 0 ? cfg.selectedSprites : ["idle"];
    function playBatch() {
      const sprite = pool[Math.floor(Math.random() * pool.length)];
      const range = cfg!.repeatMax - cfg!.repeatMin;
      const repeats = cfg!.repeatMin + (range > 0 ? Math.floor(Math.random() * (range + 1)) : 0);
      let count = 0;
      function show() {
        setRandomBubble(sprite);
        const t = window.setTimeout(() => {
          setRandomBubble(null);
          count++;
          if (count < repeats) {
            idleTimers.current = [window.setTimeout(show, 1500)];
          } else {
            scheduleNext();
          }
        }, 2500);
        idleTimers.current = [t];
      }
      show();
    }
    function scheduleNext() {
      const iMin = cfg!.intervalMin * 1000;
      const iMax = cfg!.intervalMax * 1000;
      const delay = iMin + Math.random() * (iMax - iMin);
      idleTimers.current = [window.setTimeout(playBatch, delay)];
    }
    scheduleNext();
    return () => { idleTimers.current.forEach(clearTimeout); idleTimers.current = []; };
  }, [petState, editMode, settings.idleAnim, mainIdle]);

  // 同步 effectiveIdleBubble 到设置面板
  useEffect(() => {
    void window.companion.syncIdleBubble(effectiveIdleBubble);
  }, [effectiveIdleBubble]);

  useEffect(() => {
    if (editMode) {
      void window.companion.setPetInteractive(false);
      const handle = (e: MouseEvent) => {
        if (dragging.current) return;
        const target = e.target as HTMLElement;
        void window.companion.setPetInteractive(!!target.closest('.edit-zone, .zone-resize, .edge-handle, .edit-zone-companion'));
      };
      window.addEventListener('mousemove', handle);
      return () => {
        window.removeEventListener('mousemove', handle);
        void window.companion.setPetInteractive(false);
      };
    }
    if (settings.clickThrough) {
      void window.companion.setPetInteractive(false);
      const handle = (e: MouseEvent) => {
        if (dragging.current) return;
        const target = e.target as HTMLElement;
        void window.companion.setPetInteractive(!!target.closest('.perm-card, .pomodoro-widget'));
      };
      window.addEventListener('mousemove', handle);
      return () => {
        window.removeEventListener('mousemove', handle);
        void window.companion.setPetInteractive(false);
      };
    }
    void window.companion.setPetInteractive(false);
    const handle = (e: MouseEvent) => {
      if (dragging.current) return;
      const target = e.target as HTMLElement;
      void window.companion.setPetInteractive(!!target.closest('.clawd, .bubble-wrapper, .tool-streams, .permission-card, .pomodoro-widget'));
    };
    window.addEventListener('mousemove', handle);
    return () => {
      window.removeEventListener('mousemove', handle);
      void window.companion.setPetInteractive(false);
    };
  }, [editMode, settings.clickThrough, activePermissions]);

  const offsetsRef = useRef(settings.positionOffsets ?? {});
  const scaleRef = useRef({ clawd: settings.clawdScale, bubble: settings.thoughtScale, ribbon: settings.bubbleScale, permission: settings.permissionScale });

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const key = dragging.current;
      if (!key) return;
      const { mx, my, ox, oy } = dragStart.current;
      if (key.startsWith("resize-")) {
        const zoneKey = key.slice(7);
        if (zoneKey === "clawd") {
          updateSettings({ clawdScale: Math.max(0.6, Math.min(2, ox + (e.clientX - mx) / 226)) });
        } else if (zoneKey === "bubble") {
          const ns = Math.max(0.6, Math.min(2, oy + (e.clientY - my) / 106));
          updateSettings({ thoughtScale: ns, cardScale: ns });
        } else if (zoneKey === "ribbon") {
          updateSettings({ bubbleScale: Math.max(0.6, Math.min(2, ox + (e.clientX - mx) / 144)) });
        } else if (zoneKey === "permission") {
          updateSettings({ permissionScale: Math.max(0.4, Math.min(2, ox + (e.clientX - mx) / 240)) });
        } else if (zoneKey.startsWith("edge")) {
          const ws = ox + (e.clientX - mx + e.clientY - my) / 800;
          updateSettings({ viewScale: Math.max(0.7, Math.min(2.5, ws)) });
        }
      } else if (key === "view" || key === "pet") {
        const nx = ox + e.clientX - mx;
        const ny = oy + e.clientY - my;
        const p = offsetsRef.current;
        updateSettings({ positionOffsets: { ...p, view: { x: nx, y: ny } } });
      } else {
        const nx = ox + e.clientX - mx;
        const ny = oy + e.clientY - my;
        const p = offsetsRef.current;
        updateSettings({ positionOffsets: { ...p, [key]: { x: nx, y: ny } } });
      }
    };
    const up = () => { dragging.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  useEffect(() => { offsetsRef.current = settings.positionOffsets ?? {}; }, [settings.positionOffsets]);
  useEffect(() => { scaleRef.current = { clawd: settings.clawdScale, bubble: settings.thoughtScale, ribbon: settings.bubbleScale, permission: settings.permissionScale }; }, [settings.clawdScale, settings.thoughtScale, settings.bubbleScale, settings.permissionScale]);

  const editPreviewEvent = useMemo(
    () => makeEvent("tool_start", "manual", "编辑模式预览", "这是桌宠实际显示的卡片 / 气泡位置。", "Edit"),
    []
  );
  const editPreviewStreams = useMemo(
    () => [{ event: makeEvent("tool_start", "manual", "工具指示器预览", "Edit 工具指示器位置预览。", "Edit"), exiting: false, slot: 0 }],
    []
  );
  const editPreviewPermission = useMemo(
    () => ({ id: "preview", toolName: "Bash" as ToolName, toolDetail: "预览权限卡片位置", timestamp: Date.now(), rawPayload: {} }),
    []
  );

  if (!settings.petEnabled) return <main className="pet-stage pet-disabled" />;

  const offsets = settings.positionOffsets ?? {};
  const viewOff = offsets.view ?? { x: 0, y: 0 };

  function begin(k: string, e: React.MouseEvent) {
    if (!editMode) return;
    e.stopPropagation();
    dragging.current = k;
    if (k === "view") {
      dragStart.current = { mx: e.clientX, my: e.clientY, ox: viewOff.x, oy: viewOff.y };
    } else {
      dragStart.current = { mx: e.clientX, my: e.clientY, ox: offsets[k as keyof typeof offsets]?.x ?? 0, oy: offsets[k as keyof typeof offsets]?.y ?? 0 };
    }
  }

  function beginResize(k: string, e: React.MouseEvent) {
    if (!editMode) return;
    e.stopPropagation();
    dragging.current = `resize-${k}`;
    if (k.startsWith("edge")) {
      const vs = settings.viewScale ?? settings.petScale;
      dragStart.current = { mx: e.clientX, my: e.clientY, ox: vs, oy: vs };
    } else {
      const s = scaleRef.current;
      dragStart.current = { mx: e.clientX, my: e.clientY, ox: s[k as keyof typeof s] ?? 1, oy: s[k as keyof typeof s] ?? 1 };
    }
  }

  function beginNormalDrag(e: React.MouseEvent) {
    if (editMode || settings.clickThrough) return;
    dragging.current = "pet";
    dragStart.current = { mx: e.clientX, my: e.clientY, ox: viewOff.x, oy: viewOff.y };
  }

  if (editMode) {
    const previewEvent = currentEvent ?? editPreviewEvent;
    const previewState = currentEvent ? petState : stateFromEvent(previewEvent);
    const previewStreams = toolStreams.length > 0 ? toolStreams : editPreviewStreams;
    const bubbleMode = getFeedbackMode(previewEvent);
    const cw = Math.round(226 * settings.clawdScale);
    const ch = Math.round(238 * settings.clawdScale);
    const bw = Math.round((bubbleMode === "thought" ? 172 : 234) * (bubbleMode === "thought" ? settings.thoughtScale : settings.cardScale));
    const bh = Math.round((bubbleMode === "thought" ? 82 : 124) * (bubbleMode === "thought" ? settings.thoughtScale : settings.cardScale));
    const bx = bubbleMode === "thought" ? Math.round(226 - 6 - bw) : -4;
    const by = bubbleMode === "thought" ? 84 : 10;
    const rw = Math.round(144 * settings.bubbleScale);
    const rh = Math.round(144 * settings.bubbleScale);
    const pw = Math.round(240 * settings.permissionScale);
    const ph = Math.round(140 * settings.permissionScale);

    return (
      <main className="pet-stage edit-mode"
        onMouseDown={e => { if (e.target === e.currentTarget) begin("view", e); }}>
        <span className="edge-handle edge-n" onMouseDown={e => beginResize("edgeN", e)} />
        <span className="edge-handle edge-s" onMouseDown={e => beginResize("edgeS", e)} />
        <span className="edge-handle edge-e" onMouseDown={e => beginResize("edgeE", e)} />
        <span className="edge-handle edge-w" onMouseDown={e => beginResize("edgeW", e)} />
        <span className="edge-handle edge-ne" onMouseDown={e => beginResize("edgeNE", e)} />
        <span className="edge-handle edge-nw" onMouseDown={e => beginResize("edgeNW", e)} />
        <span className="edge-handle edge-se" onMouseDown={e => beginResize("edgeSE", e)} />
        <span className="edge-handle edge-sw" onMouseDown={e => beginResize("edgeSW", e)} />
        <section className="pet-anchor" style={{ transform: `translateX(-50%) scale(${settings.petScale}) translate(${viewOff.x}px, ${viewOff.y}px)` }}>
          <div className="edit-live-layer">
            {settings.showBubbles && getFeedbackMode(previewEvent) !== "ribbon" ? (
              <div className="bubble-wrapper" style={{ transform: `translate(${offsets.bubble?.x ?? 0}px, ${offsets.bubble?.y ?? 0}px)` }}>
                <Bubble event={previewEvent} state={stateFromEvent(previewEvent)} settings={settings} />
              </div>
            ) : null}
            <div className={`clawd clawd-${previewState}`} style={{ transform: `translate(${offsets.clawd?.x ?? 0}px, ${offsets.clawd?.y ?? 0}px) scale(${settings.clawdScale})`, opacity: settings.clawdOpacity }}>
              <ClawdSprite state={previewState} idleBubble={effectiveIdleBubble} eventType={previewEvent.event} tool={previewEvent.tool} stateAnimations={settings.stateAnimations} />
              {settings.showStatusProp && previewState !== "idle" ? <StateProp state={previewState} /> : null}
            </div>
            {settings.showBubbles ? (
              <ToolStreams streams={previewStreams} offset={offsets.ribbon} />
            ) : null}
            {settings.showBubbles ? (
              <div className="permission-card-wrapper" style={{ transform: `translate(${offsets.permission?.x ?? 0}px, ${offsets.permission?.y ?? 0}px)` }}>
                <PermissionCard
                  permission={editPreviewPermission}
                  queueCount={1}
                  onAllow={() => {}}
                  onDeny={() => {}}
                  settings={settings}
                />
              </div>
            ) : null}
            {settings.pomodoroEnabled ? <PomodoroWidget settings={settings} preview /> : null}
          </div>
          {settings.pomodoroEnabled ? (
            <div className="edit-zone edit-zone-pomodoro"
              style={{
                transform: `translate(${offsets.pomodoro?.x ?? 0}px, ${offsets.pomodoro?.y ?? 0}px)`,
                width: 172,
                height: 78
              }}
              onMouseDown={e => begin("pomodoro", e)}>
              <span className="edit-zone-label">番茄钟</span>
            </div>
          ) : null}
          <div className="edit-zone edit-zone-clawd"
            style={{
              left: Math.round((226 - cw) / 2),
              transform: `translate(${offsets.clawd?.x ?? 0}px, ${offsets.clawd?.y ?? 0}px)`,
              width: cw, height: ch
            }}
            onMouseDown={e => begin("clawd", e)}>
            <span className="edit-zone-label">Clawd</span>
            <span className="zone-resize" onMouseDown={e => beginResize("clawd", e)} />
          </div>
          <div className="edit-zone edit-zone-bubble"
            style={{
              left: bx,
              top: by,
              right: "auto",
              bottom: "auto",
              transform: `translate(${offsets.bubble?.x ?? 0}px, ${offsets.bubble?.y ?? 0}px)`,
              width: bw, height: bh
            }}
            onMouseDown={e => begin("bubble", e)}>
            <span className="edit-zone-label">气泡 / 卡片</span>
            <span className="zone-resize" onMouseDown={e => beginResize("bubble", e)} />
          </div>
          <div className="edit-zone edit-zone-ribbon"
            style={{
              transform: `translate(${offsets.ribbon?.x ?? 0}px, ${offsets.ribbon?.y ?? 0}px)`,
              width: rw, height: rh
            }}
            onMouseDown={e => begin("ribbon", e)}>
            <span className="edit-zone-label">工具条</span>
            <span className="zone-resize" onMouseDown={e => beginResize("ribbon", e)} />
          </div>
          <div className="edit-zone edit-zone-permission"
            style={{
              left: 10,
              top: 10,
              transform: `translate(${offsets.permission?.x ?? 0}px, ${offsets.permission?.y ?? 0}px)`,
              width: pw, height: ph
            }}
            onMouseDown={e => begin("permission", e)}>
            <span className="edit-zone-label">权限卡片</span>
            <span className="zone-resize" onMouseDown={e => beginResize("permission", e)} />
          </div>
          <div className="edit-zone edit-zone-git-toast"
            style={{
              top: 8,
              left: "50%",
              transform: `translateX(-50%) translate(${offsets.gitToast?.x ?? 0}px, ${offsets.gitToast?.y ?? 0}px)`,
              width: 240,
              height: 36
            }}
            onMouseDown={e => begin("gitToast", e)}>
            <span className="edit-zone-label">Git 胶囊</span>
            <span className="zone-resize" onMouseDown={e => beginResize("gitToast", e)} />
          </div>
          {settings.multiSessionEnabled && [0, 1, 2].map(i => {
            const cScale = settings.companionScale ?? 0.6;
            const off = (offsets as any)[`companion${i}`] ?? { x: 80 + i * 100, y: -120 - i * 80 };
            return (
              <div key={i} className="edit-zone edit-zone-companion"
                style={{
                  left: 0,
                  bottom: 0,
                  transform: `translate(${off.x}px, ${off.y}px) scale(${cScale})`,
                  width: 168,
                  height: 160
                }}
                onMouseDown={e => begin(`companion${i}`, e)}>
                <span className="edit-zone-label">小 Clawd {i + 1}</span>
              </div>
            );
          })}
        </section>
      </main>
    );
  }

  return (
    <main className={`pet-stage ${settings.clickThrough ? 'pet-clickthrough' : ''}`}>
      <section className="pet-anchor" style={{ transform: `translateX(-50%) scale(${settings.petScale}) translate(${viewOff.x}px, ${viewOff.y}px)`, opacity: settings.petOpacity }} onMouseDown={beginNormalDrag}>
      {gitToast && (
        <div className="git-toast" key={gitToast.id} style={{ top: 8, left: "50%", transform: `translateX(-50%) translate(${(settings.positionOffsets?.gitToast?.x ?? 0)}px, ${(settings.positionOffsets?.gitToast?.y ?? 0)}px)` }}>
          <span className="git-toast-title">{gitToast.title}</span>
          <span className="git-toast-message">{gitToast.message}</span>
        </div>
      )}
        {activePermissions.length > 0 ? (
          <div className="permission-card-wrapper" style={{ transform: `translate(${offsets.permission?.x ?? 0}px, ${offsets.permission?.y ?? 0}px)` }}>
            <PermissionCard
              permission={activePermissions[0]}
              queueCount={activePermissions.length}
              onAllow={() => respondToPermission(activePermissions[0].id, "allow")}
              onDeny={() => respondToPermission(activePermissions[0].id, "deny")}
              settings={settings}
            />
          </div>
        ) : settings.showBubbles && currentEvent && getFeedbackMode(currentEvent) !== "ribbon" ? (
          <div className="bubble-wrapper" style={{ transform: `translate(${offsets.bubble?.x ?? 0}px, ${offsets.bubble?.y ?? 0}px)` }}>
            <Bubble event={currentEvent} state={stateFromEvent(currentEvent)} settings={settings} />
          </div>
        ) : null}
        <div className={`clawd clawd-${petState}`} style={{ transform: `translate(${offsets.clawd?.x ?? 0}px, ${offsets.clawd?.y ?? 0}px) scale(${settings.clawdScale})`, opacity: settings.clawdOpacity }}>
          <ClawdSprite state={petState} idleBubble={effectiveIdleBubble} eventType={currentEvent?.event} tool={currentEvent?.tool} stateAnimations={settings.stateAnimations} />
          {settings.showStatusProp && petState !== "idle" ? <StateProp state={petState} /> : null}
        </div>
        {settings.showBubbles && toolStreams.length > 0 ? (
          <ToolStreams streams={toolStreams} offset={offsets.ribbon} />
        ) : null}

        {settings.pomodoroEnabled ? <PomodoroWidget settings={settings} /> : null}

        {settings.multiSessionEnabled && mainSessionId && sessions
            .filter(s => s.sessionId !== mainSessionId && (s.isActive || exitingSessions.has(s.sessionId)))
            .slice(0, 3).map((session) => (
            <CompanionClawd
              key={session.sessionId}
              session={session}
              index={companionSlotRef.current.get(session.sessionId) ?? 0}
              settings={settings}
              exiting={exitingSessions.has(session.sessionId)}
              mainClawdOffset={offsets.clawd ?? { x: 0, y: 0 }}
            />
          ))}
      </section>
    </main>
  );
}

function PomodoroWidget({ settings, preview = false }: { settings: CompanionSettings; preview?: boolean }) {
  const { t } = useI18n();
  const workSeconds = Math.max(1, Math.round((settings.pomodoroWorkMinutes ?? 25) * 60));
  const breakSeconds = Math.max(1, Math.round((settings.pomodoroBreakMinutes ?? 5) * 60));
  const [mode, setMode] = useState<"work" | "break">("work");
  const [remaining, setRemaining] = useState(workSeconds);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (mode === "work") setRemaining(workSeconds);
    else setRemaining(breakSeconds);
  }, [workSeconds, breakSeconds, mode]);

  useEffect(() => {
    if (!running || preview) return;
    const timer = window.setInterval(() => {
      setRemaining(value => {
        if (value > 1) return value - 1;
        const nextMode = mode === "work" ? "break" : "work";
        setMode(nextMode);
        return nextMode === "work" ? workSeconds : breakSeconds;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running, preview, mode, workSeconds, breakSeconds]);

  const total = mode === "work" ? workSeconds : breakSeconds;
  const progress = Math.max(0, Math.min(1, 1 - remaining / total));
  const minutes = Math.floor(remaining / 60).toString().padStart(2, "0");
  const seconds = Math.floor(remaining % 60).toString().padStart(2, "0");
  const offsets = settings.positionOffsets ?? {};

  return (
    <section className={`pomodoro-widget ${mode} ${preview ? "preview" : ""}`} style={{ transform: `translate(${offsets.pomodoro?.x ?? 0}px, ${offsets.pomodoro?.y ?? 0}px)` }} onMouseDown={e => e.stopPropagation()}>
      <div className="pomodoro-ring" style={{ background: `conic-gradient(var(--coral) ${progress * 360}deg, rgba(255,255,255,.42) 0deg)` }}>
        <span>{mode === "work" ? "25" : "5"}</span>
      </div>
      <div className="pomodoro-main">
        <strong>{minutes}:{seconds}</strong>
        <small>{mode === "work" ? t("pomodoro.focus", "专注中") : t("pomodoro.break", "休息中")}</small>
      </div>
      {!preview ? (
        <div className="pomodoro-actions">
          <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setRunning(value => !value); }}>{running ? t("common.pause", "暂停") : t("common.start", "开始")}</button>
          <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setRunning(false); setMode("work"); setRemaining(workSeconds); }}>{t("common.reset", "重置")}</button>
        </div>
      ) : null}
    </section>
  );
}

function Bubble({ event, state, settings }: { event: CompanionEvent; state: PetState; settings: CompanionSettings }) {
  const { t } = useI18n();
  const toolLabel = event.tool && event.tool !== "Unknown" ? event.tool : event.source === "claude-code" ? "Claude Code" : "Manual";
  const feedbackMode = getFeedbackMode(event);
  if (feedbackMode === "thought") {
    return (
      <div className="thought-wrapper" style={{ transform: `scale(${settings.thoughtScale})`, opacity: settings.thoughtOpacity }}>
        <section className={`thought-bubble thought-${state}`}>
          <i />
          <span>{toolLabel}</span>
          <strong>{event.detail ?? event.title}</strong>
        </section>
      </div>
    );
  }

  return (
    <div className="bubble-wrapper" style={{ transform: `scale(${settings.cardScale})`, opacity: settings.cardOpacity }}>
      <section className={`bubble bubble-${state}`}>
        <div className="bubble-status-light" />
        <div className="bubble-content">
        <header className="bubble-header">
          <span className="bubble-state">{t(`pet.${state}`, stateCopy[state].label)}</span>
          <span className="bubble-tool">{toolLabel}</span>
        </header>
        <strong>{event.title}</strong>
        <p>{event.message}</p>
        {event.detail ? <code className="bubble-detail">{event.detail}</code> : null}
        <footer className="bubble-footer">
          <span>{t(`pet.${state}Line`, stateCopy[state].line)}</span>
          <time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
        </footer>
      </div>
    </section>
    </div>
  );
}

function PermissionCard({ permission, queueCount, onAllow, onDeny, settings }: {
  permission: PermissionRequest;
  queueCount: number;
  onAllow: () => void;
  onDeny: () => void;
  settings: CompanionSettings;
}) {
  const { t } = useI18n();
  const color = toolColorMap[permission.toolName] ?? "steel";
  const detail = permission.toolDetail ?? permission.toolName;

  return (
    <div className="permission-card-inner" style={{ transform: `scale(${settings.permissionScale})`, opacity: settings.permissionOpacity }}>
      <section className={`perm-card`}>
        <div className="perm-card-scanline" />
        <div className="perm-card-topbar">
          <span className="perm-card-dot" />
          <span className="perm-card-label">ACCESS REQUEST</span>
          <span className="perm-card-dot" />
        </div>
        <div className="perm-card-main">
          <div className="perm-card-tool-line">
            <span className="perm-card-prompt">&gt;</span>
            <span className={`perm-card-toolname color-${color}`}>{permission.toolName}</span>
          </div>
          <code className="perm-card-detail">{detail}</code>
        </div>
        <div className="perm-card-actions">
          <button className="perm-btn perm-btn-allow" onClick={onAllow}>
            <span className="perm-btn-key">Y</span> {t("pet.permissionAllow", "允许")}
          </button>
          <button className="perm-btn perm-btn-deny" onClick={onDeny}>
            <span className="perm-btn-key">N</span> {t("pet.permissionDeny", "拒绝")}
          </button>
        </div>
        {queueCount > 1 && (
          <div className="perm-card-queue">+{queueCount - 1} pending</div>
        )}
      </section>
    </div>
  );
}

const toolColorMap: Record<string, string> = {
  Read: "mint",
  Edit: "coral",
  Write: "coral",
  Bash: "ink",
  Grep: "blue",
  Glob: "blue",
  WebFetch: "blue",
  WebSearch: "blue",
  Notebook: "mint",
  Agent: "steel",
  Skill: "honey",
  Task: "steel",
  AskUserQuestion: "honey",
  MCP: "purple",
  Unknown: "steel"
};

const toolIconMap: Record<string, string> = {
  Read: "R",
  Edit: "E",
  Write: "W",
  Bash: "B",
  Grep: "G",
  Glob: "G",
  WebFetch: "W",
  WebSearch: "S",
  Notebook: "N",
  Agent: "A",
  Skill: "K",
  Task: "T",
  AskUserQuestion: "?",
  MCP: "M",
  Unknown: "?"
};

function ToolStreams({ streams, offset }: { streams: ToolStream[]; offset?: { x: number; y: number } }) {
  const visible = streams.filter((stream, index) => stream.exiting || streams.slice(0, index).filter(s => !s.exiting).length < 5);

  return (
    <div className="tool-streams" style={{ transform: `translate(${offset?.x ?? 0}px, ${offset?.y ?? 0}px)` }}>
      {visible.map((stream) => {
        const tool = stream.event.tool ?? "Unknown";
        const color = toolColorMap[tool] ?? "steel";
        const detail = stream.event.detail ?? stream.event.title;
        const slot = stream.exiting ? (stream.exitSlot ?? stream.slot) : stream.slot;
        return (
          <div
            key={stream.event.id}
            className={`tool-stream color-${color} ${stream.exiting ? "exiting" : "active"}`}
            style={{ top: 34 + slot * 18 }}
          >
            <span className="stream-wake" />
            <span className="stream-core" />
            <span className="stream-tool-name">{tool}</span>
            <span className="stream-holo" aria-hidden="true">
              <span className="stream-detail">{detail}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Clawd({ state, settings, forceIdleBubble }: { state: PetState; settings: CompanionSettings; forceIdleBubble?: string | null }) {
  const [syncedSprite, setSyncedSprite] = useState<string | null>(null);

  useEffect(() => {
    const off = window.companion.onIdleBubbleSync(setSyncedSprite);
    return () => off();
  }, []);

  const effectiveBubble = forceIdleBubble ?? syncedSprite;

  return (
    <section className={`clawd clawd-${state}`} style={{ transform: `scale(${settings.clawdScale})`, opacity: settings.clawdOpacity }} aria-label={`Clawd ${stateCopy[state].label}`}>
      <ClawdSprite state={state} idleBubble={effectiveBubble} stateAnimations={settings.stateAnimations} />
      {settings.showStatusProp && state !== "idle" ? <StateProp state={state} /> : null}
    </section>
  );
}

const idleBubbleGifClass: Record<string, string> = {
  idle: "idle_bubble",
  thinking: "thinking_speech",
  tool_read: "headset_focus",
  tool_edit: "working_hardhat",
  waiting_permission: "permission_prompt",
  done: "celebrate_bunny",
  error: "error_dead",
  skill: "idea_bulb",
  task: "idea_bulb",
  agent: "welding_work"
};

const eventSpriteOverride: Partial<Record<CompanionEvent["event"], { sprite: string; gif: string }>> = {
  session_start: { sprite: "tool_read", gif: "headset_focus" },
  prompt_submit: { sprite: "done", gif: "celebrate_bunny" }
};

// 工具到 GIF 动画的映射
const toolGifMap: Record<string, string> = {
  Skill: "idea_bulb",
  Task: "idea_bulb",
  Agent: "welding_work"
};

function ClawdSprite({ state, idleBubble, eventType, tool, stateAnimations }: { state: PetState; idleBubble?: string | null; eventType?: CompanionEvent["event"]; tool?: string; stateAnimations?: Record<string, string> }) {
  if (idleBubble) {
    const gifClass = idleBubbleGifClass[idleBubble] ?? idleBubble;
    return (
      <>
        <div className="clawd-glow" />
        <span className={`clawd-sprite clawd-sprite-${idleBubble} clawd-gif-${gifClass}`} aria-hidden="true" />
        <div className="shadow" />
      </>
    );
  }
  if (state === "idle") {
    return (
      <>
        <div className="clawd-glow" />
        <img className="clawd-image" src={clawdImage} alt="" draggable={false} />
        <div className="shadow" />
      </>
    );
  }
  // 优先级：用户自定义 > 事件覆盖 > 默认映射
  const userSprite = stateAnimations?.[state];
  if (userSprite) {
    const gifClass = idleBubbleGifClass[userSprite] ?? userSprite;
    return <span className={`clawd-sprite clawd-sprite-${userSprite} clawd-gif-${gifClass}`} aria-hidden="true" />;
  }
  const override = eventType ? eventSpriteOverride[eventType] : undefined;
  if (override) {
    return <span className={`clawd-sprite clawd-sprite-${override.sprite} clawd-gif-${override.gif}`} aria-hidden="true" />;
  }
  // 检查工具特定的 GIF 映射
  if (tool && toolGifMap[tool]) {
    const gifClass = toolGifMap[tool];
    const spriteState = state === "tool_mcp" ? "thinking" : state === "tool_read" ? "thinking" : state === "tool_bash" ? "tool_read" : state;
    return <span className={`clawd-sprite clawd-sprite-${spriteState} clawd-gif-${gifClass}`} aria-hidden="true" />;
  }
  const spriteState = state === "tool_mcp" ? "thinking" : state === "tool_read" ? "thinking" : state === "tool_bash" ? "tool_read" : state;
  return <span className={`clawd-sprite clawd-sprite-${spriteState} clawd-gif-${clawdGifName[state]}`} aria-hidden="true" />;
}

function CompanionClawd({ session, index, settings, exiting, mainClawdOffset }: { session: CompanionSession; index: number; settings: CompanionSettings; exiting?: boolean; mainClawdOffset: { x: number; y: number } }) {
  const scale = settings.companionScale ?? 0.6;
  const offsets = settings.positionOffsets ?? {};
  const off = (offsets as any)[`companion${index}`] ?? { x: 80 + index * 100, y: -120 - index * 80 };
  const baseX = off.x;
  const baseY = off.y;
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // 工作时自定义待机动画逻辑
  const isIdleInSession = session.state === "thinking" || session.state === "idle";
  const configuredIdleAnim = settings.companionIdleAnimations?.[index] ?? "thinking";

  // 处理 "random"：从动画池中随机选取精灵，循环播放
  const [randomSprite, setRandomSprite] = useState<string | null>(null);
  const randomTimerRef = useRef<number>(0);

  useEffect(() => {
    if (configuredIdleAnim !== "random" || !isIdleInSession) {
      setRandomSprite(null);
      clearTimeout(randomTimerRef.current);
      return;
    }
    const pool = settings.idleAnim?.selectedSprites?.length ? settings.idleAnim.selectedSprites : ["idle"];
    let cancelled = false;
    function next() {
      if (cancelled) return;
      const sprite = pool[Math.floor(Math.random() * pool.length)];
      setRandomSprite(sprite);
      const min = (settings.idleAnim?.intervalMin ?? 15) * 1000;
      const max = (settings.idleAnim?.intervalMax ?? 40) * 1000;
      randomTimerRef.current = window.setTimeout(next, min + Math.random() * (max - min));
    }
    next();
    return () => { cancelled = true; clearTimeout(randomTimerRef.current); };
  }, [configuredIdleAnim, isIdleInSession, settings.idleAnim]);

  // 确定最终显示的 idleBubble：优先走 idleBubble 路径（与主 Clawd 一致，ClawdSprite 通过 idleBubbleGifClass 正确解析）
  let effectiveIdleBubble: string | null = null;
  if (isIdleInSession && configuredIdleAnim) {
    if (configuredIdleAnim === "random") {
      effectiveIdleBubble = randomSprite; // null 期间 fallback 到 session.state
    } else {
      effectiveIdleBubble = configuredIdleAnim;
    }
  }

  return (
    <div
      className="companion-clawd"
      style={{
        transform: `translate(${baseX}px, ${baseY}px) scale(${scale})`,
        opacity: exiting ? 0 : mounted ? 1 : 0,
        transition: "opacity 0.3s ease-out"
      }}
    >
      <ClawdSprite state={session.state} idleBubble={effectiveIdleBubble} tool={session.lastEvent?.tool} stateAnimations={settings.stateAnimations} />
    </div>
  );
}

function StateProp({ state }: { state: PetState }) {
  if (state === "tool_bash") return <Terminal className="state-prop terminal-prop" size={30} />;
  if (state === "tool_edit") return <Code2 className="state-prop edit-prop" size={30} />;
  if (state === "tool_read") return <FileText className="state-prop read-prop" size={30} />;
  if (state === "tool_search") return <Search className="state-prop search-prop" size={30} />;
  if (state === "tool_mcp") return <PlugZap className="state-prop mcp-prop" size={30} />;
  if (state === "waiting_permission") return <Bell className="state-prop bell-prop" size={30} />;
  if (state === "done") return <Check className="state-prop check-prop" size={30} />;
  if (state === "error") return <X className="state-prop error-prop" size={30} />;
  return null;
}

function SettingsApp() {
  const { t, setLocale, locale } = useI18n();
  const { settings, updateSettings, connection, events, petState, toolStreams } = useCompanion();
  const [copied, setCopied] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState("general");
  const [now, setNow] = useState(Date.now());
  const [appVersion, setAppVersion] = useState("...");
  const sectionContentRef = useRef<HTMLDivElement | null>(null);

  // Git 胶囊：在设置窗口也渲染一份（pet 窗口可能被遮挡）
  const [gitToast, setGitToast] = useState<{ id: string; title: string; message: string } | null>(null);
  const gitToastTimer = useRef<number | null>(null);
  useEffect(() => {
    const off = window.companion.onEvent(event => {
      if (event.event !== "git_operation") return;
      if (gitToastTimer.current) window.clearTimeout(gitToastTimer.current);
      setGitToast({ id: event.id, title: event.title, message: event.message });
      gitToastTimer.current = window.setTimeout(() => setGitToast(null), 2200);
    });
    return () => {
      off();
      if (gitToastTimer.current) window.clearTimeout(gitToastTimer.current);
    };
  }, []);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    checking: false,
    available: false,
    upToDate: false,
    downloaded: false,
    downloading: false
  });
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [previewIdleBubble, setPreviewIdleBubble] = useState<string | null>(null);
  const [persistedStats, setPersistedStats] = useState<any>(null);
  const [onboardingDone, setOnboardingDone] = useState(() => {
    try { return localStorage.getItem("clawd-onboarding-done") === "1"; } catch { return true; }
  });
  const [onboardingStep, setOnboardingStep] = useState(0);
  const formatText = (template: string, values: Record<string, string | number>) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);
  const sampleEvents = useMemo<CompanionEvent[]>(() => [
    makeEvent("session_start", "manual", t("data.sampleSessionStart", "Claude Code 会话开始"), t("data.sampleSessionStartMsg", "Clawd 已经进入陪跑状态。")),
    makeEvent("prompt_submit", "manual", t("data.samplePrompt", "收到新任务"), t("data.samplePromptMsg", "正在分析你的输入。")),
    makeEvent("tool_start", "manual", t("data.sampleRead", "正在读取文件"), t("data.sampleReadMsg", "Read 工具已开始。"), "Read"),
    makeEvent("tool_start", "manual", t("data.sampleEdit", "正在编辑代码"), t("data.sampleEditMsg", "Edit 工具已开始。"), "Edit"),
    makeEvent("tool_start", "manual", t("data.sampleBash", "正在跑命令"), t("data.sampleBashMsg", "Bash 工具已开始。"), "Bash"),
    makeEvent("tool_start", "manual", t("data.sampleSearch", "正在搜索"), t("data.sampleSearchMsg", "Grep/Glob 正在检索。"), "Grep"),
    makeEvent("permission_wait", "manual", t("data.samplePermission", "需要确认"), t("data.samplePermissionMsg", "Claude Code 正在等待你的许可。")),
    makeEvent("done", "manual", t("data.sampleDone", "处理完成"), t("data.sampleDoneMsg", "这一轮已经结束。")),
    makeEvent("error", "manual", t("data.sampleError", "执行失败"), t("data.sampleErrorMsg", "有一个工具调用没有成功。")),
    makeEvent("git_operation", "manual", "✓ commit", t("data.sampleCommitMsg", "feat: 添加新功能"), undefined),
    makeEvent("git_operation", "manual", "↔ checkout", t("data.sampleCheckoutMsg", "已切换到 main"), undefined),
    makeEvent("git_operation", "manual", "✓ merge", "Merge branch 'feature'", undefined)
  ], [t]);
  const hookCommand = "node D:/build/GitLocal/Clawd-Companion/dist/hook-forwarder/index.js";
  const hookConfigPath = "C:/Users/Doulor/.claude/settings.json";
  const hookSnippet = useMemo(() => buildHookSnippet(hookCommand), [hookCommand]);

  useEffect(() => {
    window.companion.getAppVersion().then(setAppVersion);
    window.companion.getUpdateStatus().then(setUpdateStatus);
    window.companion.getStats().then(setPersistedStats);
    const offUpdate = window.companion.onUpdateStatus(setUpdateStatus);
    const offIdle = window.companion.onTriggerIdleBubble(() => {
      setPreviewIdleBubble("idle");
      setTimeout(() => setPreviewIdleBubble(null), 2500);
    });
    const offPlaySound = window.companion.onPlaySound((dataUrl) => {
      try { new Audio(dataUrl).play(); } catch { /* ignore */ }
    });
    // 每 10 秒刷新统计
    const statsInterval = window.setInterval(() => window.companion.getStats().then(setPersistedStats), 10_000);
    return () => { offUpdate(); offIdle(); offPlaySound(); window.clearInterval(statsInterval); };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  async function test(event: CompanionEvent) {
    await window.companion.sendTestEvent({ ...event, id: crypto.randomUUID(), timestamp: Date.now() });
  }

  function jumpTo(section: string) {
    if (section === activeSection) return;
    const resetSectionScroll = () => {
      sectionContentRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
      requestAnimationFrame(() => sectionContentRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" }));
    };

    if (document.startViewTransition) {
      try {
        document.startViewTransition(() => {
          flushSync(() => setActiveSection(section));
          resetSectionScroll();
        });
        return;
      } catch {
        setActiveSection(section);
        resetSectionScroll();
        return;
      }
    }
    setActiveSection(section);
    resetSectionScroll();
  }

  useEffect(() => {
    return window.companion.onOpenSection(section => jumpTo(section));
  }, [activeSection]);

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    window.setTimeout(() => setCopied(current => current === key ? null : current), 1600);
  }

  async function handleCheckUpdate() {
    setCheckingUpdate(true);
    setUpdateStatus(prev => ({ ...prev, error: undefined }));
    try {
      const result = await Promise.race([
        window.companion.checkForUpdates(),
        new Promise<{ ok: boolean; error?: string }>(resolve =>
          setTimeout(() => resolve({ ok: false, error: t("update.timeout", "检查超时，请检查网络连接后重试。") }), 15_000)
        )
      ]);
      if (!result.ok) {
        setUpdateStatus(prev => ({ ...prev, error: result.error }));
      }
    } catch {
      setUpdateStatus(prev => ({ ...prev, error: t("update.failed", "检查更新失败，请稍后重试。") }));
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleInstallClick() {
    setInstalling(true);
    try {
      const result = await window.companion.installUpdate();
      if (!result.ok) {
        setUpdateStatus(prev => ({ ...prev, error: result.error ?? t("update.installFailed", "安装启动失败") }));
      }
    } catch {
      // IPC 断开（quitAndInstall 触发退出）会到这里，属于正常情况
    } finally {
      setInstalling(false);
    }
  }

  return (
    <main className="settings-shell">
      {gitToast && (
        <div className="git-toast" key={gitToast.id} style={{ left: "50%", top: 64, transform: "translateX(-50%)" }}>
          <span className="git-toast-title">{gitToast.title}</span>
          <span className="git-toast-message">{gitToast.message}</span>
        </div>
      )}
      <section className="window-bar">
        <div className="window-title">
          <Sparkles size={16} />Clawd Companion
          {(updateStatus.available || updateStatus.downloading || updateStatus.downloaded) && (
            <button className="update-hint-btn" onClick={() => {
              const content = document.querySelector('.section-content');
              if (content) {
                content.scrollTo({ top: content.scrollHeight, behavior: 'smooth' });
              }
            }}>
              {t("main.newVersion", "发现新版本")}
            </button>
          )}
        </div>
        <div className="window-actions">
          <button title={t("main.minimize", "最小化")} onClick={() => window.companion.minimizeSettings()}>-</button>
          <button title={t("main.maximize", "最大化/还原")} onClick={() => window.companion.toggleMaximizeSettings()}>□</button>
          <button className="close" title={t("main.close", "关闭配置")} onClick={() => window.companion.closeSettings()}>×</button>
        </div>
      </section>
      <nav className="tab-bar">
        <div className="tab-mark"><Sparkles size={18} /></div>
        {[
          { id: "general", icon: <Gauge size={16} />, label: t("settings.tabs.general", "总览") },
          { id: "connect", icon: <PlugZap size={16} />, label: t("settings.tabs.connect", "连接") },
          { id: "doctor", icon: <Wrench size={16} />, label: t("settings.tabs.doctor", "诊断") },
          { id: "appearance", icon: <Bot size={16} />, label: t("settings.tabs.appearance", "外观") },
          { id: "behavior", icon: <MousePointer2 size={16} />, label: t("settings.tabs.behavior", "行为") },
          { id: "plugins", icon: <PlugZap size={16} />, label: t("settings.tabs.plugins", "插件") },
          { id: "animation", icon: <Wand2 size={16} />, label: t("settings.tabs.animation", "动画") },
          { id: "data", icon: <FileText size={16} />, label: t("settings.tabs.data", "数据") }
        ].map(tab => (
          <button
            key={tab.id}
            className={`tab-item ${activeSection === tab.id ? "active" : ""}`}
            style={activeSection === tab.id ? ({ viewTransitionName: "active-tab" } as React.CSSProperties) : undefined}
            onClick={() => jumpTo(tab.id)}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </nav>

      <div className="section-content" ref={sectionContentRef}>
        {activeSection === "general" && <>
          <section className="hero-panel">
            <div>
              <p className="eyebrow">Clawd Companion</p>
              <h1>{connection.connected ? t("main.heroConnected", "Clawd 正在跟随 Claude 会话") : t("main.heroWaiting", "Clawd 等待 Claude 会话接入")}</h1>
              <p className="subtle">{connection.connected ? formatText(t("main.heroConnectedSub", "{client} 最近在 {time} 发来事件。"), { client: connection.activeClientLabel ?? "Claude Code", time: timeAgo(connection.lastEventAt, now) }) : t("main.heroWaitingSub", "本地监听已经准备好；打开 Claude CLI 或已配置 hooks 的 Claude Code 会话后会自动连接。")}</p>
              <div className="hero-status-board">
                <ConnectionPill connected={connection.connected} label={connection.activeClientLabel} />
                <code>{shortSession(connection.activeSessionId, t("connection.noSession", "无会话"))}</code>
              </div>
            </div>
            <div className="mini-stage"><div className="mini-pet"><Clawd key={previewIdleBubble ?? "idle"} state={petState} settings={settings} forceIdleBubble={previewIdleBubble} /></div></div>
          </section>

          {!onboardingDone && (
            <section className="onboarding-card">
              <div className="onboarding-steps">
                {[t("main.onboardingWelcome", "欢迎"), t("main.onboardingConnect", "连接"), t("main.onboardingDone", "完成")].map((label, i) => (
                  <div key={label} className={`onboarding-step ${i === onboardingStep ? "active" : i < onboardingStep ? "done" : ""}`}>
                    <span className="onboarding-step-num">{i + 1}</span>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
              <div className="onboarding-content">
                {onboardingStep === 0 && <>
                  <h3>{t("main.welcomeTitle", "欢迎使用 Clawd Companion")}</h3>
                  <p>{t("main.welcomeDesc", "Clawd 是 Claude Code 的桌面宠物伴侣，会在你使用 Claude Code 时实时显示工具调用、会话状态和动画反馈。")}</p>
                  <p className="note">{t("main.welcomeNote", "接下来只需 2 步即可开始使用。")}</p>
                </>}
                {onboardingStep === 1 && <>
                  <h3>{t("main.connectTitle", "连接 Claude Code")}</h3>
                  <p>{t("main.connectDesc", "点击下方按钮，Clawd 会自动配置 Claude Code 的 hooks，让 Claude Code 把事件发送给 Clawd。")}</p>
                  <div className="hooks-manager" style={{ marginTop: 12 }}><HooksManager /></div>
                </>}
                {onboardingStep === 2 && <>
                  <h3>{t("main.doneTitle", "一切就绪")}</h3>
                  <p>{t("main.doneDesc", "打开任意 Claude Code 会话，Clawd 会自动跟随。你可以在配置面板中调整桌宠外观、动画和行为。")}</p>
                  <p className="note">{t("main.doneNote", "点击下方按钮开始使用。")}</p>
                </>}
              </div>
              <div className="onboarding-actions">
                {onboardingStep > 0 && <button className="ghost" onClick={() => setOnboardingStep(onboardingStep - 1)}>{t("main.prev", "上一步")}</button>}
                <button onClick={() => {
                  if (onboardingStep < 2) setOnboardingStep(onboardingStep + 1);
                  else { localStorage.setItem("clawd-onboarding-done", "1"); setOnboardingDone(true); }
                }}>{onboardingStep < 2 ? t("main.next", "下一步") : t("main.start", "开始使用")}</button>
              </div>
            </section>
          )}

          <section className="status-strip">
            <StatusCard icon={<Radio size={18} />} label={t("status.connection", "连接状态")} value={connection.connected ? t("status.connected", "已连接") : connection.serverListening ? t("status.waiting", "等待会话") : t("status.notListening", "未监听")} meta={connection.activeClientLabel} tone={connection.connected ? "good" : connection.serverListening ? "wait" : "bad"} />
            <StatusCard icon={<Timer size={18} />} label={t("status.recentEvent", "最近事件")} value={connection.lastEventAt ? timeAgo(connection.lastEventAt, now) : t("status.noEvent", "还没收到")} tone={connection.lastEventAt ? "good" : "wait"} />
            <StatusCard icon={<Shield size={18} />} label={t("status.session", "会话")} value={shortSession(connection.activeSessionId, t("connection.noSession", "无会话"))} tone="neutral" />
            <StatusCard icon={<MonitorCheck size={18} />} label={t("status.localServer", "本地监听")} value={connection.serverListening ? `127.0.0.1:${connection.port}` : t("status.notListening", "未监听")} tone={connection.serverListening ? "good" : "bad"} />
          </section>

          {connection.error ? <section className="connection-error"><Wrench size={18} />{connection.error}</section> : null}
        </>}

        {activeSection === "connect" && <>
          <GroupCard icon={<PlugZap size={18} />} title={t("sections.claudeConnection", "Claude Code 连接")}>
            <HooksManager />
          </GroupCard>

          <GroupCard icon={<Radio size={18} />} title={t("sections.connectionDetails", "连接详情")}>
            <div className="connection-detail-grid">
              <ConnectionDetail label={t("fields.status", "状态")} value={connection.connected ? t("status.connected", "已连接") : connection.serverListening ? t("status.waiting", "等待 Claude 会话") : t("status.notListening", "本地服务未监听")} />
              <ConnectionDetail label={t("fields.client", "客户端")} value={connection.activeClientLabel ?? t("pet.unknownClient", "未知客户端")} />
              <ConnectionDetail label={t("fields.sessionId", "会话 ID")} value={shortSession(connection.activeSessionId, t("connection.noSession", "无会话"))} />
              <ConnectionDetail label={t("fields.lastActive", "最后活动")} value={connection.lastEventAt ? timeAgo(connection.lastEventAt, now) : t("common.none", "暂无")} />
            </div>
          </GroupCard>

          <GroupCard icon={<Shield size={18} />} title={t("sections.privacySecurity", "隐私与安全")}>
            <div className="settings-columns compact">
              <section className="settings-group">
                <Field label={t("fields.eventPort", "事件端口")}>
                  <input value={settings.port} onChange={event => updateSettings({ port: Number(event.target.value) || defaultSettings.port })} />
                </Field>
                <Field label={t("fields.localToken", "本地 token")}>
                  <input value={settings.token} onChange={event => updateSettings({ token: event.target.value })} />
                </Field>
              </section>
              <section className="settings-group">
                <Segmented value={settings.privacyMode} onChange={privacyMode => updateSettings({ privacyMode })} />
                <p className="note">安全模式只显示工具类型；标准模式显示文件名和搜索模式；详细模式可显示被截断的命令摘要。</p>
              </section>
            </div>
          </GroupCard>
        </>}

        {activeSection === "doctor" && <>
          <DoctorPanel />
        </>}

        {activeSection === "appearance" && <>
          <GroupCard icon={<Eye size={18} />} title={t("sections.display", "显示")}>
            <section className="settings-group theme-settings-group">
              <h3 className="panel-subtitle">{t("sections.theme", "界面主题")}</h3>
              <div className="theme-style-row">
                <ThemeSegmented value={settings.theme ?? "system"} onChange={theme => updateSettings({ theme })} />
                <UiStyleToggle value={settings.uiStyle ?? "classic"} onChange={uiStyle => updateSettings({ uiStyle })} />
                <LanguageSegmented value={settings.language ?? "auto"} onChange={language => {
                  updateSettings({ language });
                  setLocale(language === "auto" ? detectLocale() : language);
                }} />
              </div>
              <p className="note">{t("appearance.themeNote", "选择日间、夜间或跟随系统；右侧可切换经典 / 液态玻璃界面风格。")}</p>
            </section>
            <div className="panel-divider" />
            <Toggle label={t("appearance.enablePet", "启用桌宠")} checked={settings.petEnabled} onChange={petEnabled => updateSettings({ petEnabled })} />
            <Toggle label={t("appearance.alwaysOnTop", "始终置顶")} checked={settings.alwaysOnTop} onChange={alwaysOnTop => updateSettings({ alwaysOnTop })} />
            <Toggle label={t("appearance.clickThrough", "完全点击穿透")} checked={settings.clickThrough} onChange={clickThrough => updateSettings({ clickThrough })} />
            <Toggle label={t("appearance.showBubbles", "显示气泡")} checked={settings.showBubbles} onChange={showBubbles => updateSettings({ showBubbles })} />
            <Toggle label={t("appearance.showStatusProp", "显示状态图标")} checked={settings.showStatusProp} onChange={showStatusProp => updateSettings({ showStatusProp })} />
            <Toggle label={t("appearance.showSessionTitle", "显示会话标题")} checked={settings.showSessionTitle} onChange={showSessionTitle => updateSettings({ showSessionTitle })} />
            <Toggle label={t("appearance.editPosition", "编辑桌宠位置")} checked={settings.editPosition} onChange={editPosition => updateSettings({ editPosition })} />
            {settings.editPosition ? <button className="inline-action" onClick={() => updateSettings({ positionOffsets: defaultSettings.positionOffsets, zoneSizes: defaultSettings.zoneSizes, clawdScale: defaultSettings.clawdScale, thoughtScale: defaultSettings.thoughtScale, bubbleScale: defaultSettings.bubbleScale, cardScale: defaultSettings.cardScale, petScale: defaultSettings.petScale, viewScale: defaultSettings.viewScale })}>{t("appearance.resetAll", "重置全部")}</button> : null}
          </GroupCard>

          <MonitorSettings settings={settings} updateSettings={updateSettings} />

          <div className="section-grid-2col">
            <GroupCard title={t("appearance.overallScale", "整体缩放")}>
              <Slider label={t("appearance.viewScale", "视图缩放")} min={0.7} max={1.45} step={0.05} value={settings.petScale} format={v => `${Math.round(v * 100)}%`} onChange={petScale => updateSettings({ petScale })} />
              <Slider label={t("appearance.viewportScale", "视窗缩放")} min={0.7} max={2.5} step={0.05} value={settings.viewScale ?? settings.petScale} format={v => `${Math.round(v * 100)}%`} onChange={viewScale => updateSettings({ viewScale })} />
              <Slider label={t("appearance.opacity", "整体透明")} min={0.45} max={1} step={0.05} value={settings.petOpacity} format={v => `${Math.round(v * 100)}%`} onChange={petOpacity => updateSettings({ petOpacity })} />
            </GroupCard>

            <GroupCard title="Clawd">
              <Slider label={t("appearance.size", "尺寸")} min={0.7} max={1.35} step={0.05} value={settings.clawdScale} format={v => `${Math.round(v * 100)}%`} onChange={clawdScale => updateSettings({ clawdScale })} />
              <Slider label={t("appearance.opacity", "透明")} min={0.45} max={1} step={0.05} value={settings.clawdOpacity} format={v => `${Math.round(v * 100)}%`} onChange={clawdOpacity => updateSettings({ clawdOpacity })} />
            </GroupCard>

            <GroupCard title={t("appearance.thoughtBubble", "思维泡")}>
              <Slider label={t("appearance.size", "尺寸")} min={0.75} max={1.35} step={0.05} value={settings.thoughtScale} format={v => `${Math.round(v * 100)}%`} onChange={thoughtScale => updateSettings({ thoughtScale })} />
              <Slider label={t("appearance.opacity", "透明")} min={0.45} max={1} step={0.05} value={settings.thoughtOpacity} format={v => `${Math.round(v * 100)}%`} onChange={thoughtOpacity => updateSettings({ thoughtOpacity })} />
            </GroupCard>

            <GroupCard title={t("appearance.card", "卡片")}>
              <Slider label={t("appearance.size", "尺寸")} min={0.75} max={1.25} step={0.05} value={settings.cardScale} format={v => `${Math.round(v * 100)}%`} onChange={cardScale => updateSettings({ cardScale })} />
              <Slider label={t("appearance.opacity", "透明")} min={0.45} max={1} step={0.05} value={settings.cardOpacity} format={v => `${Math.round(v * 100)}%`} onChange={cardOpacity => updateSettings({ cardOpacity })} />
            </GroupCard>

            <GroupCard title={t("appearance.bubbleToolStream", "气泡 / 工具流")}>
              <Slider label={t("appearance.size", "尺寸")} min={0.6} max={2} step={0.05} value={settings.bubbleScale} format={v => `${Math.round(v * 100)}%`} onChange={bubbleScale => updateSettings({ bubbleScale })} />
              <Slider label={t("appearance.opacity", "透明")} min={0.45} max={1} step={0.05} value={settings.bubbleOpacity} format={v => `${Math.round(v * 100)}%`} onChange={bubbleOpacity => updateSettings({ bubbleOpacity })} />
            </GroupCard>

            <GroupCard title={t("appearance.permissionPopup", "权限弹窗")}>
              <Slider label={t("appearance.size", "尺寸")} min={0.4} max={2} step={0.05} value={settings.permissionScale} format={v => `${Math.round(v * 100)}%`} onChange={permissionScale => updateSettings({ permissionScale })} />
              <Slider label={t("appearance.opacity", "透明")} min={0.45} max={1} step={0.05} value={settings.permissionOpacity} format={v => `${Math.round(v * 100)}%`} onChange={permissionOpacity => updateSettings({ permissionOpacity })} />
            </GroupCard>
          </div>
        </>}

        {activeSection === "behavior" && <>
          <GroupCard icon={<MousePointer2 size={18} />} title={t("sections.startup", "启动")}>
            <Toggle label={t("behavior.launchAtLogin", "开机自启")} checked={settings.launchAtLogin} onChange={launchAtLogin => updateSettings({ launchAtLogin })} />
            <Toggle label={t("behavior.autoStartWithCli", "Claude Code 启动时自动启动")} checked={settings.autoStartWithCli} onChange={autoStartWithCli => updateSettings({ autoStartWithCli })} />
            <Toggle label={t("behavior.openSettingsOnStart", "启动时打开配置面板")} checked={settings.openSettingsOnStart} onChange={openSettingsOnStart => updateSettings({ openSettingsOnStart })} />
          </GroupCard>

          <GroupCard icon={<Bell size={18} />} title={t("sections.sound", "通知和音效")}>
            <NotificationRulesPanel settings={settings} updateSettings={updateSettings} />
          </GroupCard>

          <GroupCard icon={<Timer size={18} />} title={t("sections.pomodoro", "番茄钟")}>
            <Toggle label={t("pomodoro.enable", "显示番茄钟")} checked={settings.pomodoroEnabled} onChange={pomodoroEnabled => updateSettings({ pomodoroEnabled })} />
            {settings.pomodoroEnabled ? (
              <div className="section-grid-2col compact-grid">
                <Slider label={t("pomodoro.workMinutes", "专注时长")} min={5} max={60} step={5} value={settings.pomodoroWorkMinutes} format={v => `${v} ${t("common.minutes", "分钟")}`} onChange={pomodoroWorkMinutes => updateSettings({ pomodoroWorkMinutes })} />
                <Slider label={t("pomodoro.breakMinutes", "休息时长")} min={1} max={20} step={1} value={settings.pomodoroBreakMinutes} format={v => `${v} ${t("common.minutes", "分钟")}`} onChange={pomodoroBreakMinutes => updateSettings({ pomodoroBreakMinutes })} />
              </div>
            ) : null}
          </GroupCard>

          <GroupCard icon={<Timer size={18} />} title={t("sections.time", "时间")}>
            <Slider label={t("behavior.bubbleStay", "气泡停留")} min={3} max={18} step={1} value={settings.bubbleDuration} format={v => `${v} ${t("common.seconds", "秒")}`} onChange={bubbleDuration => updateSettings({ bubbleDuration })} />
            <Slider label={t("behavior.toolStreamStay", "工具流停留")} min={0.3} max={3} step={0.1} value={settings.toolStreamMinDuration} format={v => `${v.toFixed(1)} ${t("common.seconds", "秒")}`} onChange={toolStreamMinDuration => updateSettings({ toolStreamMinDuration })} />
            <Slider label={t("behavior.eventHistory", "事件历史")} min={12} max={100} step={4} value={settings.eventHistoryLimit} format={v => `${v} ${t("common.items", "条")}`} onChange={eventHistoryLimit => updateSettings({ eventHistoryLimit })} />
          </GroupCard>

          <GroupCard title={t("sections.multiSession", "多会话模式")}>
            <Toggle label={<span className="toggle-label-with-badge">{t("behavior.enableMultiSession", "启用多会话")}<sup className="beta-badge">{t("behavior.testing", "测试中")}</sup></span>} checked={settings.multiSessionEnabled} onChange={multiSessionEnabled => updateSettings({ multiSessionEnabled })} />
            {settings.multiSessionEnabled && (
              <Slider label={t("behavior.companionScale", "小 Clawd 缩放")} min={0.3} max={0.8} step={0.05} value={settings.companionScale} format={v => `${Math.round(v * 100)}%`} onChange={companionScale => updateSettings({ companionScale })} />
            )}
          </GroupCard>
        </>}

        {activeSection === "plugins" && <>
          <PluginMarketPanel installedPluginIds={(settings.customPlugins ?? []).map((plugin: CustomPlugin) => plugin.id)} onInstalled={async () => updateSettings({ customPlugins: await window.companion.getPlugins() } as any)} />
          <PluginManagerPanel settings={settings} updateSettings={updateSettings} />
        </>}

        {activeSection === "animation" && <>
          <GroupCard icon={<Sparkles size={18} />} title={t("sections.idleAnimation", "待机动画")}>
            <IdleAnimSettings config={settings.idleAnim ?? defaultSettings.idleAnim!} onChange={cfg => updateSettings({ idleAnim: cfg })} settings={settings} updateSettings={updateSettings} />
          </GroupCard>

          <GroupCard icon={<Wand2 size={18} />} title={t("sections.actionMapping", "动作映射")}>
            <StateAnimSettings stateAnimations={settings.stateAnimations ?? {}} onChange={sa => updateSettings({ stateAnimations: sa })} />
          </GroupCard>
        </>}

        {activeSection === "data" && <>
          <HistoryPanel />

          <GroupCard icon={<Gauge size={18} />} title={t("sections.runtimeStats", "运行统计")}>
            {persistedStats ? <StatsPanel stats={persistedStats} /> : <p className="note">{t("common.loading", "加载中...")}</p>}
          </GroupCard>

          <GroupCard icon={<Bell size={18} />} title={t("sections.recentEvents", "最近事件")}>
            <div className="event-list data-event-list">
              {events.length === 0 ? <div className="empty">{t("data.emptyEvents", "还没有收到事件。先复制 hooks 配置，或点击测试事件看状态变化。")}</div> : events.map(event => (
                <article key={event.id} className="event-row">
                  <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
                  <strong>{event.title}</strong>
                  <p>{event.message}</p>
                  <small>{timeAgo(event.timestamp, now)}</small>
                  <em>{t(`pet.${stateFromEvent(event)}`, stateCopy[stateFromEvent(event)].label)}</em>
                </article>
              ))}
            </div>
            <div className="command-row compact">
              <span>{t("data.exportEvents", "导出当前事件历史")}</span>
              <button onClick={async () => {
                const result = await window.companion.exportEventHistoryFile();
                setCopied(result.ok ? "events-export" : "events-export-fail");
                setTimeout(() => setCopied(null), 2000);
              }}><FileText size={15} />{copied === "events-export" ? t("common.exported", "已导出") : copied === "events-export-fail" ? t("common.failed", "失败") : t("common.saveToFile", "保存到文件")}</button>
            </div>
          </GroupCard>

          <GroupCard icon={<Code2 size={18} />} title={t("sections.tokenUsage", "Token 用量")}>
            <TokenPanel />
          </GroupCard>


          <GroupCard icon={<Play size={18} />} title={t("sections.testEvents", "测试事件")}>
            <div className="test-grid">
              {sampleEvents.map(event => <button key={`${event.event}-${event.tool ?? "x"}`} onClick={() => test(event)}>{event.title}</button>)}
              <button onClick={() => window.companion.triggerIdleBubble()}>{t("data.idleAnimation", "待机动画")}</button>
              <button onClick={async () => {
                const sid1 = "test-" + Math.random().toString(36).slice(2, 8);
                const sid2 = "test-" + Math.random().toString(36).slice(2, 8);
                const send = (e: CompanionEvent) => window.companion.sendTestEvent(e);
                await send({ ...makeEvent("session_start", "manual", t("data.session1Test", "会话 1 测试"), t("data.frontend", "前端")), sessionId: sid1, tool: undefined });
                await send({ ...makeEvent("tool_start", "manual", t("data.sampleRead", "读取文件"), "package.json"), sessionId: sid1, tool: "Read" as ToolName });
                await send({ ...makeEvent("session_start", "manual", t("data.session2Test", "会话 2 测试"), t("data.backend", "后端")), sessionId: sid2, tool: undefined });
                await send({ ...makeEvent("tool_start", "manual", t("data.sampleBash", "执行命令"), "npm install"), sessionId: sid2, tool: "Bash" as ToolName });
              }}>{t("data.multiSessionTest", "多会话测试")}</button>
              <button onClick={async () => {
                await window.companion.sendTestEvent({ ...makeEvent("done", "manual", t("data.allSessionsDone", "任务完成"), t("data.allSessionsDoneMsg", "两个会话都结束了")), sessionId: undefined, tool: undefined });
              }}>{t("data.finishAllSessions", "结束全部会话")}</button>
            </div>
          </GroupCard>

          <GroupCard icon={<FileText size={18} />} title={t("sections.configManagement", "配置管理")}>
            <div className="management-action-grid">
              <section className="management-action-card">
                <div>
                  <strong>{t("data.exportConfig", "导出当前配置")}</strong>
                  <p>{t("data.exportConfigNote", "将当前应用设置保存为 JSON 文件，方便备份或迁移。")}</p>
                </div>
                <button onClick={async () => {
                  const result = await window.companion.exportSettingsFile();
                  if (result.ok) { setCopied("export-file"); setTimeout(() => setCopied(null), 2000); }
                }}><FileText size={15} />{copied === "export-file" ? t("common.exported", "已导出") : t("common.saveToFile", "保存到文件")}</button>
              </section>
              <section className="management-action-card warning">
                <div>
                  <strong>{t("data.importConfig", "导入配置")}</strong>
                  <p>{t("data.importConfigNote", "从 JSON 文件导入配置，会覆盖当前设置。")}</p>
                </div>
                <button onClick={async () => {
                  const result = await window.companion.importSettingsFile();
                  setCopied(result.ok ? "import-file-ok" : result.error ? "import-file-fail" : "");
                  if (result.ok) window.location.reload();
                  setTimeout(() => setCopied(null), 2000);
                }}><FileText size={15} />{copied === "import-file-ok" ? t("common.imported", "已导入") : copied === "import-file-fail" ? t("common.failed", "失败") : t("common.import", "导入")}</button>
              </section>
            </div>
          </GroupCard>

          <GroupCard title={t("sections.dataManagement", "数据管理")}>
            <div className="management-action-grid">
              <section className="management-action-card">
                <div>
                  <strong>{t("data.exportStats", "导出统计数据")}</strong>
                  <p>{t("data.exportStatsNote", "将累计运行统计保存为 JSON 文件。")}</p>
                </div>
                <button onClick={async () => {
                  const result = await window.companion.exportStatsFile();
                  if (result.ok) setCopied("stats-export");
                  setTimeout(() => setCopied(null), 2000);
                }}><FileText size={15} />{copied === "stats-export" ? t("common.exported", "已导出") : t("common.saveToFile", "保存到文件")}</button>
              </section>
              <section className="management-action-card warning">
                <div>
                  <strong>{t("data.importStats", "导入统计数据")}</strong>
                  <p>{t("data.importStatsNote", "从 JSON 文件导入统计数据，会覆盖当前数据。")}</p>
                </div>
                <button onClick={async () => {
                  const result = await window.companion.importStatsFile();
                  if (result.ok) window.location.reload();
                  setCopied(result.ok ? "stats-import-ok" : "stats-import-fail");
                  setTimeout(() => setCopied(null), 2000);
                }}><FileText size={15} />{copied === "stats-import-ok" ? t("common.imported", "已导入") : copied === "stats-import-fail" ? t("common.failed", "失败") : t("common.import", "导入")}</button>
              </section>
              <section className="management-action-card danger">
                <div>
                  <strong>{t("data.clearStats", "清空统计数据")}</strong>
                  <p>{t("data.clearStatsNote", "永久删除所有累计统计数据，此操作不可恢复。")}</p>
                </div>
                <button className="danger" onClick={async () => {
                  if (confirm(t("data.clearStatsConfirm", "确定要清空所有统计数据吗？此操作不可恢复。"))) {
                    await window.companion.resetStats();
                    window.location.reload();
                  }
                }}><X size={15} />{t("common.clear", "清空")}</button>
              </section>
            </div>
          </GroupCard>
        </>}
      </div>

      <footer className="version-bar">
        <div className="version-left">
          <span className="version-label">Clawd Companion</span>
          <span className="version-number">v{appVersion}</span>
          <button
            className="version-link"
            onClick={() => window.companion.openExternal("https://github.com/Doulor/Clawd-Companion")}
            title={t("update.github", "在 GitHub 上查看")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.605-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12 24 5.37 18.63 0 12 0z"/></svg>
            GitHub
          </button>
        </div>
        <div className="version-right">
          {updateStatus.error ? (
            <span className="update-error">{updateStatus.error}</span>
          ) : updateStatus.downloaded ? (
            <div className="update-install-wrap">
              <button className="update-btn update-ready" onClick={handleInstallClick} disabled={installing}>
                {installing ? t("update.installing", "正在启动安装...") : formatText(t("update.install", "点击重启并安装 v{version}"), { version: updateStatus.version ?? "" })}
              </button>
              <span className="update-install-hint">{t("update.installHint", "若安装失败，请右键本软件并以管理员身份运行后再次尝试")}</span>
            </div>
          ) : updateStatus.downloading ? (
            <span className="update-progress">{formatText(t("update.downloading", "下载中 {progress}%"), { progress: Math.round(updateStatus.progress ?? 0) })}</span>
          ) : updateStatus.checking ? (
            <span className="update-checking">{t("update.checking", "正在检查更新...")}</span>
          ) : updateStatus.available ? (
            <span className="update-available">{formatText(t("update.available", "发现新版本 v{version}，正在下载..."), { version: updateStatus.version ?? "" })}</span>
          ) : updateStatus.upToDate ? (
            <span className="update-uptodate">
              <Check size={14} />{t("update.upToDate", "已是最新版本")}
              <button className="update-refresh-btn" onClick={handleCheckUpdate} disabled={checkingUpdate} title={t("update.manualCheck", "手动检查更新")}>
                ↻
              </button>
            </span>
          ) : (
            <button className="update-btn" onClick={handleCheckUpdate} disabled={checkingUpdate}>
              {checkingUpdate ? t("update.checkShort", "检查中...") : t("update.check", "检查更新")}
            </button>
          )}
        </div>
      </footer>
    </main>
  );
}

function Panel({ id, title, icon, wide, children }: { id?: string; title: string; icon: React.ReactNode; wide?: boolean; children: React.ReactNode }) {
  return <section id={id} className={`panel ${wide ? "wide" : ""}`}><header>{icon}<h2>{title}</h2></header>{children}</section>;
}

function GroupCard({ icon, title, children }: { icon?: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="group-card">
      <header className="group-card-header">{icon}<h3>{title}</h3></header>
      {children}
    </div>
  );
}

function HooksManager() {
  const { t } = useI18n();
  const formatText = (template: string, values: Record<string, string | number>) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);
  const [status, setStatus] = useState<{ installed: boolean; configExists: boolean; hookCount: number; requiredCount: number; missingEvents: string[]; commandMatches: boolean } | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    window.companion.checkHooks().then(setStatus);
  }, []);

  async function handleInstall() {
    setAction("installing");
    const res = await window.companion.installHooks();
    setResult(res.success ? t("doctor.installDone", "安装成功！重启 Claude Code 会话后生效。") : formatText(t("doctor.installFailed", "安装失败: {error}"), { error: res.error ?? "" }));
    setStatus(await window.companion.checkHooks());
    setAction(null);
  }

  async function handleRepair() {
    setAction("repairing");
    const res = await window.companion.repairHooks();
    setResult(res.success ? formatText(t("doctor.repairDone", "修复完成，修复了 {count} 项配置。"), { count: res.fixed.length }) : formatText(t("doctor.repairFailed", "修复失败: {error}"), { error: res.error ?? "" }));
    setStatus(await window.companion.checkHooks());
    setAction(null);
  }

  async function handleRemove() {
    setAction("removing");
    const res = await window.companion.removeHooks();
    setResult(res.success ? t("doctor.removeDone", "已移除所有 Clawd hooks。") : formatText(t("doctor.removeFailed", "移除失败: {error}"), { error: res.error ?? "" }));
    setStatus(await window.companion.checkHooks());
    setAction(null);
  }

  return (
    <div className="hooks-manager">
      <StatusCard
        icon={<Wrench size={18} />}
        label={t("doctor.status", "Hooks 状态")}
        value={status?.installed ? t("hooks.installed", "已安装") : status?.configExists ? t("doctor.partial", "部分安装") : t("hooks.notInstalled", "未安装")}
        tone={status?.installed ? "good" : status?.configExists ? "wait" : "bad"}
      />

      <div className="hooks-detail">
        <span>{formatText(t("doctor.configuredCount", "已配置 {count} / {total} 个事件"), { count: status?.hookCount ?? 0, total: status?.requiredCount ?? 6 })}</span>
        {status?.missingEvents && status.missingEvents.length > 0 && (
          <span className="hooks-missing">{formatText(t("doctor.missingPrefix", "缺少: {events}"), { events: status.missingEvents.join(", ") })}</span>
        )}
        {status && !status.commandMatches && status.configExists && (
          <span className="hooks-mismatch">{t("doctor.mismatchHint", "命令路径不匹配，建议修复")}</span>
        )}
      </div>

      <div className="hooks-actions">
        <button onClick={handleInstall} disabled={!!action}>
          {action === "installing" ? t("doctor.installing", "安装中...") : t("doctor.oneClickInstall", "一键安装")}
        </button>
        <button onClick={handleRepair} disabled={!!action}>
          {action === "repairing" ? t("doctor.repairing", "修复中...") : t("doctor.repairConfig", "修复配置")}
        </button>
        <button className="danger" onClick={handleRemove} disabled={!!action}>
          {action === "removing" ? t("doctor.removing", "移除中...") : t("doctor.removeHooks", "移除 Hooks")}
        </button>
      </div>

      {result && <p className="hooks-result">{result}</p>}

      <p className="note">{t("doctor.note", "安装 hooks 后，Claude Code 会自动将事件发送到 Clawd Companion。备份文件保存在 ~/.claude/settings.clawd-backup.json")}</p>
    </div>
  );
}

function StatusCard({ icon, label, value, meta, tone }: { icon: React.ReactNode; label: string; value: string; meta?: string; tone: "good" | "bad" | "wait" | "neutral" }) {
  return <article className={`status-card ${tone}`}>{icon}<span>{label}</span><strong>{value}</strong>{meta ? <small>{meta}</small> : null}</article>;
}

function ConnectionPill({ connected, label }: { connected: boolean; label?: string }) {
  const { t } = useI18n();
  return <span className={`connection-pill ${connected ? "connected" : "waiting"}`}><i />{connected ? t("status.connected", "已连接") : t("status.waiting", "等待连接")}{label ? <small>{label}</small> : null}</span>;
}

function ConnectionDetail({ label, value }: { label: string; value: string }) {
  return <article className="connection-detail"><span>{label}</span><strong>{value}</strong></article>;
}

function Step({ number, title, text }: { number: string; title: string; text: string }) {
  return <article className="step"><b>{number}</b><div><strong>{title}</strong><p>{text}</p></div></article>;
}

function MappingRow({ row }: { row: { source: string; tool?: string; state: PetState; title: string } }) {
  return (
    <article className="mapping-row">
      <div><strong>{row.source}</strong><span>{row.tool ?? row.title}</span></div>
      <i />
      <em className={`tone-${stateCopy[row.state].tone}`}>{stateCopy[row.state].label}</em>
    </article>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Toggle({ label, checked, onChange }: { label: React.ReactNode; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      {checked ? <Eye size={17} /> : <EyeOff size={17} />}
      <span>{label}</span>
      <i />
    </button>
  );
}

function Slider({ label, min, max, step, value, format, onChange }: { label: string; min: number; max: number; step: number; value: number; format: (value: number) => string; onChange: (value: number) => void }) {
  const fillPercent = ((value - min) / (max - min)) * 100;
  return (
    <label className="slider-row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--slider-fill": `${fillPercent}%` } as React.CSSProperties}
        onChange={event => onChange(Number(event.target.value))}
      />
      <b>{format(value)}</b>
    </label>
  );
}

function Segmented({ value, onChange }: { value: PrivacyMode; onChange: (value: PrivacyMode) => void }) {
  const { t } = useI18n();
  const items: Array<{ value: PrivacyMode; label: string }> = [
    { value: "safe", label: t("connection.privacySafe", "安全") },
    { value: "standard", label: t("connection.privacyStandard", "标准") },
    { value: "detailed", label: t("connection.privacyDetailed", "详细") }
  ];
  return <div className="segmented">{items.map(item => <button key={item.value} className={value === item.value ? "active" : ""} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>;
}

function ThemeSegmented({ value, onChange }: { value: CompanionSettings["theme"]; onChange: (value: CompanionSettings["theme"]) => void }) {
  const { t } = useI18n();
  const items: Array<{ value: CompanionSettings["theme"]; label: string; icon: string }> = [
    { value: "light", label: t("settings.themeLight", "浅色"), icon: "☀" },
    { value: "system", label: t("settings.themeSystem", "跟随"), icon: "◐" },
    { value: "dark", label: t("settings.themeDark", "夜间"), icon: "☾" }
  ];
  const activeIndex = Math.max(0, items.findIndex(item => item.value === value));

  return (
    <div className={`theme-switch theme-switch-${value}`} style={{ "--theme-index": activeIndex } as React.CSSProperties}>
      <div className="theme-switch-liquid" />
      {items.map(item => (
        <button
          key={item.value}
          className={`theme-switch-option ${value === item.value ? "active" : ""}`}
          onClick={() => onChange(item.value)}
          type="button"
        >
          <span className="theme-switch-icon">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

function LanguageSegmented({ value, onChange }: { value: CompanionSettings["language"]; onChange: (value: CompanionSettings["language"]) => void }) {
  const { t } = useI18n();
  const items: Array<{ value: CompanionSettings["language"]; label: string; icon: string }> = [
    { value: "zh", label: "中文", icon: "中" },
    { value: "auto", label: t("common.auto", "自动"), icon: "◐" },
    { value: "en", label: "English", icon: "EN" }
  ];
  const activeIndex = Math.max(0, items.findIndex(item => item.value === value));
  return (
    <div className={`theme-switch language-switch language-switch-${value}`} style={{ "--theme-index": activeIndex } as React.CSSProperties}>
      <div className="theme-switch-liquid" />
      {items.map(item => (
        <button key={item.value} className={`theme-switch-option ${value === item.value ? "active" : ""}`} type="button" onClick={() => onChange(item.value)}>
          <span className="theme-switch-icon">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

function UiStyleToggle({ value, onChange }: { value: CompanionSettings["uiStyle"]; onChange: (value: CompanionSettings["uiStyle"]) => void }) {
  const { t } = useI18n();
  const next = value === "liquid" ? "classic" : "liquid";
  return (
    <button className={`ui-style-toggle ui-style-toggle-${value}`} type="button" onClick={() => onChange(next)}>
      <span className="ui-style-orb" />
      <span className="ui-style-copy">
        <strong>{value === "liquid" ? t("behavior.uiLiquid", "液态玻璃") : t("behavior.uiClassic", "经典风格")}</strong>
        <small>{value === "liquid" ? t("behavior.uiBackClassic", "点击返回经典") : t("behavior.uiSwitchNew", "点击切换新界面")}</small>
      </span>
    </button>
  );
}

function privacyLabel(mode: PrivacyMode) {
  if (mode === "safe") return "安全";
  if (mode === "standard") return "标准";
  return "详细";
}

function shortSession(sessionId?: string, fallback = "No session") {
  if (!sessionId) return fallback;
  return sessionId.length > 12 ? `${sessionId.slice(0, 6)}...${sessionId.slice(-4)}` : sessionId;
}

function timeAgo(timestamp: number | undefined, now = Date.now()) {
  const isZh = document.documentElement.lang.startsWith("zh");
  if (!timestamp) return isZh ? "暂无" : "None";
  const seconds = Math.max(1, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return isZh ? `${seconds} 秒前` : `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return isZh ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return isZh ? `${hours} 小时前` : `${hours}h ago`;
}

function buildHookSnippet(command: string) {
  const hook = { matcher: "*", hooks: [{ type: "command", command }] };
  return JSON.stringify({
    hooks: {
      SessionStart: [hook],
      UserPromptSubmit: [hook],
      PreToolUse: [hook],
      PostToolUse: [hook],
      Notification: [hook],
      Stop: [hook]
    }
  }, null, 2);
}

const idleSpriteOptions: Array<{ key: string; label: string; w: number; h: number }> = [
  { key: "idle", label: "idle_bubble", w: 168, h: 160 },
  { key: "thinking", label: "thinking_speech", w: 168, h: 209 },
  { key: "tool_read", label: "headset_focus", w: 168, h: 145 },
  { key: "tool_edit", label: "working_hardhat", w: 168, h: 133 },
  { key: "waiting_permission", label: "permission_prompt", w: 168, h: 100 },
  { key: "done", label: "celebrate_bunny", w: 168, h: 208 },
  { key: "error", label: "error_dead", w: 168, h: 182 },
  { key: "skill", label: "idea_bulb", w: 480, h: 480 },
  { key: "agent", label: "welding_work", w: 480, h: 480 }
];

function IdleAnimSettings({ config, onChange, settings, updateSettings }: { config: IdleAnimConfig; onChange: (cfg: IdleAnimConfig) => void; settings: CompanionSettings; updateSettings: (s: Partial<CompanionSettings>) => void }) {
  const { t } = useI18n();
  const [openPicker, setOpenPicker] = useState<number | null>(null);

  function toggleSprite(key: string) {
    const next = config.selectedSprites.includes(key)
      ? config.selectedSprites.filter(s => s !== key)
      : [...config.selectedSprites, key];
    onChange({ ...config, selectedSprites: next });
  }

  const formatText = (template: string, values: Record<string, string | number>) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);
  const companionLabels = [
    t("data.mainClawd", "主 Clawd"),
    formatText(t("data.smallClawd", "小 Clawd {index}"), { index: 1 }),
    formatText(t("data.smallClawd", "小 Clawd {index}"), { index: 2 }),
    formatText(t("data.smallClawd", "小 Clawd {index}"), { index: 3 })
  ];
  const companionAnimValues = [
    (settings as any).mainClawdIdleAnimation ?? "random",
    settings.companionIdleAnimations?.[0] ?? "thinking",
    settings.companionIdleAnimations?.[1] ?? "thinking",
    settings.companionIdleAnimations?.[2] ?? "thinking"
  ];

  function setCompanionAnim(index: number, value: string) {
    if (index === 0) {
      updateSettings({ mainClawdIdleAnimation: value } as any);
    } else {
      const next = [...(settings.companionIdleAnimations ?? ["thinking", "thinking", "thinking"])];
      next[index - 1] = value;
      updateSettings({ companionIdleAnimations: next });
    }
  }

  function getAnimLabel(value: string) {
    if (value === "random") return t("common.random", "随机");
    const opt = idleSpriteOptions.find(o => o.key === value);
    return opt?.label ?? value;
  }

  return (
    <div className="idle-anim-settings">
      <Toggle label={t("data.enableIdleRandom", "启用待机随机动画")} checked={config.enabled} onChange={enabled => onChange({ ...config, enabled })} />
      <div className="panel-divider" />
      <h3 className="panel-subtitle">{t("data.optionalPool", "可选动画池")}</h3>
      <div className="idle-sprite-grid">
        {idleSpriteOptions.map(opt => (
          <button
            key={opt.key}
            className={`idle-sprite-preview ${config.selectedSprites.includes(opt.key) ? "checked" : ""}`}
            onClick={() => toggleSprite(opt.key)}
          >
            <div className="sprite-preview-box">
              <span
                className={`clawd-sprite clawd-sprite-${opt.key} clawd-gif-${idleBubbleGifClass[opt.key] ?? opt.key}`}
                style={{ transform: `scale(${72 / Math.max(opt.w, opt.h)})` }}
              />
            </div>
            <span className="idle-sprite-label">{opt.label}</span>
          </button>
        ))}
      </div>
      <div className="panel-divider" />
      <RangeSlider
        label={t("data.playInterval", "播放间隔")}
        min={5}
        max={120}
        step={5}
        low={config.intervalMin}
        high={config.intervalMax}
        format={v => `${v} ${t("common.seconds", "秒")}`}
        onChange={(low, high) => onChange({ ...config, intervalMin: low, intervalMax: high })}
      />
      <div className="panel-divider" />
      <RangeSlider
        label={t("data.repeatCount", "每次播放次数")}
        min={1}
        max={5}
        step={1}
        low={config.repeatMin}
        high={config.repeatMax}
        format={v => `${v} ${t("common.times", "次")}`}
        onChange={(low, high) => onChange({ ...config, repeatMin: low, repeatMax: high })}
      />
      <div className="panel-divider" />
      <h3 className="panel-subtitle">{t("data.clawdIdleAnimations", "各 Clawd 待机动画")}</h3>
      <p className="note">{t("data.idleAnimationNote", "选择「随机」时使用上方动画池配置循环播放；选择固定动画则始终重复播放该 GIF，替代默认的静态 PNG。")}</p>
      <div className="state-anim-grid">
        {companionLabels.map((label, i) => {
          const currentValue = companionAnimValues[i];
          const isOpen = openPicker === i;
          return (
            <div key={i} className="state-anim-col">
              <span className="state-anim-col-label">{label}</span>
              <button
                className={`idle-sprite-preview ${isOpen ? "checked" : ""}`}
                onClick={() => setOpenPicker(isOpen ? null : i)}
              >
                <div className="sprite-preview-box">
                  {currentValue === "random" ? (
                    <span style={{ fontSize: 18, fontWeight: 800, color: "var(--muted)" }}>?</span>
                  ) : (
                    <span
                      className={`clawd-sprite clawd-sprite-${currentValue} clawd-gif-${idleBubbleGifClass[currentValue] ?? currentValue}`}
                      style={{ transform: `scale(${72 / Math.max(168, 168)})` }}
                    />
                  )}
                </div>
              </button>
            </div>
          );
        })}
      </div>
      {openPicker !== null && (
        <div className="state-anim-picker">
          <span className="state-anim-picker-title">
            {formatText(t("data.chooseIdleAnimation", "选择「{name}」的待机动画"), { name: companionLabels[openPicker] })}
            <button className="state-anim-picker-close" onClick={() => setOpenPicker(null)}>×</button>
          </span>
          <div className="state-anim-picker-grid">
            <button
              className={`idle-sprite-preview ${companionAnimValues[openPicker] === "random" ? "checked" : ""}`}
              onClick={() => { setCompanionAnim(openPicker, "random"); setOpenPicker(null); }}
            >
              <div className="sprite-preview-box">
                <span style={{ fontSize: 22, fontWeight: 800, color: "var(--muted)" }}>?</span>
              </div>
              <span className="idle-sprite-label">{t("common.random", "随机")}</span>
            </button>
            {idleSpriteOptions.map(opt => (
              <button
                key={opt.key}
                className={`idle-sprite-preview ${companionAnimValues[openPicker] === opt.key ? "checked" : ""}`}
                onClick={() => { setCompanionAnim(openPicker, opt.key); setOpenPicker(null); }}
              >
                <div className="sprite-preview-box">
                  <span
                    className={`clawd-sprite clawd-sprite-${opt.key} clawd-gif-${idleBubbleGifClass[opt.key] ?? opt.key}`}
                    style={{ transform: `scale(${72 / Math.max(opt.w, opt.h)})` }}
                  />
                </div>
                <span className="idle-sprite-label">{opt.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const stateAnimEntries: Array<{ state: PetState; labelKey: string; fallback: string; defaultSprite: string }> = [
  { state: "thinking", labelKey: "data.thinkingMessage", fallback: "思考 / 新消息", defaultSprite: "thinking" },
  { state: "tool_read", labelKey: "data.readFile", fallback: "读取文件", defaultSprite: "thinking" },
  { state: "tool_edit", labelKey: "data.editFile", fallback: "编辑文件", defaultSprite: "tool_edit" },
  { state: "tool_bash", labelKey: "data.runCommand", fallback: "执行命令", defaultSprite: "tool_read" },
  { state: "tool_search", labelKey: "data.searchDocs", fallback: "搜索资料", defaultSprite: "thinking" },
  { state: "tool_mcp", labelKey: "data.mcpTool", fallback: "MCP 工具", defaultSprite: "thinking" },
  { state: "skill", labelKey: "pet.skill", fallback: "技能", defaultSprite: "skill" },
  { state: "task", labelKey: "pet.task", fallback: "任务", defaultSprite: "task" },
  { state: "agent", labelKey: "data.subAgent", fallback: "子代理", defaultSprite: "agent" },
  { state: "waiting_permission", labelKey: "data.waitingConfirm", fallback: "等待确认", defaultSprite: "waiting_permission" },
  { state: "done", labelKey: "data.processDone", fallback: "处理完成", defaultSprite: "done" },
  { state: "error", labelKey: "pet.error", fallback: "错误", defaultSprite: "error" }
];

function StateAnimSettings({ stateAnimations, onChange }: { stateAnimations: Record<string, string>; onChange: (sa: Record<string, string>) => void }) {
  const { t } = useI18n();
  const formatText = (template: string, values: Record<string, string | number>) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);
  const [openKey, setOpenKey] = useState<string | null>(null);

  function selectSprite(state: string, sprite: string) {
    onChange({ ...stateAnimations, [state]: sprite });
    setOpenKey(null);
  }

  function resetState(state: string) {
    const next = { ...stateAnimations };
    delete next[state];
    onChange(next);
    setOpenKey(null);
  }

  return (
    <div className="state-anim-settings">
      <p className="note" style={{ marginTop: 0 }}>{t("data.actionPickerHint", "点击预览框展开选择器，再次点击其他动作自动收起。")}</p>
      <div className="state-anim-grid">
        {stateAnimEntries.map(entry => {
          const currentSprite = stateAnimations[entry.state] ?? entry.defaultSprite;
          const isOpen = openKey === entry.state;
          const opt = idleSpriteOptions.find(o => o.key === currentSprite);
          const spriteW = opt?.w ?? 168;
          const spriteH = opt?.h ?? 168;
          return (
            <div key={entry.state} className="state-anim-col">
              <span className="state-anim-col-label">{t(entry.labelKey, entry.fallback)}</span>
              <button
                className={`idle-sprite-preview ${isOpen ? "checked" : ""}`}
                onClick={() => setOpenKey(isOpen ? null : entry.state)}
              >
                <div className="sprite-preview-box">
                  <span
                    className={`clawd-sprite clawd-sprite-${currentSprite} clawd-gif-${idleBubbleGifClass[currentSprite] ?? currentSprite}`}
                    style={{ transform: `scale(${72 / Math.max(spriteW, spriteH)})` }}
                  />
                </div>
              </button>
            </div>
          );
        })}
      </div>
      {openKey && (
        <div className="state-anim-picker">
          <span className="state-anim-picker-title">
            {formatText(t("data.chooseActionAnimation", "选择「{name}」的动画"), { name: (() => { const entry = stateAnimEntries.find(e => e.state === openKey); return entry ? t(entry.labelKey, entry.fallback) : ""; })() })}
            <button className="state-anim-picker-close" onClick={() => setOpenKey(null)}>×</button>
          </span>
          <div className="state-anim-picker-grid">
            {idleSpriteOptions.map(opt => {
              const currentSprite = stateAnimations[openKey!] ?? stateAnimEntries.find(e => e.state === openKey!)!.defaultSprite;
              return (
                <button
                  key={opt.key}
                  className={`idle-sprite-preview ${currentSprite === opt.key ? "checked" : ""}`}
                  onClick={() => selectSprite(openKey!, opt.key)}
                >
                  <div className="sprite-preview-box">
                    <span
                      className={`clawd-sprite clawd-sprite-${opt.key} clawd-gif-${idleBubbleGifClass[opt.key] ?? opt.key}`}
                      style={{ transform: `scale(${72 / Math.max(opt.w, opt.h)})` }}
                    />
                  </div>
                  <span className="idle-sprite-label">{opt.label}</span>
                </button>
              );
            })}
            <button className="idle-sprite-preview reset" onClick={() => resetState(openKey!)}>
              <span className="idle-sprite-label">{t("common.resetDefault", "重置默认")}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RangeSlider({ label, min, max, step, low, high, format, onChange }: {
  label: string; min: number; max: number; step: number;
  low: number; high: number; format: (v: number) => string;
  onChange: (low: number, high: number) => void;
}) {
  const range = max - min;
  const leftPercent = ((low - min) / range) * 100;
  const rightPercent = ((high - min) / range) * 100;

  return (
    <label className="range-slider-row">
      <span>{label}</span>
      <div className="range-track">
        <div className="range-fill" style={{ left: `${leftPercent}%`, width: `${rightPercent - leftPercent}%` }} />
        <input
          type="range" min={min} max={max} step={step} value={low}
          onChange={e => { const v = Number(e.target.value); if (v <= high) onChange(v, high); }}
        />
        <input
          type="range" min={min} max={max} step={step} value={high}
          onChange={e => { const v = Number(e.target.value); if (v >= low) onChange(low, v); }}
        />
      </div>
      <b>{format(low)} — {format(high)}</b>
    </label>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function StatsPanel({ stats }: { stats: any }) {
  const { t } = useI18n();
  const toolUsage = stats.toolUsage as Record<string, number>;
  const sortedTools: Array<[string, number]> = Object.entries(toolUsage).sort((a, b) => b[1] - a[1]);
  const topHours = stats.hourlyActivity ? [...stats.hourlyActivity.map((v: number, i: number) => ({ hour: i, count: v }))].sort((a: any, b: any) => b.count - a.count).slice(0, 3) : [];
  const today = new Date().toISOString().slice(0, 10);
  const todayStats = stats.dailyStats?.[today];
  const totalToolCalls = Object.values(stats.toolUsage ?? {}).reduce((a: number, b: any) => a + b, 0) as number;
  const days = Object.keys(stats.dailyStats ?? {}).length;
  const avgDaily = days > 0 ? Math.round(totalToolCalls / days) : 0;
  const permTotal = (stats.permissionApproved ?? 0) + (stats.permissionDenied ?? 0);
  const permRate = permTotal > 0 ? Math.round((stats.permissionApproved / permTotal) * 100) : 0;

  return (
    <div className="stats-deep">
      <div className="stats-grid">
        <div className="stat-item"><span className="stat-value">{stats.totalSessions ?? 0}</span><span className="stat-label">{t("stats.totalSessions", "总会话数")}</span></div>
        <div className="stat-item"><span className="stat-value">{totalToolCalls}</span><span className="stat-label">{t("stats.totalToolCalls", "总工具调用")}</span></div>
        <div className="stat-item"><span className="stat-value">{stats.errorCount ?? 0}</span><span className="stat-label">{t("stats.errors", "错误次数")}</span></div>
        <div className="stat-item"><span className="stat-value">{formatDuration(stats.totalRuntime ?? 0)}</span><span className="stat-label">{t("stats.totalRuntime", "累计运行")}</span></div>
        <div className="stat-item"><span className="stat-value">{days}</span><span className="stat-label">{t("stats.activeDays", "活跃天数")}</span></div>
        <div className="stat-item"><span className="stat-value">{avgDaily}</span><span className="stat-label">{t("stats.dailyAvg", "日均调用")}</span></div>
      </div>
      <div className="panel-divider" />
      <h3 className="panel-subtitle">{t("stats.todayOverview", "今日概览")}</h3>
      <div className="stats-grid">
        <div className="stat-item"><span className="stat-value">{todayStats?.events ?? 0}</span><span className="stat-label">{t("stats.todayEvents", "事件")}</span></div>
        <div className="stat-item"><span className="stat-value">{todayStats?.toolCalls ?? 0}</span><span className="stat-label">{t("stats.todayToolCalls", "工具调用")}</span></div>
        <div className="stat-item"><span className="stat-value">{todayStats?.sessions ?? 0}</span><span className="stat-label">{t("stats.todaySessions", "会话")}</span></div>
      </div>
      {sortedTools.length > 0 && (
        <>
          <div className="panel-divider" />
          <h3 className="panel-subtitle">{t("stats.toolRanking", "工具使用排行")}</h3>
          <div className="tool-rank-list">
            {sortedTools.map(([tool, count]: [string, any], i: number) => (
              <div key={tool} className="tool-rank-row">
                <span className="tool-rank-pos">{i + 1}</span>
                <span className="tool-rank-name">{tool}</span>
                <div className="tool-rank-bar">
                  <div className="tool-rank-fill" style={{ width: `${(count / (sortedTools[0]?.[1] ?? 1)) * 100}%` }} />
                </div>
                <span className="tool-rank-count">{count}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {permTotal > 0 && (
        <>
          <div className="panel-divider" />
          <h3 className="panel-subtitle">{t("stats.permissionRequests", "权限请求")}</h3>
          <div className="stats-grid">
            <div className="stat-item"><span className="stat-value">{permTotal}</span><span className="stat-label">{t("stats.totalRequests", "总请求")}</span></div>
            <div className="stat-item"><span className="stat-value" style={{ color: "var(--mint)" }}>{stats.permissionApproved ?? 0}</span><span className="stat-label">{t("stats.approved", "已批准")}</span></div>
            <div className="stat-item"><span className="stat-value" style={{ color: "var(--coral)" }}>{stats.permissionDenied ?? 0}</span><span className="stat-label">{t("stats.denied", "已拒绝")}</span></div>
            <div className="stat-item"><span className="stat-value">{permRate}%</span><span className="stat-label">{t("stats.approvalRate", "批准率")}</span></div>
          </div>
        </>
      )}
      {topHours.length > 0 && topHours.some((h: any) => h.count > 0) && (
        <>
          <div className="panel-divider" />
          <h3 className="panel-subtitle">{t("stats.activeHours", "最活跃时段")}</h3>
          <div className="stats-grid">
            {topHours.filter((h: any) => h.count > 0).map((h: any) => (
              <div key={h.hour} className="stat-item">
                <span className="stat-value">{String(h.hour).padStart(2, "0")}:00</span>
                <span className="stat-label">{h.count} {t("stats.times", "次")}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TokenPanel() {
  const { t } = useI18n();
  const [stats, setStats] = useState<{ totalTokens: number; totalSessions: number; lastScannedAt: number; dailyTotals: { date: string; totalTokens: number; sessionCount: number }[]; modelTotals: { model: string; totalTokens: number; sessionCount: number; messageCount: number }[]; sessions: any[] } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllModels, setShowAllModels] = useState(false);
  const load = async (force = false) => {
    setError(null);
    if (force) setRefreshing(true);
    try {
      const result = await window.companion.getTokenStats(force);
      setStats(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { void load(false); }, []);

  const fmtTok = (n: number) => n >= 1_000_000_000 ? (n / 1_000_000_000).toFixed(2) + "B" : n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + "M" : n >= 1_000 ? (n / 1_000).toFixed(1) + "K" : String(n);

  if (error) return <div className="note" style={{ color: "var(--coral)" }}>{t("stats.scanFailed", "加载失败")}: {error}</div>;
  if (!stats) return <div className="note">{t("stats.scanning", "扫描中…")} {t("stats.scanHint", "首次扫描可能需要数十秒")}</div>;

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayEntry = stats.dailyTotals.find(d => d.date === todayStr);
  const todayTokens = todayEntry?.totalTokens ?? 0;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const last30 = stats.dailyTotals.filter(d => d.date >= thirtyDaysAgo).reduce((s, d) => s + d.totalTokens, 0);
  const last30Sessions = stats.dailyTotals.filter(d => d.date >= thirtyDaysAgo).reduce((s, d) => s + d.sessionCount, 0);

  // Build per-month calendar grids for the last 12 months
  const todayDate = new Date();
  const map = new Map(stats.dailyTotals.map(d => [d.date, d.totalTokens]));
  const allTokens = Array.from(map.values());
  const maxTokens = Math.max(1, ...allTokens);
  const getLevel = (tokens: number): 0 | 1 | 2 | 3 | 4 => {
    if (tokens <= 0) return 0;
    const r = tokens / maxTokens;
    if (r > 0.75) return 4;
    if (r > 0.5) return 3;
    if (r > 0.25) return 2;
    return 1;
  };
  // Generate 12 months: from (current month - 11) to current month
  const months: { label: string; cells: ({ date: string; tokens: number; level: 0|1|2|3|4 } | null)[] }[] = [];
  for (let offset = 11; offset >= 0; offset--) {
    const mDate = new Date(todayDate.getFullYear(), todayDate.getMonth() - offset, 1);
    const year = mDate.getFullYear();
    const month = mDate.getMonth();
    const label = document.documentElement.lang.startsWith("zh") ? `${month + 1}月` : mDate.toLocaleString("en-US", { month: "short" });
    const firstDow = mDate.getDay(); // 0=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: ({ date: string; tokens: number; level: 0|1|2|3|4 } | null)[] = [];
    // Pad before first day
    for (let i = 0; i < firstDow; i++) cells.push(null);
    // Fill days
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const tokens = map.get(ds) ?? 0;
      cells.push({ date: ds, tokens, level: getLevel(tokens) });
    }
    months.push({ label, cells });
  }

  return (
    <div className="token-panel">
      <div className="token-header">
        <div>
          <h3 className="panel-subtitle">{t("sections.tokenUsage", "Token 用量")}</h3>
          <p className="note">{Object.entries({ count: stats.totalSessions, time: new Date(stats.lastScannedAt).toLocaleString() }).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), t("stats.scannedSessions", "扫描 {count} 个会话 · 上次扫描 {time}"))}</p>
        </div>
        <button className="ghost-btn" onClick={() => load(true)} disabled={refreshing}>{refreshing ? t("stats.scanning", "扫描中…") : t("common.refresh", "刷新")}</button>
      </div>
      <div className="stats-grid">
        <div className="stat-item"><span className="stat-value">{todayTokens >= 1_000_000 ? (todayTokens/1_000_000).toFixed(2)+"M" : todayTokens >= 1_000 ? (todayTokens/1_000).toFixed(1)+"K" : todayTokens}</span><span className="stat-label">{t("stats.tokenToday", "今日")}</span></div>
        <div className="stat-item"><span className="stat-value">{last30 >= 1_000_000 ? (last30/1_000_000).toFixed(2)+"M" : last30 >= 1_000 ? (last30/1_000).toFixed(1)+"K" : last30}</span><span className="stat-label">{t("stats.token30d", "30天")}</span></div>
        <div className="stat-item"><span className="stat-value">{stats.totalTokens >= 1_000_000 ? (stats.totalTokens/1_000_000).toFixed(2)+"M" : stats.totalTokens >= 1_000 ? (stats.totalTokens/1_000).toFixed(1)+"K" : stats.totalTokens}</span><span className="stat-label">{t("stats.tokenTotal", "累计")}</span></div>
        <div className="stat-item"><span className="stat-value">{last30Sessions}</span><span className="stat-label">{t("stats.sessions30d", "30天会话数")}</span></div>
      </div>
      <div className="panel-divider" />
      <h3 className="panel-subtitle">{t("stats.last12m", "近 12 个月用量")}</h3>
      <div className="contrib-grid-wrap">
        <div className="contrib-grid">
          {months.map((m, mi) => (
            <div key={mi} className="contrib-month">
              <div className="contrib-month-title">{m.label}</div>
              <div className="contrib-month-cells">
                {m.cells.map((cell, ci) => cell ? (
                  <div key={ci} className={`contrib-cell level-${cell.level}`} title={`${cell.date}: ${fmtTok(cell.tokens)}`} />
                ) : <div key={ci} className="contrib-cell empty" />)}
              </div>
            </div>
          ))}
        </div>
        <div className="contrib-legend">
          <span>{t("stats.low", "少")}</span>
          <div className="contrib-cell level-0" />
          <div className="contrib-cell level-1" />
          <div className="contrib-cell level-2" />
          <div className="contrib-cell level-3" />
          <div className="contrib-cell level-4" />
          <span>{t("stats.high", "多")}</span>
        </div>
      </div>
      <div className="panel-divider" />
      <h3 className="panel-subtitle">{t("stats.byModel", "按模型拆分")} {stats.modelTotals.length > 0 && <span className="note-inline">{Object.entries({ count: stats.modelTotals.length }).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), t("stats.modelCount", "· 共 {count} 个"))}</span>}</h3>
      {stats.modelTotals.length === 0 ? <p className="note">{t("stats.noData", "无数据")}</p> : (
        <div className="token-table">
          <div className="token-table-header"><span>{t("stats.model", "模型")}</span><span>Tokens</span><span>{t("stats.todaySessions", "会话")}</span><span>{t("stats.messages", "消息")}</span></div>
          {(showAllModels ? stats.modelTotals : stats.modelTotals.slice(0, 5)).map(m => (
            <div key={m.model} className="token-table-row">
              <span className="token-model-name">{m.model}</span>
              <span>{m.totalTokens.toLocaleString("en-US")}</span>
              <span>{m.sessionCount}</span>
              <span>{m.messageCount}</span>
            </div>
          ))}
          {stats.modelTotals.length > 5 && (
            <button className="ghost-btn" style={{ marginTop: 4, width: "100%" }} onClick={() => setShowAllModels(v => !v)}>
              {showAllModels ? t("stats.collapse", "收起") : `${t("stats.showMore", "查看更多")} (${stats.modelTotals.length - 5})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function App() {
  const route = window.location.hash.replace("#/", "") || "settings";
  const localeRef = React.useRef<string | null>(null);
  const [locale, setLocaleState] = React.useState(() => {
    const saved = localStorage.getItem("clawd-locale");
    return saved === "en" || saved === "zh" ? saved : detectLocale();
  });

  React.useEffect(() => {
    const init = async () => {
      try {
        const settings = await window.companion.getSettings();
        const lang = settings.language === "auto" ? detectLocale() : settings.language;
        if (lang === "en" || lang === "zh") {
          setLocaleState(lang);
          localStorage.setItem("clawd-locale", lang);
        }
      } catch {}
    };
    init();
  }, []);

  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.setAttribute("data-ui-style", "classic");
    let themeMode: CompanionSettings["theme"] = "system";
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = () => {
      if (themeMode === "system") applyTheme("system");
    };

    const initTheme = async () => {
      try {
        const settings = await window.companion.getSettings();
        themeMode = settings.theme || "system";
        applyTheme(themeMode);
        applyUiStyle(settings.uiStyle || "classic");
      } catch {}
    };

    media.addEventListener("change", onSystemThemeChange);
    initTheme();
    return () => media.removeEventListener("change", onSystemThemeChange);
  }, []);

  return route === "pet" ? <PetApp /> : (
    <I18nProvider initialLocale={locale}>
      <SettingsApp />
    </I18nProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
