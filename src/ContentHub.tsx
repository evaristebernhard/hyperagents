import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Plus,
  Search,
  Upload,
  Download,
  Puzzle,
  Brain,
  Archive,
  Trash2,
  Pencil,
  Star,
  Check,
  Copy,
  BookOpen,
  ChevronRight,
} from "lucide-react";
import type { PageProps } from "./types";
import type { Skill, Rubric } from "./local-model";
import { communitySkills, uid, now } from "./local-model";
import { useWorkspace, download } from "./workspace";
import { IconButton, Modal } from "./ui";
import "./local.css";
import SkillCreationWizard from "./SkillCreationWizard";
export function Markdown({ content }: { content: string }) {
  return (
    <div className="local-markdown">
      {content.split("\n").map((line, i) =>
        line.startsWith("### ") ? (
          <h3 key={i}>{line.slice(4)}</h3>
        ) : line.startsWith("## ") ? (
          <h2 key={i}>{line.slice(3)}</h2>
        ) : line.startsWith("# ") ? (
          <h1 key={i}>{line.slice(2)}</h1>
        ) : line.startsWith("- ") ? (
          <div className="local-bullet" key={i}>
            • {line.slice(2)}
          </div>
        ) : line ? (
          <p key={i}>{line}</p>
        ) : (
          <br key={i} />
        ),
      )}
    </div>
  );
}
export default function ContentHub({ path, navigate, notify }: PageProps) {
  const w = useWorkspace(),
    { skills, memories, rubrics } = w.data;
  const section = path.split("/")[1],
    id = path.split("/")[2];
  const skill = skills.find((s) => s.id === id),
    rubric = rubrics.find((s) => s.id === id);
  const editing = path.endsWith("/edit"),
    creating = id === "new";
  const [query, setQuery] = useState(""),
    [archived, setArchived] = useState(false),
    [tab, setTab] = useState("Your skills"),
    [modal, setModal] = useState(""),
    [editId, setEditId] = useState(""),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [documentation, setDocumentation] = useState(""),
    [when, setWhen] = useState(""),
    [tags, setTags] = useState(""),
    [category, setCategory] = useState("User Fact"),
    [importance, setImportance] = useState("3"),
    [pinned, setPinned] = useState(false),
    [scope, setScope] = useState("Global"),
    [preview, setPreview] = useState(false),
    [pinOnly, setPinOnly] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setQuery("");
    setModal("");
    setPreview(false);
    if (skill) {
      setName(skill.name);
      setDescription(skill.description);
      setDocumentation(skill.documentation);
      setWhen(skill.whenToUse);
      setTags(skill.tags.join(", "));
    } else {
      setName("");
      setDescription("");
      setDocumentation("");
      setWhen("");
      setTags("");
    }
  }, [path, w.state.active]);
  const importSkill = async (
    file: File,
    options?: { wizard: true; signal: AbortSignal },
  ): Promise<string | null> => {
    const fail = (message: string) => {
      if (!options) notify(message);
      return message;
    };
    const maxBytes = (options ? 5 : 1) * 1024 * 1024;
    if (file.size > maxBytes)
      return fail(options ? "Skill files must be 5 MB or smaller." : "Skill files must be smaller than 1 MB.");
    if (!(options ? /\.(json|md)$/i : /\.(json|md|txt)$/i).test(file.name))
      return fail("Choose a supported skill file.");
    try {
      const text = await file.text();
      if (options?.signal.aborted) return "Import cancelled.";
      let input: Partial<Skill>;
      if (file.name.toLowerCase().endsWith(".json")) {
        input = JSON.parse(text);
        if (
          !input ||
          typeof input.name !== "string" ||
          typeof input.documentation !== "string" ||
          (input.tags !== undefined &&
            (!Array.isArray(input.tags) ||
              input.tags.some((t) => typeof t !== "string")))
        )
          throw Error("Use a skill JSON with a name and documentation.");
      } else
        input = {
          name: file.name.replace(/\.(md|txt)$/i, ""),
          documentation: text,
          description: "Imported Markdown skill",
          whenToUse: "",
          tags: [],
        };
      const s: Skill = {
        id: uid("skill"),
        name: input.name!.trim() || "Imported skill",
        description:
          typeof input.description === "string" ? input.description : "",
        documentation: input.documentation!,
        whenToUse: typeof input.whenToUse === "string" ? input.whenToUse : "",
        tags: input.tags || [],
        author: "You",
        createdAt: now(),
        updatedAt: now(),
      };
      w.set("skills", (ss) => [...ss, s]);
      await w.flush();
      navigate("/skills/" + s.id);
      notify("Skill imported locally. No script or tool was executed.");
      return null;
    } catch (e) {
      return fail(e instanceof Error ? e.message : "Could not import skill.");
    }
  };
  const exportSkill = (s: Skill) =>
    download(
      s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".json",
      JSON.stringify(s, null, 2),
      "application/json",
    );
  const saveSkill = () => {
    if (!name.trim() || !documentation.trim()) {
      notify("A name and documentation are required.");
      return;
    }
    const time = now();
    const next: Skill = {
      id: skill?.id || uid("skill"),
      name: name.trim(),
      description: description.trim(),
      documentation,
      whenToUse: when,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      author: skill?.author || "You",
      createdAt: skill?.createdAt || time,
      updatedAt: time,
      sourceId: skill?.sourceId,
    };
    w.set("skills", (ss) =>
      skill ? ss.map((s) => (s.id === skill.id ? next : s)) : [...ss, next],
    );
    navigate("/skills/" + next.id);
    notify("Skill saved in this workspace.");
  };
  const newMemory = (memoryId?: string) => {
    const m = memories.find((m) => m.id === memoryId);
    setEditId(m?.id || "");
    setDescription(m?.content || "");
    setWhen(m?.whenToUse || "");
    setTags(m?.tags?.join(", ") || "");
    setCategory(m?.category || "User Fact");
    setImportance(String(m?.importance || 3));
    setPinned(m?.pinned || false);
    setScope(m?.scope || "Global");
    setModal("memory");
  };
  const saveMemory = () => {
    if (!description.trim()) return;
    const item = {
      id: editId || uid("memory"),
      content: description.trim(),
      category,
      importance: Number(importance),
      pinned,
      whenToUse: when,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      scope,
    };
    w.set("memories", (ms) =>
      editId ? ms.map((m) => (m.id === editId ? item : m)) : [...ms, item],
    );
    setModal("");
    notify("Memory saved locally.");
  };
  const newRubric = (r?: Rubric) => {
    setEditId(r?.id || "");
    setName(r?.name || "");
    setDocumentation(r?.criteria.join("\n") || "");
    setModal("rubric");
  };
  const skillList = skills.filter(
    (s) =>
      !!s.archived === archived &&
      s.name.toLowerCase().includes(query.toLowerCase()),
  );
  const back = (
    <button className="plain" onClick={() => navigate("/" + section)}>
      <ArrowLeft size={15} />
      {section === "skills"
        ? "Skills"
        : section === "memories"
          ? "Memories"
          : "Rubrics"}
    </button>
  );
  return (
    <div className="resource-page rp-page local-content">
      {section === "skills" ? (
        creating || editing ? (
          <>
            <div className="page-header">
              {back}
              <div className="actions">
                <button className="btn" onClick={() => setPreview(!preview)}>
                  {preview ? "Editor" : "Preview"}
                </button>
                <button className="btn primary" onClick={saveSkill}>
                  Save skill
                </button>
              </div>
            </div>
            <h1 className="page-title">
              {creating ? "Create skill" : "Edit skill"}
            </h1>
            {creating && (
              <p className="demo-note">Local-only manual editor. Save your own instructions without research, model calls, or script execution.</p>
            )}
            {editing && !skill ? (
              <div className="empty-state">Skill not found.</div>
            ) : preview ? (
              <div className="card local-editor-preview">
                <Markdown content={documentation} />
              </div>
            ) : (
              <div className="local-skill-editor">
                <label className="field">
                  Skill name
                  <input
                    aria-label="Skill name"
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Product launch checklist"
                  />
                </label>
                <label className="field">
                  Description
                  <textarea
                    aria-label="Description"
                    className="textarea"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
                <label className="field">
                  When to use
                  <input
                    aria-label="When to use"
                    className="input"
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                  />
                </label>
                <label className="field">
                  Tags
                  <input
                    aria-label="Tags"
                    className="input"
                    placeholder="research, writing"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                  />
                </label>
                <label className="field">
                  Documentation
                  <textarea
                    aria-label="Documentation"
                    className="textarea local-code"
                    rows={16}
                    value={documentation}
                    onChange={(e) => setDocumentation(e.target.value)}
                    placeholder={
                      "# Skill instructions\n\n## Steps\n- Describe the reusable process"
                    }
                  />
                </label>
                <p className="demo-note">
                  Instructions are stored as text. This application does not
                  execute skill code or call an LLM.
                </p>
              </div>
            )}
          </>
        ) : id ? (
          skill ? (
            <>
              <div className="page-header">
                {back}
                <div className="actions">
                  <button
                    className="btn small"
                    onClick={() => exportSkill(skill)}
                  >
                    <Download size={14} />
                    Export JSON
                  </button>
                  <button
                    className="btn small"
                    onClick={() =>
                      download(
                        skill.name + ".md",
                        skill.documentation,
                        "text/markdown",
                      )
                    }
                  >
                    Markdown
                  </button>
                  <button
                    className="btn small"
                    onClick={() => navigate("/skills/" + skill.id + "/edit")}
                  >
                    <Pencil size={14} />
                    Edit Skill
                  </button>
                </div>
              </div>
              <h1>{skill.name}</h1>
              <p className="muted">{skill.description}</p>
              <div className="local-tags">
                {skill.tags.map((t) => (
                  <span className="badge" key={t}>
                    {t}
                  </span>
                ))}
              </div>
              <div className="grid2 local-summary-cards">
                <div className="card">
                  <h4>Usage</h4>
                  <p>
                    {
                      w.data.agents.filter((a) =>
                        a.skillIds?.includes(skill.id),
                      ).length
                    }{" "}
                    agents use this skill
                  </p>
                  <small className="muted">
                    Updated {new Date(skill.updatedAt).toLocaleDateString()}
                  </small>
                </div>
                <div className="card">
                  <h4>Credentials</h4>
                  <p>No credentials or executable scripts.</p>
                  <small className="muted">Local instructions only</small>
                </div>
              </div>
              <section className="rp-doc-section">
                <h3>When to Use</h3>
                <p>{skill.whenToUse || "Available for manual reference."}</p>
              </section>
              <section className="rp-doc-section">
                <div className="page-header">
                  <h3>Documentation</h3>
                  <button
                    className="plain"
                    onClick={() => {
                      const copy = {
                        ...skill,
                        id: uid("skill"),
                        name: skill.name + " (copy)",
                        author: "You",
                        sourceId: undefined,
                        createdAt: now(),
                        updatedAt: now(),
                      };
                      w.set("skills", (ss) => [...ss, copy]);
                      navigate("/skills/" + copy.id);
                    }}
                  >
                    <Copy size={14} />
                    Duplicate
                  </button>
                </div>
                <Markdown content={skill.documentation} />
              </section>
              <div className="local-danger-actions">
                <button
                  className="btn"
                  onClick={() => {
                    w.set("skills", (ss) =>
                      ss.map((s) =>
                        s.id === skill.id ? { ...s, archived: !s.archived } : s,
                      ),
                    );
                    navigate("/skills");
                    notify(
                      skill.archived ? "Skill restored." : "Skill archived.",
                    );
                  }}
                >
                  <Archive size={14} />
                  {skill.archived ? "Restore" : "Archive"}
                </button>
                <button
                  className="btn danger-outline"
                  onClick={() => {
                    if (
                      confirm(
                        "Delete this local skill? Agent assignments will also be removed.",
                      )
                    ) {
                      w.set("skills", (ss) =>
                        ss.filter((s) => s.id !== skill.id),
                      );
                      w.set("agents", (aa) =>
                        aa.map((a) => ({
                          ...a,
                          skillIds: a.skillIds?.filter((s) => s !== skill.id),
                        })),
                      );
                      navigate("/skills");
                    }
                  }}
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <h2>Skill not found</h2>
              {back}
            </div>
          )
        ) : (
          <>
            <header className="page-header">
              <div>
                <h1 className="page-title">Skills</h1>
                <p className="muted rp-description">
                  Building blocks that add specific capabilities to your agents
                  and threads.
                </p>
              </div>
              <div className="actions">
                <button className="btn" onClick={() => upload.current?.click()}>
                  <Upload size={14} />
                  Import skill
                </button>
                <button
                  className="btn primary"
                  onClick={() => setModal("skill-create")}
                >
                  <Plus size={14} />
                  Create skill
                </button>
              </div>
            </header>
            <div className="rp-section-head">
              <h3>Discover and install new skills</h3>
              <button
                className="plain"
                onClick={() => navigate("/marketplace")}
              >
                See more →
              </button>
            </div>
            <div className="rp-skill-cards">
              {communitySkills.map((s) => (
                <article className="card rp-skill-card" key={s.id}>
                  <a
                    href={"/marketplace/s/" + s.id}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate("/marketplace/s/" + s.id);
                    }}
                  >
                    <h3>{s.name}</h3>
                    <small>{s.author}</small>
                    <p>{s.description}</p>
                  </a>
                  <button
                    className="btn small"
                    onClick={() => {
                      const installedId = w.installSkill(s.id);
                      navigate("/skills/" + installedId);
                    }}
                  >
                    {skills.some((i) => i.sourceId === s.id || i.id === s.id)
                      ? "Open installed skill"
                      : "Add skill"}
                  </button>
                </article>
              ))}
            </div>
            <div className="rp-table-top">
              <div className="tabs">
                {["Your skills", "Shared with you"].map((t) => (
                  <button
                    className={tab === t ? "selected" : ""}
                    onClick={() => setTab(t)}
                    key={t}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={archived}
                  onChange={(e) => setArchived(e.target.checked)}
                />
                Archived
              </label>
            </div>
            <div className="rp-search">
              <Search size={15} />
              <input
                aria-label="Search installed skills"
                placeholder="Search skills…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {tab === "Shared with you" ? (
              <div className="empty-state">
                <UsersPlaceholder />
                <h3>No shared skills</h3>
                <p>Multi-user sharing is not connected.</p>
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Description</th>
                    <th>Agents</th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {skillList.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <a
                          href={"/skills/" + s.id}
                          onClick={(e) => {
                            e.preventDefault();
                            navigate("/skills/" + s.id);
                          }}
                        >
                          {s.name}
                        </a>
                      </td>
                      <td className="rp-skill-description">{s.description}</td>
                      <td>
                        {
                          w.data.agents.filter((a) =>
                            a.skillIds?.includes(s.id),
                          ).length
                        }
                      </td>
                      <td>{new Date(s.updatedAt).toLocaleDateString()}</td>
                      <td>
                        <IconButton
                          label={"Edit " + s.name}
                          onClick={() => navigate("/skills/" + s.id + "/edit")}
                        >
                          <Pencil size={14} />
                        </IconButton>
                        <IconButton
                          label={"Export " + s.name}
                          onClick={() => exportSkill(s)}
                        >
                          <Download size={14} />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === "Your skills" && !skillList.length && (
              <div className="empty-state">No matching skills.</div>
            )}
          </>
        )
      ) : section === "memories" ? (
        <>
          <header className="page-header">
            <div>
              <h1 className="page-title">Memories</h1>
              <p className="muted rp-description">
                Saved context in {w.activeName}.
              </p>
            </div>
            <button className="btn primary" onClick={() => newMemory()}>
              <Plus size={14} />
              Add memory
            </button>
          </header>
          <div className="list-controls">
            <input
              className="search-input"
              aria-label="Search memories"
              placeholder="Search memories…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="muted">{memories.length} memories</span>
            <label className="check-row">
              <input
                type="checkbox"
                checked={pinOnly}
                onChange={(e) => setPinOnly(e.target.checked)}
              />
              Pinned only
            </label>
          </div>
          {memories.length ? (
            <div className="rp-memory-list">
              {memories
                .filter(
                  (m) =>
                    m.content.toLowerCase().includes(query.toLowerCase()) &&
                    (!pinOnly || m.pinned),
                )
                .map((m) => (
                  <article className="card" key={m.id}>
                    <div className="page-header">
                      <span className="badge">
                        {m.category} · {m.importance}/5
                      </span>
                      <div className="actions">
                        <IconButton
                          label="Toggle pinned memory"
                          onClick={() =>
                            w.set("memories", (ms) =>
                              ms.map((x) =>
                                x.id === m.id ? { ...x, pinned: !x.pinned } : x,
                              ),
                            )
                          }
                        >
                          <Star
                            size={15}
                            fill={m.pinned ? "currentColor" : "none"}
                          />
                        </IconButton>
                        <IconButton
                          label="Edit memory"
                          onClick={() => newMemory(m.id)}
                        >
                          <Pencil size={15} />
                        </IconButton>
                        <IconButton
                          label="Delete memory"
                          onClick={() => {
                            if (confirm("Delete this local memory?"))
                              w.set("memories", (ms) =>
                                ms.filter((x) => x.id !== m.id),
                              );
                          }}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      </div>
                    </div>
                    <p>{m.content}</p>
                    {m.whenToUse && (
                      <small className="muted">
                        When to use: {m.whenToUse}
                      </small>
                    )}
                    <div className="local-tags">
                      {m.tags?.map((t) => (
                        <span className="badge" key={t}>
                          {t}
                        </span>
                      ))}
                    </div>
                  </article>
                ))}
            </div>
          ) : (
            <div className="empty-state">
              <Brain size={30} />
              <h3>No memories yet</h3>
              <p>Add important context you want to keep.</p>
              <button className="btn" onClick={() => newMemory()}>
                Add memory
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="page-header">
            <h1 className="page-title">Rubrics</h1>
            <button className="btn primary" onClick={() => newRubric()}>
              <Plus size={14} />
              Create rubric
            </button>
          </div>
          <div className="rp-search">
            <Search size={15} />
            <input
              placeholder="Search rubrics…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {rubrics.length ? (
            <div className="grid2 local-summary-cards">
              {rubrics
                .filter((r) =>
                  r.name.toLowerCase().includes(query.toLowerCase()),
                )
                .map((r) => (
                  <div className="card" key={r.id}>
                    <div className="page-header">
                      <h3>{r.name}</h3>
                      <div className="actions">
                        <IconButton
                          label="Edit rubric"
                          onClick={() => newRubric(r)}
                        >
                          <Pencil size={15} />
                        </IconButton>
                        <IconButton
                          label="Delete rubric"
                          onClick={() => {
                            if (confirm("Delete this local rubric?"))
                              w.set("rubrics", (rs) =>
                                rs.filter((x) => x.id !== r.id),
                              );
                          }}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      </div>
                    </div>
                    <ul>
                      {r.criteria.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                    <span className="badge">
                      Local criteria · no automated evaluation
                    </span>
                  </div>
                ))}
            </div>
          ) : (
            <div className="empty-state">
              <Check size={30} />
              <h3>No rubrics yet</h3>
              <p>Define the criteria you want to check.</p>
            </div>
          )}
        </>
      )}
      <input
        hidden
        ref={upload}
        type="file"
        accept=".json,.md,.txt"
        aria-label="Import skill file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importSkill(f);
          e.target.value = "";
        }}
      />
      {modal === "skill-create" && (
        <SkillCreationWizard
          onClose={() => setModal("")}
          onManual={() => { setModal(""); navigate("/skills/new"); }}
          onImport={(file, signal) => importSkill(file, { wizard: true, signal })}
        />
      )}
      {modal === "memory" && (
        <Modal
          title={editId ? "Edit Memory" : "Add Memory"}
          onClose={() => setModal("")}
          footer={
            <>
              <button className="btn" onClick={() => setModal("")}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!description.trim()}
                onClick={saveMemory}
              >
                {editId ? "Save Memory" : "Add Memory"}
              </button>
            </>
          }
        >
          <label className="field">
            Memory Content
            <textarea
              aria-label="Memory Content"
              className="textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="grid2">
            <label className="field">
              Category
              <select
                aria-label="Category"
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
                aria-label="Importance (1–5)"
                className="input"
                value={importance}
                onChange={(e) => setImportance(e.target.value)}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            When to Use
            <input
              aria-label="When to Use"
              className="input"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </label>
          <label className="field">
            Tags
            <input
              aria-label="Tags"
              className="input"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </label>
          <label className="field">
            Scope
            <select
              aria-label="Scope"
              className="input"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option>Global</option>
              <option>Personal</option>
            </select>
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
      {modal === "rubric" && (
        <Modal
          title={editId ? "Edit rubric" : "Create rubric"}
          onClose={() => setModal("")}
          footer={
            <button
              className="btn primary"
              disabled={!name.trim() || !documentation.trim()}
              onClick={() => {
                const r = {
                  id: editId || uid("rubric"),
                  name: name.trim(),
                  criteria: documentation
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                };
                w.set("rubrics", (rs) =>
                  editId
                    ? rs.map((x) => (x.id === editId ? r : x))
                    : [...rs, r],
                );
                setModal("");
                notify("Rubric saved locally.");
              }}
            >
              Save rubric
            </button>
          }
        >
          <label className="field">
            Name
            <input
              aria-label="Name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            Criteria
            <textarea
              aria-label="Criteria"
              className="textarea"
              rows={8}
              placeholder="One criterion per line"
              value={documentation}
              onChange={(e) => setDocumentation(e.target.value)}
            />
          </label>
        </Modal>
      )}
    </div>
  );
}
function UsersPlaceholder() {
  return <BookOpen size={28} />;
}
