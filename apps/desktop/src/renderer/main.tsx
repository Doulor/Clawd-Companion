import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { defaultSettings, stateFromEvent } from "../shared/events";
import clawdImage from "./clawd.png";
import "./clawd-sprites/sprites.css";
import "./styles.css";

const clawdGifName: Record<PetState, string> = {
  idle: "clawd_png_idle",
  thinking: "thinking_speech",
  tool_read: "thinking_speech",
  tool_edit: "working_hardhat",
  tool_bash: "headset_focus",
  tool_search: "thinking_speech",
  tool_mcp: "thinking_speech",
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
  waiting_permission: { label: "等待确认", line: "需要你处理一个确认", tone: "honey" },
  done: { label: "完成", line: "这一轮已经处理完", tone: "green" },
  error: { label: "出错", line: "刚才有一步失败了", tone: "coral" }
};

const sampleEvents: CompanionEvent[] = [
  makeEvent("session_start", "manual", "Claude Code 会话开始", "Clawd 已经进入陪跑状态。"),
  makeEvent("prompt_submit", "manual", "收到新任务", "正在分析你的输入。"),
  makeEvent("tool_start", "manual", "正在读取文件", "Read 工具已开始。", "Read"),
  makeEvent("tool_start", "manual", "正在编辑代码", "Edit 工具已开始。", "Edit"),
  makeEvent("tool_start", "manual", "正在跑命令", "Bash 工具已开始。", "Bash"),
  makeEvent("tool_start", "manual", "正在搜索", "Grep/Glob 正在检索。", "Grep"),
  makeEvent("permission_wait", "manual", "需要确认", "Claude Code 正在等待你的许可。"),
  makeEvent("done", "manual", "处理完成", "这一轮已经结束。"),
  makeEvent("error", "manual", "执行失败", "有一个工具调用没有成功。")
];

const stateFeedbackMode: Record<PetState, FeedbackMode> = {
  idle: "card",
  thinking: "card",
  tool_read: "thought",
  tool_edit: "card",
  tool_bash: "thought",
  tool_search: "thought",
  tool_mcp: "thought",
  waiting_permission: "card",
  done: "card",
  error: "card"
};

function getFeedbackMode(event: CompanionEvent): FeedbackMode {
  if (event.tool && event.tool !== "Unknown") return "ribbon";
  return stateFeedbackMode[stateFromEvent(event)] ?? "card";
}

const mappingRows: Array<{ source: string; tool?: string; state: PetState; title: string }> = [
  { source: "SessionStart", state: "thinking", title: "会话开始" },
  { source: "UserPromptSubmit", state: "thinking", title: "收到用户输入" },
  { source: "PreToolUse", tool: "Read / Notebook", state: "tool_read", title: "读取文件" },
  { source: "PreToolUse", tool: "Edit / Write", state: "tool_edit", title: "修改文件" },
  { source: "PreToolUse", tool: "Bash", state: "tool_bash", title: "执行命令" },
  { source: "PreToolUse", tool: "Grep / Glob / WebFetch / WebSearch", state: "tool_search", title: "搜索资料" },
  { source: "PreToolUse", tool: "MCP", state: "tool_mcp", title: "MCP 工具" },
  { source: "PreToolUse", tool: "Agent / Skill", state: "thinking", title: "子代理 / 技能" },
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
  const sessionsRef = useRef<Map<string, CompanionSession>>(new Map());
  const ribbonTimers = useRef<Map<string, number>>(new Map());
  const ribbonTimestamps = useRef<Map<string, number>>(new Map());
  const eventThrottleRef = useRef<{ timer: number | null; lastFlush: number }>({ timer: null, lastFlush: 0 });
  const pendingEventsRef = useRef<CompanionEvent[]>([]);

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
        let title = existing?.title ?? "";
        if (event.event === "prompt_submit" && !title) {
          title = event.message.slice(0, 20) || sid.slice(0, 6);
        }
        const wasActive = existing?.isActive ?? true;
        const session: CompanionSession = {
          sessionId: sid,
          title: title || (existing?.title) || sid.slice(0, 6),
          state: stateFromEvent(event),
          lastEvent: event,
          lastEventTime: Date.now(),
          isActive: !isDone
        };
        sessionsRef.current.set(sid, session);
        setSessions(Array.from(sessionsRef.current.values()));
        if (wasActive && isDone) {
          setExitingSessions(prev => new Set(prev).add(sid));
          setTimeout(() => {
            setExitingSessions(prev => { const next = new Set(prev); next.delete(sid); return next; });
            sessionsRef.current.delete(sid);
            setSessions(Array.from(sessionsRef.current.values()));
          }, 700);
        }
      } else if (isDone) {
        for (const [id, s] of sessionsRef.current) {
          if (s.isActive) {
            sessionsRef.current.set(id, { ...s, isActive: false });
            setExitingSessions(prev => new Set(prev).add(id));
            const exitId = id;
            setTimeout(() => {
              setExitingSessions(prev => { const next = new Set(prev); next.delete(exitId); return next; });
              sessionsRef.current.delete(exitId);
              setSessions(Array.from(sessionsRef.current.values()));
            }, 700);
          }
        }
        setSessions(Array.from(sessionsRef.current.values()));
      }

      // 节流：100ms 内只刷新一次事件列表和 petState，减少高频事件时的渲染
      const now = Date.now();
      if (now - eventThrottleRef.current.lastFlush < 100) {
        pendingEventsRef.current.push(event);
        if (!eventThrottleRef.current.timer) {
          eventThrottleRef.current.timer = window.setTimeout(() => {
            const pending = pendingEventsRef.current;
            pendingEventsRef.current = [];
            eventThrottleRef.current.timer = null;
            eventThrottleRef.current.lastFlush = Date.now();
            const latest = pending[pending.length - 1];
            setEvents(previous => [...pending.reverse(), ...previous].slice(0, settings.eventHistoryLimit));
            setPetState(stateFromEvent(latest));
            setCurrentEvent(latest);
          }, 100 - (now - eventThrottleRef.current.lastFlush));
        }
      } else {
        eventThrottleRef.current.lastFlush = now;
        setEvents(previous => [event, ...previous].slice(0, settings.eventHistoryLimit));
        setPetState(stateFromEvent(event));
        setCurrentEvent(event);
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

  async function updateSettings(next: Partial<CompanionSettings>) {
    const saved = await window.companion.saveSettings(next);
    setSettings(saved);
  }

  async function respondToPermission(id: string, decision: "allow" | "deny") {
    await window.companion.respondPermission({
      id,
      decision,
      reason: decision === "allow" ? "Approved via Clawd" : "Denied via Clawd"
    });
    setActivePermissions(prev => prev.filter(p => p.id !== id));
  }

  return { settings, updateSettings, connection, events, currentEvent, petState, toolStreams, activePermissions, sessions, exitingSessions, respondToPermission };
}

