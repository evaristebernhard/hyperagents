import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { initialThreads, initialProjects, safeRead } from "./data";
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
          (!["Document", "Webpage", "Image", "File"].includes(item.kind) ||
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
export function WorkspaceProvider({ children }: { children: ReactNode }) {
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
