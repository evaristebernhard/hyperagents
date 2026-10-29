import { useEffect, useRef, useState } from "react";
import { Activity, Database, Server, ShieldCheck } from "lucide-react";
import { api } from "./backend-client";
import "./provider-diagnostics.css";

type Diagnostics = {
  api: { status: string };
  database: { status: string; engine: string; revision: number | null };
  provider: { name: string; configured: boolean; models: string[] };
  runtime: { node: string };
};
type Probe = { status: "verified" | "failed"; code?: string; model: string; checkedAt: string; latencyMs: number; cached: boolean };
const explanations: Record<string, string> = {
  AUTH_REJECTED: "DeepSeek rejected the server credential. Check the private DEEPSEEK_API_KEY and restart the app. Do not paste it here.",
  INSUFFICIENT_BALANCE: "DeepSeek reports insufficient balance. Check the provider account’s billing.",
  RATE_LIMITED: "DeepSeek is rate-limiting requests. Wait before testing again.",
  MODEL_UNAVAILABLE: "The provider rejected this model or request. Try the other supported model and check your provider access.",
  PROVIDER_ERROR: "DeepSeek returned a service error. Retry later.",
  TIMEOUT: "No complete provider response within 15 seconds. Check the server’s outbound network and try again later.",
  CONNECTION_ERROR: "The provider connection failed or returned an invalid response. Check network access and try again later.",
};
export default function ProviderDiagnostics() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<Probe | null>(null);
  const alive = useRef(true), pending = useRef(false);
  async function refresh() {
    setLoading(true); setError("");
    try {
      const next = await api<Diagnostics>("/api/diagnostics");
      if (!alive.current) return;
      setData(next); setModel(current => next.provider.models.includes(current) ? current : next.provider.models[0] || "");
      setProbe(null);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Diagnostics unavailable."); }
    finally { if (alive.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, []);
  async function testProvider() {
    if (pending.current) return;
    pending.current = true; setTesting(true); setProbe(null); setError("");
    try {
      const result = await api<Probe>("/api/llm/test", { method: "POST", body: { model, confirmed: true } });
      if (alive.current) setProbe(result);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Provider test unavailable."); }
    finally { pending.current = false; if (alive.current) setTesting(false); }
  }
  return <section className="provider-diagnostics" aria-label="Connection diagnostics">
    <div className="pd-heading"><div><h3>Connection diagnostics</h3><p>Check the real API, database and model provider separately.</p></div><button className="btn small" disabled={loading || testing} onClick={() => void refresh()}>{loading ? "Checking…" : "Refresh status"}</button></div>
    {error && <p className="pd-error" role="alert">{error}</p>}
    {data && <>
      <div className="pd-grid">
        <div className="pd-card"><Server size={17} /><strong>Local API</strong><span>{data.api.status === "ready" ? "Reachable" : "Unavailable"}</span><small>Node {data.runtime.node}</small></div>
        <div className="pd-card"><Database size={17} /><strong>{data.database.engine}</strong><span>{data.database.status === "ready" ? "Readable" : "Unavailable"}</span><small>Workspace revision {data.database.revision ?? "unknown"}</small></div>
        <div className="pd-card"><Activity size={17} /><strong>{data.provider.name}</strong><span>{data.provider.configured ? "Key configured" : "Not configured"}</span><small>Configuration is not a connection test</small></div>
      </div>
      <div className="pd-test"><h4>Verify a model</h4><p>No provider request runs when you open or refresh this panel. The button sends a small paid request (at most 16 output tokens) using the server key. Results are reused for 30 seconds per model.</p>
        <label>Model<select aria-label="Diagnostic model" value={model} disabled={testing} onChange={e => { setModel(e.target.value); setProbe(null); }}>{data.provider.models.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <button className="btn primary small" disabled={!data.provider.configured || !model || testing || loading} onClick={() => void testProvider()}>{testing ? "Testing provider…" : "Run small paid test"}</button>
        {!data.provider.configured && <p>Set DEEPSEEK_API_KEY in the server’s private .env and restart. Never use a VITE_ variable or paste a key into this page.</p>}
        {testing && <p role="status">Waiting for DeepSeek; the test times out after 15 seconds.</p>}
        {probe && <div className={"pd-result " + (probe.status === "verified" ? "is-verified" : "is-failed")} role="status"><strong>{probe.status === "verified" ? "Provider verified" : "Provider test failed"} · {probe.model}</strong><p>{probe.status === "verified" ? "A real completion returned successfully. This verifies this model at the time shown, not all tools or future availability." : explanations[probe.code || ""] || "Provider verification failed. Retry later."}</p><small>{new Date(probe.checkedAt).toLocaleString()} · {probe.latencyMs} ms{probe.cached ? " · Cached result" : ""}</small></div>}
      </div>
      <p className="pd-private"><ShieldCheck size={14} /> Credentials stay on the server. Diagnostics do not expose keys, file paths, conversations or provider response bodies.</p>
    </>}
  </section>;
}
