import { useEffect, useState } from "react";
import { Bot, Check, ChevronRight, CircleAlert, CircleCheck, CircleX, Loader2, PlugZap, Sparkles } from "lucide-react";
import { useI18n } from "../useI18n";

interface ProviderStatus {
  installed: boolean;
  configExists: boolean;
  hookCount: number;
  requiredCount: number;
  missingEvents: string[];
  commandMatches: boolean;
}

interface DoctorProviders {
  [id: string]: {
    hooks: ProviderStatus;
    forwarder: { expectedPath: string; exists: boolean };
  };
}

const PROVIDER_META: Record<string, { label: string; tagline: string; Icon: React.ComponentType<{ size?: number }>; accent: string }> = {
  "claude-code": {
    label: "Claude Code",
    tagline: "默认启用，跟随 Claude Code 会话",
    Icon: Bot,
    accent: "claude"
  },
  "codex": {
    label: "OpenAI Codex",
    tagline: "新增：跟踪 Codex CLI 事件",
    Icon: Sparkles,
    accent: "codex"
  }
};

type Tone = "good" | "wait" | "bad" | "neutral";

function statusTone(status: ProviderStatus): Tone {
  if (status.installed) return "good";
  if (status.configExists) return "wait";
  return "bad";
}

function statusLabel(tone: Tone, t: (k: string, def: string) => string) {
  if (tone === "good") return t("hooks.installed", "已安装");
  if (tone === "wait") return t("doctor.partial", "部分安装");
  return t("hooks.notInstalled", "未安装");
}

export function SourcesPanel() {
  const { t } = useI18n();
  const [providers, setProviders] = useState<DoctorProviders | null>(null);
  const [action, setAction] = useState<{ id: string; verb: "installing" | "repairing" | "removing" } | null>(null);
  const [result, setResult] = useState<{ id: string; ok: boolean; message: string } | null>(null);

  useEffect(() => {
    window.companion.getDoctorReport().then((report) => {
      setProviders(report.providers ?? null);
    });
  }, []);

  async function refreshReport() {
    const report = await window.companion.getDoctorReport();
    setProviders(report.providers ?? null);
  }

  async function handle(id: "claude-code" | "codex", verb: "install" | "repair" | "remove") {
    setAction({ id, verb: `${verb}ing` as "installing" });
    setResult(null);
    let res: { success: boolean; error?: string; fixed?: string[] };
    if (verb === "install") res = await window.companion.installHooks(id);
    else if (verb === "repair") res = await window.companion.repairHooks(id);
    else res = await window.companion.removeHooks(id);

    if (res.success) {
      const meta = PROVIDER_META[id];
      if (verb === "install") {
        setResult({ id, ok: true, message: t("doctor.installDone", "安装成功！重启会话后生效。") + (meta ? `（${meta.label}）` : "") });
      } else if (verb === "repair") {
        const count = res.fixed?.length ?? 0;
        setResult({ id, ok: true, message: t("doctor.repairDone", "修复完成，修复了 {count} 项配置。").replace("{count}", String(count)) });
      } else {
        setResult({ id, ok: true, message: t("doctor.removeDone", "已移除所有 Clawd hooks。") + (meta ? `（${meta.label}）` : "") });
      }
    } else {
      setResult({ id, ok: false, message: `${t("common.failed", "失败：")}${res.error ?? ""}` });
    }
    await refreshReport();
    setAction(null);
  }

  if (!providers) {
    return <p className="note">{t("doctor.loading", "正在加载…")}</p>;
  }

  const ids = Object.keys(providers);
  if (ids.length === 0) {
    return <p className="note">未配置任何数据源。</p>;
  }

  return (
    <div className="sources-panel">
      <div className="sources-grid">
        {ids.map((id) => {
          const info = providers[id];
          const meta = PROVIDER_META[id] ?? { label: id, tagline: "", Icon: PlugZap, accent: "neutral" };
          const status = info.hooks;
          const tone = statusTone(status);
          const isBusy = action?.id === id;
          const busyVerb = isBusy ? action!.verb : null;
          return (
            <article key={id} className={`source-card accent-${meta.accent}`} data-tone={tone}>
              <header className="source-card-header">
                <div className="source-card-id">
                  <span className="source-card-icon"><meta.Icon size={20} /></span>
                  <div>
                    <h4>{meta.label}</h4>
                    <small className="note">{meta.tagline}</small>
                  </div>
                </div>
                <span className={`status-pill ${tone}`}>
                  {tone === "good" ? <CircleCheck size={12} /> : tone === "wait" ? <CircleAlert size={12} /> : <CircleX size={12} />}
                  {statusLabel(tone, t)}
                </span>
              </header>

              <dl className="source-card-meta">
                <div>
                  <dt>{t("doctor.hookEvents", "事件订阅")}</dt>
                  <dd>
                    <strong>{status.hookCount}</strong> <span className="muted">/ {status.requiredCount}</span>
                    <ProgressBar value={status.hookCount} max={status.requiredCount} tone={tone} />
                  </dd>
                </div>
                <div>
                  <dt>{t("doctor.configFile", "配置文件")}</dt>
                  <dd className={info.forwarder.exists ? "ok" : "bad"}>
                    {info.forwarder.exists
                      ? <><CircleCheck size={13} /> {t("doctor.exists", "已找到")}</>
                      : <><CircleX size={13} /> {t("doctor.missingFile", "未找到")} <code className="path">{info.forwarder.expectedPath}</code></>}
                  </dd>
                </div>
              </dl>

              {status.missingEvents.length > 0 && (
                <details className="source-card-missing" open={tone === "wait"}>
                  <summary>
                    <ChevronRight size={12} /> {t("doctor.missingEvents", "缺少事件")} ({status.missingEvents.length})
                  </summary>
                  <ul>
                    {status.missingEvents.map((eventName) => <li key={eventName}><code>{eventName}</code></li>)}
                  </ul>
                </details>
              )}

              <footer className="source-card-actions">
                <button
                  className="primary"
                  onClick={() => handle(id as "claude-code" | "codex", "install")}
                  disabled={!!action}
                >
                  {busyVerb === "installing" && <Loader2 size={14} className="spin" />}
                  {t("doctor.oneClickInstall", "一键安装")}
                </button>
                <button
                  onClick={() => handle(id as "claude-code" | "codex", "repair")}
                  disabled={!!action}
                >
                  {busyVerb === "repairing" && <Loader2 size={14} className="spin" />}
                  {t("doctor.repairConfig", "修复配置")}
                </button>
                <button
                  className="danger"
                  onClick={() => handle(id as "claude-code" | "codex", "remove")}
                  disabled={!!action}
                >
                  {busyVerb === "removing" && <Loader2 size={14} className="spin" />}
                  {t("doctor.removeHooks", "移除 Hooks")}
                </button>
              </footer>

              {result && result.id === id && (
                <p className={`source-card-result ${result.ok ? "ok" : "bad"}`}>
                  {result.ok ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
                  {result.message}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ProgressBar({ value, max, tone }: { value: number; max: number; tone: Tone }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
  return (
    <div className={`source-progress ${tone}`} role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
