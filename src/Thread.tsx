import RealThread from "./RealThread";
import { useState, useEffect, useRef } from "react";
import {
  Star,
  ChevronDown,
  MoreHorizontal,
  SlidersHorizontal,
  FileText,
  Globe,
  Image,
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  Layers,
  Grid2X2,
  PanelRightClose,
  PanelRightOpen,
  ListFilter,
  ArrowDownUp,
  Download,
  Copy,
  Clock,
  Plus,
  X,
  Maximize2,
  Pencil,
  Archive,
  GitFork,
  Share2,
  Folder,
  Check,
  Play,
  MousePointer2,
} from "lucide-react";
import type { DemoThread, Navigate } from "./types";
import { Composer, IconButton, Modal, Mark } from "./ui";
import { asset } from "./data";
import { useWorkspace, download, safeImage } from "./workspace";
import { uid, now } from "./local-model";
import { ArtifactView, exportArtifact } from "./LibraryManager";
export function LegacyThread({
  thread,
  update,
  navigate,
  notify,
  settingsPanel,
  agents,
}: {
  thread: DemoThread;
  update: (t: DemoThread) => void;
  navigate: Navigate;
  notify: (s: string) => void;
  settingsPanel: boolean;
  agents: string[];
}) {
  const workspace = useWorkspace();
  const [projectTarget, setProjectTarget] = useState(thread.project || ""),
    [liveInstructions, setLiveInstructions] = useState(""),
    [liveCadence, setLiveCadence] = useState("day");
  const [selected, setSelected] = useState("notes"),
    [layout, setLayout] = useState("Carousel"),
    [filter, setFilter] = useState("All"),
    [menu, setMenu] = useState(""),
    [modal, setModal] = useState(""),
    [canvas, setCanvas] = useState(true),
    [detailsTab, setDetailsTab] = useState("Configuration"),
    [notes, setNotes] = useState(
      workspace.data.artifacts.find(
        (a) => a.threadId === thread.id && a.kind === "Document",
      )?.content ||
        thread.notes ||
        "Build a clear, frontend-only workspace.\n\nKeep the page structure, menus, and navigation faithful to the reference.\n\nNo LLM, browser runtime, or external tools are connected.",
    ),
    [renamed, setRenamed] = useState(thread.title),
    [log, setLog] = useState(false),
    [ratio, setRatio] = useState(48),
    [version, setVersion] = useState("current");
  const split = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow)
      bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [thread.messages?.length, follow]);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current || !split.current) return;
      const b = split.current.getBoundingClientRect();
      setRatio(
        Math.max(32, Math.min(65, ((e.clientX - b.left) / b.width) * 100)),
      );
    };
    const up = () => {
      dragging.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu("");
        setModal("");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const send = (text: string) => {
    update({
      ...thread,
      messages: [
        ...(thread.messages || []),
        { role: "user", text },
      ],
    });
    setFollow(true);
  };
  const linkedArtifacts = workspace.data.artifacts.filter(
    (a) => !a.archived && a.threadId === thread.id,
  );
  const artifacts = (
    linkedArtifacts.length
      ? linkedArtifacts
      : [
          {
            id: "thread-notes-" + thread.id,
            title: "Working notes",
            kind: "Document" as const,
            content: thread.notes || notes,
            threadId: thread.id,
            versions: [],
            createdAt: now(),
            updatedAt: now(),
          },
        ]
  ).map((a) => ({
    ...a,
    type:
      a.kind === "Document"
        ? "Documents"
        : a.kind === "Webpage"
          ? "Webpages"
          : a.kind === "Image"
            ? "Images"
            : "Files",
  }));
  const visible = artifacts.filter(
    (a) => filter.startsWith("All") || a.type === filter,
  );
  const selectedArtifact =
    artifacts.find((a) => a.id === selected) || artifacts[0];
  useEffect(() => {
    setNotes(selectedArtifact.content);
    setVersion("current");
  }, [selectedArtifact.id]);
  const saveNotes = () => {
    if (selectedArtifact.content === notes) return;
    if (workspace.data.artifacts.some((a) => a.id === selectedArtifact.id))
      workspace.updateArtifact(selectedArtifact.id, notes);
    else
      workspace.set("artifacts", (aa) => [
        ...aa,
        { ...selectedArtifact, content: notes, updatedAt: now() },
      ]);
    update({ ...thread, notes });
  };
  const setPanel = (open: boolean) =>
    navigate("/thread/" + thread.id + (open ? "?panel=settings" : ""));
  const artifactBody = (_id: string) => {
    const a = selectedArtifact;
    if (version !== "current" && a.versions[Number(version)])
      return (
        <>
          <button
            className="btn small"
            onClick={() => {
              workspace.updateArtifact(
                a.id,
                a.versions[Number(version)].content,
              );
              setVersion("current");
              setNotes(a.versions[Number(version)].content);
            }}
          >
            Restore this version
          </button>
          <ArtifactView
            artifact={{ ...a, content: a.versions[Number(version)].content }}
          />
        </>
      );
    return a.kind === "Document" ? (
      <article className="notes-document">
        <h1>{a.title}</h1>
        <p className="muted">
          What the agent keeps for this thread: its plan, numbers, and facts.
        </p>
        <h2>Notes</h2>
        <textarea
          aria-label="Working notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={saveNotes}
        />
        <button className="btn small" onClick={saveNotes}>
          Save notes
        </button>
        <p className="demo-note">
          Saved locally to Library. Each content change creates a restorable
          version.
        </p>
      </article>
    ) : (
      <ArtifactView artifact={a} />
    );
  };
  return (
    <div
      className={
        "thread-workspace " + (!canvas && !settingsPanel ? "no-canvas" : "")
      }
      ref={split}
    >
      <section
        className="conversation"
        style={canvas || settingsPanel ? { width: ratio + "%" } : undefined}
      >
        <header className="conversation-header">
          <div className="thread-title-menu">
            <button
              className="plain thread-title"
              onClick={() => setMenu(menu === "title" ? "" : "title")}
            >
              {thread.title}
              <ChevronDown size={13} />
            </button>
            <IconButton
              label="Star thread"
              onClick={() => update({ ...thread, starred: !thread.starred })}
            >
              <Star size={17} fill={thread.starred ? "currentColor" : "none"} />
            </IconButton>
          </div>
          <div className="actions">
            <IconButton
              className="mobile-canvas-button"
              label="View artifact on mobile"
              onClick={() => setModal("fullscreen")}
            >
              <Layers size={16} />
            </IconButton>
            <button className="live-button" onClick={() => setModal("live")}>
              <span />
              Live
            </button>
            <button
              className="pill header-model"
              onClick={() => setPanel(true)}
            >
              ◉ Choose your model
            </button>
            <IconButton
              label="Open thread details"
              onClick={() => setPanel(!settingsPanel)}
            >
              <SlidersHorizontal size={17} />
            </IconButton>
            {!canvas && !settingsPanel && (
              <IconButton label="Show canvas" onClick={() => setCanvas(true)}>
                <PanelRightOpen size={17} />
              </IconButton>
            )}
          </div>
          {menu === "title" && (
            <>
              <div className="local-dismiss" onClick={() => setMenu("")} />
              <div className="popover thread-title-popover">
                {[
                  ["Rename", Pencil],
                  ["Regenerate name", Clock],
                  ["Move to project", Folder],
                  ["Share", Share2],
                  ["Fork thread", GitFork],
                  ["Exclude from knowledge", FileText],
                  ["Archive", Archive],
                  ["Thread settings…", SlidersHorizontal],
                ].map(([n, I]) => {
                  const name = n as string;
                  const Icon = I as typeof Pencil;
                  return (
                    <button
                      key={name}
                      onClick={() => {
                        setMenu("");
                        if (name === "Rename") {
                          setRenamed(thread.title);
                          setModal("rename");
                        } else if (name === "Thread settings…") setPanel(true);
                        else if (name === "Share") setModal("share");
                        else if (name === "Fork thread") {
                          const id = uid("local");
                          workspace.set("threads", (ts) => [
                            {
                              ...thread,
                              id,
                              title: thread.title + " (fork)",
                              archived: false,
                              time: "just now",
                            },
                            ...ts,
                          ]);
                          workspace.set("artifacts", (aa) => [
                            ...aa,
                            ...linkedArtifacts.map((a) => ({
                              ...a,
                              id: uid("artifact"),
                              threadId: id,
                            })),
                          ]);
                          navigate("/thread/" + id);
                          notify("Thread forked locally.");
                        } else if (name === "Move to project") {
                          setProjectTarget(thread.project || "");
                          setModal("project");
                        } else if (name === "Archive") {
                          update({ ...thread, archived: !thread.archived });
                          navigate("/threads");
                        } else if (name === "Exclude from knowledge") {
                          update({ ...thread, excluded: !thread.excluded });
                          notify(
                            thread.excluded
                              ? "Included in local knowledge metadata."
                              : "Excluded from local knowledge metadata. No indexing backend is connected.",
                          );
                        } else if (name === "Regenerate name") {
                          update({
                            ...thread,
                            title:
                              thread.messages
                                ?.find((m) => m.role === "user")
                                ?.text.split("\n")[0]
                                .slice(0, 65) || thread.summary.slice(0, 65),
                          });
                          notify(
                            "Used the first message or summary as a local title. No LLM was called.",
                          );
                        }
                      }}
                    >
                      <Icon size={15} />
                      {name === "Archive" && thread.archived
                        ? "Restore"
                        : name === "Exclude from knowledge" && thread.excluded
                          ? "Include in knowledge"
                          : name}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </header>
        <div
          className="conversation-scroll"
          ref={scroll}
          onScroll={() => {
            const e = scroll.current;
            if (e)
              setFollow(e.scrollHeight - e.scrollTop - e.clientHeight < 100);
          }}
        >
          <div className="reasoning">
            <Clock size={13} />
            Reasoned <ChevronDown size={12} />
          </div>
          <button className="tool-log" onClick={() => setLog(!log)}>
            <FileText size={15} />
            <span>
              Document edits <small>2 tool calls</small>
              <br />
              <small>Thread Context</small>
            </span>
            <ChevronDown size={14} />
          </button>
          {log && (
            <div className="mock-log">
              Updated working notes · preview data
              <br />
              Prepared an artifact card · no tools executed
            </div>
          )}
          {!thread.messages?.length && (
            <>
              <p className="message-paragraph">
                The board is ready to explore. Each concept includes its
                reference notes and a clearly labelled demo flow.
              </p>
              <button
                className="artifact-message-card"
                onClick={() => {
                  setSelected("website");
                  setCanvas(true);
                  if (settingsPanel) setPanel(false);
                  if (window.innerWidth <= 760) setModal("fullscreen");
                }}
              >
                <Globe size={20} />
                <span>
                  <strong>Local potential, redesigned</strong>
                  <small>Webpage · v1</small>
                </span>
                <span>Open ›</span>
              </button>
              <p className="message-paragraph">
                Your workspace is ready — research, documents, and finished work
                can live alongside the conversation.
              </p>
              <table className="conversation-table">
                <thead>
                  <tr>
                    <th>Business</th>
                    <th>Rating</th>
                    <th>Concept direction</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Bakery Café", "4.8 ★", "Menu & inquiry flow"],
                    ["Shoe Repair", "4.8 ★", "Repair catalogue"],
                    ["Auto Service", "4.7 ★", "Guided service intake"],
                    ["Local Atelier", "5.0 ★", "Fitting inquiries"],
                  ].map((x) => (
                    <tr key={x[0]}>
                      {x.map((t) => (
                        <td key={t}>{t}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="message-paragraph">
                <b>How to use it:</b> Open the board to inspect the preview, or
                use the thumbnails to switch between artifacts.
              </p>
              <p className="message-paragraph">
                All forms are local demos, and{" "}
                <b>no businesses have been contacted.</b> No model or browser
                session is running.
              </p>
              <button
                className="artifact-message-card"
                onClick={() => {
                  setSelected("notes");
                  setCanvas(true);
                  if (settingsPanel) setPanel(false);
                  if (window.innerWidth <= 760) setModal("fullscreen");
                }}
              >
                <FileText size={20} />
                <span>
                  <strong>Working notes</strong>
                  <small>Document · v1</small>
                </span>
                <span>Open ›</span>
              </button>
            </>
          )}
          {thread.messages?.map((m, i) => (
            <div className={"chat-bubble " + m.role} key={i}>
              {m.text}
            </div>
          ))}
          <div className="message-actions">
            <IconButton
              label="Copy conversation"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(
                    thread.messages?.map((m) => m.text).join("\n") ||
                      thread.summary,
                  )
                  .then(() => notify("Copied conversation"))
                  .catch(() =>
                    notify("Clipboard is unavailable in this browser."),
                  );
              }}
            >
              <Copy size={14} />
            </IconButton>
            <button
              className="plain"
              onClick={() =>
                notify("Read aloud is not connected in this frontend preview.")
              }
            >
              <Play size={13} />
              Read aloud
            </button>
            <button className="plain" onClick={() => setModal("actions")}>
              <MoreHorizontal size={14} />
              More
            </button>
          </div>
          <p className="muted suggestion-label">
            Suggested learnings <span className="badge">1</span>
          </p>
          <button
            className="learning-card"
            onClick={() => navigate("/learning")}
          >
            <PuzzleLabel />
            Small Biz Website Builder <span>Review ›</span>
          </button>
          <div ref={bottom} />
        </div>
        {!follow && (
          <button
            className="scroll-bottom"
            onClick={() => {
              setFollow(true);
              bottom.current?.scrollIntoView({
                block: "end",
                behavior: "smooth",
              });
            }}
          >
            Scroll to bottom ↓
          </button>
        )}
        <div className="conversation-composer">
          <Composer
            compact
            navigate={navigate}
            notify={notify}
            onSend={send}
            agents={agents}
          />
        </div>
      </section>
      {(canvas || settingsPanel) && (
        <div
          className="split-handle"
          role="separator"
          aria-orientation="vertical"
          tabIndex={0}
          aria-label="Resize conversation"
          aria-valuenow={Math.round(ratio)}
          aria-valuemin={32}
          aria-valuemax={65}
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            document.body.style.cursor = "col-resize";
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setRatio(Math.max(32, ratio - 2));
            if (e.key === "ArrowRight") setRatio(Math.min(65, ratio + 2));
          }}
        />
      )}
      {settingsPanel ? (
        <aside className="thread-details">
          <div className="tabs">
            {["Configuration", "Learning", "Usage"].map((t) => (
              <button
                className={detailsTab === t ? "selected" : ""}
                key={t}
                onClick={() => setDetailsTab(t)}
              >
                {t}
              </button>
            ))}
            <IconButton
              label="Close thread details"
              onClick={() => setPanel(false)}
            >
              <X size={16} />
            </IconButton>
          </div>
          {detailsTab === "Configuration" ? (
            <div className="details-fields">
              <h3>Model & compute</h3>
              <label className="field">
                Model
                <select aria-label="Model" className="input">
                  <option>Choose your model</option>
                  <option>Auto</option>
                  <option>GPT-6.1 Sol</option>
                </select>
              </label>
              <label className="field">
                Reasoning effort
                <select aria-label="Reasoning effort" className="input">
                  <option>Medium</option>
                  <option>Low</option>
                  <option>High</option>
                </select>
              </label>
              <label className="field">
                Provider
                <select aria-label="Provider" className="input">
                  <option>Any</option>
                  <option>OpenAI</option>
                </select>
              </label>
              {[
                "Subagents",
                "Autonomy & safety",
                "Capabilities · 17 active",
              ].map((n) => (
                <details key={n}>
                  <summary>{n}</summary>
                  <p className="muted">
                    Preview configuration. No external execution is enabled.
                  </p>
                  <label className="check-row">
                    <input type="checkbox" defaultChecked />
                    Enabled in UI preview
                  </label>
                </details>
              ))}
              <button
                className="btn"
                onClick={() =>
                  notify("Default selection saved for this preview only.")
                }
              >
                Save as default
              </button>
            </div>
          ) : detailsTab === "Learning" ? (
            <div className="empty-state">
              <FileText size={24} />
              <h3>Suggested improvements</h3>
              <p>Review reusable findings from your conversations.</p>
              <button className="btn" onClick={() => navigate("/learning")}>
                Open Learning
              </button>
            </div>
          ) : (
            <div className="empty-state">
              <Clock size={24} />
              <h3>No runtime usage</h3>
              <p>No models or tools have been called in this demo.</p>
            </div>
          )}
        </aside>
      ) : (
        canvas && (
          <section className="artifact-canvas">
            <div className="canvas-toolbar">
              <div className="canvas-filter">
                <button
                  className="btn small"
                  onClick={() => setMenu(menu === "filter" ? "" : "filter")}
                >
                  <ListFilter size={15} />
                  {filter.startsWith("All")
                    ? "All " + artifacts.length
                    : filter}
                  <ChevronDown size={12} />
                </button>
                {menu === "filter" && (
                  <div className="popover">
                    {[
                      "All " + artifacts.length,
                      "Documents",
                      "Webpages",
                      "Images",
                      "Files",
                    ].map((f) => (
                      <button
                        key={f}
                        onClick={() => {
                          setFilter(f);
                          setMenu("");
                        }}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="segmented">
                {[
                  ["Carousel", Layers],
                  ["Tile", Grid2X2],
                  ["Windows", FileText],
                ].map(([n, I]) => {
                  const name = n as string,
                    Icon = I as typeof Layers;
                  return (
                    <IconButton
                      key={name}
                      label={name}
                      className={layout === name ? "selected" : ""}
                      onClick={() => setLayout(name)}
                    >
                      <Icon size={16} />
                    </IconButton>
                  );
                })}
                <IconButton
                  label="Sort artifacts"
                  onClick={() =>
                    notify(
                      "Artifacts are sorted by creation time in this demo.",
                    )
                  }
                >
                  <ArrowDownUp size={16} />
                </IconButton>
              </div>
              <IconButton label="Hide canvas" onClick={() => setCanvas(false)}>
                <PanelRightClose size={17} />
              </IconButton>
            </div>
            <div
              className={
                "canvas-stage " +
                (layout === "Tile"
                  ? "tile-layout"
                  : layout === "Windows"
                    ? "windows-layout"
                    : "")
              }
            >
              {layout === "Tile" ? (
                visible.map((a) => (
                  <button
                    className="artifact-tile"
                    key={a.id}
                    onClick={() => {
                      setSelected(a.id);
                      setLayout("Carousel");
                    }}
                  >
                    {a.id === "notes" ? (
                      <FileText size={45} />
                    ) : a.id === "website" ? (
                      <Globe size={45} />
                    ) : (
                      <img src={safeImage(a.content)} alt={a.title} />
                    )}
                    <strong>{a.title}</strong>
                    <small>{a.type}</small>
                  </button>
                ))
              ) : (
                <>
                  <div className="artifact-tab">
                    <span>
                      {selectedArtifact.type === "Documents" ? (
                        <FileText size={13} />
                      ) : (
                        <Globe size={13} />
                      )}{" "}
                      {selectedArtifact.title}
                    </span>
                    <select
                      aria-label="Artifact version"
                      value={version}
                      onChange={(e) => setVersion(e.target.value)}
                    >
                      <option value="current">
                        v{selectedArtifact.versions.length + 1} Current
                      </option>
                      {selectedArtifact.versions.map((v, i) => (
                        <option key={v.id} value={i}>
                          v{i + 1}
                        </option>
                      ))}
                    </select>
                    <IconButton
                      label="Fullscreen artifact"
                      onClick={() => setModal("fullscreen")}
                    >
                      <Maximize2 size={13} />
                    </IconButton>
                  </div>
                  <div className="artifact-window">
                    {artifactBody(selected)}
                  </div>
                </>
              )}
            </div>
            <div className="canvas-dock">
              {visible.map((a) => (
                <button
                  key={a.id}
                  className={selected === a.id ? "selected" : ""}
                  onClick={() => setSelected(a.id)}
                  aria-label={"Open " + a.title}
                >
                  {a.id === "notes" ? (
                    <FileText size={23} />
                  ) : a.id === "website" ? (
                    <Globe size={23} />
                  ) : (
                    <img src={safeImage(a.content)} alt="" />
                  )}
                  <span>{a.title}</span>
                </button>
              ))}
            </div>
          </section>
        )
      )}
      {modal === "project" && (
        <Modal
          title="Move to project"
          onClose={() => setModal("")}
          footer={
            <button
              className="btn primary"
              onClick={() => {
                update({ ...thread, project: projectTarget || undefined });
                setModal("");
                notify("Project assignment updated locally.");
              }}
            >
              Move thread
            </button>
          }
        >
          <label className="field">
            Project
            <select
              aria-label="Project"
              className="input"
              value={projectTarget}
              onChange={(e) => setProjectTarget(e.target.value)}
            >
              <option value="">No project</option>
              {workspace.data.projects
                .filter((p) => !p.archived)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
        </Modal>
      )}
      {modal === "rename" && (
        <Modal
          title="Rename thread"
          onClose={() => setModal("")}
          footer={
            <>
              <button className="btn" onClick={() => setModal("")}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!renamed.trim()}
                onClick={() => {
                  update({ ...thread, title: renamed.trim() });
                  setModal("");
                }}
              >
                Save name
              </button>
            </>
          }
        >
          <label className="field">
            Thread name
            <input
              aria-label="Thread name"
              className="input"
              value={renamed}
              onChange={(e) => setRenamed(e.target.value)}
            />
          </label>
        </Modal>
      )}
      {modal === "live" && (
        <Modal
          title="Set up Live mode"
          onClose={() => setModal("")}
          footer={
            <>
              <button className="btn" onClick={() => setModal("")}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  workspace.set("schedules", (ss) => [
                    ...ss,
                    {
                      id: uid("schedule"),
                      name: thread.title,
                      instructions: liveInstructions || thread.summary,
                      cadence:
                        liveCadence === "day"
                          ? "Daily at 09:00"
                          : liveCadence === "week"
                            ? "Weekly on Monday"
                            : "Every hour",
                      enabled: false,
                    },
                  ]);
                  setModal("");
                  notify(
                    "Schedule configuration saved locally. Execution remains off.",
                  );
                }}
              >
                Continue
              </button>
            </>
          }
        >
          <p className="muted">
            Set up an always-on agent from this thread. It runs on a schedule,
            in a thread of its own.
          </p>
          <label className="field">
            Every
            <select
              aria-label="Every"
              className="input"
              value={liveCadence}
              onChange={(e) => setLiveCadence(e.target.value)}
            >
              <option>day</option>
              <option>week</option>
              <option>hour</option>
            </select>
            run the following actions:
            <textarea
              className="textarea"
              placeholder="Describe the recurring work…"
              value={liveInstructions}
              onChange={(e) => setLiveInstructions(e.target.value)}
            />
          </label>
          <h3>Where should this agent reach you?</h3>
          <p className="muted">We’ll use this as a draft hint.</p>
          {["This thread", "Slack", "Telegram", "Email"].map((s, i) => (
            <label className="check-row delivery-row" key={s}>
              <input type="radio" name="delivery" defaultChecked={i === 0} />
              <span>
                <strong>{s}</strong>
                <small>
                  {i === 0
                    ? "No extra setup"
                    : "Configure after the draft is saved"}
                </small>
              </span>
            </label>
          ))}
          <p className="demo-note">
            UI preview only. No background work will run.
          </p>
        </Modal>
      )}
      {modal === "fullscreen" && (
        <Modal title={selectedArtifact.title} wide onClose={() => setModal("")}>
          <div className="fullscreen-artifact">{artifactBody(selected)}</div>
        </Modal>
      )}
      {["share", "fork", "actions"].includes(modal) && (
        <Modal
          title={
            modal === "share"
              ? "Share thread"
              : modal === "fork"
                ? "Fork thread"
                : "Message actions"
          }
          onClose={() => setModal("")}
        >
          <p>
            Export a portable copy of this local conversation. This does not
            publish a public link.
          </p>
          <button
            className="btn primary"
            onClick={() =>
              download(
                thread.title + ".json",
                JSON.stringify(thread, null, 2),
                "application/json",
              )
            }
          >
            Export thread JSON
          </button>
          <button
            className="btn"
            onClick={() =>
              download(
                thread.title + ".md",
                "# " +
                  thread.title +
                  "\n\n" +
                  (thread.messages
                    ?.map((m) => "## " + m.role + "\n" + m.text)
                    .join("\n\n") || thread.summary),
                "text/markdown",
              )
            }
          >
            Export Markdown
          </button>
          <button
            className="btn"
            onClick={() => {
              setModal("");
              notify("No external action was performed.");
            }}
          >
            Close preview
          </button>
        </Modal>
      )}
    </div>
  );
}
function PuzzleLabel() {
  return <span className="skill-glyph">✣</span>;
}

export type ThreadProps = {
  thread: DemoThread;
  update: (thread: DemoThread) => void;
  navigate: Navigate;
  notify: (message: string) => void;
  settingsPanel: boolean;
  agents: string[];
};

export default function Thread(props: ThreadProps) {
  const w = useWorkspace();
  return w.mode === "fixture" ? <LegacyThread {...props} /> : <RealThread {...props} />;
}
