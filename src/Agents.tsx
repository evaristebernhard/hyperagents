import { useState } from "react";
import {
  Plus,
  Users,
  ArrowLeft,
  Sparkles,
  Settings2,
  Puzzle,
  Clock,
  Brain,
  ChevronRight,
  Search,
  Folder,
  Globe,
  FileText,
  Upload,
  MessageSquare,
  Store,
  Bot,
  Star,
  SlidersHorizontal,
  Check,
  Link,
  Mail,
  Webhook,
  Calendar,
  Send,
  X,
} from "lucide-react";
import type { DemoAgent, PageProps } from "./types";
import { IconButton, Modal } from "./ui";
import { useWorkspace, download } from "./workspace";
import Schedules from "./Schedules";
export default function Agents({
  path,
  navigate,
  notify,
  agents,
  setAgents,
}: PageProps & { agents: DemoAgent[]; setAgents: (a: DemoAgent[]) => void }) {
  const workspace = useWorkspace();
  const id = path.split("/")[2];
  const editing = agents.find((a) => a.id === id);
  const [tab, setTab] = useState("Identity"),
    [manual, setManual] = useState(!!editing),
    [name, setName] = useState(editing?.name || ""),
    [description, setDescription] = useState(editing?.description || ""),
    [prompt, setPrompt] = useState(editing?.prompt || ""),
    [job, setJob] = useState(""),
    [query, setQuery] = useState(""),
    [modal, setModal] = useState(""),
    [selected, setSelected] = useState(
      editing?.tools || ["Search", "Webpages", "Documents", "Thread Search"],
    ),
    [library, setLibrary] = useState(editing?.libraryEnabled || false),
    [model, setModel] = useState(editing?.model || "Auto"),
    [provider, setProvider] = useState(editing?.provider || "Any"),
    [reasoning, setReasoning] = useState(editing?.reasoning || "Medium"),
    [memoryMode, setMemoryMode] = useState(
      editing?.memoryMode || "Summary memory",
    ),
    [learning, setLearning] = useState<Record<string, string>>(
      editing?.learning || {},
    ),
    [skillIds, setSkillIds] = useState<string[]>(editing?.skillIds || []),
    [archived, setArchived] = useState(false),
    [sort, setSort] = useState("Starred first"),
    [starOnly, setStarOnly] = useState(false);
  const tabs = [
    ["Identity", Sparkles],
    ["Model", Settings2],
    ["Tools & integrations", Puzzle],
    ["Invocations", Clock],
    ["Knowledge", Brain],
  ] as const;
  const tools = [
    "Search",
    "Find Similar",
    "Exa Research",
    "Exa Websets",
    "Thread Search",
    "Browser",
    "Webpages",
    "Slides",
    "Tables",
    "Documents",
    "Image generation",
    "Video generation",
    "Audio generation",
    "Maps",
    "Transcribe audio",
    "Avatar video",
    "Thread Search",
  ];
  if (path === "/agents")
    return (
      <div className="standard-page">
        <div className="page-header">
          <h1 className="page-title">Agents</h1>
          <button
            className="btn primary"
            onClick={() => navigate("/agents/new")}
          >
            <Plus size={15} />
            New agent
          </button>
        </div>
        <div className="list-controls">
          <label className="check-row">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />
            Archived
          </label>
          <input
            className="search-input"
            placeholder="Search agents…"
            aria-label="Search agents"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn small" onClick={() => setModal("filters")}>
            <SlidersHorizontal size={14} />
            Filters
          </button>
          <select
            className="compact-select"
            aria-label="Sort agents"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option>Starred first</option>
            <option>Name</option>
            <option>Recently created</option>
          </select>
        </div>
        {!agents.length ? (
          <div className="empty-state">
            <Bot size={32} />
            <h3>No agents yet</h3>
            <p>Use New agent to create your first agent.</p>
          </div>
        ) : (
          <div className="grid3 agent-roster">
            {agents
              .filter(
                (a) =>
                  !!a.archived === archived &&
                  (!starOnly || a.starred) &&
                  a.name.toLowerCase().includes(query.toLowerCase()),
              )
              .slice()
              .sort((a, b) =>
                sort === "Name"
                  ? a.name.localeCompare(b.name)
                  : sort === "Starred first"
                    ? Number(!!b.starred) - Number(!!a.starred)
                    : agents.indexOf(b) - agents.indexOf(a),
              )
              .map((a) => (
                <article className="card" key={a.id}>
                  <a
                    href={"/agents/" + a.id}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate("/agents/" + a.id);
                    }}
                  >
                    <span className="agent-avatar">🤖</span>
                    <h3>{a.name}</h3>
                    <p className="muted">{a.description}</p>
                    <span className="badge">Local identity</span>
                  </a>
                  <div className="local-tags">
                    <button
                      className="plain"
                      aria-label={"Star " + a.name}
                      onClick={() =>
                        setAgents(
                          agents.map((x) =>
                            x.id === a.id ? { ...x, starred: !x.starred } : x,
                          ),
                        )
                      }
                    >
                      <Star
                        size={14}
                        fill={a.starred ? "currentColor" : "none"}
                      />
                      {a.starred ? "Starred" : "Star"}
                    </button>
                  </div>
                </article>
              ))}
          </div>
        )}
        {modal === "filters" && (
          <Modal title="Filter agents" onClose={() => setModal("")}>
            <label className="check-row">
              <input
                type="checkbox"
                checked={starOnly}
                onChange={(e) => setStarOnly(e.target.checked)}
              />
              Starred agents only
            </label>
            <p className="demo-note">
              All displayed agents are saved locally on this device.
            </p>
          </Modal>
        )}
      </div>
    );
  if (id !== "new" && !editing)
    return (
      <div className="empty-state">
        <Bot size={32} />
        <h2>Agent not found</h2>
        <button className="btn" onClick={() => navigate("/agents")}>
          View roster
        </button>
      </div>
    );
  const save = () => {
    if (!name.trim() || !prompt.trim()) {
      notify("Add an agent name and system prompt first.");
      setTab("Identity");
      setManual(true);
      return;
    }
    const item = {
      ...editing,
      id: editing?.id || "agent-" + Date.now(),
      name: name.trim(),
      description,
      prompt,
      model,
      provider,
      reasoning,
      tools: selected,
      skillIds,
      memoryMode,
      learning,
      libraryEnabled: library,
    };
    setAgents(
      editing
        ? agents.map((a) => (a.id === item.id ? item : a))
        : [...agents, item],
    );
    notify("Agent saved locally. No runtime or automation is connected.");
    navigate("/agents");
  };
  return (
    <div className="agent-editor" key={id}>
      <header className="agent-editor-header">
        <div>
          <button className="plain" onClick={() => navigate("/agents")}>
            <ArrowLeft size={15} />
            {editing ? "Edit agent" : "Create agent"}
          </button>
          <small className="muted">
            {name || "Add a name and system prompt"}
          </small>
        </div>
        <div className="actions">
          {editing && (
            <>
              <button
                className="btn small"
                onClick={() =>
                  download(
                    editing.name + ".json",
                    JSON.stringify(editing, null, 2),
                    "application/json",
                  )
                }
              >
                Export JSON
              </button>
              <button
                className="btn small"
                onClick={() => {
                  setAgents(
                    agents.map((a) =>
                      a.id === editing.id ? { ...a, archived: !a.archived } : a,
                    ),
                  );
                  navigate("/agents");
                }}
              >
                {editing.archived ? "Restore" : "Archive"}
              </button>
              <button
                className="btn small"
                onClick={() => {
                  if (confirm("Delete this local agent identity?")) {
                    setAgents(agents.filter((a) => a.id !== editing.id));
                    workspace.set("rooms", (rs) =>
                      rs.map((r) => ({
                        ...r,
                        agentIds: r.agentIds.filter((id) => id !== editing.id),
                      })),
                    );
                    workspace.set("schedules", (ss) =>
                      ss.map((s) =>
                        s.agentId === editing.id
                          ? { ...s, agentId: undefined, enabled: false }
                          : s,
                      ),
                    );
                    navigate("/agents");
                  }
                }}
              >
                Delete
              </button>
            </>
          )}
          <button className="btn primary" onClick={save}>
            {editing ? "Save changes" : "Create Agent"}
          </button>
        </div>
      </header>
      <div className="agent-editor-body">
        <section className="agent-form">
          <nav className="agent-tabs" aria-label="Agent configuration">
            {tabs.map(([n, I]) => (
              <button
                key={n}
                className={tab === n ? "selected" : ""}
                onClick={() => setTab(n)}
              >
                <I size={18} />
                <span>{n}</span>
              </button>
            ))}
          </nav>
          <div className="agent-section-title">
            <span
              className={"section-color " + tab.split(" ")[0].toLowerCase()}
            >
              {tab === "Identity" ? (
                <Sparkles size={19} />
              ) : tab === "Model" ? (
                <Settings2 size={19} />
              ) : tab === "Knowledge" ? (
                <Brain size={19} />
              ) : (
                <Puzzle size={19} />
              )}
            </span>
            <div>
              <h2>{tab}</h2>
              <p className="muted">
                {tab === "Identity"
                  ? "Name, description, and system prompt."
                  : tab === "Model"
                    ? "Select a model and reasoning level."
                    : tab === "Tools & integrations"
                      ? "Choose the capabilities this agent can use."
                      : tab === "Invocations"
                        ? "Choose where and how this agent works."
                        : "Skills, memory, and supporting context."}
              </p>
            </div>
          </div>
          {tab === "Identity" && (
            <>
              {!manual ? (
                <>
                  <p className="muted">
                    Describe what this agent should do. We’ll draft a starter
                    name, description, and system prompt — you can refine each
                    below, or fill them in manually.
                  </p>
                  <label className="field">
                    Describe the job
                    <textarea
                      aria-label="Describe the job"
                      className="textarea"
                      rows={5}
                      value={job}
                      onChange={(e) => setJob(e.target.value)}
                      placeholder="Who they are, what they watch, what they never do without you."
                    />
                  </label>
                  <div className="manual-actions">
                    <button className="plain" onClick={() => setManual(true)}>
                      Fill these in manually →
                    </button>
                    <div className="actions">
                      <button
                        className="btn small"
                        onClick={() => setModal("cast")}
                      >
                        <Sparkles size={14} />
                        Hire a coworker
                      </button>
                      <button
                        className="btn small"
                        disabled={!job.trim()}
                        onClick={() => {
                          setName("Research companion");
                          setDescription(job);
                          setPrompt(
                            "Help with the following work: " +
                              job +
                              ". Ask before consequential actions.",
                          );
                          setManual(true);
                          notify(
                            "Filled a local starter template — no model was called.",
                          );
                        }}
                      >
                        Draft identity
                      </button>
                    </div>
                  </div>
                  <h4>Or add an agent another way</h4>
                  <div className="grid2 agent-source-options">
                    <button
                      className="card"
                      onClick={() => navigate("/threads/new")}
                    >
                      <MessageSquare size={19} />
                      <strong>Describe it in a thread</strong>
                      <small>Tell the agent builder what you need.</small>
                    </button>
                    <button className="card" onClick={() => setModal("import")}>
                      <Upload size={19} />
                      <strong>Import an agent</strong>
                      <small>
                        Bring an agent you exported from another tool.
                      </small>
                    </button>
                    <button
                      className="card"
                      onClick={() => navigate("/marketplace")}
                    >
                      <Store size={19} />
                      <strong>Browse the marketplace</strong>
                      <small>
                        Agents other people have published, ready to add.
                      </small>
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <label className="field">
                    Agent name
                    <input
                      aria-label="Agent name"
                      className="input"
                      placeholder="e.g. Research Analyst"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    Description
                    <input
                      aria-label="Description"
                      className="input"
                      placeholder="What does this agent do?"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    System prompt
                    <textarea
                      aria-label="System prompt"
                      className="textarea"
                      rows={11}
                      placeholder="Define the agent’s role, instructions, and boundaries…"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                    />
                  </label>
                  <label className="check-row">
                    <input type="checkbox" defaultChecked />
                    Use a consistent identity across conversations
                  </label>
                  <p className="demo-note">
                    Saved locally. No model or tool execution is connected.
                  </p>
                </>
              )}
            </>
          )}
          {tab === "Model" && (
            <>
              <label className="field">
                Model
                <select
                  aria-label="Model"
                  className="input"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option>Auto</option>
                  <option>GPT-6.1 Sol</option>
                  <option>Claude Opus</option>
                  <option>Gemini Pro</option>
                </select>
              </label>
              <div className="grid2">
                <label className="field">
                  Model provider
                  <select
                    aria-label="Model provider"
                    className="input"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                  >
                    <option>Any</option>
                    <option>OpenAI</option>
                    <option>Anthropic</option>
                  </select>
                </label>
                <label className="field">
                  Quality preference
                  <select aria-label="Quality preference" className="input">
                    <option>Balanced</option>
                    <option>Low cost</option>
                    <option>High capability</option>
                  </select>
                </label>
              </div>
              <label className="field">
                Reasoning effort
                <select
                  aria-label="Reasoning effort"
                  className="input"
                  value={reasoning}
                  onChange={(e) => setReasoning(e.target.value)}
                >
                  <option>Medium</option>
                  <option>Low</option>
                  <option>High</option>
                </select>
              </label>
              <p className="demo-note">
                These are UI selections, not available model connections.
              </p>
            </>
          )}
          {tab === "Tools & integrations" && (
            <>
              <h4>Integrations</h4>
              <button
                className="card integration-add"
                onClick={() => navigate(path + "?settings=integrations")}
              >
                <Plus size={24} />
                Add integration
              </button>
              <h4>
                Tools <span className="badge">{selected.length} enabled</span>
              </h4>
              <input
                className="input"
                placeholder="Search tools…"
                aria-label="Search tools"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="tool-settings-list">
                {[...new Set(tools)]
                  .filter((n) => n.toLowerCase().includes(query.toLowerCase()))
                  .map((n) => (
                    <label className="card tool-setting" key={n}>
                      <span>
                        <Puzzle size={16} />
                        <strong>{n}</strong>
                        <small>
                          Available to the agent in a connected environment.
                        </small>
                      </span>
                      <input
                        type="checkbox"
                        checked={selected.includes(n)}
                        onChange={() =>
                          setSelected(
                            selected.includes(n)
                              ? selected.filter((t) => t !== n)
                              : [...selected, n],
                          )
                        }
                      />
                    </label>
                  ))}
              </div>
              <p className="demo-note">
                Tool toggles are local preview state only.
              </p>
            </>
          )}
          {tab === "Invocations" && (
            <>
              {editing ? (
                <Schedules agentId={editing.id} />
              ) : (
                <p className="demo-note">
                  Save the agent identity first to attach local schedules.
                </p>
              )}
              <div className="card invocation-row">
                <Clock size={20} />
                <div>
                  <h3>Live mode</h3>
                  <p>Keep this agent working on a recurring checklist.</p>
                </div>
                <button className="btn small" onClick={() => setModal("live")}>
                  Set up live mode
                </button>
              </div>
              {[
                ["Browser", "Start a conversation in the workspace", Globe],
                ["Telegram", "Pair the bot after saving your agent", Send],
                ["Scheduled work", "Run on a regular schedule", Calendar],
                [
                  "Webhooks",
                  "Trigger this agent with an external event",
                  Webhook,
                ],
                ["Email", "Give your agent an email address", Mail],
                ["Slack", "Work with your team in Slack", MessageSquare],
              ].map(([n, t, I]) => {
                const Icon = I as typeof Clock;
                return (
                  <div className="invocation-row" key={n as string}>
                    <Icon size={18} />
                    <div>
                      <strong>{n as string}</strong>
                      <small>{t as string}</small>
                    </div>
                    <button
                      className="btn small"
                      onClick={() => {
                        setModal("invocation:" + n);
                      }}
                    >
                      {n === "Browser" ? "Open preview" : "Set up"}
                    </button>
                  </div>
                );
              })}
            </>
          )}
          {tab === "Knowledge" && (
            <>
              <h3>Assigned skills</h3>
              <p className="muted">
                Local skill instructions linked to this identity.
              </p>
              {workspace.data.skills
                .filter((s) => !s.archived)
                .map((s) => (
                  <label className="check-row" key={s.id}>
                    <input
                      type="checkbox"
                      checked={skillIds.includes(s.id)}
                      onChange={(e) =>
                        setSkillIds(
                          e.target.checked
                            ? [...skillIds, s.id]
                            : skillIds.filter((id) => id !== s.id),
                        )
                      }
                    />
                    {s.name}
                  </label>
                ))}
              <h3>Knowledge profile</h3>
              <p className="muted">
                Choose the context and resources this agent can draw on.
              </p>
              <div className="grid2">
                {[
                  "Summary memory",
                  "Recall-only memory",
                  "Document memory",
                  "Collection memory",
                ].map((n, i) => (
                  <label className="card" key={n}>
                    <input
                      type="radio"
                      name="memory-mode"
                      checked={memoryMode === n}
                      onChange={() => setMemoryMode(n)}
                    />
                    <strong>{n}</strong>
                    <p className="muted">
                      Keep relevant facts available to the agent.
                    </p>
                  </label>
                ))}
              </div>
              <h3>Self learning</h3>
              {[
                "Skills",
                "Memory suggestions",
                "Tool suggestions",
                "Prompt suggestions",
                "Rubric suggestions",
              ].map((n) => (
                <label className="setting-line" key={n}>
                  {n}
                  <select
                    className="compact-select"
                    value={learning[n] || "Suggest"}
                    onChange={(e) =>
                      setLearning({ ...learning, [n]: e.target.value })
                    }
                  >
                    <option>Suggest</option>
                    <option>Disabled</option>
                  </select>
                </label>
              ))}
              <label className="setting-line">
                Thread search
                <input type="checkbox" defaultChecked />
              </label>
              <label className="setting-line">
                Use workspace library
                <input
                  type="checkbox"
                  checked={library}
                  onChange={(e) => setLibrary(e.target.checked)}
                />
              </label>
              <div className="actions">
                <button className="btn" onClick={() => navigate("/skills")}>
                  Browse skills
                </button>
                <button className="btn" onClick={() => navigate("/library")}>
                  Browse library
                </button>
              </div>
            </>
          )}
        </section>
        <aside className="agent-summary">
          <div className="agent-summary-cover">🤖</div>
          <h3>{name || "Your agent"}</h3>
          <small className="muted">
            {description || "Add an identity to get started."}
          </small>
          {[
            ["Model", model],
            [
              "Automations",
              String(
                workspace.data.schedules.filter(
                  (s) => s.agentId === editing?.id,
                ).length,
              ),
            ],
            ["Integrations", "0"],
            ["Tools", String(selected.length)],
            ["Skills", String(skillIds.length)],
            ["Memory", "0"],
            ["Library", "0"],
          ].map(([n, v]) => (
            <div className="summary-stat" key={n}>
              <span>{n}</span>
              <span>
                {v}
                <ChevronRight size={12} />
              </span>
            </div>
          ))}
          <p className="demo-note">Local preview · no runtime connected</p>
        </aside>
      </div>
      {modal && (
        <Modal
          title={
            modal === "cast"
              ? "Choose a starter identity"
              : modal === "import"
                ? "Import an agent"
                : modal === "live"
                  ? "Set up Live mode"
                  : modal.replace("invocation:", "Set up ")
          }
          onClose={() => setModal("")}
        >
          {modal === "cast" ? (
            <>
              <p>
                Choose a local starter. No characters or images are being
                generated.
              </p>
              <div className="grid3">
                {[
                  "Research companion",
                  "Creative partner",
                  "Operations guide",
                ].map((n, i) => (
                  <button
                    className="card"
                    key={n}
                    onClick={() => {
                      setName(n);
                      setDescription(
                        "A thoughtful " +
                          n.toLowerCase() +
                          " for your workspace.",
                      );
                      setPrompt(
                        "Act as a " +
                          n.toLowerCase() +
                          ". Be precise, helpful, and ask before consequential actions.",
                      );
                      setManual(true);
                      setModal("");
                    }}
                  >
                    <span className="agent-avatar">{["🔎", "✦", "⚙"][i]}</span>
                    <h4>{n}</h4>
                  </button>
                ))}
              </div>
            </>
          ) : modal === "import" ? (
            <>
              <label className="field">
                Agent JSON file
                <input
                  aria-label="Agent JSON file"
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f)
                      f.text().then((s) => {
                        try {
                          const v = JSON.parse(s);
                          if (typeof v.name !== "string") throw Error();
                          setName(v.name);
                          setDescription(
                            typeof v.description === "string"
                              ? v.description
                              : "",
                          );
                          setPrompt(
                            typeof v.prompt === "string"
                              ? v.prompt
                              : typeof v.systemPrompt === "string"
                                ? v.systemPrompt
                                : "",
                          );
                          setManual(true);
                          setModal("");
                          notify(
                            "Loaded into local editor. Review before saving.",
                          );
                        } catch {
                          notify(
                            "Please select valid agent JSON with a name field.",
                          );
                        }
                      });
                  }}
                />
              </label>
              <p className="demo-note">
                File is read locally and never uploaded.
              </p>
            </>
          ) : (
            <>
              <p>
                This setup requires an agent runtime and connected services. It
                is intentionally not connected in this frontend recreation.
              </p>
              <label className="field">
                Instructions
                <textarea
                  aria-label="Instructions"
                  className="textarea"
                  placeholder="What should this automation do?"
                />
              </label>
              <button
                className="btn"
                onClick={() => {
                  setModal("");
                  notify("Preview closed. No automation was created.");
                }}
              >
                Close preview
              </button>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
