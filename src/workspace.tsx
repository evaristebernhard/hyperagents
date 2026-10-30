import { parseSlidesContent } from "./slide-preview";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { initialThreads, initialProjects, safeRead } from "./data";
import { api, ApiError, fixtureMode, getState, saveState, migrateState, previewMigration } from "./backend-client";
import type { WorkspacePreferences } from "./types";
import { SnapshotLock } from "./snapshot-lock";
import {
  communitySkills,
  now,
  uid,
  type Artifact,
  type WorkspaceData,
  type WorkspaceState,
} from "./local-model";
const KEY = "hyperagents-demo:workspace-v1";
function seed(personal = false): WorkspaceData {
  const createdAt = now();
  const skill = {
    ...communitySkills[3],
    id: "small-biz-builder",
    sourceId: "small-biz-builder",
  };
  const artifacts: Artifact[] = personal
    ? [
        {
          id: "notes",
          title: "Working notes",
          kind: "Document",
          content:
            "Build a clear, frontend-only workspace.\n\nKeep the page structure, menus, and navigation faithful to the reference.\n\nNo LLM, browser runtime, or external tools are connected.",
          threadId: "small-business",
          versions: [],
          createdAt,
          updatedAt: createdAt,
        },
        {
          id: "website",
          title: "Local potential, redesigned",
          kind: "Webpage",
          content:
            '<main style="padding:40px;background:#111;color:white;font-family:system-ui;min-height:100vh"><small>LOCAL / OPPORTUNITY BOARD</small><h1>Loved around town.<br><span style="color:#c9ed62">Ready for a better site.</span></h1><p>A local demonstration artifact. No business has been contacted.</p></main>',
          threadId: "small-business",
          versions: [],
          createdAt,
          updatedAt: createdAt,
        },
        ...["campaign", "property", "hiring", "brand"].map((id) => ({
          id,
          title: id + "-preview.svg",
          kind: "Image" as const,
          content: "/examples/" + id + ".svg",
          threadId: "small-business",
          versions: [],
          createdAt,
          updatedAt: createdAt,
        })),
      ]
    : [];
  return {
    threads: personal ? safeRead("threads", initialThreads) : [],
    projects: personal ? safeRead("projects", initialProjects) : [],
    agents: personal ? safeRead("agents", []) : [],
    memories: personal ? safeRead("memories", []) : [],
    skills: personal ? [skill] : [],
    rooms: [],
    artifacts,
    schedules: [],
    rubrics: [],
    reviewedSuggestions: [],
    connections: [],
  };
}
function load(): WorkspaceState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return validateSnapshot(JSON.parse(raw));
  } catch {}
  return {
    version: 1,
    active: "personal",
    workspaces: [{ id: "personal", name: "Personal", data: seed(true) }],
  };
}
const arrays = [
  "threads",
  "projects",
  "agents",
  "memories",
  "skills",
  "rooms",
  "artifacts",
  "schedules",
  "rubrics",
  "reviewedSuggestions",
  "connections",
] as const;
export function validateSnapshot(input: unknown): WorkspaceState {
  const state = input as WorkspaceState;
  if (
    !state ||
    state.version !== 1 ||
    !Array.isArray(state.workspaces) ||
    state.workspaces.length < 1 ||
    state.workspaces.length > 50 ||
    typeof state.active !== "string"
  )
    throw Error("Unsupported backup format.");
  const ids = new Set<string>();
  for (const w of state.workspaces) {
    if (
      !w ||
      typeof w.id !== "string" ||
      !w.id ||
      ids.has(w.id) ||
      typeof w.name !== "string" ||
      !w.name.trim() ||
      !w.data
    )
      throw Error("Invalid workspace.");
    ids.add(w.id);
    if (!("connections" in w.data)) (w.data as WorkspaceData).connections = [];
    for (const key of arrays) {
      const list = w.data[key];
      if (!Array.isArray(list) || list.length > 10000)
        throw Error("Invalid " + key);
      if (key === "reviewedSuggestions") {
        if (list.some((x) => typeof x !== "string"))
          throw Error("Invalid suggestions");
        continue;
      }
      const seen = new Set<string>();
      for (const item of list as any[]) {
        if (
          !item ||
          typeof item.id !== "string" ||
          !item.id ||
          seen.has(item.id)
        )
          throw Error("Invalid or duplicate " + key + " id.");
        seen.add(item.id);
        const strings: Record<string, string[]> = {
          threads: ["title", "summary", "time"],
          projects: ["name", "description", "goal"],
          agents: ["name", "description", "prompt"],
          memories: ["content", "category"],
          skills: [
            "name",
            "description",
            "documentation",
            "whenToUse",
            "author",
            "createdAt",
            "updatedAt",
          ],
          rooms: ["name", "topic"],
          artifacts: ["title", "kind", "content", "createdAt", "updatedAt"],
          schedules: ["name", "instructions", "cadence"],
          rubrics: ["name"],
          connections: ["provider", "label", "endpoint", "createdAt"],
        };
        if (strings[key].some((k) => typeof item[k] !== "string"))
          throw Error("Invalid " + key + " fields.");
        if (
          key === "threads" &&
          item.messages !== undefined &&
          (!Array.isArray(item.messages) ||
            item.messages.some(
              (m: any) =>
                !m ||
                !["user", "assistant"].includes(m.role) ||
                typeof m.text !== "string",
            ))
        )
          throw Error("Invalid messages");
        if (
          key === "skills" &&
          (!Array.isArray(item.tags) ||
            item.tags.some((t: unknown) => typeof t !== "string"))
        )
          throw Error("Invalid tags");
        if (
          key === "memories" &&
          (!Number.isInteger(item.importance) ||
            item.importance < 1 ||
            item.importance > 5 ||
            typeof item.pinned !== "boolean")
        )
          throw Error("Invalid memory");
        if (
          key === "rooms" &&
          (!Array.isArray(item.agentIds) ||
            item.agentIds.some((x: unknown) => typeof x !== "string") ||
            !Array.isArray(item.notes) ||
            item.notes.some(
              (n: any) =>
                !n ||
                typeof n.id !== "string" ||
                typeof n.text !== "string" ||
                typeof n.createdAt !== "string",
            ))
        )
          throw Error("Invalid room");
        if (
          key === "artifacts" &&
          (!["Document", "Webpage", "Slides", "Table", "Image", "File"].includes(item.kind) ||
            !Array.isArray(item.versions) ||
            item.versions.some(
              (v: any) =>
                !v ||
                typeof v.id !== "string" ||
                typeof v.content !== "string" ||
                typeof v.createdAt !== "string",
            ))
        )
          throw Error("Invalid artifact");
        if (key === "artifacts" && item.kind === "Slides") {
          parseSlidesContent(item.content);
          for (const version of item.versions) parseSlidesContent(version.content);
        }
        if (
          key === "rubrics" &&
          (!Array.isArray(item.criteria) ||
            item.criteria.some((x: unknown) => typeof x !== "string"))
        )
          throw Error("Invalid criteria");
        if (
          (key === "schedules" || key === "connections") &&
          typeof item.enabled !== "boolean"
        )
          throw Error("Invalid schedule");
        if (key === "agents") {
          for (const field of ["tools", "skillIds"])
            if (
              item[field] !== undefined &&
              (!Array.isArray(item[field]) ||
                item[field].some((v: unknown) => typeof v !== "string"))
            )
              throw Error("Invalid agent configuration");
        }
      }
    }
  }
  if (!ids.has(state.active)) throw Error("Missing active workspace.");
  return state;
}
type Setter<K extends keyof WorkspaceData> = (
  value: WorkspaceData[K] | ((old: WorkspaceData[K]) => WorkspaceData[K]),
) => void;
type Store = {
  mode: "server" | "fixture";
  persistence: "loading" | "saving" | "saved" | "error" | "conflict";
  flush: () => Promise<void>;
  reload: () => Promise<void>;
  retrySave: () => Promise<void>;
  setPreferences: (patch: Partial<WorkspacePreferences>) => void;
  data: WorkspaceData;
  set: <K extends keyof WorkspaceData>(
    key: K,
    value: WorkspaceData[K] | ((old: WorkspaceData[K]) => WorkspaceData[K]),
  ) => void;
  state: WorkspaceState;
  storageError: string;
  activeName: string;
  switchWorkspace: (id: string) => void;
  createWorkspace: (name: string) => string;
  renameWorkspace: (id: string, name: string) => void;
  importSnapshot: (snapshot: unknown) => void;
  exportSnapshot: () => void;
  updateArtifact: (id: string, content: string) => void;
  installSkill: (id: string) => string;
};
const Context = createContext<Store | null>(null);
function FixtureWorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(load),
    [storageError, setStorageError] = useState("");
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      setStorageError("");
    } catch {
      setStorageError(
        "Browser storage is full or unavailable. Export a backup before closing this page.",
      );
    }
  }, [state]);
  const active =
    state.workspaces.find((w) => w.id === state.active) || state.workspaces[0];
  const set: Store["set"] = (key, value) =>
    setState((current) => ({
      ...current,
      workspaces: current.workspaces.map((w) =>
        w.id !== current.active
          ? w
          : {
              ...w,
              data: {
                ...w.data,
                [key]:
                  typeof value === "function"
                    ? (value as (v: any) => any)(w.data[key])
                    : value,
              },
            },
      ),
    }));
  const store: Store = {
    mode: "fixture", persistence: "saved", flush: async () => {}, reload: async () => {}, retrySave: async () => {},
    setPreferences: (patch) => set("preferences", old => ({ ...(old || {}), ...patch })),
    state,
    data: active.data,
    set,
    storageError,
    activeName: active.name,
    switchWorkspace: (id) => {
      if (state.workspaces.some((w) => w.id === id))
        setState({ ...state, active: id });
    },
    createWorkspace: (name) => {
      if (!name.trim()) throw Error("A workspace name is required.");
      const id = uid("workspace");
      setState({
        ...state,
        active: id,
        workspaces: [
          ...state.workspaces,
          { id, name: name.trim(), data: seed() },
        ],
      });
      return id;
    },
    renameWorkspace: (id, name) => {
      if (name.trim())
        setState({
          ...state,
          workspaces: state.workspaces.map((w) =>
            w.id === id ? { ...w, name: name.trim() } : w,
          ),
        });
    },
    importSnapshot: (snapshot) => setState(validateSnapshot(snapshot)),
    exportSnapshot: () =>
      download(
        "hyperagents-workspace-backup.json",
        JSON.stringify(state, null, 2),
        "application/json",
      ),
    updateArtifact: (id, content) =>
      set("artifacts", (items) =>
        items.map((a) =>
          a.id === id && content !== a.content
            ? {
                ...a,
                content,
                versions: [
                  ...a.versions,
                  {
                    id: uid("version"),
                    content: a.content,
                    createdAt: a.updatedAt,
                  },
                ],
                updatedAt: now(),
              }
            : a,
        ),
      ),
    installSkill: (id) => {
      const source = communitySkills.find((s) => s.id === id);
      if (!source) throw Error("Unknown community skill.");
      const exists = active.data.skills.find(
        (s) => s.sourceId === id || s.id === id,
      );
      if (exists) {
        set("skills", (ss) =>
          ss.map((s) => (s.id === exists.id ? { ...s, archived: false } : s)),
        );
        return exists.id;
      }
      const installed = {
        ...source,
        id: uid("skill"),
        sourceId: id,
        createdAt: now(),
        updatedAt: now(),
      };
      set("skills", (ss) => [...ss, installed]);
      return installed.id;
    },
  };
  return (
    <Context.Provider value={store}>
      <div className="backend-savebar"><span>Fixture mode — browser-only test data; no server persistence</span></div>
      {storageError && (
        <div role="alert" className="local-storage-error">
          {storageError}
          <button onClick={store.exportSnapshot}>Export backup</button>
        </div>
      )}
      {children}
    </Context.Provider>
  );
}

function ServerWorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkspaceState>(() => ({ version: 1, active: "personal", workspaces: [{ id: "personal", name: "Personal", data: seed(false) }] }));
  const [ready, setReady] = useState(false);
  const [persistence, setPersistence] = useState<Store["persistence"]>("loading");
  const [error, setError] = useState("");
  const stateRef = useRef(state);
  const readyRef = useRef(false);
  const revision = useRef(0);
  const acknowledged = useRef("");
  const blocked = useRef<Error | null>(null);
  const flight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const replacement = useRef(new SnapshotLock());
  const [replacing, setReplacing] = useState(false);
  const ownerRoot = useRef<HTMLDivElement>(null);
  const replacementStatus = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ownerRoot.current;
    if (!root) return;
    if (replacing) { root.setAttribute("inert", ""); replacementStatus.current?.focus(); }
    else root.removeAttribute("inert");
  }, [replacing]);
  const installServerState = (payload: { state: WorkspaceState; revision: number }) => {
    const next = validateSnapshot(payload.state);
    if (!Number.isInteger(payload.revision)) throw Error("The data service returned an invalid revision.");
    revision.current = payload.revision;
    acknowledged.current = JSON.stringify(next);
    stateRef.current = next;
    blocked.current = null;
    readyRef.current = true;
    setState(next); setReady(true); setPersistence("saved"); setError("");
  };
  const replaceSnapshot = async (load: () => Promise<{ state: WorkspaceState; revision: number }>, persistFirst: boolean) => {
    replacement.current.assertMutable();
    setReplacing(true);
    try {
      await replacement.current.run(
        async () => { if (persistFirst) await flush(); else if (flight.current) await flight.current.catch(() => {}); },
        async () => { installServerState(await load()); },
      );
    } finally { setReplacing(false); }
  };
  const reload = async () => { await replaceSnapshot(getState, false); };
  const flush = (): Promise<void> => {
    if (flight.current) return flight.current;
    if (blocked.current) return Promise.reject(blocked.current);
    if (!readyRef.current) return Promise.reject(new Error("The data service has not loaded yet."));
    const work = (async () => {
      while (acknowledged.current !== JSON.stringify(stateRef.current)) {
        const next = stateRef.current;
        const encoded = JSON.stringify(next);
        if (mounted.current) { setPersistence("saving"); setError(""); }
        try {
          const reply = await saveState(next, revision.current);
          if (!Number.isInteger(reply.revision)) throw Error("The data service did not acknowledge the save.");
          revision.current = reply.revision; acknowledged.current = encoded;
        } catch (e) {
          const problem = e instanceof Error ? e : new Error("Could not save changes.");
          blocked.current = problem;
          if (mounted.current) { setError(problem.message); setPersistence(e instanceof ApiError && e.status === 409 ? "conflict" : "error"); }
          throw problem;
        }
      }
      if (mounted.current) setPersistence("saved");
    })();
    const pending = work.finally(() => {
      flight.current = null;
      if (mounted.current && !blocked.current && acknowledged.current !== JSON.stringify(stateRef.current)) queueMicrotask(() => void flush().catch(() => {}));
    });
    flight.current = pending;
    return pending;
  };
  const retrySave = async () => { replacement.current.assertMutable(); blocked.current = null; await flush(); };
  const commitState = (update: WorkspaceState | ((current: WorkspaceState) => WorkspaceState)) => {
    replacement.current.assertMutable();
    const next = typeof update === "function" ? update(stateRef.current) : update;
    stateRef.current = next; setState(next);
    if (!blocked.current) queueMicrotask(() => { if (mounted.current && !blocked.current) void flush().catch(() => {}); });
  };
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    getState().then(payload => { if (!cancelled) installServerState(payload); }).catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : "Could not load the workspace."); setPersistence("error"); } });
    return () => { cancelled = true; mounted.current = false; };
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (readyRef.current && acknowledged.current !== JSON.stringify(stateRef.current)) { event.preventDefault(); event.returnValue = ""; }
    };
    const resume = () => { if (readyRef.current && blocked.current && !replacement.current.locked) void retrySave().catch(() => {}); };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("backend-session-restored", resume);
    return () => { window.removeEventListener("beforeunload", warn); window.removeEventListener("backend-session-restored", resume); };
  }, []);
  const active = state.workspaces.find(w => w.id === state.active) || state.workspaces[0];
  const set: Store["set"] = (key, value) => commitState(current => ({ ...current, workspaces: current.workspaces.map(w => {
    if (w.id !== current.active) return w;
    const data = { ...w.data, [key]: typeof value === "function" ? (value as (v: any) => any)(w.data[key]) : value };
    // Removing a resource unlinks live references; historical message context is retained.
    if (["projects", "agents", "rooms", "skills"].includes(key)) {
      const ids = new Set((data[key] as { id: string }[]).map(item => item.id));
      if (key === "projects") {
        data.threads = data.threads.map(t => t.projectId && !ids.has(t.projectId) ? { ...t, projectId: undefined } : t);
        data.artifacts = data.artifacts.map(a => a.projectId && !ids.has(a.projectId) ? { ...a, projectId: undefined } : a);
      }
      if (key === "agents") {
        data.threads = data.threads.map(t => t.config?.agentId && !ids.has(t.config.agentId) ? { ...t, config: { ...t.config, agentId: undefined } } : t);
        data.rooms = data.rooms.map(r => ({ ...r, agentIds: r.agentIds.filter(id => ids.has(id)) }));
        data.schedules = data.schedules.map(s => s.agentId && !ids.has(s.agentId) ? { ...s, agentId: undefined, enabled: false } : s);
        const defaults = data.preferences?.defaultThreadSettings;
        if (defaults?.agentId && !ids.has(defaults.agentId)) data.preferences = { ...data.preferences, defaultThreadSettings: { ...defaults, agentId: undefined } };
      }
      if (key === "rooms") {
        data.threads = data.threads.map(t => t.roomId && !ids.has(t.roomId) ? { ...t, roomId: undefined } : t);
        data.schedules = data.schedules.map(s => s.roomId && !ids.has(s.roomId) ? { ...s, roomId: undefined, enabled: false } : s);
      }
      if (key === "skills") data.agents = data.agents.map(a => ({ ...a, skillIds: (a.skillIds || []).filter(id => ids.has(id)) }));
    }
    return { ...w, data };
  }) }));
  const store: Store = {
    mode: "server", persistence, flush, retrySave, reload,
    data: active.data, state, storageError: error, activeName: active.name, set,
    setPreferences: patch => set("preferences", old => ({ ...(old || {}), ...patch })),
    switchWorkspace: id => commitState(current => current.workspaces.some(w => w.id === id) ? { ...current, active: id } : current),
    createWorkspace: name => {
      if (!name.trim()) throw Error("A workspace name is required.");
      const id = uid("workspace");
      commitState(current => ({ ...current, active: id, workspaces: [...current.workspaces, { id, name: name.trim(), data: seed(false) }] }));
      return id;
    },
    renameWorkspace: (id, name) => { if (name.trim()) commitState(current => ({ ...current, workspaces: current.workspaces.map(w => w.id === id ? { ...w, name: name.trim() } : w) })); },
    importSnapshot: snapshot => commitState(validateSnapshot(snapshot)),
    exportSnapshot: () => download("hyperagents-workspace-metadata.json", JSON.stringify(stateRef.current, null, 2), "application/json"),
    updateArtifact: (id, content) => set("artifacts", items => items.map(a => a.id !== id || content === a.content ? a : { ...a, content, versions: [...a.versions, { id: uid("version"), content: a.content, createdAt: a.updatedAt }], updatedAt: now() })),
    installSkill: id => {
      const source = communitySkills.find(s => s.id === id);
      if (!source) throw Error("Unknown community sample.");
      const current = stateRef.current.workspaces.find(w => w.id === stateRef.current.active)!;
      const exists = current.data.skills.find(s => s.sourceId === id || s.id === id);
      if (exists) { set("skills", items => items.map(s => s.id === exists.id ? { ...s, archived: false } : s)); return exists.id; }
      const installed = { ...source, id: uid("skill"), sourceId: id, createdAt: now(), updatedAt: now() };
      set("skills", items => [...items, installed]); return installed.id;
    },
  };
  const [legacy, setLegacy] = useState<WorkspaceState | null>(null);
  const [legacyError, setLegacyError] = useState("");
  const [legacyWarnings, setLegacyWarnings] = useState<string[]>([]);
  const [previewingLegacy, setPreviewingLegacy] = useState(false);
  const [legacyDismissed, setLegacyDismissed] = useState(false);
  const [migrationConfirmed, setMigrationConfirmed] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const hasLegacy = !legacyDismissed && (() => { try { return !!localStorage.getItem(KEY); } catch { return false; } })();
  if (!ready) return <section className="backend-loading" role="status"><h1>{error ? "Workspace unavailable" : "Loading your workspace…"}</h1><p>{error || "Reading the persistent data service."}</p>{error && <button className="btn" onClick={() => void reload().catch(e => setError(e.message))}>Retry loading</button>}</section>;
  return <Context.Provider value={store}>
    <div className="backend-owner-root" ref={ownerRoot} aria-busy={replacing}>
    <div className={"backend-savebar " + persistence}>
      <span role="status" aria-label="Storage status">{persistence === "saved" ? "Saved to local server" : persistence === "saving" ? "Saving…" : persistence === "conflict" ? "Conflicting changes — not overwritten" : "Changes not saved"}</span>
      {error && <span role="alert">{error}</span>}
      {(persistence === "error" || persistence === "conflict") && <>
        <button onClick={store.exportSnapshot}>Export unsaved data</button>
        <button onClick={() => void retrySave().catch(() => {})}>Retry save</button>
        <button onClick={() => { if (confirm("Reload the server version? Unsaved changes will be discarded. Export them first.")) void reload().catch(e => setError(e.message)); }}>Reload server version</button>
      </>}
      <button className="backend-signout" onClick={async () => {
        if (acknowledged.current !== JSON.stringify(stateRef.current) && !confirm("Some changes have not been saved. Sign out anyway?")) return;
        try { await api("/api/logout", { method: "POST", body: {} }); window.dispatchEvent(new Event("backend-logout")); }
        catch (e) { setError(e instanceof Error ? e.message : "Could not sign out."); }
      }}>Sign out</button>
    </div>
    {hasLegacy && <section className="backend-migration">
      <strong>Browser data found</strong><span>It may include previous demo examples. Nothing has been imported automatically.</span>
      {!legacy && <button className="btn small" disabled={previewingLegacy} onClick={async () => {
        setPreviewingLegacy(true); setLegacyError(""); setMigrationConfirmed(false);
        try {
          const raw = localStorage.getItem(KEY); if (!raw) throw Error("No browser data found.");
          const candidate = validateSnapshot(JSON.parse(raw));
          const preview = await previewMigration(candidate);
          setLegacyWarnings(preview.warnings); setLegacy(candidate);
        } catch (e) { setLegacyError(e instanceof Error ? e.message : "Invalid browser backup."); }
        finally { setPreviewingLegacy(false); }
      }}>{previewingLegacy ? "Checking browser backup…" : "Preview browser import"}</button>}
      <button className="plain" disabled={migrating} onClick={() => setLegacyDismissed(true)}>Dismiss</button>
      {legacy && <div className="backend-migration-preview">
        <h3>Import a copy, without replacing server workspaces</h3>
        {legacy.workspaces.map(w => <p key={w.id}>{w.name}: {w.data.threads.length} threads, {w.data.agents.length} agents, {w.data.artifacts.length} artifacts</p>)}
        {!!legacyWarnings.length && <div role="status"><strong>Import changes to review</strong><ul>{legacyWarnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}
        <p>New workspace IDs will be created. The original browser data is kept. File names alone cannot restore file bytes; JSON export is metadata, not a full file backup.</p>
        <label><input type="checkbox" checked={migrationConfirmed} onChange={e => setMigrationConfirmed(e.target.checked)} /> I understand and want to import a copy.</label>
        <button className="btn primary" disabled={!migrationConfirmed || migrating} onClick={async () => {
          setMigrating(true); setLegacyError("");
          try { await replaceSnapshot(() => migrateState(legacy, revision.current), true); setLegacyDismissed(true); }
          catch (e) { setLegacyError(e instanceof Error ? e.message : "Migration failed."); }
          finally { setMigrating(false); }
        }}>{migrating ? "Importing…" : "Confirm browser import"}</button>
        <button className="btn" disabled={migrating} onClick={() => { setLegacy(null); setMigrationConfirmed(false); }}>Cancel import</button>
      </div>}
      {legacyError && <p role="alert">{legacyError}</p>}
    </section>}
    {children}
    </div>
    {replacing && <div className="backend-replacement-overlay" role="alertdialog" aria-modal="true" aria-label="Updating workspace snapshot" tabIndex={-1} ref={replacementStatus}><h2>Updating workspace snapshot</h2><p>Finishing pending saves, then importing or reloading. Editing is paused so no changes can be lost.</p></div>}
  </Context.Provider>;
}
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  return fixtureMode() ? <FixtureWorkspaceProvider>{children}</FixtureWorkspaceProvider> : <ServerWorkspaceProvider>{children}</ServerWorkspaceProvider>;
}

export function useWorkspace() {
  const c = useContext(Context);
  if (!c) throw Error("WorkspaceProvider is required.");
  return c;
}
export function useCollection<K extends keyof WorkspaceData>(
  key: K,
): [WorkspaceData[K], Setter<K>] {
  const w = useWorkspace();
  return [w.data[key], (value) => w.set(key, value)];
}
export function download(
  filename: string,
  content: string,
  type = "text/plain",
) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function safeImage(content: string) {
  return /^\/examples\/[a-z-]+\.svg$/.test(content) ||
    /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(content)
    ? content
    : "";
}
