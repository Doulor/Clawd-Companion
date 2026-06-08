import { useEffect, useState } from "react";
import { Bot, CircleAlert, CircleCheck, CircleX, PlugZap, Sparkles } from "lucide-react";
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

const PROVIDER_META: Record<string, { label: string; tagline: string; Icon: React.ComponentType<{ size?: number }> }> = {
  "claude-code": {
    label: "Claude Code",
    tagline: "默认启用，跟随 Claude Code 会话",
    Icon: Bot
  },
  "codex": {
    label: "OpenAI Codex",
    tagline: "新增：跟踪 Codex CLI 事件",
    Icon: Sparkles
  }
};

export function SourcesPanel() {
  const { t } = useI18n();
  const formatText = (template: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);

  const [providers, setProviders] = useState<DoctorProviders | null>(null);
  const [action, setAction] = useState<{ id: string; verb: string } | null>(null);
  const [result, setResult] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    window.companion.getDoctorReport().then((report) => {
      setProviders(report.providers ?? null);
    });
  }, []);

  async function handle(id: "claude-code" | "codex", verb: "install" | "repair" | "remove") {
    setAction({ id, verb });
    setResult(null);
    let res: { success: boolean; error?: string; fixed?: string[] };
    if (verb === "install") res = await window.companion.installHooks(id);
    else if (verb === "repair") res = await window.companion.repairHooks(id);
    else res = await window.companion.removeHooks(id);

    if (res.success) {
      const meta = PROVIDER_META[id];
      const suffix = meta ? `（${meta.label}）` : "";
      if (verb === "install") setResult({ id, message: t("doctor.installDone", "安装成功！重启会话后生效。") + suffix });
      else if (verb === "repair") setResult({ id, message: formatText(t("doctor.repairDone", "修复完成，修复了 {count} 项配置。"), { count: res.fixed?.length ?? 0 }) });
      else setResult({ id, message: t("doctor.removeDone", "已移除所有 Clawd hooks。") + suffix });
    } else {
      setResult({ id, message: formatText(t("doctor.installFailed", "安装失败: {error}"), { error: res.error ?? "" }) });
    }
    const report = await window.companion.getDoctorReport();
    setProviders(report.providers ?? null);
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
      {ids.map((id) => {
        const info = providers[id];
        const meta = PROVIDER_META[id] ?? { label: id, tagline: "", Icon: PlugZap };
        const status = info.hooks;
        const tone: "good" | "wait" | "bad" = status.installed ? "good" : status.configExists ? "wait" : "bad";
        const isBusy = action?.id === id;
        return (
          <div key={id} className="source-card">
            <StatusCard
              icon={<meta.Icon size={18} />}
              label={formatText(t("doctor.statusLabel", "{provider} 状态"), { provider: meta.label })}
              value={
                status.installed
                  ? formatText(t("hooks.installedToProvider", "已安装到 {provider}"), { provider: meta.label })
                  : status.configExists
                  ? t("doctor.partial", "部分安装")
                  : t("hooks.notInstalled", "未安装")
              }
              tone={tone}
            />

            <div className="hooks-detail">
              <span>{formatText(t("doctor.configuredCount", "已配置 {count} / {total} 个事件"), { count: status.hookCount, total: status.requiredCount })}</span>
              {status.missingEvents.length > 0 && (
                <span className="hooks-missing">
                  {formatText(t("doctor.missingPrefix", "缺少: {events}"), { events: status.missingEvents.join(", ") })}
                </span>
              )}
              {!status.commandMatches && status.configExists && (
                <span className="hooks-mismatch">{t("doctor.mismatchHint", "命令路径不匹配，建议修复")}</span>
              )}
              {!info.forwarder.exists && (
                <span className="hooks-mismatch">{t("doctor.forwarderMissing", "Forwarder 文件未找到")}</span>
              )}
            </div>

            <div className="hooks-actions">
              <button onClick={() => handle(id as "claude-code" | "codex", "install")} disabled={!!action}>
                {isBusy && action!.verb === "installing" ? t("doctor.installing", "安装中...") : t("doctor.oneClickInstall", "一键安装")}
              </button>
              <button onClick={() => handle(id as "claude-code" | "codex", "repair")} disabled={!!action}>
                {isBusy && action!.verb === "repairing" ? t("doctor.repairing", "修复中...") : t("doctor.repairConfig", "修复配置")}
              </button>
              <button className="danger" onClick={() => handle(id as "claude-code" | "codex", "remove")} disabled={!!action}>
                {isBusy && action!.verb === "removing" ? t("doctor.removing", "移除中...") : t("doctor.removeHooks", "移除 Hooks")}
              </button>
            </div>

            {result && result.id === id && <p className="hooks-result">{result.message}</p>}
          </div>
        );
      })}
    </div>
  );
}

function StatusCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone: "good" | "bad" | "wait" | "neutral" }) {
  return (
    <article className={`status-card ${tone}`}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}
