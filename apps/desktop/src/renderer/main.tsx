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
import type { CompanionConnectionStatus, CompanionEvent, CompanionSettings, FeedbackMode, PetState, PrivacyMode, ToolName } from "../shared/events";
import { defaultSettings, stateFromEvent } from "../shared/events";
import clawdImage from "./clawd.png";
import "./styles.css";

const stateCopy: Record<PetState, { label: string; line: string; tone: string }> = {
  idle: { label: "待机", line: "Clawd 在桌面边缘小憩", tone: "sand" },
  thinking: { label: "思考中", line: "正在整理上下文", tone: "blue" },
  tool_read: { label: "读取", line: "正在看文件", tone: "green" },
  tool_edit: { label: "编辑", line: "正在改代码", tone: "coral" },
  tool_bash: { label: "终端", line: "正在执行命令", tone: "ink" },
  tool_search: { label: "搜索", line: "正在检索线索", tone: "blue" },
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

function getFeedbackMode(event: CompanionEvent, settings: CompanionSettings): FeedbackMode {
  if (event.tool && event.tool !== "Unknown" && settings.toolFeedbackModes?.[event.tool]) {
    return settings.toolFeedbackModes[event.tool]!;
  }
  return settings.feedbackModes?.[stateFromEvent(event)] ?? "card";
}

const toolFeedbackRows: Array<{ tool: ToolName; label: string }> = [
  { tool: "Read", label: "读取文件" },
  { tool: "Edit", label: "编辑文件" },
  { tool: "Write", label: "写入文件" },
  { tool: "Bash", label: "执行命令" },
  { tool: "Grep", label: "搜索内容" },
  { tool: "Glob", label: "搜索文件" },
  { tool: "WebFetch", label: "抓取网页" },
  { tool: "Task", label: "子任务" }
];

const feedbackRows: Array<{ state: PetState; label: string }> = [
  { state: "thinking", label: "思考 / 新消息" },
  { state: "tool_read", label: "读取文件" },
  { state: "tool_edit", label: "编辑文件" },
  { state: "tool_bash", label: "执行命令" },
  { state: "tool_search", label: "搜索资料" },
  { state: "waiting_permission", label: "等待确认" },
  { state: "done", label: "处理完成" },
  { state: "error", label: "错误" }
];

const mappingRows: Array<{ source: string; tool?: string; state: PetState; title: string }> = [
  { source: "SessionStart", state: "thinking", title: "会话开始" },
  { source: "UserPromptSubmit", state: "thinking", title: "收到用户输入" },
  { source: "PreToolUse", tool: "Read", state: "tool_read", title: "读取文件" },
  { source: "PreToolUse", tool: "Edit / Write", state: "tool_edit", title: "修改文件" },
  { source: "PreToolUse", tool: "Bash", state: "tool_bash", title: "执行命令" },
  { source: "PreToolUse", tool: "Grep / Glob / WebFetch", state: "tool_search", title: "搜索资料" },
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
  const [toolRibbon, setToolRibbon] = useState<CompanionEvent[]>([]);

  useEffect(() => {
    void window.companion.getSettings().then(setSettings);
    void window.companion.getConnectionStatus().then(setConnection);
    const offSettings = window.companion.onSettings(setSettings);
    const offConnection = window.companion.onConnection(setConnection);
    const offEvent = window.companion.onEvent(event => {
      setEvents(previous => [event, ...previous].slice(0, settings.eventHistoryLimit));
      setPetState(stateFromEvent(event));
      if (event.event !== "tool_end") {
        setCurrentEvent(event);
      }
      if (event.event === "tool_start") {
        setToolRibbon(previous => [event, ...previous].slice(0, 8));
        window.setTimeout(() => {
          setToolRibbon(previous => previous.filter(e => e.id !== event.id));
        }, 3500);
      }
      if (event.event === "tool_end") {
        setToolRibbon(previous => previous.filter(e => !(e.tool === event.tool && e.event === "tool_start")));
      }
      const timeout = (event.event === "done" || event.event === "error" ? 5.2 : event.event === "tool_end" ? 2 : settings.bubbleDuration) * 1000;
      window.setTimeout(() => {
        setPetState(current => current === stateFromEvent(event) ? "idle" : current);
        setCurrentEvent(current => current?.id === event.id ? null : current);
      }, timeout);
    });
    return () => {
      offSettings();
      offConnection();
      offEvent();
    };
  }, [settings.bubbleDuration, settings.eventHistoryLimit]);

  async function updateSettings(next: Partial<CompanionSettings>) {
    const saved = await window.companion.saveSettings(next);
    setSettings(saved);
  }

  return { settings, updateSettings, connection, events, currentEvent, petState, toolRibbon };
}

function PetApp() {
  const { settings, updateSettings, currentEvent, petState, toolRibbon } = useCompanion();
  const [editMode, setEditMode] = useState(false);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const dragOrigin = useRef<{ mouseX: number; mouseY: number; offX: number; offY: number } | null>(null);

  useEffect(() => {
    if (editMode) void window.companion.setPetInteractive(true);
    else void window.companion.setPetInteractive(false);
  }, [editMode]);

  useEffect(() => {
    if (!dragTarget) return;
    function onMouseMove(e: MouseEvent) {
      if (!dragOrigin.current) return;
      const dx = e.clientX - dragOrigin.current.mouseX;
      const dy = e.clientY - dragOrigin.current.mouseY;
      const key = dragTarget as "clawd" | "bubble" | "ribbon";
      const offsets = settings.positionOffsets ?? {};
      updateSettings({ positionOffsets: { ...offsets, [key]: { x: dragOrigin.current.offX + dx, y: dragOrigin.current.offY + dy } } });
    }
    function onMouseUp() { setDragTarget(null); dragOrigin.current = null; }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  }, [dragTarget, settings.positionOffsets, updateSettings]);

  if (!settings.petEnabled) return <main className="pet-stage pet-disabled" />;

  const offsets = settings.positionOffsets ?? {};

  function startDrag(key: string, e: React.MouseEvent) {
    if (!editMode) return;
    e.stopPropagation();
    setDragTarget(key);
    dragOrigin.current = { mouseX: e.clientX, mouseY: e.clientY, offX: offsets[key as keyof typeof offsets]?.x ?? 0, offY: offsets[key as keyof typeof offsets]?.y ?? 0 };
  }

  return (
    <main className={`pet-stage ${editMode ? "edit-mode" : ""}`}>
      <section
        className="pet-anchor"
        style={{ transform: `translateX(-50%) scale(${settings.petScale})`, opacity: settings.petOpacity }}
      >
        {settings.showBubbles && currentEvent && getFeedbackMode(currentEvent, settings) !== "ribbon" ? (
          <div className={`draggable ${editMode ? "can-drag" : ""} ${dragTarget === "bubble" ? "dragging" : ""}`} style={{ transform: `translate(${offsets.bubble?.x ?? 0}px, ${offsets.bubble?.y ?? 0}px)` }} onMouseDown={e => startDrag("bubble", e)}>
            <Bubble event={currentEvent} state={stateFromEvent(currentEvent)} settings={settings} />
          </div>
        ) : null}
        <div className={`draggable ${editMode ? "can-drag" : ""} ${dragTarget === "clawd" ? "dragging" : ""}`} style={{ transform: `translate(${offsets.clawd?.x ?? 0}px, ${offsets.clawd?.y ?? 0}px)` }} onMouseDown={e => startDrag("clawd", e)}>
          <Clawd state={petState} settings={settings} />
        </div>
        {settings.showBubbles && toolRibbon.length > 0 ? (
          <div className={`draggable ${editMode ? "can-drag" : ""} ${dragTarget === "ribbon" ? "dragging" : ""}`} style={{ transform: `translate(${offsets.ribbon?.x ?? 0}px, ${offsets.ribbon?.y ?? 0}px)` }} onMouseDown={e => startDrag("ribbon", e)}>
            <ToolRibbon events={toolRibbon} settings={settings} />
          </div>
        ) : null}
      </section>
      <button className={`pet-edit-btn ${editMode ? "active" : ""}`} title={editMode ? "完成调整" : "调整位置"} onClick={() => setEditMode(!editMode)}>
        {editMode ? "✓" : "✎"}
      </button>
    </main>
  );
}

function Bubble({ event, state, settings }: { event: CompanionEvent; state: PetState; settings: CompanionSettings }) {
  const toolLabel = event.tool && event.tool !== "Unknown" ? event.tool : event.source === "claude-code" ? "Claude Code" : "Manual";
  const feedbackMode = getFeedbackMode(event, settings);
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

const toolColorMap: Record<string, string> = {
  Read: "mint",
  Edit: "coral",
  Write: "coral",
  Bash: "ink",
  Grep: "blue",
  Glob: "blue",
  WebFetch: "blue",
  Task: "steel",
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
  Task: "T",
  Unknown: "?"
};

function ToolRibbon({ events, settings }: { events: CompanionEvent[]; settings: CompanionSettings }) {
  return (
    <div className="tool-ribbon" style={{ transform: `scale(${settings.bubbleScale})`, opacity: settings.bubbleOpacity }}>
      {events.slice(0, 5).map((event, index) => {
        const tool = event.tool ?? "Unknown";
        const color = toolColorMap[tool] ?? "steel";
        const isEnd = event.event === "tool_end";
        const icon = toolIconMap[tool] ?? "?";
        return (
          <div
            key={event.id}
            className={`ribbon-row color-${color} ${isEnd ? "ribbon-done" : ""}`}
            style={{ animationDelay: `${index * 35}ms` }}
          >
            <span className="ribbon-dot" />
            <code className="ribbon-icon">{icon}</code>
            <span className="ribbon-label">{tool}</span>
            {event.detail ? <span className="ribbon-detail">{event.detail}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function Clawd({ state, settings }: { state: PetState; settings: CompanionSettings }) {
  return (
    <section className={`clawd clawd-${state}`} style={{ transform: `scale(${settings.clawdScale})`, opacity: settings.clawdOpacity }} aria-label={`Clawd ${stateCopy[state].label}`}>
      <div className="clawd-glow" />
      <img className="clawd-image" src={clawdImage} alt="" draggable={false} />
      {settings.showStatusProp ? <StateProp state={state} /> : null}
      <div className="shadow" />
    </section>
  );
}

function StateProp({ state }: { state: PetState }) {
  if (state === "tool_bash") return <Terminal className="state-prop terminal-prop" size={30} />;
  if (state === "tool_edit") return <Code2 className="state-prop edit-prop" size={30} />;
  if (state === "tool_read") return <FileText className="state-prop read-prop" size={30} />;
  if (state === "tool_search") return <Search className="state-prop search-prop" size={30} />;
  if (state === "waiting_permission") return <Bell className="state-prop bell-prop" size={30} />;
  if (state === "done") return <Check className="state-prop check-prop" size={30} />;
  if (state === "error") return <X className="state-prop error-prop" size={30} />;
  return null;
}

function SettingsApp() {
  const { settings, updateSettings, connection, events, petState } = useCompanion();
  const [copied, setCopied] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState("overview");
  const [now, setNow] = useState(Date.now());
  const hookCommand = "node D:/build/GitLocal/claude-code-companion/dist/hook-forwarder/index.js";
  const hookConfigPath = "C:/Users/Doulor/.claude/settings.json";
  const launchPath = "D:/build/GitLocal/claude-code-companion/静默启动Clawd.vbs";
  const hookSnippet = useMemo(() => buildHookSnippet(hookCommand), [hookCommand]);

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
        <div className="mini-stage"><div className="mini-pet"><Clawd state={petState} settings={settings} /></div></div>
      </section>

      <section className="status-strip">
        <StatusCard icon={<Radio size={18} />} label="连接状态" value={connection.connected ? "已连接" : connection.serverListening ? "等待会话" : "未监听"} meta={connection.activeClientLabel} tone={connection.connected ? "good" : connection.serverListening ? "wait" : "bad"} />
        <StatusCard icon={<Timer size={18} />} label="最近事件" value={connection.lastEventAt ? timeAgo(connection.lastEventAt, now) : "还没收到"} tone={connection.lastEventAt ? "good" : "wait"} />
        <StatusCard icon={<Shield size={18} />} label="会话" value={shortSession(connection.activeSessionId)} tone="neutral" />
        <StatusCard icon={<MonitorCheck size={18} />} label="本地监听" value={connection.serverListening ? `127.0.0.1:${connection.port}` : "未监听"} tone={connection.serverListening ? "good" : "bad"} />
      </section>

      {connection.error ? <section className="connection-error"><Wrench size={18} />{connection.error}</section> : null}

      <section className="content-grid">
        <Panel id="connect" title="Claude Code 连接" icon={<PlugZap size={18} />} wide>
          <div className="connect-layout">
            <div className="steps">
              <Step number="1" title="保持 Clawd Companion 运行" text={`本地服务监听 ${connection.port}，Claude Code hooks 会把事件 POST 到这里。`} />
              <Step number="2" title="把 hooks 写入 Claude Code 设置" text={`推荐位置：${hookConfigPath}。把右侧 JSON 合并到 settings.json 的 hooks 字段。`} />
              <Step number="3" title="重新打开一个 Claude Code 会话" text="发送一条消息或运行工具后，下面的最近事件和状态映射会立刻亮起来。" />
            </div>
            <div className="code-card">
              <div className="code-card-head">
                <span>hooks 配置片段</span>
                <button onClick={() => copy(hookSnippet, "hooks")}><Clipboard size={15} />{copied === "hooks" ? "已复制" : "复制"}</button>
              </div>
              <pre>{hookSnippet}</pre>
            </div>
          </div>
          <div className="connection-detail-grid">
            <ConnectionDetail label="状态" value={connection.connected ? "已连接" : connection.serverListening ? "等待 Claude 会话" : "本地服务未监听"} />
            <ConnectionDetail label="客户端" value={connection.activeClientLabel ?? "未知客户端"} />
            <ConnectionDetail label="会话 ID" value={shortSession(connection.activeSessionId)} />
            <ConnectionDetail label="最后活动" value={connection.lastEventAt ? timeAgo(connection.lastEventAt, now) : "暂无"} />
          </div>
          <div className="command-row">
            <span>Hook forwarder 命令</span>
            <code>{hookCommand}</code>
            <button onClick={() => copy(hookCommand, "cmd")}><Clipboard size={15} />{copied === "cmd" ? "已复制" : "复制"}</button>
          </div>
        </Panel>

        <Panel id="appearance" title="桌宠外观" icon={<Bot size={18} />}>
          <Toggle label="启用桌宠" checked={settings.petEnabled} onChange={petEnabled => updateSettings({ petEnabled })} />
          <Toggle label="始终置顶" checked={settings.alwaysOnTop} onChange={alwaysOnTop => updateSettings({ alwaysOnTop })} />
          <Toggle label="完全点击穿透" checked={settings.clickThrough} onChange={clickThrough => updateSettings({ clickThrough })} />
          <Toggle label="显示气泡" checked={settings.showBubbles} onChange={showBubbles => updateSettings({ showBubbles })} />
          <Toggle label="显示状态道具" checked={settings.showStatusProp} onChange={showStatusProp => updateSettings({ showStatusProp })} />
          <Slider label="整体尺寸" min={0.7} max={1.45} step={0.05} value={settings.petScale} format={value => `${Math.round(value * 100)}%`} onChange={petScale => updateSettings({ petScale })} />
          <Slider label="Clawd尺寸" min={0.7} max={1.35} step={0.05} value={settings.clawdScale} format={value => `${Math.round(value * 100)}%`} onChange={clawdScale => updateSettings({ clawdScale })} />
          <Slider label="Clawd透明" min={0.45} max={1} step={0.05} value={settings.clawdOpacity} format={value => `${Math.round(value * 100)}%`} onChange={clawdOpacity => updateSettings({ clawdOpacity })} />
          <Slider label="思维泡尺寸" min={0.75} max={1.35} step={0.05} value={settings.thoughtScale} format={value => `${Math.round(value * 100)}%`} onChange={thoughtScale => updateSettings({ thoughtScale })} />
          <Slider label="思维泡透明" min={0.45} max={1} step={0.05} value={settings.thoughtOpacity} format={value => `${Math.round(value * 100)}%`} onChange={thoughtOpacity => updateSettings({ thoughtOpacity })} />
          <Slider label="卡片尺寸" min={0.75} max={1.25} step={0.05} value={settings.cardScale} format={value => `${Math.round(value * 100)}%`} onChange={cardScale => updateSettings({ cardScale })} />
          <Slider label="卡片透明" min={0.45} max={1} step={0.05} value={settings.cardOpacity} format={value => `${Math.round(value * 100)}%`} onChange={cardOpacity => updateSettings({ cardOpacity })} />
          <div className="feedback-mode-list">
            {feedbackRows.map(row => <FeedbackModeRow key={row.state} label={row.label} value={settings.feedbackModes?.[row.state] ?? "card"} onChange={mode => updateSettings({ feedbackModes: { ...(settings.feedbackModes ?? {}), [row.state]: mode } })} />)}
          </div>
        </Panel>

        <Panel title="应用行为" icon={<MousePointer2 size={18} />}>
          <Toggle label="开机自启" checked={settings.launchAtLogin} onChange={launchAtLogin => updateSettings({ launchAtLogin })} />
          <Toggle label="启动时打开配置面板" checked={settings.openSettingsOnStart} onChange={openSettingsOnStart => updateSettings({ openSettingsOnStart })} />
          <Toggle label="完成时系统通知" checked={settings.doneSound} onChange={doneSound => updateSettings({ doneSound })} />
          <Slider label="气泡停留" min={3} max={18} step={1} value={settings.bubbleDuration} format={value => `${value} 秒`} onChange={bubbleDuration => updateSettings({ bubbleDuration })} />
          <Slider label="事件历史" min={12} max={100} step={4} value={settings.eventHistoryLimit} format={value => `${value} 条`} onChange={eventHistoryLimit => updateSettings({ eventHistoryLimit })} />
          <div className="launch-note">
            想摆脱命令行窗口，请双击项目根目录的 <code>静默启动Clawd.vbs</code>。退出应用请用托盘菜单。
            <button className="inline-action" onClick={() => copy(launchPath, "launch")}>{copied === "launch" ? "已复制路径" : "复制静默启动路径"}</button>
          </div>
          <div className="panel-divider" />
          <h3 className="panel-subtitle">工具显示方式</h3>
          <p className="note" style={{ marginTop: 0, marginBottom: 10 }}>为每种工具单独设置显示方式。设为"跟随"则使用上方的状态默认设置。</p>
          {toolFeedbackRows.map(row => (
            <div key={row.tool} className="feedback-mode-row">
              <span>{row.label}</span>
              <div>
                <button className={!settings.toolFeedbackModes?.[row.tool] ? "active" : ""} onClick={() => { const next = { ...(settings.toolFeedbackModes ?? {}) }; delete next[row.tool]; updateSettings({ toolFeedbackModes: next }); }}>跟随</button>
                <button className={settings.toolFeedbackModes?.[row.tool] === "thought" ? "active" : ""} onClick={() => updateSettings({ toolFeedbackModes: { ...(settings.toolFeedbackModes ?? {}), [row.tool]: "thought" } })}>气泡</button>
                <button className={settings.toolFeedbackModes?.[row.tool] === "card" ? "active" : ""} onClick={() => updateSettings({ toolFeedbackModes: { ...(settings.toolFeedbackModes ?? {}), [row.tool]: "card" } })}>卡片</button>
                <button className={settings.toolFeedbackModes?.[row.tool] === "ribbon" ? "active" : ""} onClick={() => updateSettings({ toolFeedbackModes: { ...(settings.toolFeedbackModes ?? {}), [row.tool]: "ribbon" } })}>条</button>
              </div>
            </div>
          ))}
        </Panel>

        <Panel id="privacy" title="隐私和端口" icon={<Shield size={18} />}>
          <Field label="事件端口">
            <input value={settings.port} onChange={event => updateSettings({ port: Number(event.target.value) || defaultSettings.port })} />
          </Field>
          <Field label="本地 token">
            <input value={settings.token} onChange={event => updateSettings({ token: event.target.value })} />
          </Field>
          <Segmented value={settings.privacyMode} onChange={privacyMode => updateSettings({ privacyMode })} />
          <p className="note">安全模式只显示工具类型；标准模式显示文件名和搜索模式；详细模式可显示被截断的命令摘要，但仍不会展示完整 prompt 或命令输出。</p>
        </Panel>

        <Panel title="状态配对" icon={<Radio size={18} />}>
          <div className="mapping-list">
            {mappingRows.map(row => <MappingRow key={`${row.source}-${row.tool ?? row.state}`} row={row} />)}
          </div>
        </Panel>

        <Panel title="测试事件" icon={<Play size={18} />}>
          <div className="test-grid">
            {sampleEvents.map(event => <button key={`${event.event}-${event.tool ?? "x"}`} onClick={() => test(event)}>{event.title}</button>)}
          </div>
        </Panel>

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
    </main>
  );
}

function Panel({ id, title, icon, wide, children }: { id?: string; title: string; icon: React.ReactNode; wide?: boolean; children: React.ReactNode }) {
  return <section id={id} className={`panel ${wide ? "wide" : ""}`}><header>{icon}<h2>{title}</h2></header>{children}</section>;
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

function FeedbackModeRow({ label, value, onChange }: { label: string; value: FeedbackMode; onChange: (value: FeedbackMode) => void }) {
  return (
    <div className="feedback-mode-row">
      <span>{label}</span>
      <div>
        <button className={value === "thought" ? "active" : ""} onClick={() => onChange("thought")}>气泡</button>
        <button className={value === "card" ? "active" : ""} onClick={() => onChange("card")}>卡片</button>
        <button className={value === "ribbon" ? "active" : ""} onClick={() => onChange("ribbon")}>条</button>
      </div>
    </div>
  );
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

function App() {
  const route = window.location.hash.replace("#/", "") || "settings";
  return route === "pet" ? <PetApp /> : <SettingsApp />;
}

createRoot(document.getElementById("root")!).render(<App />);
