import { buildWebpagePreview } from "./webpage-preview";
import { useEffect, useRef, useState } from "react";
import {
  Plus,
  Search,
  Upload,
  Download,
  Archive,
  Trash2,
  Pencil,
  X,
  History,
  FileText,
  Globe,
  Image as ImageIcon,
  Grid2X2,
  List,
  ArrowUpRight,
} from "lucide-react";
import type { PageProps } from "./types";
import type { Artifact } from "./local-model";
import { uid, now } from "./local-model";
import { useWorkspace, download, safeImage } from "./workspace";
import { IconButton, Modal } from "./ui";
import { Markdown } from "./ContentHub";
import { parseTable, tableCsv } from "./table-utils";
export function ArtifactView({ artifact }: { artifact: Artifact }) {
  if (artifact.kind === "Table") {
    try { const data = parseTable(artifact.content); return <div className="rt-answer-table"><table aria-label={artifact.title}><thead><tr>{data.columns.map((c,i)=><th key={i}>{c}</th>)}</tr></thead><tbody>{data.rows.map((row,i)=><tr key={i}>{row.map((c,j)=><td key={j}>{c}</td>)}</tr>)}</tbody></table></div>; }
    catch (e) { return <p role="alert">{e instanceof Error ? e.message : "Invalid table"}</p>; }
  }
  return artifact.kind === "Image" ? (
    safeImage(artifact.content) ? (
      <img
        className="local-artifact-image"
        src={safeImage(artifact.content)}
        alt={artifact.title}
      />
    ) : (
      <p>Image unavailable or unsupported.</p>
    )
  ) : artifact.kind === "Webpage" ? (
    <iframe
      className="local-web-frame"
      title={artifact.title}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={buildWebpagePreview(artifact.content)}
    />
  ) : artifact.kind === "Document" ? (
    <article className="notes-document">
      <h1>{artifact.title}</h1>
      <Markdown content={artifact.content} />
    </article>
  ) : (
    <pre className="local-file-preview">{artifact.content}</pre>
  );
}
export function exportArtifact(a: Artifact) {
  if (a.kind === "Table") { download(a.title.replace(/\.csv$/i, "") + ".csv", "\uFEFF" + tableCsv(a.content), "text/csv;charset=utf-8"); return; }
  if (a.kind === "Image") {
    const url = safeImage(a.content);
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = a.title;
    link.click();
    return;
  }
  download(
    a.title.replace(/\.(md|html|txt)$/, "") +
      (a.kind === "Webpage" ? ".html" : a.kind === "Document" ? ".md" : ".txt"),
    a.content,
    a.kind === "Webpage"
      ? "text/html"
      : a.kind === "Document"
        ? "text/markdown"
        : "text/plain",
  );
}
export default function LibraryManager({ path, navigate, notify }: PageProps) {
  const w = useWorkspace();
  const [query, setQuery] = useState(""),
    [kind, setKind] = useState("All"),
    [archived, setArchived] = useState(false),
    [sort, setSort] = useState("Newest"),
    [grid, setGrid] = useState(true),
    [modal, setModal] = useState(""),
    [selected, setSelected] = useState(""),
    [title, setTitle] = useState(""),
    [content, setContent] = useState(""),
    [editKind, setEditKind] = useState<Artifact["kind"]>("Document"),
    [threadId, setThreadId] = useState(""),
    [projectId, setProjectId] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const artifact = w.data.artifacts.find((a) => a.id === selected);
  useEffect(() => {
    const requested = new URLSearchParams(location.search).get("artifact");
    if (requested && w.data.artifacts.some((a) => a.id === requested)) {
      setSelected(requested);
      setModal("preview");
    }
  }, [path, location.search]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal("");
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  const items = w.data.artifacts
    .filter(
      (a) =>
        !!a.archived === archived &&
        (path !== "/documents" || a.kind === "Document") &&
        (kind === "All" || a.kind === kind) &&
        a.title.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "Name"
        ? a.title.localeCompare(b.title)
        : sort === "Newest"
          ? b.updatedAt.localeCompare(a.updatedAt)
          : a.updatedAt.localeCompare(b.updatedAt),
    );
  const edit = (a?: Artifact) => {
    setSelected(a?.id || "");
    setTitle(a?.title || "");
    setContent(a?.content || "");
    setEditKind(a?.kind || "Document");
    setThreadId(a?.threadId || "");
    setProjectId(a?.projectId || "");
    setModal("editor");
  };
  const save = () => {
    if (!title.trim()) return;
    if (editKind === "Table") { try { parseTable(content); } catch (e) { notify(e instanceof Error ? e.message : "Invalid table"); return; } }
    const time = now();
    if (artifact) {
      w.set("artifacts", (aa) =>
        aa.map((a) =>
          a.id === artifact.id
            ? {
                ...a,
                title: title.trim(),
                content,
                kind: editKind,
                threadId: threadId || undefined,
                projectId: projectId || undefined,
                updatedAt: time,
                versions:
                  content === a.content
                    ? a.versions
                    : [
                        ...a.versions,
                        {
                          id: uid("version"),
                          content: a.content,
                          createdAt: a.updatedAt,
                        },
                      ],
              }
            : a,
        ),
      );
    } else
      w.set("artifacts", (aa) => [
        {
          id: uid("artifact"),
          title: title.trim(),
          kind: editKind,
          content,
          threadId: threadId || undefined,
          projectId: projectId || undefined,
          versions: [],
          createdAt: time,
          updatedAt: time,
        },
        ...aa,
      ]);
    setModal("");
    notify("Artifact saved locally.");
  };
  const importFile = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      notify("Files must be smaller than 2 MB for this lightweight store.");
      return;
    }
    try {
      let content = "",
        kind: Artifact["kind"] = "File";
      if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
        kind = "Image";
        content = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = reject;
          r.readAsDataURL(file);
        });
      } else {
        content = await file.text();
        kind = /\.html?$/i.test(file.name)
          ? "Webpage"
          : /\.(md|txt)$/i.test(file.name)
            ? "Document"
            : "File";
      }
      const a: Artifact = {
        id: uid("artifact"),
        title: file.name,
        kind,
        content,
        versions: [],
        createdAt: now(),
        updatedAt: now(),
      };
      w.set("artifacts", (aa) => [a, ...aa]);
      setSelected(a.id);
      setModal("preview");
      notify("File imported locally.");
    } catch {
      notify("Could not read that file.");
    }
  };
  return (
    <div className="resource-page rp-page">
      <div className="page-header">
        <h1 className="page-title">
          {path === "/documents" ? "Documents" : "Library"}
        </h1>
        <div className="actions">
          <button className="btn small" onClick={() => upload.current?.click()}>
            <Upload size={14} />
            Import file
          </button>
          <button className="btn primary small" onClick={() => edit()}>
            <Plus size={14} />
            New artifact
          </button>
        </div>
      </div>
      <div className="list-controls">
        <div className="rp-search">
          <Search size={15} />
          <input
            aria-label="Search library"
            placeholder="Search library…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          className="compact-select"
          aria-label="Artifact type"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          {["All", "Document", "Webpage", "Table", "Image", "File"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select
          className="compact-select"
          aria-label="Sort library"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option>Newest</option>
          <option>Oldest</option>
          <option>Name</option>
        </select>
        <label className="check-row">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Archived
        </label>
        <IconButton
          label="Toggle library layout"
          onClick={() => setGrid(!grid)}
        >
          {grid ? <List size={16} /> : <Grid2X2 size={16} />}
        </IconButton>
      </div>
      <div className={"rp-library-grid " + (!grid ? "list" : "")}>
        {items.map((a) => (
          <button
            key={a.id}
            className="rp-library-card"
            onClick={() => {
              setSelected(a.id);
              setModal("preview");
            }}
          >
            <div className="rp-library-preview">
              {a.kind === "Image" && safeImage(a.content) ? (
                <img src={safeImage(a.content)} alt="" />
              ) : (
                <div className="rp-note-preview">
                  {a.kind === "Webpage" ? (
                    <Globe size={30} />
                  ) : (
                    <FileText size={30} />
                  )}
                  <h3>{a.title}</h3>
                  <p>
                    {a.kind === "Webpage"
                      ? "Webpage preview"
                      : a.content.slice(0, 150)}
                  </p>
                </div>
              )}
            </div>
            <strong>{a.title}</strong>
            <small>
              from{" "}
              {w.data.threads.find((t) => t.id === a.threadId)?.title ||
                w.data.projects.find((p) => p.id === a.projectId)?.name ||
                w.activeName}
            </small>
            <small>
              {a.kind} · {new Date(a.updatedAt).toLocaleDateString()}
            </small>
          </button>
        ))}
      </div>
      {!items.length && (
        <div className="empty-state">
          <FileText size={32} />
          <h3>No matching artifacts</h3>
          <p>Create a document or import a local file.</p>
        </div>
      )}
      <input
        ref={upload}
        hidden
        type="file"
        accept=".md,.txt,.html,.json,.png,.jpg,.jpeg,.webp,.gif"
        aria-label="Import library file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importFile(f);
          e.target.value = "";
        }}
      />
      {modal === "editor" && (
        <Modal
          wide
          title={artifact ? "Edit artifact" : "New artifact"}
          onClose={() => setModal("")}
          footer={
            <>
              <button className="btn" onClick={() => setModal("")}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!title.trim()}
                onClick={save}
              >
                Save artifact
              </button>
            </>
          }
        >
          <div className="grid2">
            <label className="field">
              Title
              <input
                aria-label="Title"
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="field">
              Type
              <select
                aria-label="Type"
                className="input"
                value={editKind}
                onChange={(e) =>
                  setEditKind(e.target.value as Artifact["kind"])
                }
                disabled={artifact?.kind === "Image"}
              >
                <option>Document</option>
                <option>Webpage</option>
                <option>Table</option>
                <option>File</option>
                {artifact?.kind === "Image" && <option>Image</option>}
              </select>
            </label>
          </div>
          {editKind === "Image" ? (
            <p className="demo-note">
              To replace an image, import a new local file.
            </p>
          ) : (
            <label className="field">
              Content
              <textarea
                aria-label="Content"
                className="textarea local-code"
                rows={15}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={
                  editKind === "Webpage"
                    ? "<main><h1>Your page</h1></main>"
                    : "Write your document…"
                }
              />
            </label>
          )}
          <div className="grid2">
            <label className="field">
              Related thread
              <select
                aria-label="Related thread"
                className="input"
                value={threadId}
                onChange={(e) => setThreadId(e.target.value)}
              >
                <option value="">None</option>
                {w.data.threads.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Related project
              <select
                aria-label="Related project"
                className="input"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">None</option>
                {w.data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="demo-note">
            Saved locally. Webpage previews block scripts, network access, and
            forms.
          </p>
        </Modal>
      )}
      {modal === "preview" && artifact && (
        <div
          className="rp-artifact-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Artifact preview"
        >
          <header>
            <span>{artifact.title}</span>
            <IconButton
              label="Close artifact preview"
              onClick={() => setModal("")}
            >
              <X size={18} />
            </IconButton>
          </header>
          <div className="rp-artifact-body">
            <div className="rp-artifact-display local-live-preview">
              <ArtifactView artifact={artifact} />
            </div>
            <aside>
              <h3>{artifact.title}</h3>
              <h5>ACTIONS</h5>
              <button onClick={() => edit(artifact)}>
                <Pencil size={14} /> Edit
              </button>
              <button onClick={() => exportArtifact(artifact)}>
                <Download size={14} /> Download
              </button>
              <button
                onClick={() => {
                  w.set("artifacts", (aa) =>
                    aa.map((a) =>
                      a.id === artifact.id
                        ? { ...a, archived: !a.archived }
                        : a,
                    ),
                  );
                  setModal("");
                }}
              >
                <Archive size={14} />{" "}
                {artifact.archived ? "Restore" : "Archive"}
              </button>
              <button
                onClick={() => {
                  if (
                    confirm(
                      "Delete this local artifact and its version history?",
                    )
                  ) {
                    w.set("artifacts", (aa) =>
                      aa.filter((a) => a.id !== artifact.id),
                    );
                    setModal("");
                  }
                }}
              >
                <Trash2 size={14} /> Delete
              </button>
              <h5>VERSION HISTORY</h5>
              <p>v{artifact.versions.length + 1} · Current</p>
              {[...artifact.versions].reverse().map((v, i) => (
                <button
                  key={v.id}
                  onClick={() => {
                    if (
                      confirm("Restore this previous content as a new version?")
                    )
                      w.updateArtifact(artifact.id, v.content);
                  }}
                >
                  v{artifact.versions.length - i} ·{" "}
                  {new Date(v.createdAt).toLocaleString()} · Restore
                </button>
              ))}
              <h5>USED IN THREADS</h5>
              {artifact.threadId && (
                <button
                  onClick={() => navigate("/thread/" + artifact.threadId)}
                >
                  {w.data.threads.find((t) => t.id === artifact.threadId)
                    ?.title || "Open thread"}{" "}
                  ↗
                </button>
              )}
              <p className="demo-note">
                Public publishing is not connected. Download an HTML or Markdown
                file to share it yourself.
              </p>
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}
