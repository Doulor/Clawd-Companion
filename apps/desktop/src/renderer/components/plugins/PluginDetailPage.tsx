import React, { useState } from "react";
import type { CustomPlugin, PluginMarketItem, PluginRunRecord } from "../../../shared/events";
import { useI18n } from "../../useI18n";
import { Toggle } from "../ui/Toggle";
import { PluginInstallControls } from "./PluginInstallControls";
import { PluginPermissionsEditor } from "./PluginPermissionsEditor";
import { PluginRunList } from "./PluginRunList";
import { PluginSettingsFields } from "./PluginSettingsFields";
import { SafeMarkdown } from "./SafeMarkdown";

export function PluginDetailPage({ plugin, marketItem, runs, installing, onBack, onInstall, onRemove, onPatchPlugin, onRunNow }: {
  plugin?: CustomPlugin;
  marketItem?: PluginMarketItem;
  runs: PluginRunRecord[];
  installing?: boolean;
  onBack: () => void;
  onInstall?: () => void;
  onRemove?: () => void;
  onPatchPlugin: (patch: Partial<CustomPlugin>) => void;
  onRunNow?: () => void;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [readmeExpanded, setReadmeExpanded] = useState(false);
  const title = zh ? plugin?.manifest?.nameZh ?? plugin?.name ?? marketItem?.nameZh ?? marketItem?.name ?? "插件" : plugin?.manifest?.name ?? plugin?.name ?? marketItem?.name ?? "Plugin";
  const description = zh ? plugin?.manifest?.descriptionZh ?? plugin?.manifest?.description ?? marketItem?.descriptionZh ?? marketItem?.description ?? "" : plugin?.manifest?.description ?? marketItem?.description ?? "";
  const manifest = plugin?.manifest;
  const widgets = manifest?.widgets ?? [];
  const readme = zh
    ? plugin?.readmeZh ?? plugin?.manifest?.readmeZh ?? marketItem?.readmeZh ?? marketItem?.detailsZh ?? plugin?.readme ?? plugin?.manifest?.readme ?? marketItem?.readme ?? marketItem?.details ?? description
    : plugin?.readme ?? plugin?.manifest?.readme ?? marketItem?.readme ?? marketItem?.details ?? description;
  const scriptLike = !!plugin && plugin.events.length > 0;

  return (
    <div className="plugin-detail-page">
      <div className="plugin-detail-sticky-bar"><button className="ghost-btn plugin-back-btn" onClick={onBack}>← {zh ? "返回插件列表" : "Back to plugins"}</button></div>
      <header className="plugin-detail-hero">
        <div>
          <p className="eyebrow">{marketItem ? (zh ? "市场插件" : "Market plugin") : plugin?.scriptPath ? (zh ? "已安装插件" : "Installed plugin") : (zh ? "插件" : "Plugin")}</p>
          <h2>{title}</h2>
          <p>{description}</p>
          <div className="plugin-status-badges">
            {plugin ? <span>{plugin.enabled ? (zh ? "已启用" : "Enabled") : (zh ? "已停用" : "Disabled")}</span> : <span>{zh ? "未安装" : "Not installed"}</span>}
            {plugin ? <span>{plugin.trusted ? (zh ? "已信任" : "Trusted") : (zh ? "未信任" : "Untrusted")}</span> : null}
            {widgets.length ? <span>{zh ? "组件" : "Widget"}</span> : null}
            {scriptLike ? <span>{zh ? "脚本" : "Script"}</span> : null}
            {(plugin?.version ?? marketItem?.version) ? <span>v{plugin?.version ?? marketItem?.version}</span> : null}
          </div>
        </div>
        <PluginInstallControls marketItem={marketItem} installed={plugin} installing={installing} onInstall={onInstall} onRemove={onRemove} onRunNow={onRunNow} zh={zh} />
      </header>

      <div className="plugin-detail-layout">
        <main className="plugin-detail-main">
          <section className={`plugin-detail-section readme-section ${readmeExpanded ? "expanded" : "collapsed"}`}>
            <div className="plugin-section-title-row">
              <h3>{zh ? "说明" : "README"}</h3>
              <button className="ghost-btn" onClick={() => setReadmeExpanded(value => !value)}>{readmeExpanded ? (zh ? "收起" : "Collapse") : (zh ? "展开完整说明" : "Expand")}</button>
            </div>
            <div className="readme-collapse-body">
              <SafeMarkdown text={readme || (zh ? "暂无插件说明。" : "No README provided.")} />
            </div>
          </section>

          {plugin ? (
            <section className="plugin-detail-section">
              <h3>{zh ? "设置" : "Settings"}</h3>
              <PluginSettingsFields fields={plugin.manifest?.settings ?? []} values={plugin.settings ?? {}} onChange={(key, value) => onPatchPlugin({ settings: { ...(plugin.settings ?? {}), [key]: value } })} zh={zh} />
            </section>
          ) : null}

          {plugin ? (
            <section className="plugin-detail-section">
              <h3>{zh ? "事件与权限" : "Events & permissions"}</h3>
              <PluginPermissionsEditor plugin={plugin} onChange={onPatchPlugin} zh={zh} />
            </section>
          ) : null}

          {plugin ? (
            <section className="plugin-detail-section">
              <h3>{zh ? "最近运行" : "Recent runs"}</h3>
              {scriptLike ? <PluginRunList runs={runs} zh={zh} /> : <div className="empty">{zh ? "没有事件运行记录。这个插件由内置组件渲染。" : "No event runs. This plugin is rendered as a built-in widget."}</div>}
            </section>
          ) : null}
        </main>

        <aside className="plugin-detail-sidebar">
          {plugin ? (
            <section className="plugin-detail-section compact">
              <h3>{zh ? "启用状态" : "Activation"}</h3>
              <Toggle label={zh ? "启用" : "Enabled"} checked={plugin.enabled} onChange={enabled => onPatchPlugin({ enabled })} />
              <Toggle label={zh ? "信任脚本执行" : "Trusted for scripts"} checked={plugin.trusted === true} onChange={trusted => onPatchPlugin({ trusted })} />
              <p className="note">{zh ? "启用控制插件是否生效；信任只允许本地 Node.js 脚本执行。" : "Enabled controls plugin visibility/activity. Trusted only allows local Node.js script execution."}</p>
            </section>
          ) : null}

          {plugin?.resolvedDataDir ? (
            <section className="plugin-detail-section compact">
              <h3>{zh ? "数据目录" : "Data directory"}</h3>
              <p className="plugin-data-dir-path">{plugin.resolvedDataDir}</p>
              <button className="ghost-btn" onClick={() => void window.companion.openPluginDataDir(plugin.id)}>{zh ? "在文件管理器中打开" : "Open in explorer"}</button>
            </section>
          ) : null}

          {plugin && widgets.length ? (
            <section className="plugin-detail-section compact">
              <h3>{zh ? "组件" : "Widgets"}</h3>
              {widgets.map(widget => {
                const key = widget.positionKey ?? widget.type;
                const offset = plugin.widgetOffsets?.[key] ?? { x: 0, y: 0 };
                return (
                  <div key={key} className="plugin-widget-row">
                    <strong>{widget.label ?? widget.type}</strong>
                    <span>{widget.width ?? 172}×{widget.height ?? 78}</span>
                    <small>{zh ? "位置偏移" : "Offset"}: {offset.x}, {offset.y}</small>
                    <button className="ghost-btn" onClick={() => onPatchPlugin({ widgetOffsets: { ...(plugin.widgetOffsets ?? {}), [key]: { x: 735, y: -5 } } })}>{zh ? "重置位置" : "Reset position"}</button>
                  </div>
                );
              })}
              <p className="note">{zh ? "到「外观」打开位置编辑模式，可以在桌面上拖动组件。" : "Use Appearance → edit position mode to drag widgets on the desktop."}</p>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
