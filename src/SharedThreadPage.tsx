import { useEffect, useState } from "react";
import type { Artifact } from "./local-model";
import { ArtifactView, exportArtifact } from "./LibraryManager";
import { parseSlidesContent } from "./slide-preview";
import "./real-thread.css";

type PublicMessage = { role: "user" | "assistant"; text: string; createdAt?: string; attachments?: (string | { name: string })[]; attachmentNames?: string[] };
type PublicSnapshot = { title: string; createdAt: string; messages: PublicMessage[]; artifacts: Artifact[] };

function parseSnapshot(value: unknown): PublicSnapshot {
  if (!value || typeof value !== "object") throw Error("This shared snapshot is invalid.");
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== "string" || !Array.isArray(raw.messages) || !Array.isArray(raw.artifacts)) throw Error("This shared snapshot is invalid.");
  const messages = raw.messages.map((item: unknown) => {
    if (!item || typeof item !== "object") throw Error("This shared snapshot is invalid.");
    const m = item as Record<string, unknown>;
    if ((m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") throw Error("This shared snapshot is invalid.");
    const attachmentNames: string[] = [];
    for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
      if (typeof a === "string") attachmentNames.push(a);
      else if (a && typeof a === "object" && typeof a.name === "string") attachmentNames.push(a.name);
    }
    if (Array.isArray(m.attachmentNames)) attachmentNames.push(...m.attachmentNames.filter((a): a is string => typeof a === "string"));
    return { role: m.role, text: m.text, createdAt: typeof m.createdAt === "string" ? m.createdAt : undefined, attachmentNames } as PublicMessage;
  });
  const artifacts = raw.artifacts.map((item: unknown, i: number) => {
    if (!item || typeof item !== "object") throw Error("This shared snapshot is invalid.");
    const a = item as Record<string, unknown>;
    if (typeof a.title !== "string" || typeof a.content !== "string" || !["Document", "Webpage", "Slides", "Table", "Image", "File"].includes(String(a.kind))) throw Error("This shared snapshot is invalid.");
    if (a.kind === "Slides") parseSlidesContent(a.content);
    // Deliberately use only the snapshot content, not historical versions or private IDs.
    return { id: "public-artifact-" + i, title: a.title, kind: a.kind, content: a.content, versions: [], createdAt: typeof a.createdAt === "string" ? a.createdAt : "", updatedAt: typeof a.updatedAt === "string" ? a.updatedAt : "" } as Artifact;
  });
  return { title: raw.title, createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "", messages, artifacts };
}

export default function SharedThreadPage({ token }: { token?: string }) {
  const shareToken = token ?? window.location.pathname.split("/").filter(Boolean)[1] ?? "";
  const [snapshot, setSnapshot] = useState<PublicSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setSnapshot(null);
    void (async () => {
      try {
        if (!shareToken) throw Error("Shared snapshot not found.");
        // This public route never loads session, owner state, or private file endpoints.
        const response = await fetch("/api/public/shares/" + encodeURIComponent(shareToken), { credentials: "omit", signal: controller.signal });
        if (!response.ok) throw Error(response.status === 404 ? "This shared snapshot was not found or has been revoked." : "The shared snapshot could not be loaded. Please try again.");
        const data = parseSnapshot(await response.json());
        if (!controller.signal.aborted) setSnapshot(data);
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "The shared snapshot could not be loaded.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [shareToken, retry]);
  return <main className="rt-public">
    <header><span className="rt-badge">Shared snapshot · Read only</span><h1>{snapshot?.title || "Shared thread"}</h1><p>Public snapshot. No live thread access, private attachments, or execution.</p></header>
    {loading && <p role="status">Loading shared snapshot…</p>}
    {error && <section className="rt-error" role="alert"><p>{error}</p><button className="btn" onClick={() => setRetry(n => n + 1)}>Try again</button></section>}
    {snapshot && <>
      {snapshot.createdAt && <p className="rt-public-date">Published {new Date(snapshot.createdAt).toLocaleString()}</p>}
      <section aria-label="Shared messages"><h2>Messages</h2>{!snapshot.messages.length && <p>No messages in this snapshot.</p>}{snapshot.messages.map((m, i) => <article className="rt-message" key={i}><div className="rt-message-meta"><strong>{m.role === "user" ? "User" : "Assistant"}</strong>{m.createdAt && <time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleString()}</time>}</div><p>{m.text}</p>{!!m.attachmentNames?.length && <div className="rt-attachments"><strong>Attachment names only</strong><ul>{m.attachmentNames.map((name, n) => <li key={n}>{name}</li>)}</ul><small>Private file content is not included.</small></div>}</article>)}</section>
      <section aria-label="Shared artifacts"><h2>Published artifacts</h2>{!snapshot.artifacts.length && <p>No artifacts were included.</p>}{snapshot.artifacts.map(a => <article className="rt-public-artifact" key={a.id}><div className="rt-section-heading"><h3>{a.title}</h3><button className="btn small" onClick={() => exportArtifact(a)}>Download snapshot</button></div><ArtifactView artifact={a} /></article>)}</section>
    </>}
  </main>;
}
