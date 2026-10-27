import { useEffect, useState } from "react";
import {
  Plus,
  Search,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  ArrowUpRight,
  FileText,
  Globe,
  Puzzle,
  Brain,
  Folder,
  BookOpen,
  Store,
  Users,
  Bot,
  Star,
  Clock,
  Image,
  Grid2X2,
  List,
  Download,
  Trash2,
  X,
  Check,
  History,
  GitBranch,
  Activity,
  Layers,
  ExternalLink,
} from "lucide-react";
import type { ResourceProps } from "./types";
import { IconButton, Modal, Composer } from "./ui";
import { asset } from "./data";
import "./resources-ui.css";
const skillList = [
  {
    id: "nyt-data-viz",
    name: "NYT Data Viz",
    author: "Hyperagent Team",
    description:
      "NYT-discipline data visualization. Applies clear rules for color, typography, annotation, and chart selection.",
    tag: "Content creation",
    count: "187",
  },
  {
    id: "swiss-grid-design",
    name: "Swiss Grid Design",
    author: "Hyperagent Team",
    description:
      "Build editorial, magazine, and report webpages on a precise modular grid. Thoughtful typography and restrained visual hierarchy.",
    tag: "Development & engineering",
    count: "178",
  },
  {
    id: "roast-my-idea",
    name: "Roast My Idea",
    author: "Community",
    description:
      "Explore an idea from five independent perspectives, then identify the biggest risk and the cheapest test.",
    tag: "Research",
    count: "607",
  },
  {
    id: "small-biz-builder",
    name: "Small Biz Website Builder",
    author: "Community",
    description:
      "Find local businesses with great reviews and weak web presence, build concept sites, and package them as a dashboard.",
    tag: "Sales & outreach",
    count: "684",
  },
];
const marketAgents = [
  [
    "priya",
    "Priya",
    "Sales",
    "Find work early, answer inbound leads, and keep one honest sales pipeline.",
    "🟣",
  ],
  [
    "yuki",
    "Yuki",
    "Marketing",
    "Build channel-native campaigns, preview creative, and report verified results.",
    "🟢",
  ],
  [
    "theo",
    "Theo",
    "Quoting",
    "Turn a brief into clear, owner-priced quotes for service businesses.",
    "🟠",
  ],
  [
    "dmitri",
    "Dmitri",
    "Operations",
    "Run the calendar, match capacity, and recover disrupted days.",
    "🔵",
  ],
  [
    "callum",
    "Callum",
    "Recruiting",
    "Write clear job posts, organize structured interviews, and prepare first-week plans.",
    "🟤",
  ],
  [
    "marisol",
    "Marisol",
    "Loyalty",
    "Turn completed customer experiences into reviews, referrals, and repeat business.",
    "🔴",
  ],
];
export default function ResourcesUI(p: ResourceProps) {
  const {
    path,
    navigate,
    notify,
    threads,
    projects,
    setProjects,
    memories,
    setMemories,
    openThread,
    onCreateThread,
  } = p;
  const section = path.split("/")[1],
    id = path.split("/")[2];
  const [query, setQuery] = useState(""),
    [tab, setTab] = useState(""),
    [modal, setModal] = useState(""),
    [filters, setFilters] = useState(false),
    [sort, setSort] = useState("Newest"),
    [grid, setGrid] = useState(true),
    [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [goal, setGoal] = useState(""),
    [category, setCategory] = useState("User Fact"),
    [importance, setImportance] = useState("3"),
    [pinned, setPinned] = useState(false),
    [artifact, setArtifact] = useState("website"),
    [installed, setInstalled] = useState<string[]>([]),
    [wikiTab, setWikiTab] = useState("Pages"),
    [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    setQuery("");
    setTab("");
    setModal("");
    setFilters(false);
    setTitle("");
    setBody("");
    setGoal("");
  }, [path]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal("");
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  const header = (
    name: string,
    description?: string,
    action?: React.ReactNode,
  ) => (
    <header className="page-header">
      <div>
        <h1 className="page-title">{name}</h1>
        {description && <p className="muted rp-description">{description}</p>}
      </div>
      {action}
    </header>
  );
  const search = (placeholder: string) => (
    <div className="rp-search-row">
      <div className="rp-search">
        <Search size={15} />
        <input
          placeholder={placeholder}
          aria-label={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <button className="btn small" onClick={() => setFilters(!filters)}>
        <SlidersHorizontal size={14} />
        Filters
      </button>
    </div>
  );
  const empty = (
    name: string,
    description: string,
    icon: React.ReactNode,
    action?: React.ReactNode,
  ) => (
    <div className="empty-state">
      {icon}
      <h3>{name}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
  const createMemory = () => {
    if (!body.trim()) return;
    setMemories([
      ...memories,
      {
        id: "memory-" + Date.now(),
        content: body.trim(),
        category,
        importance: Number(importance),
        pinned,
      },
    ]);
    setBody("");
    setModal("");
    notify("Memory saved on this device.");
  };
  const addProject = () => {
    if (!title.trim()) return;
    const item = {
      id: "project-" + Date.now(),
      name: title.trim(),
      description: body,
      goal,
    };
    setProjects([...projects, item]);
    navigate("/projects/" + item.id);
    notify("Project created locally.");
  };
  const demoNoBackend = (action: string) =>
    notify(action + " is a frontend preview. No external service was called.");
  const skillCards = (count = 4) => (
    <div className="rp-skill-cards">
      {skillList.slice(0, count).map((s) => (
        <a
          className="card rp-skill-card"
          key={s.id}
          href={"/marketplace/s/" + s.id}
          onClick={(e) => {
            e.preventDefault();
            navigate("/marketplace/s/" + s.id);
          }}
        >
          <h3>{s.name}</h3>
          <small>
            <span className="rp-author-avatar">{s.author[0]}</span>
            {s.author}
          </small>
          <p>{s.description}</p>
          <div className="rp-card-footer">
            <span className="badge">{s.tag}</span>
            <small>
              <Download size={11} />
              {s.count}
            </small>
          </div>
        </a>
      ))}
    </div>
  );
  let content: React.ReactNode;
  if (section === "skills") {
    if (!id)
      content = (
        <>
          {header(
            "Skills",
            "Building blocks that add specific capabilities to your agents and threads.",
            <button className="btn" onClick={() => navigate("/skills/new")}>
              <Plus size={15} />
              Create skill
            </button>,
          )}
          <div className="rp-section-head">
            <h3>Discover and install new skills</h3>
            <button className="plain" onClick={() => navigate("/marketplace")}>
              See more →
            </button>
          </div>
          {skillCards()}
          <div className="rp-table-top">
            <div className="tabs">
              {["Your skills", "Shared with you"].map((n) => (
                <button
                  key={n}
                  className={(tab || "Your skills") === n ? "selected" : ""}
                  onClick={() => setTab(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <button className="btn small" onClick={() => setFilters(!filters)}>
              <SlidersHorizontal size={14} />
              Filters
            </button>
          </div>
          {filters && search("Search installed skills…")}
          {(tab || "Your skills") === "Your skills" ? (
            <table className="table">
              <thead>
                <tr>
                  {[
                    "Name",
                    "Description",
                    "Agents",
                    "Threads",
                    "Installed on",
                    "Actions",
                  ].map((n) => (
                    <th key={n}>{n}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {skillList
                  .filter(
                    (s) =>
                      (s.id === "small-biz-builder" ||
                        installed.includes(s.id)) &&
                      s.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((s) => (
                    <tr key={s.id}>
                      <td>
                        <a
                          href={"/skills/" + s.id + "?from=skills"}
                          onClick={(e) => {
                            e.preventDefault();
                            navigate("/skills/" + s.id + "?from=skills");
                          }}
                        >
                          <b>{s.name}</b>
                        </a>
                      </td>
                      <td className="rp-skill-description">{s.description}</td>
                      <td>0</td>
                      <td>1</td>
                      <td>Oct 27, 2026</td>
                      <td>
                        <button
                          className="plain"
                          onClick={() => navigate("/skills/" + s.id)}
                        >
                          Open ›
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            empty(
              "No shared skills",
              "Skills shared with you will appear here.",
              <Puzzle size={28} />,
            )
          )}
        </>
      );
    else if (id === "new" || path.endsWith("/edit"))
      content = (
        <>
          {header(
            id === "new" ? "Create skill" : "Edit skill",
            undefined,
            <button className="btn" onClick={() => navigate("/skills")}>
              Cancel
            </button>,
          )}
          <form
            className="rp-form"
            onSubmit={(e) => {
              e.preventDefault();
              demoNoBackend("Skill saving");
            }}
          >
            <label className="field">
              Skill name
              <input
                className="input"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Data visualization"
              />
            </label>
            <label className="field">
              Description
              <textarea
                className="textarea"
                required
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            <label className="field">
              When to use
              <input
                className="input"
                placeholder="When should an agent use this skill?"
              />
            </label>
            <label className="field">
              Documentation
              <textarea
                className="textarea"
                rows={10}
                placeholder="Reusable instructions in Markdown…"
              />
            </label>
            <p className="demo-note">
              Editor preview only. Skill execution and credentials are not
              connected.
            </p>
            <button className="btn primary">Preview save</button>
          </form>
        </>
      );
    else {
      const s = skillList.find((s) => s.id === id) || skillList[3];
      content = (
        <>
          <div className="rp-back">
            <button className="plain" onClick={() => navigate("/skills")}>
              <ArrowLeft size={15} />
              Skills
            </button>
            <div className="actions">
              <button
                className="btn small"
                onClick={() => demoNoBackend("Sharing")}
              >
                Share…
              </button>
              <button
                className="btn small"
                onClick={() => navigate("/skills/" + id + "/edit?from=skills")}
              >
                Edit Skill
              </button>
            </div>
          </div>
          <h1>{s.name}</h1>
          <p className="muted">{s.description}</p>
          <div className="actions rp-tags">
            <span className="badge">Created today</span>
            <span className="badge">web-design</span>
            <span className="badge">research</span>
            <button
              className="btn small"
              onClick={() =>
                onCreateThread(
                  "Use " + s.name + " to help with my next project.",
                )
              }
            >
              Try This Skill
            </button>
          </div>
          <div className="card rp-recent-threads">
            <div className="page-header">
              <h3>
                Recent Threads <span className="badge">0</span>
              </h3>
              <button
                className="btn small"
                onClick={() => onCreateThread("Use " + s.name)}
              >
                New Thread
              </button>
            </div>
            {empty(
              "No threads yet",
              "Start a conversation to use this skill",
              <MessageIcon />,
            )}
          </div>
          <div className="grid2">
            <div className="card">
              <h4>Usage</h4>
              <p>All your agents, on-demand</p>
              <div className="rp-meta-row">
                <span>Agents using</span>
                <span>0</span>
              </div>
              <div className="rp-meta-row">
                <span>Threads</span>
                <span>0</span>
              </div>
            </div>
            <div className="card">
              <h4>Credentials</h4>
              <p>
                Authentication <span className="badge">None</span>
              </p>
              <small className="muted">No credentials required.</small>
            </div>
          </div>
          <section className="rp-doc-section">
            <h3>When to Use</h3>
            <p>
              Use when you need a structured approach to researching options and
              turning findings into a clear deliverable.
            </p>
          </section>
          <section className="rp-doc-section">
            <h3>Documentation</h3>
            <h2>{s.name}</h2>
            <p>{s.description}</p>
            <h3>Start with the context</h3>
            <p>
              Understand the task, gather evidence, and verify the important
              facts. Distinguish observations from assumptions.
            </p>
            <h3>Build the deliverable</h3>
            <p>
              Keep the output practical, clear, and honest about what is and is
              not connected.
            </p>
            <p className="demo-note">
              Example documentation for UI demonstration, not the original skill
              implementation.
            </p>
            <button
              className="plain"
              onClick={() => navigate("/marketplace/s/" + s.id)}
            >
              View original in Marketplace →
            </button>
          </section>
        </>
      );
    }
  } else if (section === "memories")
    content = (
      <>
        {header(
          "Memories",
          "Browse saved context and memories owned by your agents.",
          <button className="btn" onClick={() => setModal("memory")}>
            <Plus size={15} />
            Add memory
          </button>,
        )}
        <div className="rp-memory-toolbar">
          <span className="pill">
            Personal <span className="badge">{memories.length}</span>
          </span>
          <span className="muted">{memories.length} memories</span>
          {search("Search memories…")}
        </div>
        {filters && (
          <div className="filter-strip">
            <label>
              <input
                type="checkbox"
                checked={pinned}
                onChange={(e) => setPinned(e.target.checked)}
              />
              Pinned only
            </label>
            <button
              className="plain"
              onClick={() => {
                setPinned(false);
                setFilters(false);
              }}
            >
              Clear
            </button>
          </div>
        )}
        {memories.length ? (
          <div className="rp-memory-list">
            {memories
              .filter(
                (m) =>
                  m.content.toLowerCase().includes(query.toLowerCase()) &&
                  (!filters || !pinned || m.pinned),
              )
              .map((m) => (
                <div className="card" key={m.id}>
                  <div className="page-header">
                    <span className="badge">{m.category}</span>
                    <div className="actions">
                      <span className="muted">Importance {m.importance}</span>
                      <IconButton
                        label="Delete memory"
                        onClick={() => {
                          if (confirm("Delete this local demo memory?"))
                            setMemories(memories.filter((x) => x.id !== m.id));
                        }}
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    </div>
                  </div>
                  <p>{m.content}</p>
                  {m.pinned && <span className="badge">Pinned</span>}
                </div>
              ))}
          </div>
        ) : (
          empty(
            "No memories yet",
            "Add important context you want your agents to remember.",
            <Brain size={32} />,
            <button
              className="btn primary small"
              onClick={() => setModal("memory")}
            >
              Add memory
            </button>,
          )
        )}
      </>
    );
  else if (section === "projects") {
    if (id === "new")
      content = (
        <>
          <button className="plain" onClick={() => navigate("/projects")}>
            <ArrowLeft size={15} />
            New project
          </button>
          <p className="muted rp-description">
            Create a context for your related work.
          </p>
          <form
            className="rp-form card"
            onSubmit={(e) => {
              e.preventDefault();
              addProject();
            }}
          >
            <h3>Project details</h3>
            <p className="muted">
              Projects keep related threads, files, and context together.
            </p>
            <label className="field">
              Project name
              <input
                className="input"
                required
                autoFocus
                placeholder="Name your project"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="field">
              Description
              <textarea
                className="textarea"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="A short description of what this project is about"
              />
            </label>
            <label className="field">
              Goals
              <textarea
                className="textarea"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="What are the goals of this project?"
              />
            </label>
            <div className="rp-form-actions">
              <button
                type="button"
                className="plain"
                onClick={() => navigate("/projects")}
              >
                Cancel
              </button>
              <button className="btn primary" disabled={!title.trim()}>
                Create project
              </button>
            </div>
          </form>
        </>
      );
    else if (!id)
      content = (
        <>
          {header(
            "Projects",
            undefined,
            <div className="actions">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                />
                Show Archived
              </label>
              <button
                className="btn primary"
                onClick={() => navigate("/projects/new")}
              >
                <Plus size={14} />
                New project
              </button>
            </div>,
          )}
          <div className="rp-project-cards">
            {projects.map((pr) => (
              <article className="card" key={pr.id}>
                <a
                  href={"/projects/" + pr.id}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate("/projects/" + pr.id);
                  }}
                >
                  <h3>
                    <Folder size={18} />
                    {pr.name}
                  </h3>
                  <p className="muted">{pr.description}</p>
                  <div className="actions">
                    <span className="muted">Active today</span>
                    <span className="badge">
                      {threads.filter((t) => t.project === pr.id).length}{" "}
                      threads
                    </span>
                    <span className="badge">0 files</span>
                  </div>
                </a>
                <h5 className="muted">RECENT THREADS</h5>
                {threads
                  .filter((t) => t.project === pr.id)
                  .map((t) => (
                    <button
                      className="rp-project-thread"
                      key={t.id}
                      onClick={() => openThread(t.id)}
                    >
                      {t.title}
                      <small>{t.time}</small>
                    </button>
                  ))}
              </article>
            ))}
          </div>
        </>
      );
    else {
      const pr = projects.find((x) => x.id === id);
      content = pr ? (
        <>
          <div className="rp-back">
            <button className="plain" onClick={() => navigate("/projects")}>
              <ArrowLeft size={15} />
              <Folder size={15} />
              {pr.name}
            </button>
            <button
              className="plain"
              onClick={() => {
                setTitle(pr.name);
                setBody(pr.description);
                setGoal(pr.goal);
                setModal("project-edit");
              }}
            >
              <SlidersHorizontal size={15} />
              Edit project
            </button>
          </div>
          <div className="rp-project-composer">
            <Composer
              navigate={navigate}
              notify={notify}
              onSend={(t) => onCreateThread(t, id)}
            />
          </div>
          <div className="tabs">
            {["Threads", "All artifacts", "Context docs"].map((n, i) => (
              <button
                className={(tab || "Threads") === n ? "selected" : ""}
                key={n}
                onClick={() => setTab(n)}
              >
                {n} (
                {i === 0
                  ? threads.filter((t) => t.project === id).length
                  : i === 2
                    ? 1
                    : 0}
                )
              </button>
            ))}
          </div>
          {(tab || "Threads") === "Threads" ? (
            <>
              <div className="rp-section-head">
                <input
                  className="search-input"
                  placeholder="Search by name or topic"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button
                  className="btn small"
                  onClick={() => setModal("add-thread")}
                >
                  <Plus size={14} />
                  Add existing thread
                </button>
              </div>
              {threads
                .filter(
                  (t) =>
                    t.project === id &&
                    t.title.toLowerCase().includes(query.toLowerCase()),
                )
                .map((t) => (
                  <button
                    className="card rp-project-thread-card"
                    key={t.id}
                    onClick={() => openThread(t.id)}
                  >
                    <h3>{t.title}</h3>
                    <p>{t.summary}</p>
                    <small>{t.time}</small>
                  </button>
                ))}
            </>
          ) : tab === "Context docs" ? (
            <div className="card rp-context">
              <h2>{pr.name}</h2>
              <h3>Goals</h3>
              <p>{pr.goal || "Define your project goals here."}</p>
              <h3>Critical Facts</h3>
              <p>{pr.description}</p>
              <h3>Research & Findings</h3>
              <p className="muted">Accumulated research and discoveries.</p>
            </div>
          ) : (
            empty(
              "No artifacts yet",
              "Artifacts from this project’s threads appear here.",
              <Layers size={28} />,
            )
          )}
        </>
      ) : (
        empty(
          "Project not found",
          "Return to the project list.",
          <Folder size={28} />,
          <button className="btn" onClick={() => navigate("/projects")}>
            Projects
          </button>,
        )
      );
    }
  } else if (section === "library") {
    const items = [
      { id: "notes", title: "Working notes", type: "Documents" },
      ...["website", "campaign", "property", "hiring", "brand"].map((n, i) => ({
        id: n,
        title: i === 0 ? "Local potential, redesigned" : n + "-preview.png",
        type: i === 0 ? "Webpages" : "Images",
      })),
    ];
    const filtered = items.filter(
      (x) =>
        (!tab || tab === "All" || x.type === tab) &&
        x.title.toLowerCase().includes(query.toLowerCase()),
    );
    content = (
      <>
        {header(
          "Library",
          undefined,
          <div className="actions">
            <label className="check-row">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show Archived
            </label>
            <IconButton
              label="Toggle library layout"
              onClick={() => setGrid(!grid)}
            >
              {grid ? <List size={16} /> : <Grid2X2 size={16} />}
            </IconButton>
          </div>,
        )}
        <div className="rp-library-toolbar">
          {search("Search library…")}
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
        </div>
        {filters && (
          <div className="tabs">
            {["All", "Images", "Documents", "Webpages"].map((n) => (
              <button
                key={n}
                className={(tab || "All") === n ? "selected" : ""}
                onClick={() => setTab(n)}
              >
                {n}
              </button>
            ))}
          </div>
        )}
        <div className={"rp-library-grid " + (!grid ? "list" : "")}>
          {(sort === "Oldest"
            ? [...filtered].reverse()
            : sort === "Name"
              ? [...filtered].sort((a, b) => a.title.localeCompare(b.title))
              : filtered
          ).map((x) => (
            <button
              className="rp-library-card"
              key={x.id}
              onClick={() => {
                setArtifact(x.id);
                setModal("artifact");
              }}
            >
              <div className="rp-library-preview">
                {x.id === "notes" ? (
                  <div className="rp-note-preview">
                    <h2>Working notes</h2>
                    <p>What the agent keeps for this thread.</p>
                    <h4>Notes</h4>
                    <p>Capture the plan, research, and important decisions.</p>
                  </div>
                ) : (
                  <img
                    src={asset(x.id === "website" ? "brand" : x.id)}
                    alt={x.title}
                  />
                )}
              </div>
              <strong>{x.title}</strong>
              <small>
                from <span>Small Biz Website Builder Thread</span>
              </small>
              <small className="muted">today · {x.type}</small>
            </button>
          ))}
        </div>
      </>
    );
  } else if (section === "marketplace") {
    const detail = path.split("/")[3];
    if (id === "a" && detail) {
      const a = marketAgents.find((a) => a[0] === detail) || marketAgents[0];
      content = (
        <div className="rp-market-detail">
          <button className="plain" onClick={() => navigate("/marketplace")}>
            <ArrowLeft size={15} />
            Marketplace
          </button>
          <span className="rp-market-avatar">{a[4]}</span>
          <h1>{a[1]}</h1>
          <p className="muted">{a[2]} · Hyperagent Team</p>
          <p>{a[3]}</p>
          <button
            className="btn primary"
            onClick={() => navigate("/agents/new")}
          >
            Add agent <Plus size={14} />
          </button>
          <h3>Skills</h3>
          <div className="rp-market-skills">
            {skillList.map((s) => (
              <button
                className="card"
                key={s.id}
                onClick={() => navigate("/marketplace/s/" + s.id)}
              >
                <strong>{s.name}</strong>
                <p>{s.description}</p>
              </button>
            ))}
          </div>
          <h3>System prompt</h3>
          <h2>
            {a[1]}, the {a[2].toLowerCase()} agent
          </h2>
          <p>
            Be practical, precise, and honest about what is known. Keep the
            owner in charge of consequential actions.
          </p>
          <p className="demo-note">
            Independent sample content, not the original agent configuration.
          </p>
        </div>
      );
    } else if (id === "s" && detail) {
      const s = skillList.find((s) => s.id === detail) || skillList[3];
      content = (
        <div className="rp-market-detail">
          <button className="plain" onClick={() => navigate("/marketplace")}>
            <ArrowLeft size={15} />
            Marketplace
          </button>
          <h1>{s.name}</h1>
          <p className="muted">{s.author}</p>
          <p>{s.description}</p>
          <div className="actions">
            <button
              className="btn primary"
              onClick={() => {
                setInstalled([...new Set([...installed, s.id])]);
                notify(
                  "Added to the demo skill list for this session. No remote installation.",
                );
              }}
            >
              {installed.includes(s.id) ? "Added to demo" : "Add skill"}
              <Plus size={14} />
            </button>
            <span className="badge">{s.tag}</span>
          </div>
          <img
            className="rp-market-cover"
            src={asset("brand")}
            alt="Example deliverable"
          />
          <h3>Instructions</h3>
          <h2>{s.name}</h2>
          <p>
            Gather context, verify evidence, and produce clear work that can be
            reviewed and improved.
          </p>
          <h3>Tools used</h3>
          <p>Search · Documents · Webpages</p>
          <p className="demo-note">
            UI demonstration only. Nothing will execute.
          </p>
        </div>
      );
    } else
      content = (
        <>
          {header(
            "Marketplace",
            undefined,
            <div className="rp-search">
              <Search size={15} />
              <input
                placeholder="Search the marketplace"
                aria-label="Search marketplace"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>,
          )}
          <h1 className="rp-market-heading">Hire your team of agents</h1>
          <p>From the community</p>
          <div className="rp-market-agents">
            {marketAgents
              .filter((a) =>
                a.join(" ").toLowerCase().includes(query.toLowerCase()),
              )
              .map((a) => (
                <a
                  className="card"
                  href={"/marketplace/a/" + a[0]}
                  key={a[0]}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate("/marketplace/a/" + a[0]);
                  }}
                >
                  <div className="rp-agent-title">
                    <span>{a[4]}</span>
                    <div>
                      <h3>{a[1]}</h3>
                      <small>{a[2]}</small>
                    </div>
                  </div>
                  <small className="muted">Hyperagent Team</small>
                  <p>{a[3]}</p>
                  <span className="muted">More ›</span>
                </a>
              ))}
          </div>
          <h3>Skills from the community</h3>
          {skillCards()}
        </>
      );
  } else if (section === "inbox")
    content = (
      <>
        {header("Inbox")}
        <div className="rp-inbox">
          <aside>
            <button className="selected">
              <Brain size={18} />
              <div>
                <strong>1 learning</strong>
                <small>Review suggested memories and skills</small>
              </div>
            </button>
          </aside>
          <section>
            <h3>
              1 learning <span className="badge">Suggestion</span>
            </h3>
            <p className="muted">
              Review and save these suggestions in Learning.
            </p>
            <small className="muted">
              Skill Update · Small Biz Website Builder Thread
            </small>
            <div className="card">
              <strong>Small Biz Website Builder</strong>
              <p className="muted">
                Capture reusable findings from this conversation.
              </p>
            </div>
            <button className="btn small" onClick={() => navigate("/learning")}>
              Open learning
            </button>
          </section>
        </div>
      </>
    );
  else if (section === "learning")
    content = (
      <>
        {header(
          "Learning",
          undefined,
          <span className="badge">1 pending</span>,
        )}
        <div className="rp-learning-filters">
          <span>Agent:</span>
          {["All", "No Agent"].map((n) => (
            <button
              className={
                "pill " + (tab === n || (!tab && n === "All") ? "selected" : "")
              }
              key={n}
              onClick={() => setTab(n)}
            >
              {n}
            </button>
          ))}
          <span>Type:</span>
          <button className="pill" onClick={() => setFilters(!filters)}>
            1 Skill
          </button>
        </div>
        <p className="muted rp-description">
          Click a type to see grouped suggestions across all threads.
        </p>
        {threads.map((t) => (
          <div className="rp-learning-row" key={t.id}>
            <button onClick={() => openThread(t.id)}>
              <strong>{t.title}</strong>
              <small>
                {t.messages?.length || 3} messages · {t.time}
              </small>
            </button>
            <span className="muted">
              {t.id === "small-business" ? "1 suggestion" : "—"}
            </span>
            <div className="actions">
              <IconButton
                label={"Open " + t.title}
                onClick={() => openThread(t.id)}
              >
                <ArrowUpRight size={15} />
              </IconButton>
              <IconButton
                label="Review learning"
                onClick={() => setModal("learning")}
              >
                <Brain size={15} />
              </IconButton>
            </div>
          </div>
        ))}
        {filters && (
          <div className="card rp-learning-suggestion">
            <span className="badge">Skill Update</span>
            <h3>Small Biz Website Builder</h3>
            <p>
              Keep reusable research and UI observations for the next project.
            </p>
            <button className="btn small" onClick={() => setModal("learning")}>
              Review suggestion
            </button>
          </div>
        )}
      </>
    );
  else if (section === "rubrics")
    content = (
      <>
        {header(
          "Rubrics",
          "Define what excellent work looks like.",
          <button className="btn primary" onClick={() => setModal("rubric")}>
            <Plus size={15} />
            Create rubric
          </button>,
        )}
        {search("Search rubrics…")}
        {empty(
          "No rubrics yet",
          "Create a rubric to evaluate work against clear criteria.",
          <Check size={28} />,
          <button className="btn" onClick={() => setModal("rubric")}>
            Create rubric
          </button>,
        )}
      </>
    );
  else if (section === "wiki")
    content = (
      <>
        {header(
          "Autowiki",
          "One page for each person, customer, project and process your agents know, kept up to date by dreaming.",
          <span className="badge">BETA</span>,
        )}
        <div className="rp-section-head">
          <span className="badge">Dreaming is off</span>
          <button
            className="plain"
            onClick={() => notify("No archived pages in this demo.")}
          >
            Show archived
          </button>
        </div>
        <div className="tabs">
          {["Pages", "Graph", "History"].map((n) => (
            <button
              key={n}
              className={wikiTab === n ? "selected" : ""}
              onClick={() => setWikiTab(n)}
            >
              {n}
            </button>
          ))}
        </div>
        {wikiTab === "Pages" ? (
          <>
            <p className="muted rp-no-pages">No pages yet.</p>
            <div className="card rp-wiki-start">
              <h2>Start your Autowiki</h2>
              <p>
                Dreaming reads your threads, saved memories and documents, and
                writes a page for each person, customer, project and process.
              </p>
              <div className="actions">
                <span>Start from the last</span>
                <select className="input">
                  <option>14 days</option>
                  <option>7 days</option>
                </select>
                <span>then dream daily at</span>
                <input className="input" type="time" defaultValue="01:00" />
              </div>
              <button
                className="btn primary"
                onClick={() => demoNoBackend("Dreaming")}
              >
                Turn on
              </button>
              <p className="demo-note">
                Preview only. No data will be read or processed.
              </p>
            </div>
          </>
        ) : (
          empty(
            wikiTab === "Graph" ? "No graph yet" : "No history yet",
            "Pages will appear when a backend is connected.",
            wikiTab === "Graph" ? (
              <GitBranch size={28} />
            ) : (
              <History size={28} />
            ),
          )
        )}
      </>
    );
  else if (section === "command-center")
    content = (
      <>
        {header("Command Center")}
        <div className="rp-stat-grid">
          {[
            ["AGENTS", "0"],
            ["ACTIVE", "0"],
            ["TOTAL RUNS", "0"],
            ["AVG SCORE", "--"],
            ["PENDING", "1"],
          ].map(([n, v]) => (
            <div key={n}>
              <small>{n}</small>
              <strong>{v}</strong>
            </div>
          ))}
        </div>
        <div className="card rp-roster">
          <h3>
            Agent Roster <span className="badge">0 agents</span>
          </h3>
          <table className="table">
            <thead>
              <tr>
                {[
                  "AGENT",
                  "RUNS",
                  "QUALITY",
                  "QUALITY TREND",
                  "LAST ACTIVE",
                ].map((n) => (
                  <th key={n}>{n}</th>
                ))}
              </tr>
            </thead>
          </table>
          {empty(
            "No agent runs yet",
            "Locally created demo agents do not execute.",
            <Bot size={24} />,
          )}
        </div>
        <div className="grid2 rp-dashboard-grid">
          <div className="card">
            <h3>Active Operations</h3>
            {empty(
              "All quiet",
              "No active operations.",
              <Activity size={22} />,
            )}
          </div>
          <div className="card">
            <h3>
              Score Trends <small className="muted">Last 90 days</small>
            </h3>
            {empty(
              "Not enough eval data",
              "No model evaluations are running.",
              <Layers size={22} />,
            )}
          </div>
        </div>
        <div className="card">
          <div className="page-header">
            <h3>Needs Attention · 1</h3>
            <button className="plain" onClick={() => navigate("/learning")}>
              View all
            </button>
          </div>
          <strong>1 pending improvement</strong>
          <p className="muted">
            Review a suggested skill update from your recent work.
          </p>
          <span className="badge">Skill Update</span>
        </div>
        <h3 className="rp-section-spaced">Recent Runs</h3>
        <p className="muted">No completed runs yet.</p>
      </>
    );
  else
    content = (
      <>
        {header(
          (
            {
              documents: "Documents",
              hyperapps: "HyperApps",
              workflows: "Workflows",
              workspaces: "Workspaces",
            } as Record<string, string>
          )[section] || "Workspace",
        )}
        <p className="demo-note">
          Supplementary demo route; this page was not captured in the reference
          set.
        </p>
        {empty(
          "Nothing here yet",
          "This preview does not connect a backend for this feature.",
          <Layers size={30} />,
          <button className="btn" onClick={() => navigate("/threads/new")}>
            Start a task
          </button>,
        )}
      </>
    );
  return (
    <div
      className={
        "resource-page rp-page " +
        (section === "marketplace" ? "rp-marketplace" : "")
      }
    >
      {content}
      {modal === "memory" && (
        <Modal
          title="Add Memory"
          onClose={() => setModal("")}
          footer={
            <>
              <button className="btn" onClick={() => setModal("")}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!body.trim()}
                onClick={createMemory}
              >
                Add Memory
              </button>
            </>
          }
        >
          <p className="muted">Add something you want the agent to remember.</p>
          <label className="field">
            Memory Content
            <textarea
              className="textarea"
              autoFocus
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Add important context…"
            />
          </label>
          <div className="grid2">
            <label className="field">
              Category
              <select
                className="input"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {["User Fact", "Preference", "Workflow", "Project Context"].map(
                  (n) => (
                    <option key={n}>{n}</option>
                  ),
                )}
              </select>
            </label>
            <label className="field">
              Importance (1–5)
              <select
                className="input"
                value={importance}
                onChange={(e) => setImportance(e.target.value)}
              >
                {["1", "2", "3", "4", "5"].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            When to Use (optional)
            <input className="input" placeholder="When is this relevant?" />
          </label>
          <label className="field">
            Tags (optional)
            <input className="input" placeholder="Comma-separated tags" />
          </label>
          <h4>Scope</h4>
          <label className="check-row">
            <input type="checkbox" defaultChecked />
            Global — all your demo agents
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
            />
            Pinned
          </label>
        </Modal>
      )}
      {modal === "project-edit" && (
        <Modal
          title="Edit project"
          onClose={() => setModal("")}
          footer={
            <>
              <button className="btn" onClick={() => setModal("")}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!title.trim()}
                onClick={() => {
                  setProjects(
                    projects.map((x) =>
                      x.id === id
                        ? { ...x, name: title, description: body, goal }
                        : x,
                    ),
                  );
                  setModal("");
                  notify("Project updated locally.");
                }}
              >
                Save changes
              </button>
            </>
          }
        >
          <label className="field">
            Name
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            Description
            <textarea
              className="textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <label className="field">
            Goals
            <textarea
              className="textarea"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </label>
        </Modal>
      )}
      {modal === "add-thread" && (
        <Modal title="Add existing thread" onClose={() => setModal("")}>
          {threads.map((t) => (
            <button
              className="rp-add-thread-row"
              key={t.id}
              onClick={() => {
                p.setThreads(
                  threads.map((x) =>
                    x.id === t.id ? { ...x, project: id } : x,
                  ),
                );
                notify("Thread added to this project locally.");
                setModal("");
              }}
            >
              <FileText size={16} />
              {t.title}
              <Plus size={14} />
            </button>
          ))}
        </Modal>
      )}
      {modal === "artifact" && (
        <div
          className="rp-artifact-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Artifact preview"
        >
          <header>
            <span>
              {artifact === "website"
                ? "Local potential, redesigned"
                : artifact === "notes"
                  ? "Working notes"
                  : artifact + "-preview.png"}
            </span>
            <IconButton
              label="Close artifact preview"
              onClick={() => setModal("")}
            >
              <X size={19} />
            </IconButton>
          </header>
          <div className="rp-artifact-body">
            <div className="rp-artifact-display">
              {artifact === "notes" ? (
                <article className="notes-document">
                  <h1>Working notes</h1>
                  <p>What the agent keeps for this thread.</p>
                  <h2>Notes</h2>
                  <p>
                    This is an independent UI preview, with no model or external
                    execution.
                  </p>
                </article>
              ) : (
                <img
                  src={asset(artifact === "website" ? "brand" : artifact)}
                  alt="Artifact preview"
                />
              )}
            </div>
            <aside>
              <h3>
                {artifact === "website"
                  ? "Local potential, redesigned"
                  : "Artifact preview"}
              </h3>
              <h5>ACTIONS</h5>
              {["Publish", "Open in new tab", "Download", "Delete"].map((n) => (
                <button
                  key={n}
                  onClick={() => {
                    if (n === "Open in new tab") {
                      setModal("");
                      openThread("small-business");
                    } else demoNoBackend(n);
                  }}
                >
                  {n}
                </button>
              ))}
              <h5>VERSION HISTORY</h5>
              <strong>
                v1 <small>Original</small>
              </strong>
              <p>Oct 27, 2026</p>
              <h5>USED IN THREADS</h5>
              <button
                onClick={() => {
                  setModal("");
                  openThread("small-business");
                }}
              >
                Small Biz Website Builder Thread ↗
              </button>
              <p className="demo-note">
                No publishing or server-side changes are enabled.
              </p>
            </aside>
          </div>
        </div>
      )}
      {modal === "learning" && (
        <Modal title="Review suggested learning" onClose={() => setModal("")}>
          <span className="badge">Skill Update</span>
          <h3>Small Biz Website Builder</h3>
          <p>
            Record reusable research findings and UI patterns for future tasks.
          </p>
          <p className="demo-note">
            This preview cannot update an agent’s real knowledge.
          </p>
          <button
            className="btn"
            onClick={() => {
              setModal("");
              notify("Suggestion reviewed in this local preview.");
            }}
          >
            Mark reviewed locally
          </button>
        </Modal>
      )}
      {modal === "rubric" && (
        <Modal title="Create rubric" onClose={() => setModal("")}>
          <label className="field">
            Name
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Quality checklist"
            />
          </label>
          <label className="field">
            Criteria
            <textarea
              className="textarea"
              placeholder="Accuracy, clarity, completeness…"
            />
          </label>
          <button
            className="btn primary"
            disabled={!title.trim()}
            onClick={() => {
              setModal("");
              notify(
                "Rubric editor preview complete. Evaluation runtime is not connected.",
              );
            }}
          >
            Preview rubric
          </button>
        </Modal>
      )}
    </div>
  );
}
function MessageIcon() {
  return <FileText size={25} />;
}
