#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => processInput(input));

let idleTimer;
process.stdin.on("data", () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => processInput(input), 500);
});

function processInput(raw) {
  if (idleTimer) clearTimeout(idleTimer);
  try {
    const event = JSON.parse(raw || "{}");
    const settings = JSON.parse(process.env.CLAWD_PLUGIN_SETTINGS || "{}");
    const reportHour = parseInt(settings.reportHour || "22", 10);
    const now = new Date();

    // Check if it's time to generate (within 1 hour window)
    if (now.getHours() !== reportHour) return;

    // Check if report already exists for today
    const outputDir = resolveOutputDir(settings.outputDir);
    const today = formatDate(now);
    const reportPath = path.join(outputDir, `clawd-report-${today}.html`);
    if (fs.existsSync(reportPath)) return;

    // Read event history
    const historyPath = findEventHistoryPath();
    if (!historyPath || !fs.existsSync(historyPath)) return;
    const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    const entries = Array.isArray(history) ? history : (history.entries ?? []);

    // Filter yesterday's events
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yStart = startOfDay(yesterday);
    const yEnd = endOfDay(yesterday);
    const yesterdayEntries = entries.filter(e => e.timestamp >= yStart && e.timestamp <= yEnd);

    if (yesterdayEntries.length === 0) return;

    // Calculate stats
    const stats = computeStats(yesterdayEntries, yesterday);
    const maxTimeline = parseInt(settings.maxTimeline || "20", 10);

    // Generate HTML
    const html = renderReport(stats, yesterday, maxTimeline);

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    // Write report
    fs.writeFileSync(reportPath, html, "utf8");
    console.log(`Daily report saved to ${reportPath}`);
  } catch (err) {
    console.error("Daily report error:", err.message);
    process.exit(1);
  }
}

function findEventHistoryPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const winPath = path.join(appData, "clawd-companion", "clawd-companion", "event-history.json");
  if (fs.existsSync(winPath)) return winPath;
  const macPath = path.join(os.homedir(), "Library", "Application Support", "clawd-companion", "event-history.json");
  if (fs.existsSync(macPath)) return macPath;
  const linuxPath = path.join(os.homedir(), ".config", "clawd-companion", "event-history.json");
  if (fs.existsSync(linuxPath)) return linuxPath;
  return null;
}

function resolveOutputDir(configured) {
  if (configured && configured.trim()) {
    return configured.replace(/^~/, os.homedir());
  }
  const desktop = process.platform === "win32"
    ? path.join(os.homedir(), "Desktop")
    : path.join(os.homedir(), "Desktop");
  return path.join(desktop, "clawd-reports");
}

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function endOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime(); }
function formatDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

function computeStats(entries, day) {
  const toolCounts = {};
  let errors = 0;
  let success = 0;
  const timeline = [];
  const sessions = new Set();
  let firstEvent = Infinity, lastEvent = 0;

  for (const e of entries) {
    const ev = e.event;
    if (ev.sessionId) sessions.add(ev.sessionId);
    if (e.timestamp < firstEvent) firstEvent = e.timestamp;
    if (e.timestamp > lastEvent) lastEvent = e.timestamp;

    if (ev.event === "tool_start" && ev.tool) {
      toolCounts[ev.tool] = (toolCounts[ev.tool] || 0) + 1;
    }
    if (ev.event === "done") success++;
    if (ev.event === "error") errors++;

    if (ev.event === "session_start" || ev.event === "done" || ev.event === "error") {
      timeline.push({
        time: new Date(e.timestamp),
        type: ev.event === "error" ? "error" : ev.event === "done" ? "success" : "info",
        text: ev.title || ev.message || ev.event,
        tool: ev.tool
      });
    }
  }

  const durationMs = lastEvent - firstEvent;
  const totalToolCalls = Object.values(toolCounts).reduce((a, b) => a + b, 0);

  return {
    date: formatDate(day),
    sessions: sessions.size,
    durationMs,
    totalToolCalls,
    errors,
    success,
    toolCounts,
    timeline
  };
}

