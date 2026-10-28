import { useEffect, useRef, useState } from "react";
import { Star, SlidersHorizontal, Share2, GitFork, Archive, Trash2, Pencil, X } from "lucide-react";
import type { ThreadProps } from "./Thread";
import type { MessageContext, ThreadSettings } from "./types";
import { defaultThreadSettings } from "./types";
import type { Artifact } from "./local-model";
import { now, uid } from "./local-model";
import { useWorkspace } from "./workspace";
import { Composer, IconButton, Modal } from "./ui";
import { ArtifactView, exportArtifact } from "./LibraryManager";
import { api, fileDownloadUrl } from "./backend-client";
import "./real-thread.css";

type Share = { id: string; token: string; createdAt: string; revokedAt?: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : "The operation could not be completed.";
const dateLabel = (value?: string) => value ? new Date(value).toLocaleString() : "";

export default function RealThread({ thread, update, navigate, notify, settingsPanel, agents }: ThreadProps) {
  const w = useWorkspace();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState("");
  const [title, setTitle] = useState(thread.title);
  const [config, setConfig] = useState<ThreadSettings>(thread.config || w.data.preferences?.defaultThreadSettings || defaultThreadSettings);
  const [toolsText, setToolsText] = useState(config.tools.join(", "));
  const [selectedId, setSelectedId] = useState("");
  const [kind, setKind] = useState("All");
  const [sort, setSort] = useState("updated");
  const [search, setSearch] = useState("");
  const [artifactTitle, setArtifactTitle] = useState("");
  const [content, setContent] = useState("");
  const [versionId, setVersionId] = useState("");
  const [editing, setEditing] = useState(false);
  const [shares, setShares] = useState<Share[]>([]);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState("");
  const [shareIds, setShareIds] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const operationBusy = useRef(false);
  const latest = useRef(thread);
  latest.current = thread;
  const linked = w.data.artifacts.filter(a => a.threadId === thread.id && !a.archived);
  const visible = linked.filter(a => (kind === "All" || a.kind === kind) && a.title.toLowerCase().includes(search.toLowerCase())).sort((a, b) => sort === "title" ? a.title.localeCompare(b.title) : (sort === "created" ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt)));
  const selected = linked.find(a => a.id === selectedId);
  const historical = selected?.versions.find(v => v.id === versionId);
  const preview = selected && historical ? { ...selected, content: historical.content } : selected;

  useEffect(() => {
    setTitle(thread.title);
    setConfig(thread.config || w.data.preferences?.defaultThreadSettings || defaultThreadSettings);
    setToolsText((thread.config || w.data.preferences?.defaultThreadSettings || defaultThreadSettings).tools.join(", "));
  }, [thread.id, thread.title, thread.config]);
  useEffect(() => { setSelectedId(""); setModal(""); setError(""); }, [thread.id]);
  useEffect(() => {
    setArtifactTitle(selected?.title || ""); setContent(selected?.content || "");
    setVersionId(""); setEditing(false);
  }, [selected?.id, selected?.content, selected?.title]);

  async function perform(action: () => Promise<void>) {
    if (operationBusy.current) return;
    operationBusy.current = true; setBusy(true); setError("");
    try { await action(); } catch (e) { setError(errorText(e)); } finally { operationBusy.current = false; setBusy(false); }
  }
  async function saveThread(patch: Partial<typeof thread>) {
    update({ ...latest.current, ...patch, updatedAt: now() });
    await w.flush();
  }
  async function send(text: string, context?: MessageContext, clientRequestId?: string) {
    setError("");
    const current = latest.current;
    const message = { id: clientRequestId || crypto.randomUUID(), role: "user" as const, text, createdAt: now(), ...(context ? { context } : {}) };
    const next = { ...current, updatedAt: now(), config: context?.settings || current.config || config, projectId: context?.projectId || current.projectId, messages: current.messages?.some(m => m.id === message.id) ? current.messages : [...(current.messages || []), message] };
    latest.current = next;
    update(next);
    try { await w.flush(); } catch (e) { setError(errorText(e)); throw e; }
  }
  async function fork() {
    const timestamp = now();
    const id = uid("thread");
    const allArtifacts = w.data.artifacts.filter(a => a.threadId === thread.id);
    const ids = new Map(allArtifacts.map(a => [a.id, uid("artifact")]));
    const copies = allArtifacts.map(a => ({ ...structuredClone(a), id: ids.get(a.id)!, threadId: id, versions: a.versions.map(v => ({ ...v, id: uid("version") })), createdAt: timestamp, updatedAt: timestamp }));
    const copy = { ...structuredClone(thread), id, title: thread.title + " (fork)", starred: false, archived: false, createdAt: timestamp, updatedAt: timestamp, messages: (thread.messages || []).map(m => ({ ...structuredClone(m), id: crypto.randomUUID(), ...(m.context ? { context: { ...structuredClone(m.context), artifactIds: (m.context.artifactIds || []).map(a => ids.get(a) || a) } } : {}) })) };
    w.set("threads", items => [...items, copy]);
    w.set("artifacts", items => [...items, ...copies]);
    await w.flush(); navigate("/thread/" + id);
  }
  async function newArtifact(artifactKind: "Document" | "Webpage") {
    const timestamp = now();
    const artifact: Artifact = { id: uid("artifact"), title: "Untitled " + artifactKind.toLowerCase(), kind: artifactKind, content: "", threadId: thread.id, projectId: thread.projectId, versions: [], createdAt: timestamp, updatedAt: timestamp };
    w.set("artifacts", items => [...items, artifact]); setSelectedId(artifact.id);
    await w.flush();
  }
  async function saveArtifact() {
    if (!selected || !artifactTitle.trim()) throw Error("An artifact title is required.");
    w.set("artifacts", items => items.map(a => a.id !== selected.id ? a : { ...a, title: artifactTitle.trim(), content, updatedAt: now(), versions: content === a.content ? a.versions : [...a.versions, { id: uid("version"), content: a.content, createdAt: a.updatedAt }] }));
    await w.flush(); setEditing(false);
  }
  async function loadShares() {
    setShareLoading(true); setShareError("");
    try { await w.flush(); const result = await api<{ shares: Share[] }>("/api/shares?workspaceId=" + encodeURIComponent(w.state.active) + "&threadId=" + encodeURIComponent(thread.id)); setShares(result.shares); }
    catch (e) { setShareError(errorText(e)); } finally { setShareLoading(false); }
  }
  function openShare() { setShareIds([]); setConfirmed(false); setShares([]); setModal("share"); void loadShares(); }
  async function publish() {
    if (!confirmed) return;
    await w.flush();
    const { share } = await api<{ share: Share }>("/api/shares", { method: "POST", body: { workspaceId: w.state.active, threadId: thread.id, artifactIds: shareIds.filter(id => linked.some(a => a.id === id)) } });
    setShares(items => [share, ...items]); setConfirmed(false);
  }

  return <main className="real-thread">
    <header className="rt-header">
      <div className="rt-title"><h1>{thread.title}</h1>{thread.archived && <span className="rt-badge">Archived</span>}</div>
      <div className="rt-actions">
        <IconButton label={thread.starred ? "Unstar thread" : "Star thread"} onClick={() => void perform(() => saveThread({ starred: !thread.starred }))}><Star size={17} fill={thread.starred ? "currentColor" : "none"} /></IconButton>
        <IconButton label="Rename thread" onClick={() => { setTitle(thread.title); setModal("rename"); }}><Pencil size={17} /></IconButton>
        <IconButton label="Fork thread" onClick={() => void perform(fork)}><GitFork size={17} /></IconButton>
        <IconButton label={thread.archived ? "Unarchive thread" : "Archive thread"} onClick={() => void perform(() => saveThread({ archived: !thread.archived }))}><Archive size={17} /></IconButton>
        <IconButton label="Delete thread" onClick={() => setModal("delete")}><Trash2 size={17} /></IconButton>
        <button className="btn small" onClick={openShare}><Share2 size={15} />Share</button>
        <IconButton label="Thread configuration" onClick={() => navigate("/thread/" + thread.id + (settingsPanel ? "" : "?panel=settings"))}><SlidersHorizontal size={17} /></IconButton>
      </div>
    </header>
    <div className="rt-status"><span>Data-only workspace · No model or tool execution</span><span role="status">{busy ? "Saving…" : w.persistence === "saved" ? "Saved" : w.persistence}</span></div>
    {error && <div className="rt-error" role="alert">{error}<button className="btn small" onClick={() => setError("")}>Dismiss</button></div>}
    {(w.persistence === "error" || w.persistence === "conflict") && <div className="rt-error" role="alert"><p>{w.storageError || "Changes are not saved. Export a backup before reloading saved data."}</p><div className="rt-actions"><button className="btn small" onClick={w.exportSnapshot}>Export backup</button>{w.persistence === "error" && <button className="btn small" disabled={busy} onClick={() => void perform(w.retrySave)}>Retry save</button>}<button className="btn small" disabled={busy} onClick={() => { if (window.confirm("Discard unsaved local changes and reload saved server data? Export a backup first if you want to keep them.")) void perform(w.reload); }}>Reload saved data</button></div></div>}
    <div className={"rt-columns" + (settingsPanel ? " has-settings" : "")}>
      <section className="rt-conversation" aria-label="Conversation">
        <div className="rt-messages">
          {!(thread.messages || []).length && <div className="rt-empty"><h2>No messages yet</h2><p>Write a message to save it to this thread. Messages and context are stored; no assistant response is generated.</p></div>}
          {(thread.messages || []).map((message, i) => <article className={"rt-message " + message.role} key={message.id || i}>
            <div className="rt-message-meta"><strong>{message.role === "user" ? "You" : "Assistant"}</strong><time dateTime={message.createdAt}>{dateLabel(message.createdAt)}</time></div>
            <p>{message.text}</p>
            {!!message.context?.attachments?.length && <ul className="rt-attachments">{message.context.attachments.map(file => <li key={file.id}><a href={fileDownloadUrl(file)} download={file.name}>{file.name}</a><span> · {file.size.toLocaleString()} bytes</span></li>)}</ul>}
            {message.context && <details className="rt-context"><summary>Saved context</summary><dl><dt>Model preference</dt><dd>{message.context.settings?.model || "Not selected"}</dd><dt>Provider preference</dt><dd>{message.context.settings?.provider || "Not selected"}</dd><dt>Skills</dt><dd>{(message.context.skillIds || []).map(id => w.data.skills.find(s => s.id === id)?.name || id).join(", ") || "None"}</dd><dt>Memories</dt><dd>{(message.context.memoryIds || []).length}</dd><dt>Artifacts</dt><dd>{(message.context.artifactIds || []).map(id => w.data.artifacts.find(a => a.id === id)?.title || id).join(", ") || "None"}</dd><dt>Integrations</dt><dd>{(message.context.integrationIds || []).map(id => w.data.connections.find(c => c.id === id)?.label || id).join(", ") || "None"}</dd></dl></details>}
          </article>)}
        </div>
        <div className="rt-composer"><Composer compact navigate={navigate} notify={notify} agents={agents} initialSettings={thread.config} contextKey={thread.id} onSend={send} /></div>
      </section>
      <section className="rt-artifacts" aria-label="Thread artifacts">
        <div className="rt-section-heading"><h2>Artifacts <span>{linked.length}</span></h2><div className="rt-actions"><button className="btn small" disabled={busy} onClick={() => void perform(() => newArtifact("Document"))}>New document</button><button className="btn small" disabled={busy} onClick={() => void perform(() => newArtifact("Webpage"))}>New webpage</button></div></div>
        <div className="rt-artifact-filters"><input aria-label="Filter artifacts" placeholder="Filter artifacts…" value={search} onChange={e => setSearch(e.target.value)} /><select aria-label="Artifact type" value={kind} onChange={e => setKind(e.target.value)}>{["All", "Document", "Webpage", "Image", "File"].map(k => <option key={k}>{k}</option>)}</select><select aria-label="Sort artifacts" value={sort} onChange={e => setSort(e.target.value)}><option value="updated">Last updated</option><option value="created">Newest first</option><option value="title">Title A–Z</option></select></div>
        {!linked.length ? <div className="rt-empty"><h3>No linked artifacts</h3><p>Create a document or webpage to start. This thread has no generated or sample content.</p></div> : !visible.length ? <p className="rt-empty">No artifacts match these filters.</p> : <nav className="rt-artifact-list" aria-label="Select artifact">{visible.map(a => <button key={a.id} className={a.id === selectedId ? "active" : ""} onClick={() => setSelectedId(a.id)}><span>{a.title}</span><small>{a.kind}</small></button>)}</nav>}
        {selected ? <div className="rt-artifact-editor">
          <div className="rt-section-heading"><h3>{selected.title}</h3><button className="btn small" onClick={() => exportArtifact(preview!)}>Download</button></div>
          <div className="rt-artifact-filters"><label>Version <select aria-label="Artifact version" value={versionId} onChange={e => { setVersionId(e.target.value); setEditing(false); }}><option value="">Current version</option>{[...selected.versions].reverse().map((v, i) => <option key={v.id} value={v.id}>{dateLabel(v.createdAt)} · revision {selected.versions.length - i}</option>)}</select></label>{historical ? <button className="btn small" disabled={busy} onClick={() => void perform(async () => { w.updateArtifact(selected.id, historical.content); await w.flush(); setVersionId(""); })}>Restore this version</button> : <button className="btn small" onClick={() => setEditing(!editing)}>{editing ? "Preview" : "Edit artifact"}</button>}</div>
          {historical && <p className="rt-notice">Viewing a previous version. Restoring preserves the current content in version history.</p>}
          {editing ? <form onSubmit={e => { e.preventDefault(); void perform(saveArtifact); }} className="rt-artifact-form"><label>Artifact title<input required value={artifactTitle} onChange={e => setArtifactTitle(e.target.value)} /></label><label>{selected.kind === "Webpage" ? "HTML source" : "Content"}<textarea aria-label="Artifact content" value={content} onChange={e => setContent(e.target.value)} /></label><button className="btn primary" disabled={busy}>Save artifact</button></form> : <ArtifactView artifact={preview!} />}
        </div> : !!linked.length && <p className="rt-empty">Select an artifact to preview, edit, download, or restore a version.</p>}
      </section>
      {settingsPanel && <aside className="rt-settings" aria-label="Thread configuration"><div className="rt-section-heading"><h2>Configuration</h2><IconButton label="Close configuration" onClick={() => navigate("/thread/" + thread.id)}><X size={16} /></IconButton></div><p className="rt-notice">These are saved preferences only. No LLM, tools, schedules, or agent execution is connected.</p>
        <label>Project<select aria-label="Thread project" value={thread.projectId || ""} onChange={e => void perform(() => saveThread({ projectId: e.target.value || undefined, project: undefined }))}><option value="">No project</option>{w.data.projects.filter(p => !p.archived || p.id === thread.projectId).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <form onSubmit={e => { e.preventDefault(); void perform(() => saveThread({ config })); }}>
          <label>Provider preference<input value={config.provider} onChange={e => setConfig({ ...config, provider: e.target.value })} /></label>
          <label>Model preference<input value={config.model} placeholder="Not selected" onChange={e => setConfig({ ...config, model: e.target.value })} /></label>
          <label>Reasoning preference<input value={config.reasoning} onChange={e => setConfig({ ...config, reasoning: e.target.value })} /></label>
          <label>Mode preference<select value={config.mode} onChange={e => setConfig({ ...config, mode: e.target.value })}>{Array.from(new Set([config.mode, "Execute", "Plan", "Ask"])).map(m => <option key={m}>{m}</option>)}</select></label>
          <label>Agent preference<select value={config.agentId || ""} onChange={e => setConfig({ ...config, agentId: e.target.value || undefined, starterAgentName: undefined })}><option value="">No agent</option>{w.data.agents.filter(a => !a.archived || a.id === config.agentId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label>Tools preference (comma-separated)<input value={toolsText} onChange={e => { setToolsText(e.target.value); setConfig({ ...config, tools: e.target.value.split(",").map(s => s.trim()).filter(Boolean) }); }} /></label>
          <label>Output format<input value={config.outputFormat || ""} onChange={e => setConfig({ ...config, outputFormat: e.target.value })} /></label>
          <label>Visual style<input value={config.visuals || ""} onChange={e => setConfig({ ...config, visuals: e.target.value })} /></label>
          <div className="rt-actions"><button className="btn primary" disabled={busy}>Save configuration</button><button type="button" className="btn" disabled={busy} onClick={() => void perform(async () => { w.setPreferences({ defaultThreadSettings: structuredClone(config) }); await w.flush(); })}>Save as default</button></div>
        </form>
        <button className="btn" disabled title="Execution is not connected">Schedule execution unavailable</button>
      </aside>}
    </div>
    {modal === "rename" && <Modal title="Rename thread" onClose={() => setModal("")}><form className="rt-dialog-form" onSubmit={e => { e.preventDefault(); if (title.trim()) void perform(async () => { await saveThread({ title: title.trim() }); setModal(""); }); }}><label>Thread title<input aria-label="Thread title" required autoFocus value={title} onChange={e => setTitle(e.target.value)} /></label>{error && <p className="rt-error" role="alert">{error}</p>}<button className="btn primary" disabled={busy || !title.trim()}>Save name</button></form></Modal>}
    {modal === "delete" && <Modal title="Delete thread?" onClose={() => setModal("")}><p>This permanently removes “{thread.title}” and its messages. Artifacts remain in the Library, unlinked from this thread. All active public snapshots of this thread will also be revoked. This cannot be undone.</p>{error && <p className="rt-error" role="alert">{error}</p>}<div className="rt-actions"><button className="btn" onClick={() => setModal("")}>Cancel</button><button className="btn danger" disabled={busy} onClick={() => void perform(async () => { await w.flush(); const result = await api<{ shares: Share[] }>("/api/shares?workspaceId=" + encodeURIComponent(w.state.active) + "&threadId=" + encodeURIComponent(thread.id)); for (const share of result.shares.filter(s => !s.revokedAt)) await api("/api/shares/" + encodeURIComponent(share.id), { method: "DELETE" }); w.set("threads", items => items.filter(t => t.id !== thread.id)); w.set("artifacts", items => items.map(a => a.threadId === thread.id ? { ...a, threadId: undefined } : a)); await w.flush(); navigate("/threads"); })}>Delete permanently</button></div></Modal>}
    {modal === "share" && <Modal title="Share thread snapshot" onClose={() => setModal("")} wide><div className="rt-share"><p>Publishing creates an immutable public snapshot of the thread title, message text and attachment filenames. Only artifacts you select below are included. Private attachment bytes, context, settings, and workspace data are never public.</p><p>Anyone with the link can read the snapshot. Review message text and artifact contents for sensitive information before publishing.</p><fieldset><legend>Artifacts to include</legend>{linked.length ? linked.map(a => <label className="rt-checkbox" key={a.id}><input type="checkbox" checked={shareIds.includes(a.id)} onChange={e => setShareIds(ids => e.target.checked ? [...ids, a.id] : ids.filter(id => id !== a.id))} />{a.title} ({a.kind})</label>) : <p>No linked artifacts.</p>}</fieldset><label className="rt-checkbox"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I confirm the message text and selected artifact snapshots may be public.</label><button className="btn primary" disabled={busy || !confirmed} onClick={() => void perform(publish)}>Publish snapshot</button>{error && <p role="alert" className="rt-error">{error}</p>}<div className="rt-section-heading"><h3>Published snapshots</h3><button className="btn small" disabled={shareLoading} onClick={() => void loadShares()}>Refresh</button></div>{shareLoading && <p role="status">Loading snapshots…</p>}{shareError && <p role="alert" className="rt-error">{shareError}</p>}{!shareLoading && !shareError && !shares.length && <p>No published snapshots.</p>}{shares.map(share => <div className="rt-share-row" key={share.id}><div><time>{dateLabel(share.createdAt)}</time>{share.revokedAt ? <p>Revoked</p> : <a href={"/share/" + encodeURIComponent(share.token)} target="_blank" rel="noopener noreferrer">{window.location.origin}/share/{share.token}</a>}</div>{!share.revokedAt && <button className="btn small" disabled={busy} onClick={() => void perform(async () => { await api("/api/shares/" + encodeURIComponent(share.id), { method: "DELETE" }); setShares(items => items.map(s => s.id === share.id ? { ...s, revokedAt: now() } : s)); })}>Revoke</button>}</div>)}</div></Modal>}
  </main>;
}
