import { useState } from "react";
import { useWorkspace } from "./workspace";
import { defaultThreadSettings, type ThreadSettings } from "./types";
export default function ServerThreadDefaults() {
  const w = useWorkspace();
  const [value, setValue] = useState<ThreadSettings>(() => structuredClone(w.data.preferences?.defaultThreadSettings || defaultThreadSettings));
  const [tools, setTools] = useState(value.tools.join(", "));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  return <form onSubmit={async e => {
    e.preventDefault(); setBusy(true); setStatus(""); setError("");
    try { w.setPreferences({ defaultThreadSettings: { ...value, tools: tools.split(",").map(s => s.trim()).filter(Boolean) } }); await w.flush(); setStatus("Default thread settings saved to the local server."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save defaults."); }
    finally { setBusy(false); }
  }}>
    <p>Defaults are stored in this workspace's database and copied into new conversations. They are preferences, not enabled execution capabilities.</p>
    <label className="field">Default model<input className="input" aria-label="Default model preference" value={value.model} placeholder="Not configured" onChange={e => setValue({ ...value, model: e.target.value })} /></label>
    <label className="field">Provider<input className="input" aria-label="Default provider preference" value={value.provider} onChange={e => setValue({ ...value, provider: e.target.value })} /></label>
    <label className="field">Reasoning effort<select className="input" aria-label="Default reasoning preference" value={value.reasoning} onChange={e => setValue({ ...value, reasoning: e.target.value })}>{Array.from(new Set([value.reasoning, "Low", "Medium", "High"])).map(s => <option key={s}>{s}</option>)}</select></label>
    <label className="field">Mode preference<select className="input" aria-label="Default mode preference" value={value.mode} onChange={e => setValue({ ...value, mode: e.target.value })}>{Array.from(new Set([value.mode, "Execute", "Plan first"])).map(s => <option key={s}>{s}</option>)}</select></label>
    <label className="field">Tools preference<input className="input" aria-label="Default tools preference" value={tools} placeholder="Comma-separated tool names" onChange={e => setTools(e.target.value)} /></label>
    <label className="field">Output format<input className="input" aria-label="Default output format" value={value.outputFormat || ""} onChange={e => setValue({ ...value, outputFormat: e.target.value })} /></label>
    <button className="btn primary" disabled={busy}>Save default thread settings</button>
    <p className="demo-note">Models, agent delegation, safety approvals and run time limits require an execution service, which is intentionally not connected.</p>
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
  </form>;
}
