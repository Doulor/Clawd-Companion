import React from "react";
import type { CustomPlugin, CompanionSettings } from "../../shared/events";
import { useI18n } from "../useI18n";
import { Toggle } from "./ui/Toggle";

export function PluginManagerPanel({ settings, updateSettings }: { settings: any; updateSettings: (s: any) => void }) {
  const { t } = useI18n();
  const plugins: CustomPlugin[] = settings.customPlugins ?? [];

  const addPlugin = () => {
    const id = crypto.randomUUID();
    const next = [...plugins, { id, name: "New Plugin", scriptPath: "", enabled: true, events: [] }];
    updateSettings({ customPlugins: next } as any);
  };

  const updatePlugin = (id: string, patch: Partial<CustomPlugin>) => {
    const next = plugins.map(p => p.id === id ? { ...p, ...patch } : p);
    updateSettings({ customPlugins: next } as any);
  };

  const removePlugin = (id: string) => {
    updateSettings({ customPlugins: plugins.filter(p => p.id !== id) } as any);
  };

  return (
    <div className="panel-group-card">
      <h3 className="panel-title">{t("plugins.title", "Plugin Manager")}</h3>
      <p className="note">{t("plugins.hint", "Plugins are local JS files that execute on specific events.")}</p>
      {plugins.length === 0 ? (
        <div className="empty">{t("plugins.noPlugins", "No plugins")}</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {plugins.map(p => (
            <div key={p.id} className="mapping-row" style={{ gridTemplateColumns: "1fr 1.2fr 1fr auto" }}>
              <input type="text" value={p.name} onChange={e => updatePlugin(p.id, { name: e.target.value })}
                placeholder={t("plugins.name", "Plugin Name")} style={{ background: "transparent", border: "1px solid var(--line)", borderRadius: 4, padding: "4px 8px", color: "var(--ink)" }} />
              <input type="text" value={p.scriptPath} onChange={e => updatePlugin(p.id, { scriptPath: e.target.value })}
                placeholder={t("plugins.path", "Script Path")} style={{ background: "transparent", border: "1px solid var(--line)", borderRadius: 4, padding: "4px 8px", color: "var(--ink)" }} />
              <input type="text" value={p.events.join(",")} onChange={e => updatePlugin(p.id, { events: e.target.value.split(",").map(v => v.trim()).filter(Boolean) })}
                placeholder={t("plugins.events", "Events: done,error")} style={{ background: "transparent", border: "1px solid var(--line)", borderRadius: 4, padding: "4px 8px", color: "var(--ink)" }} />
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <Toggle label="" checked={p.enabled} onChange={enabled => updatePlugin(p.id, { enabled })} />
                <button className="ghost-btn danger" onClick={() => removePlugin(p.id)}>{t("plugins.remove", "Remove")}</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <button className="ghost-btn" onClick={addPlugin} style={{ marginTop: 8 }}>{t("plugins.add", "Add Plugin")}</button>
    </div>
  );
}
