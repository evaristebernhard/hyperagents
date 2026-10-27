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
export default function Thread({
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
  const [selected, setSelected] = useState("notes"),
    [layout, setLayout] = useState("Carousel"),
    [filter, setFilter] = useState("All 6"),
    [menu, setMenu] = useState(""),
    [modal, setModal] = useState(""),
    [canvas, setCanvas] = useState(true),
    [detailsTab, setDetailsTab] = useState("Configuration"),
    [notes, setNotes] = useState(
      "Build a clear, frontend-only workspace.\n\nKeep the page structure, menus, and navigation faithful to the reference.\n\nNo LLM, browser runtime, or external tools are connected.",
    ),
    [renamed, setRenamed] = useState(thread.title),
    [log, setLog] = useState(false),
    [ratio, setRatio] = useState(48),
    [version, setVersion] = useState("v1");
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
        {
          role: "assistant",
          text: "Your message is saved locally. This frontend preview does not send requests to a model, browser, or tool service.",
        },
      ],
    });
    setFollow(true);
  };
  const artifacts = [
    { id: "notes", title: "Working notes", type: "Documents" },
    { id: "website", title: "Local potential, redesigned", type: "Webpages" },
    { id: "campaign", title: "campaign-preview.png", type: "Images" },
    { id: "property", title: "property-preview.png", type: "Images" },
    { id: "hiring", title: "hiring-preview.png", type: "Images" },
    { id: "brand", title: "brand-preview.png", type: "Images" },
  ];
  const visible = artifacts.filter(
    (a) => filter === "All 6" || a.type === filter,
  );
  const selectedArtifact =
    artifacts.find((a) => a.id === selected) || artifacts[0];
  const setPanel = (open: boolean) =>
    navigate("/thread/" + thread.id + (open ? "?panel=settings" : ""));
  const artifactBody = (id: string) =>
    id === "notes" ? (
      <article className="notes-document">
        <h1>Working notes</h1>
        <p className="muted">
          What the agent keeps for this thread: its plan, the numbers, and the
          facts it must not forget.
        </p>
        <h2>Notes</h2>
        <textarea
          aria-label="Working notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <h2>Plan Overview</h2>
        <p>
          Create a practical workspace where research, decisions, and finished
          work remain in view.
        </p>
        <h2>Plan Tasks</h2>
        {[
          "Map the main pages and routes",
          "Capture the important UI states",
          "Build the local interaction flows",
          "Verify navigation and accessibility",
        ].map((s, i) => (
          <label className="check-row" key={s}>
            <input type="checkbox" defaultChecked={i < 2} />
            {s}
          </label>
        ))}
        <p className="demo-note">
          Editable preview · changes stay in this open view.
        </p>
      </article>
    ) : id === "website" ? (
      <div className="demo-webpage">
        <div className="demo-site-nav">
          LOCAL / OPPORTUNITY BOARD <span>2026</span>
        </div>
        <p className="eyebrow">INDEPENDENT BUSINESSES. UNDERSERVED WEBSITES.</p>
        <h1>
          Loved around town.
          <br />
          <em>Ready for a better site.</em>
        </h1>
        <p>
          Five well-reviewed businesses, each with a clear opportunity to
          improve their web presence.
        </p>
        <div className="demo-stats">
          <div>
            <b>05</b>CONCEPTS
          </div>
          <div>
            <b>4.7–5.0 ★</b>RATING RANGE
          </div>
          <div>
            <b>1,786</b>COMBINED REVIEWS
          </div>
        </div>
        <div className="demo-sites">
          {["Bakery Café", "Shoe Repair", "Auto Service", "Alterations"].map(
            (n, i) => (
              <button
                key={n}
                onClick={() =>
                  notify(n + " concept selected · static demo preview")
                }
              >
                <img
                  src={asset(["brand", "campaign", "hiring", "property"][i])}
                  alt={n}
                />
                <strong>{n}</strong>
                <span>★ 4.8 · See concept →</span>
              </button>
            ),
          )}
        </div>
      </div>
    ) : (
      <div className="canvas-image">
        <img src={asset(id)} alt={id + " preview"} />
      </div>
    );
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
                        else if (name === "Fork thread") setModal("fork");
                        else if (name === "Move to project")
                          navigate("/projects");
                        else
                          notify(
                            name +
                              " is a demo action; no remote data was changed.",
                          );
                      }}
                    >
                      <Icon size={15} />
                      {name}
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
                <select className="input">
                  <option>Choose your model</option>
                  <option>Auto</option>
                  <option>GPT-6.1 Sol</option>
                </select>
              </label>
              <label className="field">
                Reasoning effort
                <select className="input">
                  <option>Medium</option>
                  <option>Low</option>
                  <option>High</option>
                </select>
              </label>
              <label className="field">
                Provider
                <select className="input">
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
                  {filter}
                  <ChevronDown size={12} />
                </button>
                {menu === "filter" && (
                  <div className="popover">
                    {["All 6", "Documents", "Webpages", "Images"].map((f) => (
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
                      <img src={asset(a.id)} alt={a.title} />
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
                      <option>v1</option>
                      <option>Original</option>
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
                    <img src={asset(a.id)} alt="" />
                  )}
                  <span>{a.title}</span>
                </button>
              ))}
            </div>
          </section>
        )
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
                  setModal("");
                  notify(
                    "Live mode is a preview only. No schedule or agent was created.",
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
            <select className="input">
              <option>day</option>
              <option>week</option>
              <option>hour</option>
            </select>
            run the following actions:
            <textarea
              className="textarea"
              placeholder="Describe the recurring work…"
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
            This is a local frontend preview. Public sharing and server-side
            thread operations are not connected.
          </p>
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