function PetApp() {
  const { settings, updateSettings, currentEvent, petState, toolStreams, activePermissions, sessions, exitingSessions, connection, respondToPermission } = useCompanion();
  const editMode = settings.editPosition;
  const dragging = useRef<string | null>(null);
  const dragStart = useRef<{ mx: number; my: number; ox: number; oy: number }>({ mx: 0, my: 0, ox: 0, oy: 0 });
  const offRef = useRef(settings.positionOffsets ?? {});
  const [idleBubbleSprite, setIdleBubbleSprite] = useState<string | null>(null);
  const idleTimers = useRef<number[]>([]);

  // 响应测试按钮
  useEffect(() => {
    const off = window.companion.onTriggerIdleBubble(() => {
      setIdleBubbleSprite("idle");
      setTimeout(() => setIdleBubbleSprite(null), 2500);
    });
    return () => off();
  }, []);

  // 随机待机动画
  useEffect(() => {
    const cfg = settings.idleAnim;
    if (!cfg?.enabled || petState !== "idle" || editMode) {
      setIdleBubbleSprite(null);
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
        setIdleBubbleSprite(sprite);
        const t = window.setTimeout(() => {
          setIdleBubbleSprite(null);
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
  }, [petState, editMode, settings.idleAnim]);

  // 同步 idleBubbleSprite 到设置面板
  useEffect(() => {
    void window.companion.syncIdleBubble(idleBubbleSprite);
  }, [idleBubbleSprite]);

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
      if (activePermissions.length === 0) return;
      const handle = (e: MouseEvent) => {
        if (dragging.current) return;
        const target = e.target as HTMLElement;
        void window.companion.setPetInteractive(!!target.closest('.perm-card'));
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
      void window.companion.setPetInteractive(!!target.closest('.clawd, .bubble-wrapper, .tool-streams, .permission-card'));
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
              <ClawdSprite state={previewState} idleBubble={idleBubbleSprite} eventType={previewEvent.event} stateAnimations={settings.stateAnimations} />
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
          </div>
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
          <ClawdSprite state={petState} idleBubble={idleBubbleSprite} eventType={currentEvent?.event} stateAnimations={settings.stateAnimations} />
          {settings.showStatusProp && petState !== "idle" ? <StateProp state={petState} /> : null}
        </div>
        {settings.showBubbles && toolStreams.length > 0 ? (
          <ToolStreams streams={toolStreams} offset={offsets.ribbon} />
        ) : null}
        {(() => {
          if (!settings.multiSessionEnabled) return null;
          const companions = sessions.filter(s => (s.isActive || exitingSessions.has(s.sessionId)) && (exitingSessions.has(s.sessionId) || s.sessionId !== connection.activeSessionId)).slice(0, 3);
          if (companions.length === 0) {
            return <div style={{ position: "absolute", left: 10, top: 10, background: "red", color: "white", padding: "4px 8px", fontSize: 10, zIndex: 999, borderRadius: 4 }}>
              无伴生 | 会话:{sessions.length} 活跃:{connection.activeSessionId?.slice(0, 6) ?? "无"} 启用:{String(settings.multiSessionEnabled)}
            </div>;
          }
          return companions.map((session, i) => (
            <CompanionClawd
              key={session.sessionId}
              session={session}
              index={i}
              settings={settings}
              showTitle={settings.showSessionTitle}
              exiting={exitingSessions.has(session.sessionId)}
              mainClawdOffset={offsets.clawd ?? { x: 0, y: 0 }}
            />
          ));
        })()}
      </section>
    </main>
  );
}

function Bubble({ event, state, settings }: { event: CompanionEvent; state: PetState; settings: CompanionSettings }) {
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
          <span className="bubble-state">{stateCopy[state].label}</span>
          <span className="bubble-tool">{toolLabel}</span>
        </header>
        <strong>{event.title}</strong>
        <p>{event.message}</p>
        {event.detail ? <code className="bubble-detail">{event.detail}</code> : null}
        <footer className="bubble-footer">
          <span>{stateCopy[state].line}</span>
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
            <span className="perm-btn-key">Y</span> 允许
          </button>
          <button className="perm-btn perm-btn-deny" onClick={onDeny}>
            <span className="perm-btn-key">N</span> 拒绝
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
  error: "error_dead"
};

const eventSpriteOverride: Partial<Record<CompanionEvent["event"], { sprite: string; gif: string }>> = {
  session_start: { sprite: "tool_read", gif: "headset_focus" },
  prompt_submit: { sprite: "done", gif: "celebrate_bunny" }
};

function ClawdSprite({ state, idleBubble, eventType, stateAnimations }: { state: PetState; idleBubble?: string | null; eventType?: CompanionEvent["event"]; stateAnimations?: Record<string, string> }) {
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
  const spriteState = state === "tool_mcp" ? "thinking" : state === "tool_read" ? "thinking" : state === "tool_bash" ? "tool_read" : state;
  return <span className={`clawd-sprite clawd-sprite-${spriteState} clawd-gif-${clawdGifName[state]}`} aria-hidden="true" />;
}

function CompanionClawd({ session, index, settings, showTitle, exiting, mainClawdOffset }: { session: CompanionSession; index: number; settings: CompanionSettings; showTitle: boolean; exiting?: boolean; mainClawdOffset: { x: number; y: number } }) {
  const scale = settings.companionScale ?? 0.6;
  const offsets = settings.positionOffsets ?? {};
  const off = (offsets as any)[`companion${index}`] ?? { x: 80 + index * 100, y: -120 - index * 80 };
  const baseX = off.x;
  const baseY = off.y;

  return (
    <div
      className="companion-clawd"
      style={{
        transform: `translate(${baseX}px, ${baseY}px) scale(${scale})`,
        opacity: exiting ? 0 : 1,
        transition: exiting ? "opacity 0.6s ease-out" : "none"
      }}
    >
      {showTitle && session.title && (
        <div className="companion-title">{session.title}</div>
      )}
      <ClawdSprite state={session.state} stateAnimations={settings.stateAnimations} />
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
  const { settings, updateSettings, connection, events, petState, toolStreams } = useCompanion();
  const [copied, setCopied] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState("overview");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedTab, setAdvancedTab] = useState("privacy");
  const [now, setNow] = useState(Date.now());
  const [appVersion, setAppVersion] = useState("...");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    checking: false,
    available: false,
    upToDate: false,
    downloaded: false,
    downloading: false
  });
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [previewIdleBubble, setPreviewIdleBubble] = useState<string | null>(null);
  const [persistedStats, setPersistedStats] = useState<any>(null);
  const [onboardingDone, setOnboardingDone] = useState(() => {
    try { return localStorage.getItem("clawd-onboarding-done") === "1"; } catch { return true; }
  });
  const [onboardingStep, setOnboardingStep] = useState(0);
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
    // 每 10 秒刷新统计
    const statsInterval = window.setInterval(() => window.companion.getStats().then(setPersistedStats), 10_000);
    return () => { offUpdate(); offIdle(); window.clearInterval(statsInterval); };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const shell = document.querySelector(".settings-shell");
    const sections = ["overview", "connect", "appearance", "privacy"];
    function updateActiveSection() {
      const current = sections
        .map(id => ({ id, top: document.getElementById(id)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY }))
        .filter(section => section.top < 180)
        .sort((a, b) => b.top - a.top)[0];
      if (current) setActiveSection(current.id);
    }
    shell?.addEventListener("scroll", updateActiveSection, { passive: true });
    updateActiveSection();
    return () => shell?.removeEventListener("scroll", updateActiveSection);
  }, []);

  async function test(event: CompanionEvent) {
    await window.companion.sendTestEvent({ ...event, id: crypto.randomUUID(), timestamp: Date.now() });
  }

  function jumpTo(section: string) {
    setActiveSection(section);
    document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

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
          setTimeout(() => resolve({ ok: false, error: "检查超时，请检查网络连接后重试。" }), 15_000)
        )
      ]);
      if (!result.ok) {
        setUpdateStatus(prev => ({ ...prev, error: result.error }));
      }
    } catch {
      setUpdateStatus(prev => ({ ...prev, error: "检查更新失败，请稍后重试。" }));
    } finally {
      setCheckingUpdate(false);
    }
  }

  return (
    <main className="settings-shell">
      <section className="window-bar">
        <div className="window-title"><Sparkles size={16} />Clawd Companion</div>
        <div className="window-actions">
          <button title="最小化" onClick={() => window.companion.minimizeSettings()}>-</button>
          <button title="最大化/还原" onClick={() => window.companion.toggleMaximizeSettings()}>□</button>
          <button className="close" title="关闭配置" onClick={() => window.companion.closeSettings()}>×</button>
        </div>
      </section>
      <aside className="rail">
        <div className="mark"><Sparkles size={26} /></div>
        <button className={`rail-button ${activeSection === "overview" ? "active" : ""}`} title="总览" onClick={() => jumpTo("overview")}><Gauge size={20} /></button>
        <button className={`rail-button ${activeSection === "connect" ? "active" : ""}`} title="连接" onClick={() => jumpTo("connect")}><PlugZap size={20} /></button>
        <button className={`rail-button ${activeSection === "appearance" ? "active" : ""}`} title="桌宠" onClick={() => jumpTo("appearance")}><Bot size={20} /></button>
        <button className={`rail-button ${activeSection === "privacy" ? "active" : ""}`} title="隐私" onClick={() => jumpTo("privacy")}><Shield size={20} /></button>
      </aside>

      <section className="hero-panel" id="overview">
        <div>
          <p className="eyebrow">Clawd Companion</p>
          <h1>{connection.connected ? "Clawd 正在跟随 Claude 会话" : "Clawd 等待 Claude 会话接入"}</h1>
          <p className="subtle">{connection.connected ? `${connection.activeClientLabel ?? "Claude Code"} 最近在 ${timeAgo(connection.lastEventAt, now)} 发来事件。` : "本地监听已经准备好；打开 Claude CLI 或已配置 hooks 的 Claude Code 会话后会自动连接。"}</p>
          <div className="hero-status-board">
            <ConnectionPill connected={connection.connected} label={connection.activeClientLabel} />
            <code>{shortSession(connection.activeSessionId)}</code>
          </div>
        </div>
        <div className="mini-stage"><div className="mini-pet"><Clawd key={previewIdleBubble ?? "idle"} state={petState} settings={settings} forceIdleBubble={previewIdleBubble} /></div></div>
      </section>

      {!onboardingDone && (
        <section className="onboarding-card">
          <div className="onboarding-steps">
            {["欢迎", "连接", "完成"].map((label, i) => (
              <div key={label} className={`onboarding-step ${i === onboardingStep ? "active" : i < onboardingStep ? "done" : ""}`}>
                <span className="onboarding-step-num">{i + 1}</span>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="onboarding-content">
            {onboardingStep === 0 && (
              <>
                <h3>欢迎使用 Clawd Companion</h3>
                <p>Clawd 是 Claude Code 的桌面宠物伴侣，会在你使用 Claude Code 时实时显示工具调用、会话状态和动画反馈。</p>
                <p className="note">接下来只需 2 步即可开始使用。</p>
              </>
            )}
            {onboardingStep === 1 && (
              <>
                <h3>连接 Claude Code</h3>
                <p>点击下方按钮，Clawd 会自动配置 Claude Code 的 hooks，让 Claude Code 把事件发送给 Clawd。</p>
                <div className="hooks-manager" style={{ marginTop: 12 }}>
                  <HooksManager />
                </div>
              </>
            )}
            {onboardingStep === 2 && (
              <>
                <h3>一切就绪</h3>
                <p>打开任意 Claude Code 会话，Clawd 会自动跟随。你可以在配置面板中调整桌宠外观、动画和行为。</p>
                <p className="note">点击下方按钮开始使用。</p>
              </>
            )}
          </div>
          <div className="onboarding-actions">
            {onboardingStep > 0 && <button className="ghost" onClick={() => setOnboardingStep(onboardingStep - 1)}>上一步</button>}
            <button onClick={() => {
              if (onboardingStep < 2) setOnboardingStep(onboardingStep + 1);
              else { localStorage.setItem("clawd-onboarding-done", "1"); setOnboardingDone(true); }
            }}>{onboardingStep < 2 ? "下一步" : "开始使用"}</button>
          </div>
        </section>
      )}

      <section className="status-strip">
        <StatusCard icon={<Radio size={18} />} label="连接状态" value={connection.connected ? "已连接" : connection.serverListening ? "等待会话" : "未监听"} meta={connection.activeClientLabel} tone={connection.connected ? "good" : connection.serverListening ? "wait" : "bad"} />
        <StatusCard icon={<Timer size={18} />} label="最近事件" value={connection.lastEventAt ? timeAgo(connection.lastEventAt, now) : "还没收到"} tone={connection.lastEventAt ? "good" : "wait"} />
        <StatusCard icon={<Shield size={18} />} label="会话" value={shortSession(connection.activeSessionId)} tone="neutral" />
        <StatusCard icon={<MonitorCheck size={18} />} label="本地监听" value={connection.serverListening ? `127.0.0.1:${connection.port}` : "未监听"} tone={connection.serverListening ? "good" : "bad"} />
      </section>

      {connection.error ? <section className="connection-error"><Wrench size={18} />{connection.error}</section> : null}

      <section className="content-grid">
        {onboardingDone && (
          <Panel id="connect" title="Claude Code 连接" icon={<PlugZap size={18} />} wide>
            <HooksManager />
            <div className="panel-divider" />
            <div className="connection-detail-grid">
              <ConnectionDetail label="状态" value={connection.connected ? "已连接" : connection.serverListening ? "等待 Claude 会话" : "本地服务未监听"} />
              <ConnectionDetail label="客户端" value={connection.activeClientLabel ?? "未知客户端"} />
              <ConnectionDetail label="会话 ID" value={shortSession(connection.activeSessionId)} />
              <ConnectionDetail label="最后活动" value={connection.lastEventAt ? timeAgo(connection.lastEventAt, now) : "暂无"} />
            </div>
          </Panel>
        )}

        <Panel id="appearance" title="桌宠外观" icon={<Bot size={18} />} wide>
          <div className="settings-columns">
            <section className="settings-group">
              <h3 className="panel-subtitle">显示</h3>
              <Toggle label="启用桌宠" checked={settings.petEnabled} onChange={petEnabled => updateSettings({ petEnabled })} />
              <Toggle label="始终置顶" checked={settings.alwaysOnTop} onChange={alwaysOnTop => updateSettings({ alwaysOnTop })} />
              <Toggle label="完全点击穿透" checked={settings.clickThrough} onChange={clickThrough => updateSettings({ clickThrough })} />
              <Toggle label="显示气泡" checked={settings.showBubbles} onChange={showBubbles => updateSettings({ showBubbles })} />
              <Toggle label="显示状态图标" checked={settings.showStatusProp} onChange={showStatusProp => updateSettings({ showStatusProp })} />
              <Toggle label="编辑桌宠位置" checked={settings.editPosition} onChange={editPosition => updateSettings({ editPosition })} />
              {settings.editPosition ? <button className="inline-action" onClick={() => updateSettings({ positionOffsets: defaultSettings.positionOffsets, zoneSizes: defaultSettings.zoneSizes, clawdScale: defaultSettings.clawdScale, thoughtScale: defaultSettings.thoughtScale, bubbleScale: defaultSettings.bubbleScale, cardScale: defaultSettings.cardScale, petScale: defaultSettings.petScale, viewScale: defaultSettings.viewScale })}>重置全部</button> : null}
            </section>
            <section className="settings-group">
              <h3 className="panel-subtitle">尺寸与透明度</h3>
              <Slider label="整体尺寸" min={0.7} max={1.45} step={0.05} value={settings.petScale} format={value => `${Math.round(value * 100)}%`} onChange={petScale => updateSettings({ petScale })} />
              <Slider label="Clawd尺寸" min={0.7} max={1.35} step={0.05} value={settings.clawdScale} format={value => `${Math.round(value * 100)}%`} onChange={clawdScale => updateSettings({ clawdScale })} />
              <Slider label="Clawd透明" min={0.45} max={1} step={0.05} value={settings.clawdOpacity} format={value => `${Math.round(value * 100)}%`} onChange={clawdOpacity => updateSettings({ clawdOpacity })} />
              <Slider label="思维泡尺寸" min={0.75} max={1.35} step={0.05} value={settings.thoughtScale} format={value => `${Math.round(value * 100)}%`} onChange={thoughtScale => updateSettings({ thoughtScale })} />
              <Slider label="思维泡透明" min={0.45} max={1} step={0.05} value={settings.thoughtOpacity} format={value => `${Math.round(value * 100)}%`} onChange={thoughtOpacity => updateSettings({ thoughtOpacity })} />
              <Slider label="卡片尺寸" min={0.75} max={1.25} step={0.05} value={settings.cardScale} format={value => `${Math.round(value * 100)}%`} onChange={cardScale => updateSettings({ cardScale })} />
              <Slider label="卡片透明" min={0.45} max={1} step={0.05} value={settings.cardOpacity} format={value => `${Math.round(value * 100)}%`} onChange={cardOpacity => updateSettings({ cardOpacity })} />
            </section>
          </div>
        </Panel>

        <Panel title="应用行为" icon={<MousePointer2 size={18} />}>
          <Toggle label="开机自启" checked={settings.launchAtLogin} onChange={launchAtLogin => updateSettings({ launchAtLogin })} />
          <Toggle label="启动时打开配置面板" checked={settings.openSettingsOnStart} onChange={openSettingsOnStart => updateSettings({ openSettingsOnStart })} />
          <Toggle label="完成时系统通知" checked={settings.doneSound} onChange={doneSound => updateSettings({ doneSound })} />
          <Slider label="气泡停留" min={3} max={18} step={1} value={settings.bubbleDuration} format={value => `${value} 秒`} onChange={bubbleDuration => updateSettings({ bubbleDuration })} />
          <Slider label="工具流停留" min={0.3} max={3} step={0.1} value={settings.toolStreamMinDuration} format={value => `${value.toFixed(1)} 秒`} onChange={toolStreamMinDuration => updateSettings({ toolStreamMinDuration })} />
          <Slider label="事件历史" min={12} max={100} step={4} value={settings.eventHistoryLimit} format={value => `${value} 条`} onChange={eventHistoryLimit => updateSettings({ eventHistoryLimit })} />
          <div className="panel-divider" />
          <h3 className="panel-subtitle">多会话模式</h3>
          <Toggle label="启用多会话" checked={settings.multiSessionEnabled} onChange={multiSessionEnabled => updateSettings({ multiSessionEnabled })} />
          {settings.multiSessionEnabled && (
            <>
              <Toggle label="显示会话标题" checked={settings.showSessionTitle} onChange={showSessionTitle => updateSettings({ showSessionTitle })} />
              <Slider label="小 Clawd 缩放" min={0.3} max={0.8} step={0.05} value={settings.companionScale} format={value => `${Math.round(value * 100)}%`} onChange={companionScale => updateSettings({ companionScale })} />
            </>
          )}
        </Panel>

        <Panel title="运行统计" icon={<Gauge size={18} />} wide>
          {persistedStats ? <StatsPanel stats={persistedStats} /> : <p className="note">加载中...</p>}
          <div className="panel-divider" />
          <Toggle label="高级选项" checked={showAdvanced} onChange={setShowAdvanced} />
        </Panel>

        {showAdvanced && (
          <Panel id="privacy" title="高级设置" icon={<Shield size={18} />} wide>
            <div className="advanced-tabs">
              {[
                ["privacy", "隐私端口"],
                ["idle", "待机动画"],
                ["mapping", "动作映射"],
                ["test", "测试事件"],
                ["config", "配置管理"],
                ["data", "数据管理"]
              ].map(([key, label]) => (
                <button key={key} className={advancedTab === key ? "active" : ""} onClick={() => setAdvancedTab(key)}>{label}</button>
              ))}
            </div>
            <div className="advanced-content">
              {advancedTab === "privacy" && (
                <div className="settings-columns compact">
                  <section className="settings-group">
                    <Field label="事件端口">
                      <input value={settings.port} onChange={event => updateSettings({ port: Number(event.target.value) || defaultSettings.port })} />
                    </Field>
                    <Field label="本地 token">
                      <input value={settings.token} onChange={event => updateSettings({ token: event.target.value })} />
                    </Field>
                  </section>
                  <section className="settings-group">
                    <Segmented value={settings.privacyMode} onChange={privacyMode => updateSettings({ privacyMode })} />
                    <p className="note">安全模式只显示工具类型；标准模式显示文件名和搜索模式；详细模式可显示被截断的命令摘要。</p>
                  </section>
                </div>
              )}
              {advancedTab === "idle" && (
                <IdleAnimSettings config={settings.idleAnim ?? defaultSettings.idleAnim!} onChange={cfg => updateSettings({ idleAnim: cfg })} />
              )}
              {advancedTab === "mapping" && (
                <StateAnimSettings stateAnimations={settings.stateAnimations ?? {}} onChange={sa => updateSettings({ stateAnimations: sa })} />
              )}
              {advancedTab === "test" && (
                <div className="test-grid">
                  {sampleEvents.map(event => <button key={`${event.event}-${event.tool ?? "x"}`} onClick={() => test(event)}>{event.title}</button>)}
                  <button onClick={() => window.companion.triggerIdleBubble()}>待机动画</button>
                  <button onClick={async () => {
                    const sid1 = "test-" + Math.random().toString(36).slice(2, 8);
                    const sid2 = "test-" + Math.random().toString(36).slice(2, 8);
                    const send = (e: CompanionEvent) => window.companion.sendTestEvent(e);
                    // 会话 1 开始并运行 Read
                    await send({ ...makeEvent("session_start", "manual", "会话 1 测试", "前端"), sessionId: sid1, tool: undefined });
                    await send({ ...makeEvent("tool_start", "manual", "读取文件", "package.json"), sessionId: sid1, tool: "Read" as ToolName });
                    // 会话 2 开始并运行 Bash
                    await send({ ...makeEvent("session_start", "manual", "会话 2 测试", "后端"), sessionId: sid2, tool: undefined });
                    await send({ ...makeEvent("tool_start", "manual", "执行命令", "npm install"), sessionId: sid2, tool: "Bash" as ToolName });
                  }}>多会话测试</button>
                  <button onClick={async () => {
                    await window.companion.sendTestEvent({ ...makeEvent("done", "manual", "任务完成", "两个会话都结束了"), sessionId: undefined, tool: undefined });
                  }}>结束全部会话</button>
                </div>
              )}
              {advancedTab === "config" && (
                <div className="settings-columns compact">
                  <section className="settings-group">
                    <div className="command-row compact">
                      <span>导出当前配置</span>
                      <button onClick={async () => {
                        const result = await window.companion.exportSettingsFile();
                        if (result.ok) {
                          setCopied("export-file");
                          setTimeout(() => setCopied(null), 2000);
                        }
                      }}><FileText size={15} />{copied === "export-file" ? "已导出" : "保存到文件"}</button>
                    </div>
                  </section>
                  <section className="settings-group">
                    <div className="command-row compact">
                      <span>导入配置</span>
                      <button onClick={async () => {
                        const result = await window.companion.importSettingsFile();
                        setCopied(result.ok ? "import-file-ok" : result.error ? "import-file-fail" : "");
                        if (result.ok) window.location.reload();
                        setTimeout(() => setCopied(null), 2000);
                      }}><FileText size={15} />{copied === "import-file-ok" ? "已导入" : copied === "import-file-fail" ? "失败" : "从文件导入"}</button>
                    </div>
                    <p className="note">从 JSON 文件导入配置，会覆盖当前设置。</p>
                  </section>
                </div>
              )}
              {advancedTab === "data" && (
                <div className="settings-columns compact">
                  <section className="settings-group">
                    <div className="command-row compact">
                      <span>导出统计数据</span>
                      <button onClick={async () => {
                        const result = await window.companion.exportStatsFile();
                        if (result.ok) setCopied("stats-export");
                        setTimeout(() => setCopied(null), 2000);
                      }}><FileText size={15} />{copied === "stats-export" ? "已导出" : "保存到文件"}</button>
                    </div>
                  </section>
                  <section className="settings-group">
                    <div className="command-row compact">
                      <span>导入统计数据</span>
                      <button onClick={async () => {
                        const result = await window.companion.importStatsFile();
                        if (result.ok) window.location.reload();
                        setCopied(result.ok ? "stats-import-ok" : "stats-import-fail");
                        setTimeout(() => setCopied(null), 2000);
                      }}><FileText size={15} />{copied === "stats-import-ok" ? "已导入" : copied === "stats-import-fail" ? "失败" : "从文件导入"}</button>
                    </div>
                    <p className="note">从 JSON 文件导入统计数据，会覆盖当前数据。</p>
                  </section>
                  <section className="settings-group" style={{ gridColumn: "1 / -1" }}>
                    <div className="command-row compact">
                      <span>清空统计数据</span>
                      <button className="danger" onClick={async () => {
                        if (confirm("确定要清空所有统计数据吗？此操作不可恢复。")) {
                          await window.companion.resetStats();
                          window.location.reload();
                        }
                      }}><X size={15} />清空</button>
                    </div>
                    <p className="note">永久删除所有累计统计数据，此操作不可恢复。</p>
                  </section>
                </div>
              )}
            </div>
          </Panel>
        )}

        <Panel title="最近事件" icon={<Bell size={18} />} wide>
          <div className="event-list">
            {events.length === 0 ? <div className="empty">还没有收到事件。先复制 hooks 配置，或点击测试事件看状态变化。</div> : events.map(event => (
              <article key={event.id} className="event-row">
                <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
                <strong>{event.title}</strong>
                <p>{event.message}</p>
                <small>{timeAgo(event.timestamp, now)}</small>
                <em>{stateCopy[stateFromEvent(event)].label}</em>
              </article>
            ))}
          </div>
        </Panel>
      </section>

      <footer className="version-bar">
        <div className="version-left">
          <span className="version-label">Clawd Companion</span>
          <span className="version-number">v{appVersion}</span>
          <button
            className="version-link"
            onClick={() => window.companion.openExternal("https://github.com/Doulor/Clawd-Companion")}
            title="在 GitHub 上查看"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.605-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12 24 5.37 18.63 0 12 0z"/></svg>
            GitHub
          </button>
        </div>
        <div className="version-right">
          {updateStatus.error ? (
            <span className="update-error">{updateStatus.error}</span>
          ) : updateStatus.downloaded ? (
            <button className="update-btn update-ready" onClick={() => window.companion.installUpdate()}>
              点击重启并安装 v{updateStatus.version}
            </button>
          ) : updateStatus.downloading ? (
            <span className="update-progress">下载中 {Math.round(updateStatus.progress ?? 0)}%</span>
          ) : updateStatus.checking ? (
            <span className="update-checking">正在检查更新...</span>
          ) : updateStatus.available ? (
            <span className="update-available">发现新版本 v{updateStatus.version}，正在下载...</span>
          ) : updateStatus.upToDate ? (
            <span className="update-uptodate"><Check size={14} />已是最新版本</span>
          ) : (
            <button className="update-btn" onClick={handleCheckUpdate} disabled={checkingUpdate}>
              {checkingUpdate ? "检查中..." : "检查更新"}
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

function HooksManager() {
  const [status, setStatus] = useState<{ installed: boolean; configExists: boolean; hookCount: number; requiredCount: number; missingEvents: string[]; commandMatches: boolean } | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    window.companion.checkHooks().then(setStatus);
  }, []);

  async function handleInstall() {
    setAction("installing");
    const res = await window.companion.installHooks();
    setResult(res.success ? "安装成功！重启 Claude Code 会话后生效。" : `安装失败: ${res.error}`);
    setStatus(await window.companion.checkHooks());
    setAction(null);
  }

  async function handleRepair() {
    setAction("repairing");
    const res = await window.companion.repairHooks();
    setResult(res.success ? `修复完成，修复了 ${res.fixed.length} 项配置。` : `修复失败: ${res.error}`);
    setStatus(await window.companion.checkHooks());
    setAction(null);
  }

  async function handleRemove() {
    setAction("removing");
    const res = await window.companion.removeHooks();
    setResult(res.success ? "已移除所有 Clawd hooks。" : `移除失败: ${res.error}`);
    setStatus(await window.companion.checkHooks());
    setAction(null);
  }

  return (
    <div className="hooks-manager">
      <StatusCard
        icon={<Wrench size={18} />}
        label="Hooks 状态"
        value={status?.installed ? "已安装" : status?.configExists ? "部分安装" : "未安装"}
        tone={status?.installed ? "good" : status?.configExists ? "wait" : "bad"}
      />

      <div className="hooks-detail">
        <span>已配置 {status?.hookCount ?? 0} / {status?.requiredCount ?? 6} 个事件</span>
        {status?.missingEvents && status.missingEvents.length > 0 && (
          <span className="hooks-missing">缺少: {status.missingEvents.join(", ")}</span>
        )}
        {status && !status.commandMatches && status.configExists && (
          <span className="hooks-mismatch">命令路径不匹配，建议修复</span>
        )}
      </div>

      <div className="hooks-actions">
        <button onClick={handleInstall} disabled={!!action}>
          {action === "installing" ? "安装中..." : "一键安装"}
        </button>
        <button onClick={handleRepair} disabled={!!action}>
          {action === "repairing" ? "修复中..." : "修复配置"}
        </button>
        <button className="danger" onClick={handleRemove} disabled={!!action}>
          {action === "removing" ? "移除中..." : "移除 Hooks"}
        </button>
      </div>

      {result && <p className="hooks-result">{result}</p>}

      <p className="note">安装 hooks 后，Claude Code 会自动将事件发送到 Clawd Companion。备份文件保存在 ~/.claude/settings.clawd-backup.json</p>
    </div>
  );
}

function StatusCard({ icon, label, value, meta, tone }: { icon: React.ReactNode; label: string; value: string; meta?: string; tone: "good" | "bad" | "wait" | "neutral" }) {
  return <article className={`status-card ${tone}`}>{icon}<span>{label}</span><strong>{value}</strong>{meta ? <small>{meta}</small> : null}</article>;
}

function ConnectionPill({ connected, label }: { connected: boolean; label?: string }) {
  return <span className={`connection-pill ${connected ? "connected" : "waiting"}`}><i />{connected ? "已连接" : "等待连接"}{label ? <small>{label}</small> : null}</span>;
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

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
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
  const items: Array<{ value: PrivacyMode; label: string }> = [
    { value: "safe", label: "安全" },
    { value: "standard", label: "标准" },
    { value: "detailed", label: "详细" }
  ];
  return <div className="segmented">{items.map(item => <button key={item.value} className={value === item.value ? "active" : ""} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>;
}

function privacyLabel(mode: PrivacyMode) {
  if (mode === "safe") return "安全";
  if (mode === "standard") return "标准";
  return "详细";
}

function shortSession(sessionId?: string) {
  if (!sessionId) return "无会话";
  return sessionId.length > 12 ? `${sessionId.slice(0, 6)}...${sessionId.slice(-4)}` : sessionId;
}

function timeAgo(timestamp: number | undefined, now = Date.now()) {
  if (!timestamp) return "暂无";
  const seconds = Math.max(1, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  return `${hours} 小时前`;
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
  { key: "error", label: "error_dead", w: 168, h: 182 }
];

function IdleAnimSettings({ config, onChange }: { config: IdleAnimConfig; onChange: (cfg: IdleAnimConfig) => void }) {
  function toggleSprite(key: string) {
    const next = config.selectedSprites.includes(key)
      ? config.selectedSprites.filter(s => s !== key)
      : [...config.selectedSprites, key];
    onChange({ ...config, selectedSprites: next });
  }

  return (
    <div className="idle-anim-settings">
      <Toggle label="启用待机随机动画" checked={config.enabled} onChange={enabled => onChange({ ...config, enabled })} />
      <div className="panel-divider" />
      <h3 className="panel-subtitle">可选动画</h3>
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
        label="播放间隔"
        min={5}
        max={120}
        step={5}
        low={config.intervalMin}
        high={config.intervalMax}
        format={v => `${v} 秒`}
        onChange={(low, high) => onChange({ ...config, intervalMin: low, intervalMax: high })}
      />
      <div className="panel-divider" />
      <RangeSlider
        label="每次播放次数"
        min={1}
        max={5}
        step={1}
        low={config.repeatMin}
        high={config.repeatMax}
        format={v => `${v} 次`}
        onChange={(low, high) => onChange({ ...config, repeatMin: low, repeatMax: high })}
      />
      <p className="note">待机时在勾选的动画中随机挑选播放。若未勾选任何动画则默认使用 idle_bubble。</p>
    </div>
  );
}

const stateAnimEntries: Array<{ state: PetState; label: string; defaultSprite: string }> = [
  { state: "thinking", label: "思考 / 新消息", defaultSprite: "thinking" },
  { state: "tool_read", label: "读取文件", defaultSprite: "thinking" },
  { state: "tool_edit", label: "编辑文件", defaultSprite: "tool_edit" },
  { state: "tool_bash", label: "执行命令", defaultSprite: "tool_read" },
  { state: "tool_search", label: "搜索资料", defaultSprite: "thinking" },
  { state: "waiting_permission", label: "等待确认", defaultSprite: "waiting_permission" },
  { state: "done", label: "处理完成", defaultSprite: "done" },
  { state: "error", label: "错误", defaultSprite: "error" }
];

function StateAnimSettings({ stateAnimations, onChange }: { stateAnimations: Record<string, string>; onChange: (sa: Record<string, string>) => void }) {
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
      <p className="note" style={{ marginTop: 0 }}>点击预览框展开选择器，再次点击其他动作自动收起。</p>
      <div className="state-anim-grid">
        {stateAnimEntries.map(entry => {
          const currentSprite = stateAnimations[entry.state] ?? entry.defaultSprite;
          const isOpen = openKey === entry.state;
          return (
            <div key={entry.state} className="state-anim-col">
              <span className="state-anim-col-label">{entry.label}</span>
              <button
                className={`idle-sprite-preview ${isOpen ? "checked" : ""}`}
                onClick={() => setOpenKey(isOpen ? null : entry.state)}
              >
                <div className="sprite-preview-box">
                  <span
                    className={`clawd-sprite clawd-sprite-${currentSprite} clawd-gif-${idleBubbleGifClass[currentSprite] ?? currentSprite}`}
                    style={{ transform: `scale(${72 / Math.max(168, 168)})` }}
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
            选择「{stateAnimEntries.find(e => e.state === openKey)?.label}」的动画
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
              <span className="idle-sprite-label">重置默认</span>
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
        <div className="stat-item"><span className="stat-value">{stats.totalSessions ?? 0}</span><span className="stat-label">总会话数</span></div>
        <div className="stat-item"><span className="stat-value">{totalToolCalls}</span><span className="stat-label">总工具调用</span></div>
        <div className="stat-item"><span className="stat-value">{stats.errorCount ?? 0}</span><span className="stat-label">错误次数</span></div>
        <div className="stat-item"><span className="stat-value">{formatDuration(stats.totalRuntime ?? 0)}</span><span className="stat-label">累计运行</span></div>
        <div className="stat-item"><span className="stat-value">{days}</span><span className="stat-label">活跃天数</span></div>
        <div className="stat-item"><span className="stat-value">{avgDaily}</span><span className="stat-label">日均调用</span></div>
      </div>
      <div className="panel-divider" />
      <h3 className="panel-subtitle">今日概览</h3>
      <div className="stats-grid">
        <div className="stat-item"><span className="stat-value">{todayStats?.events ?? 0}</span><span className="stat-label">事件</span></div>
        <div className="stat-item"><span className="stat-value">{todayStats?.toolCalls ?? 0}</span><span className="stat-label">工具调用</span></div>
        <div className="stat-item"><span className="stat-value">{todayStats?.sessions ?? 0}</span><span className="stat-label">会话</span></div>
      </div>
      {sortedTools.length > 0 && (
        <>
          <div className="panel-divider" />
          <h3 className="panel-subtitle">工具使用排行</h3>
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
          <h3 className="panel-subtitle">权限请求</h3>
          <div className="stats-grid">
            <div className="stat-item"><span className="stat-value">{permTotal}</span><span className="stat-label">总请求</span></div>
            <div className="stat-item"><span className="stat-value" style={{ color: "var(--mint)" }}>{stats.permissionApproved ?? 0}</span><span className="stat-label">已批准</span></div>
            <div className="stat-item"><span className="stat-value" style={{ color: "var(--coral)" }}>{stats.permissionDenied ?? 0}</span><span className="stat-label">已拒绝</span></div>
            <div className="stat-item"><span className="stat-value">{permRate}%</span><span className="stat-label">批准率</span></div>
          </div>
        </>
      )}
      {topHours.length > 0 && topHours.some((h: any) => h.count > 0) && (
        <>
          <div className="panel-divider" />
          <h3 className="panel-subtitle">最活跃时段</h3>
          <div className="stats-grid">
            {topHours.filter((h: any) => h.count > 0).map((h: any) => (
              <div key={h.hour} className="stat-item">
                <span className="stat-value">{String(h.hour).padStart(2, "0")}:00</span>
                <span className="stat-label">{h.count} 次</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function App() {
  const route = window.location.hash.replace("#/", "") || "settings";
  return route === "pet" ? <PetApp /> : <SettingsApp />;
}

createRoot(document.getElementById("root")!).render(<App />);
