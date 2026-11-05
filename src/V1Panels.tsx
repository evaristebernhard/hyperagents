import BrowserProfiles from "./BrowserProfiles";
import { useEffect, useState } from "react";
import {
  Plus,
  ArrowUpRight,
  Download,
  Brain,
  Users,
  BookOpen,
  Search,
  Check,
} from "lucide-react";
import { v1, submitTask, fileUrl, artifactKind } from "./v1-client";
import { useWorkspace } from "./workspace";
import { communitySkills } from "./local-model";
import { defaultThreadSettings, type PageProps } from "./types";
import { Modal } from "./ui";
import AnswerMarkdown from "./AnswerMarkdown";
import { ArtifactPreview } from "./V1Thread";
import Schedules from "./Schedules";

type Package = {
  id: string;
  name: string;
  description: string;
  source: { url?: string };
  installed_digest: string | null;
  revision: number | null;
  local: boolean;
  versions: {
    digest: string;
    requirements: { python?: string[]; node?: string[] };
    createdAt: string;
  }[];
};
type Suggestion = {
  id: string;
  name: string;
  kind: string;
  content: string;
  reason: string;
  target_id?: string;
  before_value?: { content?: string };
  decision: string | null;
  conversation_id: string;
};
type LibraryItem = {
  id: string;
  name: string;
  conversation_id: string;
  file_id: string;
  format: string;
  version: number;
  created_at: string;
};
type Member = { id: string; email: string; role: string; owner: boolean };
type Wiki = {
  id: string;
  value: { name: string; content: string; sourceTaskIds: string[] };
  revision: number;
};
export default function V1Panels({ path, navigate, notify }: PageProps) {
  const w = useWorkspace(),
    section = path.split("/")[1];
  const [versionPreview, setVersionPreview] = useState<{
    digest: string;
    changes: { path: string; before: string | null; after: string | null }[];
  } | null>(null);
  const [packages, setPackages] = useState<Package[]>([]);
  const [bundleDraft, setBundleDraft] = useState("");
  const [repository, setRepository] = useState("");
  const [gitRef, setGitRef] = useState("main");
  const [unlink, setUnlink] = useState(false);
  const [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]),
    [library, setLibrary] = useState<LibraryItem[]>([]),
    [members, setMembers] = useState<Member[]>([]),
    [wiki, setWiki] = useState<Wiki[]>([]);
  const [inbox, setInbox] = useState<{
    tasks: {
      id: string;
      conversation_id: string;
      prompt: string;
      state: string;
      error_code: string;
    }[];
    learning: { id: string; name: string }[];
    schedules: {
      schedule_id: string;
      occurrence: string;
      task_id: string;
      error_code: string;
    }[];
  }>({ tasks: [], learning: [], schedules: [] });
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(""),
    [tab, setTab] = useState("Pages"),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("member"),
    [invite, setInvite] = useState(""),
    [accept, setAccept] = useState("");
  const readonly = w.role === "viewer";
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    const load = async () => {
      if (section === "marketplace")
        setPackages(await v1<Package[]>("/marketplace", { signal: c.signal }));
      if (section === "learning")
        setSuggestions(
          await v1<Suggestion[]>("/learning", { signal: c.signal }),
        );
      if (["library", "documents"].includes(section))
        setLibrary(await v1<LibraryItem[]>("/library", { signal: c.signal }));
      if (section === "workspaces")
        setMembers(await v1<Member[]>("/members", { signal: c.signal }));
      if (section === "inbox")
        setInbox(await v1("/inbox", { signal: c.signal }));
      if (section === "wiki")
        setWiki(
          (
            await v1<(Wiki & { kind: string })[]>("/resources", {
              signal: c.signal,
            })
          ).filter((r) => r.kind === "wiki"),
        );
    };
    void load()
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [section, w.state.active, reload]);
  const title: Record<string, string> = {
    library: "Library",
    documents: "Library",
    learning: "Learning",
    inbox: "Inbox",
    wiki: "Autowiki",
    marketplace: "Marketplace",
    workspaces: "Workspaces",
    workflows: "Scheduled work",
    integrations: "Integrations",
  };
  const search = (
    <label className="rp-search">
      <Search size={16} />
      <input
        className="input"
        aria-label="Search resources"
        placeholder="Search…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
    </label>
  );
  const match = (value: string) =>
    value.toLowerCase().includes(query.toLowerCase());
  const start = async (prompt: string) => {
    const task = await submitTask(prompt);
    navigate("/thread/" + task.conversationId);
  };
  return (
    <section
      className={
        "standard-page v1-resources " +
        (section === "marketplace" ? "marketplace-page" : "")
      }
    >
      <div className="page-header">
        <h1 className="page-title">{title[section] || section}</h1>
        <button
          className="btn small"
          disabled={busy}
          onClick={() => setReload((n) => n + 1)}
        >
          Refresh
        </button>
      </div>
      {loading && (
        <p role="status" className="muted">
          Loading workspace resources…
        </p>
      )}
      {error && (
        <p className="rt-error" role="alert">
          {error}
        </p>
      )}
      {readonly && (
        <p className="rt-notice">
          You have read-only access to this workspace.
        </p>
      )}
      {["library", "documents"].includes(section) && (
        <>
          {search}
          <div className="tabs">
            {["All", "Document", "Webpage", "Table", "Image", "File"].map(
              (t) => (
                <button
                  key={t}
                  className={
                    tab === t || (tab === "Pages" && t === "All")
                      ? "selected"
                      : ""
                  }
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ),
            )}
          </div>
          <div className="grid3">
            {library
              .filter(
                (a) =>
                  match(a.name) &&
                  (["Pages", "All"].includes(tab) ||
                    artifactKind(a.format) === tab),
              )
              .map((a) => (
                <article className="card v1-library-card" key={a.id}>
                  <button className="plain" onClick={() => setSelected(a.id)}>
                    <BookOpen size={24} />
                    <h3>{a.name}</h3>
                  </button>
                  <p className="muted">
                    {artifactKind(a.format)} · v{a.version}
                  </p>
                  <div className="actions">
                    <a className="btn small" href={fileUrl(a.file_id)} download>
                      <Download size={14} />
                      Download
                    </a>
                    <button
                      className="btn small"
                      onClick={() => navigate("/thread/" + a.conversation_id)}
                    >
                      Open thread <ArrowUpRight size={14} />
                    </button>
                  </div>
                </article>
              ))}
          </div>
          {!loading && !library.length && (
            <div className="empty-state">
              <BookOpen />
              <h3>Your work, in one place</h3>
              <p>
                Files created in your threads appear here with their saved
                versions.
              </p>
            </div>
          )}
          {library.find((a) => a.id === selected) && (
            <Modal
              title={library.find((a) => a.id === selected)!.name}
              onClose={() => setSelected("")}
            >
              <ArtifactPreview
                fileId={library.find((a) => a.id === selected)!.file_id}
              />
            </Modal>
          )}
        </>
      )}
      {section === "learning" && (
        <>
          <p className="muted">
            Review reusable findings from your agents. Nothing enters memory or
            skills until you accept it.
          </p>
          <div className="tabs">
            {["Pending", "Reviewed"].map((t) => (
              <button
                key={t}
                className={
                  (tab === "Pages" ? "Pending" : tab) === t ? "selected" : ""
                }
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          {suggestions
            .filter((s) => (tab === "Reviewed" ? s.decision : !s.decision))
            .map((s) => (
              <article className="card" key={s.id}>
                <span className="badge">{s.kind}</span>
                <h3>{s.name}</h3>
                <AnswerMarkdown content={s.content} />
                <p className="muted">{s.reason}</p>
                {s.target_id && (
                  <details>
                    <summary>Proposed update · previous content</summary>
                    <p>{s.before_value?.content}</p>
                  </details>
                )}
                <div className="actions">
                  <button
                    className="btn small"
                    onClick={() => navigate("/thread/" + s.conversation_id)}
                  >
                    Source thread
                  </button>
                  {!s.decision ? (
                    <>
                      <button
                        className="btn primary"
                        disabled={busy || readonly}
                        onClick={() =>
                          void run(async () => {
                            await v1("/learning/" + s.id, {
                              method: "POST",
                              body: { decision: "accepted" },
                            });
                            await w.reload();
                          })
                        }
                      >
                        <Check size={14} />
                        Accept
                      </button>
                      <button
                        className="btn"
                        disabled={busy || readonly}
                        onClick={() =>
                          void run(async () => {
                            await v1("/learning/" + s.id, {
                              method: "POST",
                              body: { decision: "dismissed" },
                            });
                          })
                        }
                      >
                        Dismiss
                      </button>
                    </>
                  ) : (
                    <span>{s.decision}</span>
                  )}
                </div>
              </article>
            ))}
          {!loading && !suggestions.length && (
            <div className="empty-state">
              <Brain />
              <h3>No suggestions yet</h3>
              <p>
                Ask an agent to suggest a reusable memory or skill from its
                work.
              </p>
            </div>
          )}
        </>
      )}
      {section === "inbox" && (
        <>
          <h3>Needs your attention</h3>
          {inbox.tasks.map((t) => (
            <button
              className="card v1-inbox-row"
              key={t.id}
              onClick={() => navigate("/thread/" + t.conversation_id)}
            >
              <strong>{t.prompt.slice(0, 160)}</strong>
              <span>
                {t.state.replaceAll("_", " ")}
                {t.error_code ? " · " + t.error_code : ""}
              </span>
              <ArrowUpRight size={16} />
            </button>
          ))}
          {inbox.learning.map((s) => (
            <button
              className="card v1-inbox-row"
              key={s.id}
              onClick={() => navigate("/learning")}
            >
              <Brain size={18} />
              <strong>{s.name}</strong>
              <span>Review learning</span>
            </button>
          ))}
          {!inbox.tasks.length && !inbox.learning.length && (
            <div className="empty-state">
              <Check />
              <h3>You're all caught up</h3>
            </div>
          )}
          <h3>Scheduled runs</h3>
          {inbox.schedules.map((s) => (
            <p key={s.schedule_id + s.occurrence}>
              {new Date(s.occurrence).toLocaleString()} ·{" "}
              {s.error_code || "Task queued"}{" "}
              {s.task_id && (
                <button
                  className="plain"
                  onClick={() =>
                    void run(async () => {
                      const t = await v1<{ conversationId: string }>(
                        "/tasks/" + s.task_id,
                      );
                      navigate("/thread/" + t.conversationId);
                    })
                  }
                >
                  Open thread ↗
                </button>
              )}
            </p>
          ))}
        </>
      )}
      {section === "wiki" && (
        <>
          <p className="muted">
            Approved knowledge pages, with links to the work they came from.
          </p>
          <div className="tabs">
            {["Pages", "Sources"].map((t) => (
              <button
                key={t}
                className={tab === t ? "selected" : ""}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <button
            className="btn primary"
            disabled={busy || readonly}
            onClick={() =>
              void run(() =>
                start(
                  'Search saved workspace knowledge. Propose a concise wiki page summarizing one useful topic with learning_propose(kind="wiki"). Cite the supporting memories and do not invent facts. If there is insufficient knowledge, ask me what to add.',
                ),
              )
            }
          >
            Suggest a knowledge page
          </button>
          {wiki.map((p) => (
            <article className="card" key={p.id}>
              <h3>{p.value.name}</h3>
              {tab !== "Sources" ? (
                <AnswerMarkdown content={p.value.content} />
              ) : (
                p.value.sourceTaskIds.map((id) => (
                  <button
                    className="btn small"
                    key={id}
                    onClick={() =>
                      void run(async () => {
                        const t = await v1<{ conversationId: string }>(
                          "/tasks/" + id,
                        );
                        navigate("/thread/" + t.conversationId);
                      })
                    }
                  >
                    View source task ↗
                  </button>
                ))
              )}
            </article>
          ))}
          {!loading && !wiki.length && (
            <div className="empty-state">
              <BookOpen />
              <h3>No approved pages yet</h3>
              <p>
                Page suggestions are reviewed in Learning before they appear
                here.
              </p>
            </div>
          )}
        </>
      )}
      {section === "marketplace" && (
        <>
          {search}
          {versionPreview && (
            <Modal
              title={"Version " + versionPreview.digest.slice(0, 12)}
              onClose={() => setVersionPreview(null)}
            >
              {versionPreview.changes.map((change) => (
                <details key={change.path}>
                  <summary>{change.path}</summary>
                  <p>Previous</p>
                  <pre
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {change.before || "(absent)"}
                  </pre>
                  <p>Proposed</p>
                  <pre
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {change.after || "(removed)"}
                  </pre>
                </details>
              ))}
            </Modal>
          )}
          <details className="card">
            <summary>Import a skill package</summary>
            <p>
              Import JSON with id, name, description and files, or upload
              Markdown / ZIP. Review the version before installing.
            </p>
            <textarea
              aria-label="Skill package JSON"
              value={bundleDraft}
              onChange={(e) => setBundleDraft(e.target.value)}
            />
            <button
              className="btn"
              disabled={readonly || busy}
              onClick={() =>
                void run(async () => {
                  await v1("/skill-imports", {
                    method: "POST",
                    body: JSON.stringify(JSON.parse(bundleDraft)),
                  });
                  setBundleDraft("");
                  notify("Package imported. Review and install below.");
                })
              }
            >
              Import JSON
            </button>
            <input
              aria-label="Skill file"
              type="file"
              accept=".md,.json,.zip"
              disabled={readonly || busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void run(async () => {
                  const id = file.name
                    .replace(/\.[^.]+$/, "")
                    .replace(/[^a-zA-Z0-9_-]/g, "-");
                  const meta = { id, name: id, description: "Imported skill" };
                  if (file.name.endsWith(".zip")) {
                    const bytes = new Uint8Array(await file.arrayBuffer());
                    let binary = "";
                    for (const byte of bytes)
                      binary += String.fromCharCode(byte);
                    await v1("/skill-imports/archive", {
                      method: "POST",
                      body: JSON.stringify({ ...meta, archive: btoa(binary) }),
                    });
                  } else
                    await v1("/skill-imports", {
                      method: "POST",
                      body: JSON.stringify(
                        file.name.endsWith(".json")
                          ? JSON.parse(await file.text())
                          : {
                              ...meta,
                              files: { "SKILL.md": await file.text() },
                            },
                      ),
                    });
                  notify("Package imported. Review and install below.");
                });
              }}
            />
            <input
              aria-label="GitHub repository"
              placeholder="owner/repository"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
            />
            <input
              aria-label="Git revision"
              placeholder="Commit, tag or branch"
              value={gitRef}
              onChange={(e) => setGitRef(e.target.value)}
            />
            <button
              className="btn"
              disabled={readonly || busy}
              onClick={() =>
                void run(async () => {
                  await v1("/skill-imports/github", {
                    method: "POST",
                    body: JSON.stringify({
                      id: repository.replace("/", "-"),
                      name: repository,
                      description: "GitHub skill",
                      repository,
                      ref: gitRef,
                    }),
                  });
                  notify("GitHub version imported.");
                })
              }
            >
              Import GitHub
            </button>
          </details>
          <label>
            <input
              type="checkbox"
              checked={unlink}
              onChange={(e) => setUnlink(e.target.checked)}
            />{" "}
            Remove Agent links when uninstalling
          </label>
          <div className="grid2">
            {packages
              .filter((p) => match(p.name + " " + p.description))
              .map((p) => (
                <article className="card" key={p.id}>
                  <h3>{p.name}</h3>
                  <p>{p.description}</p>
                  {p.source.url && (
                    <a href={p.source.url} target="_blank" rel="noreferrer">
                      Source
                    </a>
                  )}
                  <p>
                    {p.installed_digest
                      ? "Installed " + p.installed_digest.slice(0, 12)
                      : "Not installed"}
                    {p.local ? " · Local version" : ""}
                  </p>
                  {p.versions.map((v) => (
                    <div key={v.digest}>
                      <code>{v.digest.slice(0, 12)}</code>
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() =>
                          void run(async () =>
                            setVersionPreview(
                              await v1(
                                "/skill-packages/" +
                                  p.id +
                                  "/versions/" +
                                  v.digest,
                              ),
                            ),
                          )
                        }
                      >
                        Review changes
                      </button>
                      <p>
                        Dependencies:{" "}
                        {[
                          ...(v.requirements.python || []),
                          ...(v.requirements.node || []),
                        ].join(", ") || "None declared"}
                      </p>
                      <button
                        className="btn"
                        disabled={
                          readonly ||
                          busy ||
                          p.installed_digest === v.digest ||
                          p.local
                        }
                        onClick={() =>
                          void run(async () => {
                            await v1("/skill-installations/" + p.id, {
                              method: "PUT",
                              body: JSON.stringify({
                                digest: v.digest,
                                revision: p.revision || 0,
                              }),
                            });
                            await w.reload();
                            notify("Skill version installed.");
                          })
                        }
                      >
                        {p.installed_digest === v.digest
                          ? "Installed"
                          : p.installed_digest
                            ? "Use this version"
                            : "Install"}
                      </button>
                    </div>
                  ))}
                  {p.installed_digest && (
                    <button
                      className="btn"
                      disabled={readonly || busy}
                      onClick={() =>
                        void run(async () => {
                          await v1("/skill-installations/" + p.id, {
                            method: "DELETE",
                            body: JSON.stringify({
                              revision: p.revision,
                              unlink,
                            }),
                          });
                          await w.reload();
                          notify("Skill uninstalled.");
                        })
                      }
                    >
                      Uninstall
                    </button>
                  )}
                </article>
              ))}
            {communitySkills
              .filter(
                (s) =>
                  match(s.name + " " + s.description) &&
                  !packages.some((p) => p.id === s.id),
              )
              .map((s) => (
                <article className="card" key={s.id}>
                  <h3>{s.name}</h3>
                  <p>{s.description}</p>
                  <details>
                    <summary>Instructions</summary>
                    <AnswerMarkdown content={s.documentation} />
                  </details>
                  <button
                    className="btn"
                    disabled={readonly || busy}
                    onClick={() =>
                      void run(async () => {
                        const imported = await v1<{ digest: string }>(
                          "/skill-imports",
                          {
                            method: "POST",
                            body: JSON.stringify({
                              id: s.id,
                              name: s.name,
                              description: s.description,
                              files: { "SKILL.md": s.documentation },
                            }),
                          },
                        );
                        await v1("/skill-installations/" + s.id, {
                          method: "PUT",
                          body: JSON.stringify({
                            digest: imported.digest,
                            revision: 0,
                          }),
                        });
                        await w.reload();
                        notify("Skill installed.");
                      })
                    }
                  >
                    Install skill
                  </button>
                </article>
              ))}
          </div>
        </>
      )}
      {section === "workspaces" && (
        <>
          <p className="muted">
            Personal work stays private. Team members can access the rooms,
            threads and knowledge saved in that team workspace.
          </p>
          <div className="grid2">
            {w.state.workspaces.map((space) => (
              <article className="card" key={space.id}>
                <Users />
                <h3>{space.name}</h3>
                <button
                  className="btn"
                  disabled={space.id === w.state.active || busy}
                  onClick={() => w.switchWorkspace(space.id)}
                >
                  {space.id === w.state.active
                    ? "Current workspace"
                    : "Switch workspace"}
                </button>
              </article>
            ))}
          </div>
          <form
            className="card"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await v1<{ id: string }>("/workspaces", {
                  method: "POST",
                  body: { name },
                });
                await w.reload();
                w.switchWorkspace(result.id);
              });
            }}
          >
            <h3>Create a team workspace</h3>
            <label className="field">
              Workspace name
              <input
                className="input"
                required
                maxLength={160}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button className="btn primary" disabled={busy || !name.trim()}>
              Create workspace
            </button>
          </form>
          <h3>Members of {w.activeName}</h3>
          {members.map((m) => (
            <div className="card v1-inbox-row" key={m.id}>
              <strong>{m.email}</strong>
              <span>
                {m.role}
                {m.owner ? " · owner" : ""}
              </span>
              {w.role === "admin" && !m.owner && (
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await v1("/members/" + m.id, { method: "DELETE" });
                    })
                  }
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          {w.role === "admin" && (
            <form
              className="card"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const r = await v1<{ token: string }>("/team-invites", {
                    method: "POST",
                    body: { email, role },
                  });
                  setInvite(r.token);
                });
              }}
            >
              <h3>Invite a teammate</h3>
              <label className="field">
                Email
                <input
                  className="input"
                  type="email"
                  value={email}
                  required
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label className="field">
                Role
                <select
                  className="input"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                >
                  <option value="member">Member · create and edit</option>
                  <option value="viewer">Viewer · read only</option>
                  <option value="admin">Admin · manage members</option>
                </select>
              </label>
              <button className="btn" disabled={busy}>
                Create invitation
              </button>
              {invite && (
                <label className="field">
                  Invitation link (valid for this email for 7 days)
                  <input
                    className="input"
                    readOnly
                    value={
                      location.origin +
                      "/register?invite=" +
                      encodeURIComponent(invite)
                    }
                  />
                  <small>
                    Existing users can paste this token below: {invite}
                  </small>
                </label>
              )}
            </form>
          )}
          <form
            className="card"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const token = accept.includes("invite=")
                  ? new URL(accept).searchParams.get("invite")
                  : accept;
                const r = await v1<{ workspaceId: string }>(
                  "/team-invites/accept",
                  { method: "POST", body: { token } },
                );
                await w.reload();
                w.switchWorkspace(r.workspaceId);
              });
            }}
          >
            <h3>Join a team</h3>
            <label className="field">
              Invitation link or token
              <input
                className="input"
                value={accept}
                onChange={(e) => setAccept(e.target.value)}
                required
              />
            </label>
            <button className="btn" disabled={busy}>
              Accept invitation
            </button>
          </form>
        </>
      )}
      {section === "workflows" && <Schedules />}
      {section === "integrations" && (
        <>
          <BrowserProfiles />
          <p className="muted">
            Available capabilities use public websites or your existing sandbox.
            Paid services are not connected.
          </p>
          <div className="grid2">
            {[
              [
                "Web Search",
                "Search public pages with automatic fallback. No paid search API.",
              ],
              ["Web Reader", "Read public pages and retain source links."],
              [
                "Public image search",
                "Find Wikimedia Commons images with their source credits and license information. No key or generation charge.",
              ],
              [
                "Documents & Code",
                "Python, JavaScript, PDF, charts, tables and HTML in the isolated sandbox.",
              ],
            ].map(([n, d]) => (
              <article className="card" key={n}>
                <span className="badge">Available</span>
                <h3>{n}</h3>
                <p>{d}</p>
              </article>
            ))}
            {[
              "Image generation",
              "Video generation",
              "Audio generation",
              "External account actions",
            ].map((n) => (
              <article className="card" key={n}>
                <span className="badge">Not connected</span>
                <h3>{n}</h3>
                <p>A suitable free public service has not been configured.</p>
                <button className="btn" disabled>
                  Unavailable
                </button>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
