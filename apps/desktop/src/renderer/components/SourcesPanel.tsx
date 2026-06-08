import { useEffect, useState } from "react";
import { Bot, Check, PlugZap, Sparkles, Wrench, X } from "lucide-react";
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

const PROVIDER_LABELS: Record<string, { label: string; Icon: React.ComponentType<{ size?: number }>; tagline: string }> = {
  "claude-code": { label: "Claude Code", Icon: Bot, tagline: "默认启用，跟随 Claude Code 会话" },
  "codex": { label: "OpenAI Codex", Icon: Sparkles, tagline: "新增：跟踪 Codex CLI 事件" }
};

export function SourcesPanel() {
  const { t } = useI18n();
  const [providers, setProviders] = useState<DoctorProviders | null>(null);
  const [action, setAction] = useState<{ id: string; verb: "installing" | "repairing" | "removing" } | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    window.companion.getDoctorReport().then((report) => {
      setProviders(report.providers ?? null);
    });
  }, []);

  async function handle(id: "claude-code" | "codex", verb: "install" | "repair" | "remove") {
    setAction({ id, verb: `${verb}ing` as "installing" });
    setResult(null);
    let res: { success: boolean; error?: string; fixed?: string[] };
    if (verb === "install") res = await window.companion.installHooks(id);
    else if (verb === "repair") res = await window.companion.repairHooks(id);
    else res = await window.companion.removeHooks(id);
    if (res.success) {
      if (verb === "install") setResult(t("doctor.installDone", "安装成功！重启会话后生效。"));
      else if (verb === "repair") setResult(`${t("doctor.repairDone", "修复完成，修复了 {count} 项配置。")}`.replace("{count}", String(res.fixed?.length ?? 0)));
      else setResult(t("doctor.removeDone", "已移除所有 Clawd hooks。"));
    } else {
      setResult(`${t("common.failed", "失败：")}${res.error ?? ""}`);
    }
    const report = await window.companion.getDoctorReport();
    setProviders(report.providers ?? null);
    setAction(null);
  }

  if (!providers) {
    return <p className="note">{t("doctor.loading", "正在加载…")}</p>;
  }

  return (
    <div className="sources-panel">
      {Object.entries(providers).map(([id, info]) => {
        const meta = PROVIDER_LABELS[id] ?? { label: id, Icon: PlugZap, tagline: "" };
        const Icon = meta.Icon;
        const status = info.hooks;
        const tone = status.installed ? "good" : status.configExists ? "wait" : "neutral";
        return (
          <div key={id} className="source-row">
            <div className="source-row-head">
              <Icon size={20} />
              <div>
                <h4>{meta.label}</h4>
                <small className="note">{meta.tagline}</small>
              </div>
              <span className={`status-pill ${tone}`}>
                {status.installed
                  ? t("hooks.installedToProvider", "已安装到 {provider}").replace("{provider}", meta.label)
                  : status.configExists
                  ? t("doctor.partial", "部分安装")
                  : t("hooks.notInstalled", "未安装")}
              </span>
            </div>
            <div className="hooks-detail">
              <span>{`已配置 ${status.hookCount} / ${status.requiredCount} 个事件`}</span>
              {status.missingEvents.length > 0 && <span className="hooks-missing">{`缺少: ${status.missingEvents.join(", ")}`}</span>}
              {!info.forwarder.exists && <span className="hooks-mismatch">Forwarder 文件未找到: {info.forwarder.expectedPath}</span>}
            </div>
            <div className="hooks-actions">
              <button onClick={() => handle(id as "claude-code" | "codex", "install")} disabled={!!action}>
                {action?.id === id && action.verb === "installing" ? t("doctor.installing", "安装中...") : t("doctor.oneClickInstall", "一键安装")}
              </button>
              <button onClick={() => handle(id as "claude-code" | "codex", "repair")} disabled={!!action}>
                {t("doctor.repairConfig", "修复配置")}
              </button>
              <button className="danger" onClick={() => handle(id as "claude-code" | "codex", "remove")} disabled={!!action}>
                {t("doctor.removeHooks", "移除 Hooks")}
              </button>
            </div>
          </div>
        );
      })}
      {result && <p className="hooks-result">{result}</p>}
    </div>
  );
}