function renderReport(stats, day, maxTimeline) {
  const dateStr = formatDate(day);
  const duration = formatDuration(stats.durationMs);
  const successTotal = stats.success + stats.errors;
  const successRate = successTotal > 0 ? Math.round((stats.success / successTotal) * 100) : 100;
  const errorRate = 360 - Math.round(successRate * 3.6);
  const sortedTools = Object.entries(stats.toolCounts).sort((a, b) => b[1] - a[1]);
  const maxToolCount = sortedTools.length > 0 ? sortedTools[0][1] : 1;
  const timelineItems = stats.timeline.slice(-maxTimeline);

  const toolBars = sortedTools.map(([name, count]) => {
    const pct = Math.round((count / maxToolCount) * 100);
    return `<div class="bar-row"><span class="bar-label">${esc(name)}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%;"></div><span class="bar-value">${count}</span></div></div>`;
  }).join("\n        ");

  const timelineHtml = timelineItems.map(item => {
    const time = item.time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return `<div class="timeline-item ${item.type}"><div class="timeline-time">${time}</div><div class="timeline-content">${esc(item.text)}${item.tool ? ` (${esc(item.tool)})` : ""}</div></div>`;
  }).join("\n        ");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Clawd Report ${esc(dateStr)}</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    :root { --honey: #F5A623; --amber: #D4872C; --paper: #F8F6F3; --card: #FFFFFF; --ink: #2D3436; --muted: #636E72; --green: #2ECC71; --red: #E74C3C; --border: rgba(213,135,44,0.2); }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; background: var(--paper); color: var(--ink); line-height: 1.6; padding: 2rem; }
    .report { max-width: 900px; margin: 0 auto; }
    .hero { background: linear-gradient(135deg, var(--honey), var(--amber)); border-radius: 16px 16px 0 0; padding: 3rem 2rem; color: #fff; text-align: center; position: relative; overflow: hidden; }
    .hero::before { content: ""; position: absolute; inset: 0; background: url("data:image/svg+xml,%3Csvg width='60' height='60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%23fff' fill-opacity='.1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/svg%3E"); pointer-events: none; }
    .hero h1 { font-size: 2.5rem; font-weight: 700; margin-bottom: .5rem; position: relative; }
    .hero p { font-size: 1.1rem; opacity: .9; position: relative; }
    .card { background: var(--card); border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,.06); margin-bottom: 1.5rem; padding: 1.5rem; }
    .card h2 { font-size: 1.2rem; font-weight: 600; margin-bottom: 1rem; display: flex; align-items: center; gap: .5rem; }
    .card h2::before { content: ""; width: 4px; height: 1.2rem; background: linear-gradient(180deg, var(--honey), var(--amber)); border-radius: 2px; }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; }
    .stat { background: linear-gradient(135deg, #FFF9F0, #FFF5E6); border-radius: 10px; padding: 1.2rem; text-align: center; border: 1px solid var(--border); }
    .stat strong { display: block; font-size: 2rem; color: var(--amber); line-height: 1.2; }
    .stat small { color: var(--muted); font-size: .9rem; }
    .bar-row { display: flex; align-items: center; margin-bottom: .7rem; }
    .bar-label { width: 100px; font-size: .9rem; color: var(--muted); text-align: right; padding-right: 1rem; flex-shrink: 0; }
    .bar-track { flex: 1; background: #F0EDE8; border-radius: 4px; height: 24px; position: relative; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--honey), var(--amber)); }
    .bar-value { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: .85rem; font-weight: 600; color: #fff; }
    .timeline { position: relative; padding-left: 2rem; }
    .timeline::before { content: ""; position: absolute; left: .5rem; top: 0; bottom: 0; width: 2px; background: var(--border); }
    .tl { position: relative; margin-bottom: 1rem; padding-left: 1.5rem; }
    .tl::before { content: ""; position: absolute; left: -1.25rem; top: .5rem; width: 10px; height: 10px; border-radius: 50%; background: var(--honey); border: 2px solid #fff; box-shadow: 0 0 0 2px var(--honey); }
    .tl.error::before { background: var(--red); box-shadow: 0 0 0 2px var(--red); }
    .tl.success::before { background: var(--green); box-shadow: 0 0 0 2px var(--green); }
    .tl small { display: block; font-size: .8rem; color: var(--muted); }
    .tl span { font-size: .95rem; }
    .donut-row { display: flex; align-items: center; gap: 2rem; }
    .donut { width: 120px; height: 120px; border-radius: 50%; position: relative; flex-shrink: 0; }
    .donut-inner { position: absolute; inset: 20px; background: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: .9rem; font-weight: 600; }
    .legend { display: flex; flex-direction: column; gap: .5rem; }
    .legend i { display: inline-block; width: 12px; height: 12px; border-radius: 2px; margin-right: .5rem; vertical-align: middle; }
    .footer { text-align: center; padding: 2rem; color: var(--muted); font-size: .85rem; border-top: 1px solid var(--border); margin-top: 2rem; }
    @media (max-width: 600px) { body { padding: 1rem; } .hero h1 { font-size: 1.75rem; } .stats { grid-template-columns: repeat(2, 1fr); } .donut-row { flex-direction: column; align-items: flex-start; } }
  </style>
</head>
<body>
  <div class="report">
    <header class="hero">
      <h1>Clawd Daily Report</h1>
      <p>${esc(dateStr)} | Claude Code Session Summary</p>
    </header>

    <section class="card">
      <h2>Stats Overview</h2>
      <div class="stats">
        <div class="stat"><strong>${stats.sessions}</strong><small>${zh("会话数", "Sessions")}</small></div>
        <div class="stat"><strong>${duration}</strong><small>${zh("总时长", "Duration")}</small></div>
        <div class="stat"><strong>${stats.totalToolCalls}</strong><small>${zh("工具调用", "Tool Calls")}</small></div>
        <div class="stat"><strong>${stats.errors}</strong><small>${zh("错误", "Errors")}</small></div>
      </div>
    </section>

    ${sortedTools.length > 0 ? `<section class="card"><h2>${zh("工具使用分布", "Tool Usage")}</h2><div class="bar-chart">${toolBars}</div></section>` : ""}

    ${timelineItems.length > 0 ? `<section class="card"><h2>${zh("事件时间线", "Event Timeline")}</h2><div class="timeline">${timelineHtml}</div></section>` : ""}

    <section class="card">
      <h2>${zh("成功/错误比例", "Success/Error Ratio")}</h2>
      <div class="donut-row">
        <div class="donut" style="background: conic-gradient(var(--green) 0deg ${360 - errorRate * 3.6}deg, var(--red) ${360 - errorRate * 3.6}deg 360deg);">
          <div class="donut-inner">${successRate}%</div>
        </div>
        <div class="legend">
          <span><i style="background:var(--green);"></i>${zh("成功", "Success")} (${stats.success})</span>
          <span><i style="background:var(--red);"></i>${zh("错误", "Errors")} (${stats.errors})</span>
        </div>
      </div>
    </section>

    <footer class="footer">
      <p>Generated by <strong>Clawd Companion</strong></p>
    </footer>
  </div>
</body>
</html>`;
}

function formatDuration(ms) {
  if (ms <= 0) return "0m";
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function zh(zh, en) { return zh; }
