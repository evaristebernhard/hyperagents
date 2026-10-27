import { useEffect, useLayoutEffect, useState, useRef, type ReactNode } from "react";
import {
  Search,
  Inbox,
  Plus,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  PanelLeftClose,
  PanelLeftOpen,
  MessageSquare,
  Users,
  Puzzle,
  Brain,
  GraduationCap,
  Folder,
  BookOpen,
  Store,
  Settings2,
  LogOut,
  HelpCircle,
  Star,
  Grid2X2,
  List,
  Archive,
  MoreHorizontal,
  SlidersHorizontal,
  Home,
  LayoutDashboard,
  FileText,
  Workflow,
  Layers,
  X,
  ArrowLeft,
  Sparkles,
  Clock,
  Check,
} from "lucide-react";
import type { DemoThread, DemoAgent, DemoProject, DemoMemory } from "./types";
import {
  initialThreads,
  initialProjects,
  examples,
  safeRead,
  asset,
} from "./data";
import { Mark, IconButton, Modal, Composer } from "./ui";
import Resources from "./ResourcesUI";
import Settings from "./SettingsUI";
import Thread from "./Thread";
import Agents from "./Agents";
import AgentCasting from "./AgentCasting";
import Marketing from "./Marketing";
import { useWorkspace, useCollection } from "./workspace";
import ContentHub from "./ContentHub";
import Rooms from "./Rooms";
import LibraryManager from "./LibraryManager";
import LocalWorkspace from "./LocalWorkspace";

function useSaved<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => safeRead(key, initial));
  useEffect(() => {
    try {
      localStorage.setItem("hyperagents-demo:" + key, JSON.stringify(v));
    } catch {}
  }, [key, v]);
  return [v, setV] as const;
}
const gotoItems = [
  ["Projects", "/projects"],
  ["Threads", "/threads"],
  ["Inbox", "/inbox"],
  ["Rooms", "/rooms"],
  ["Agents", "/agents"],
  ["Command Center", "/command-center"],
  ["Workspaces", "/workspaces"],
  ["Skills", "/skills"],
  ["Memories", "/memories"],
  ["Documents", "/documents"],
  ["Rubrics", "/rubrics"],
  ["HyperApps", "/hyperapps"],
  ["Workflows", "/workflows"],
  ["Library", "/library"],
  ["Learning", "/learning"],
  ["Marketplace", "/marketplace"],
  ["Integrations", "/threads/new?settings=integrations"],
];
export default function App() {
  const [url, setUrl] = useState(() => location.pathname + location.search);
  const navigate = (next: string) => {
    if (next === location.pathname + location.search) return;
    history.pushState({}, "", next);
    setUrl(next);
    setMenu("");
    setSearch(false);
    window.scrollTo(0, 0);
  };
  const workspace = useWorkspace();
  const [threads, setThreads] = useCollection("threads");
  const [projects, setProjects] = useCollection("projects");
  const [agents, setAgents] = useCollection("agents");
  const [memories, setMemories] = useCollection("memories");
  const [collapsed, setCollapsed] = useSaved("sidebar-collapsed", false),
    [theme, setTheme] = useSaved("theme", "light");
  const [menu, setMenu] = useState(""),
    [search, setSearch] = useState(false),
    [toast, setToast] = useState(""),
    [agentsExpanded, setAgentsExpanded] = useState(false),
    [recentExpanded, setRecentExpanded] = useState(true),
    [roomsExpanded, setRoomsExpanded] = useState(true),
    [dialog, setDialog] = useState("");
  const [menuPosition, setMenuPosition] = useState<{ left: number; top?: number; bottom?: number }>({ left: 8 });
  const shellMenuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const profile = safeRead("profile", { name: "Demo User", company: "" });
  const profileName = profile.name || "Demo User";
  const profileInitials = profileName.split(/\s+/).slice(0, 2).map(n => n[0]).join("").toUpperCase();
  useEffect(() => {
    if (menu) shellMenuRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [menu]);
  useLayoutEffect(() => {
    if (!menu) return;
    const position = () => {
      const el = shellMenuRef.current;
      if (!el) return;
      el.style.maxHeight = `${Math.max(80, innerHeight - 16)}px`;
      const rect = el.getBoundingClientRect();
      el.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - rect.width - 8))}px`;
      if (rect.top < 8 || rect.bottom > innerHeight - 8) {
        el.style.bottom = "auto";
        el.style.top = `${Math.max(8, Math.min(rect.top, innerHeight - rect.height - 8))}px`;
      }
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [menu, menuPosition, workspace.state.workspaces.length]);
  const mainRef = useRef<HTMLElement>(null);
  const query = new URLSearchParams(url.split("?")[1] || "");
  const path = url.split("?")[0];
  const settings = query.get("settings");
  useEffect(() => {
    const pop = () => {
      setUrl(location.pathname + location.search);
      setMenu("");
      setSearch(false);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (path === "/" || path === "/home" || path.startsWith("/settings")) {
      const section = path.startsWith("/settings/")
        ? path.split("/")[2]
        : "personalization";
      const next = path.startsWith("/settings")
        ? "/threads/new?settings=" + section
        : "/threads/new";
      history.replaceState({}, "", next);
      setUrl(next);
    }
    mainRef.current?.scrollTo(0, 0);
  }, [path]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch((s) => !s);
        setMenu("");
      }
      if (e.key === "Escape") {
        setSearch(false);
        setMenu("");
        if (settings) {
          history.pushState({}, "", path);
          setUrl(path);
        }
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [settings, path]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    document.documentElement.dataset.theme =
      theme === "system"
        ? matchMedia("(prefers-color-scheme:dark)").matches
          ? "dark"
          : "light"
        : theme;
  }, [theme]);
  useEffect(() => {
    const title =
      threads.find((t) => path === "/thread/" + t.id)?.title ||
      gotoItems.find((i) => i[1] === path)?.[0] ||
      "Workspace";
    document.title = title + " · Hyperagents UI Demo";
  }, [path, threads]);
  const notify = (t: string) => setToast(t);
  const toggle = (m: string, trigger?: HTMLElement) => {
    if (trigger) {
      menuTriggerRef.current = trigger;
      const rect = trigger.getBoundingClientRect();
      const left = Math.max(8, Math.min(m === "learning" ? rect.right + 4 : rect.left, innerWidth - 248));
      setMenuPosition(m === "account"
        ? { left, bottom: Math.max(8, innerHeight - rect.top + 4) }
        : { left, top: Math.max(8, Math.min(m === "learning" ? rect.top : rect.bottom + 4, innerHeight - 170)) });
    }
    setMenu(menu === m ? "" : m);
  };
  const createThread = (text: string, project?: string) => {
    const id = "local-" + Date.now();
    const t: DemoThread = {
      id,
      title: text.split("\n")[0].slice(0, 65) || "New conversation",
      summary: text.slice(0, 150),
      time: "just now",
      project,
      messages: [
        { role: "user", text },
        {
          role: "assistant",
          text: "This is a frontend-only preview. Your message is saved on this device; no LLM, browser session, or tool was called.",
        },
      ],
    };
    setThreads([t, ...threads]);
    navigate("/thread/" + id);
  };
  const link = (
    route: string,
    label: string,
    Icon: typeof Search,
    extra?: ReactNode,
  ) => (
    <a
      key={route}
      href={route}
      className={"nav-item " + (path === route ? "active" : "")}
      title={collapsed ? label : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate(route);
      }}
    >
      <Icon size={17} />
      {!collapsed && <span>{label}</span>}
      {!collapsed && extra}
    </a>
  );
  const recent = threads.filter((t) => !t.archived).slice(0, 6);
  const renderPage = () => {
    if (
      path.startsWith("/skills") ||
      path.startsWith("/memories") ||
      path.startsWith("/rubrics")
    )
      return <ContentHub path={path} navigate={navigate} notify={notify} />;
    if (path.startsWith("/rooms"))
      return <Rooms path={path} navigate={navigate} notify={notify} />;
    if (path === "/library" || path === "/documents")
      return <LibraryManager path={path} navigate={navigate} notify={notify} />;
    if (path === "/workspaces" || path === "/workflows")
      return <LocalWorkspace path={path} navigate={navigate} notify={notify} />;

    if (path === "/threads/new" || path === "/home" || path === "/")
      return (
        <div className="home-page">
          <div className="home-hero">
            <h1>Let's get to work.</h1>
            <Composer
              navigate={navigate}
              onSend={createThread}
              notify={notify}
              agents={agents.map((a) => a.name)}
            />
            <button
              className="setup-agent"
              onClick={() => navigate("/agents/new")}
            >
              <Sparkles size={15} />
              Set up your agent
            </button>
          </div>
          <div className="home-recent">
            <ThreadList
              threads={threads.filter((t) => !t.archived).slice(0, 3)}
              allThreads={threads}
              setThreads={setThreads}
              navigate={navigate}
              title="Recent threads"
              home
            />
          </div>
          <section className="examples-section">
            <h2>See what Hyperagent is capable of building</h2>
            <div className="examples-grid">
              {examples.map((x) => (
                <a
                  className="example-card"
                  href={"/featured/" + x.slug}
                  key={x.slug}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate("/featured/" + x.slug);
                  }}
                >
                  <img src={asset(x.image)} alt={x.title} />
                  <div>
                    <strong>{x.title}</strong>
                    <p>{x.description}</p>
                    <small>
                      <Clock size={12} />
                      {x.duration}
                    </small>
                  </div>
                </a>
              ))}
            </div>
          </section>
        </div>
      );
    if (path === "/threads")
      return (
        <div className="standard-page">
          <ThreadList
            threads={threads}
            allThreads={threads}
            setThreads={setThreads}
            navigate={navigate}
            title="Threads"
          />
        </div>
      );
    if (path.startsWith("/thread/")) {
      const id = decodeURIComponent(path.split("/")[2]);
      const thread = threads.find((t) => t.id === id);
      if (!thread) return <NotFound navigate={navigate} />;
      return (
        <Thread
          key={id}
          thread={thread}
          update={(t) => setThreads(threads.map((x) => (x.id === id ? t : x)))}
          navigate={navigate}
          notify={notify}
          settingsPanel={query.get("panel") === "settings"}
          agents={agents.map((a) => a.name)}
        />
      );
    }
    if (path === "/agents/new/cast")
      return <AgentCasting key={workspace.state.active + ":casting"} navigate={navigate} />;
    if (path.startsWith("/agents"))
      return (
        <Agents
          key={workspace.state.active + ":" + path}
          path={path}
          creationManual={query.get("creation") === "manual"}
          navigate={navigate}
          notify={notify}
          agents={agents}
          setAgents={setAgents}
        />
      );
    if (path === "/rooms" || path === "/rooms/new")
      return (
        <RoomPage
          create={path.endsWith("new")}
          navigate={navigate}
          notify={notify}
          agents={agents}
        />
      );
    if (path.startsWith("/featured/")) {
      const x = examples.find((x) => x.slug === path.split("/")[2]);
      if (!x) return <NotFound navigate={navigate} />;
      return (
        <div className="standard-page featured-page">
          <button className="plain" onClick={() => navigate("/threads/new")}>
            <ArrowLeft size={16} />
            Examples
          </button>
          <h1>{x.title}</h1>
          <p>{x.description}</p>
          <img src={asset(x.image)} alt={x.title} />
          <button
            className="btn primary"
            onClick={() => createThread("Help me create: " + x.title)}
          >
            Try this example
          </button>
          <p className="demo-note">
            Starts a local demo conversation. No agent runtime is connected.
          </p>
        </div>
      );
    }
    const valid = [
      "skills",
      "memories",
      "projects",
      "library",
      "marketplace",
      "inbox",
      "learning",
      "rubrics",
      "wiki",
      "command-center",
      "documents",
      "hyperapps",
      "workflows",
      "workspaces",
    ];
    if (valid.includes(path.split("/")[1]))
      return (
        <Resources
          path={path}
          navigate={navigate}
          notify={notify}
          threads={threads}
          projects={projects}
          setProjects={setProjects}
          memories={memories}
          setMemories={setMemories}
          setThreads={setThreads}
          openThread={(id) => navigate("/thread/" + id)}
          onCreateThread={createThread}
        />
      );
    return <NotFound navigate={navigate} />;
  };
  if (["/marketing", "/terms", "/privacy"].includes(path))
    return <Marketing path={path} navigate={navigate} />;
  if (["/404", "/signup"].includes(path))
    return <NotFound navigate={navigate} />;
  if (path === "/login")
    return (
      <div className="login-page">
        <a
          className="login-brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          Hyperagent
        </a>
        <div className="login-card">
          <h1>Hyperagent</h1>
          <button
            className="btn primary"
            onClick={() =>
              notify(
                "Demo authentication only. Use Continue to workspace below.",
              )
            }
          >
            ◉ &nbsp; Sign in with ChatGPT
          </button>
          <p className="muted">
            Use your existing ChatGPT subscription
            <br />
            to pay for Hyperagent usage.
          </p>
          <div className="or-divider">or</div>
          {["Google", "Apple", "Microsoft"].map((n) => (
            <button
              className="btn"
              key={n}
              onClick={() =>
                notify(n + " OAuth is not connected in this frontend demo.")
              }
            >
              Sign in with {n}
            </button>
          ))}
          <button className="plain" onClick={() => setDialog("email")}>
            ✉ Continue with email
          </button>
          <p className="muted legal">
            This is an independent frontend demo.
            <br />
            No real authentication or account creation.
          </p>
          <button className="btn" onClick={() => navigate("/threads/new")}>
            Continue to demo workspace →
          </button>
        </div>
        {dialog === "email" && (
          <Modal title="Continue with email" onClose={() => setDialog("")}>
            <label className="field">
              Email
              <input
                className="input"
                type="email"
                placeholder="you@example.com"
              />
            </label>
            <button
              className="btn primary"
              onClick={() => {
                setDialog("");
                navigate("/threads/new");
              }}
            >
              Continue to demo
            </button>
          </Modal>
        )}
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </div>
    );
  return (
    <div className={"app-shell " + (collapsed ? "sidebar-collapsed" : "")}>
      <aside className="sidebar">
        <div className="brand-row">
          <a
            className="brand"
            href="/threads/new"
            onClick={(e) => {
              e.preventDefault();
              navigate("/threads/new");
            }}
          >
            <Mark />
            {!collapsed && <span>Hyperagent</span>}
          </a>
          <IconButton
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? (
              <PanelLeftOpen size={16} />
            ) : (
              <PanelLeftClose size={16} />
            )}
          </IconButton>
        </div>
        <button
          className="workspace-switch"
          onClick={(e) => toggle("workspace", e.currentTarget)}
          aria-haspopup="menu"
          aria-expanded={menu === "workspace"}
        >
          <span className="avatar tiny">P</span>
          {!collapsed && (
            <>
              {workspace.activeName}
              <ChevronDown size={14} />
            </>
          )}
        </button>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {link("/threads/new", "New thread", MessageSquare)}
          <button
            className="nav-item"
            onClick={() => {
              setSearch(true);
              setMenu("");
            }}
            title="Search"
          >
            <Search size={17} />
            {!collapsed && (
              <>
                <span>Search</span>
                <kbd>Ctrl+K</kbd>
              </>
            )}
          </button>
          {link("/inbox", "Inbox", Inbox)}
          <div className="nav-group">
            <button
              className="group-title"
              onClick={() => setAgentsExpanded(!agentsExpanded)}
              aria-expanded={agentsExpanded}
              aria-controls="sidebar-agent-list"
              title="Agents"
            >
              {collapsed ? (
                <Users size={17} />
              ) : (
                <>
                  Agents
                  {agentsExpanded ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )}
                </>
              )}
            </button>
            {agentsExpanded && !collapsed && (
              <div id="sidebar-agent-list">
                {agents.map((a) => link("/agents/" + a.id, a.name, Users))}
                {link("/agents/new", "New agent", Plus)}
                {link("/agents", "View roster", ArrowUpRight)}
              </div>
            )}
          </div>
          <div className="nav-group">
            <button
              className="group-title"
              onClick={() => setRecentExpanded(!recentExpanded)}
              aria-expanded={recentExpanded}
              aria-controls="sidebar-recent-list"
              title="Recent threads"
            >
              {collapsed ? (
                <MessageSquare size={17} />
              ) : (
                <>
                  Recent threads
                  {recentExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </>
              )}
            </button>
            {recentExpanded && !collapsed && (
              <div id="sidebar-recent-list">
                {recent.map((t) => (
                  <a
                    href={"/thread/" + t.id}
                    key={t.id}
                    className={
                      "nav-item thread-link " +
                      (path === "/thread/" + t.id ? "active" : "")
                    }
                    onClick={(e) => {
                      e.preventDefault();
                      navigate("/thread/" + t.id);
                    }}
                  >
                    <span className="mini-mark">
                      <Mark />
                    </span>
                    <span>{t.title}</span>
                    {t.project && <Folder size={11} />}
                  </a>
                ))}
                {link("/threads", "View all", ArrowUpRight)}
              </div>
            )}
          </div>
          <div className="nav-group">
            <button
              className="group-title"
              onClick={() => setRoomsExpanded(!roomsExpanded)}
              aria-expanded={roomsExpanded}
              aria-controls="sidebar-room-list"
              title="Rooms"
            >
              {collapsed ? (
                <Users size={17} />
              ) : (
                <>
                  Recent rooms
                  {roomsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </>
              )}
            </button>
            {roomsExpanded && !collapsed && (
              <div id="sidebar-room-list">
                {workspace.data.rooms
                  .filter((r) => !r.archived)
                  .slice(0, 4)
                  .map((r) => link("/rooms/" + r.id, r.name, Users))}
                {link("/rooms/new", "New room", Plus)}
              </div>
            )}
          </div>
          {!collapsed && (
            <div className="group-title resources-label">Resources</div>
          )}
          {link("/skills", "Skills", Puzzle)}
          {link("/memories", "Memories", Brain)}
          <button
            className={
              "nav-item " +
              (["/learning", "/rubrics", "/wiki"].includes(path)
                ? "active"
                : "")
            }
            title="Learning"
            onClick={(e) => toggle("learning", e.currentTarget)}
            aria-haspopup="menu"
            aria-expanded={menu === "learning"}
          >
            <GraduationCap size={17} />
            {!collapsed && (
              <>
                <span>Learning</span>
                <ChevronRight size={13} />
              </>
            )}
          </button>
          {projects.length ? link("/projects", "Projects", Folder) : link("/projects/new", "New project", Plus)}
          {link("/library", "Library", BookOpen)}
          {link("/marketplace", "Marketplace", Store)}
        </nav>
        <button
          className="account-button"
          onClick={(e) => toggle("account", e.currentTarget)}
          aria-haspopup="menu"
          aria-expanded={menu === "account"}
        >
          <span className="avatar">{profileInitials}</span>
          {!collapsed && (
            <>
              <span>
                <strong>{profileName}</strong>
                <small>demo@example.com</small>
              </span>
              <ChevronRight size={14} />
            </>
          )}
        </button>
      </aside>
      <main
        ref={mainRef}
        key={workspace.state.active}
        className={
          "main-content " + (path.startsWith("/thread/") ? "thread-main" : "")
        }
      >
        {renderPage()}
      </main>
      {menu && (
        <>
          <div className="menu-dismiss" onClick={() => setMenu("")} />
          <div
            ref={shellMenuRef}
            role="menu"
            aria-label={menu === "workspace" ? "Workspaces" : menu === "learning" ? "Learning" : "Account"}
            style={menuPosition}
            onKeyDown={(e) => {
              if (["Escape", "ArrowLeft"].includes(e.key)) {
                e.preventDefault(); e.stopPropagation(); setMenu(""); menuTriggerRef.current?.focus(); return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
              e.preventDefault();
              const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }}
            className={
              "popover shell-menu " +
              menu +
              (collapsed ? " collapsed-menu" : "")
            }
          >
            {menu === "workspace" ? (
              <>
                <small>Workspaces</small>
                <button role="menuitem" onClick={() => setMenu("")}>
                  <span className="avatar tiny">{profileInitials}</span>
                  {workspace.activeName}
                  <Check size={14} />
                </button>
                <button role="menuitem"
                  onClick={() => {
                    setMenu("");
                    navigate("/workspaces");
                  }}
                >
                  <Plus size={15} />
                  Create workspace
                </button>
                {workspace.state.workspaces
                  .filter((w) => w.id !== workspace.state.active)
                  .map((w) => (
                    <button role="menuitem"
                      key={w.id}
                      onClick={() => {
                        workspace.switchWorkspace(w.id);
                        setMenu("");
                        navigate("/threads/new");
                      }}
                    >
                      {w.name}
                    </button>
                  ))}
              </>
            ) : menu === "learning" ? (
              <>
                <small>Learning</small>
                {[
                  ["Improvements", "/learning"],
                  ["Rubrics", "/rubrics"],
                  ["Autowiki", "/wiki"],
                ].map(([n, p]) => (
                  <button role="menuitem" key={p} onClick={() => navigate(p)}>
                    {n}
                    <ChevronRight size={13} />
                  </button>
                ))}
              </>
            ) : (
              <>
                <div className="account-menu-heading">
                  <strong>{profileName}</strong>
                  <small>demo@example.com</small>
                </div>
                <button role="menuitem"
                  onClick={() => navigate(path + "?settings=personalization")}
                >
                  <Settings2 size={15} />
                  Account settings
                </button>
                <button role="menuitem" onClick={() => navigate(path + "?settings=billing")}>
                  <Star size={15} />
                  Plan & billing<span className="badge">Free</span>
                </button>
                <button role="menuitem"
                  onClick={() => {
                    setMenu("");
                    setDialog("help");
                  }}
                >
                  <HelpCircle size={15} />
                  Help & support
                </button>
                <button role="menuitem"
                  onClick={() => {
                    setMenu("");
                    setDialog("account");
                  }}
                >
                  <Plus size={15} />
                  Add account
                </button>
                <button role="menuitem" title="Return to the local demo login; no real account session is managed." onClick={() => navigate("/login")}>
                  <LogOut size={15} />
                  Sign out
                </button>
              </>
            )}
          </div>
        </>
      )}
      {search && (
        <SearchDialog
          threads={threads}
          projects={projects}
          agents={agents}
          onClose={() => setSearch(false)}
          navigate={navigate}
        />
      )}
      {settings && (
        <Settings
          section={settings}
          navigateSection={(s) => navigate(path + "?settings=" + s)}
          onClose={() => navigate(path)}
          notify={notify}
          theme={theme}
          setTheme={setTheme}
        />
      )}
      {dialog && (
        <Modal
          title={
            dialog === "workspace"
              ? "Create workspace"
              : dialog === "help"
                ? "About this demo"
                : "Add account"
          }
          onClose={() => setDialog("")}
        >
          {dialog === "workspace" ? (
            <>
              <label className="field">
                Workspace name
                <input className="input" placeholder="Your team" />
              </label>
              <p className="demo-note">
                Team accounts and permissions are not connected. This preview
                stays in Personal.
              </p>
              <button
                className="btn"
                onClick={() => {
                  setDialog("");
                  notify(
                    "Workspace creation requires a backend; no account was created.",
                  );
                }}
              >
                Close preview
              </button>
            </>
          ) : (
            <>
              <p>
                This is an independent, frontend-only recreation. Changes are
                stored locally on this device.
              </p>
              <p>
                LLM inference, browser control, tool execution, OAuth and
                billing are intentionally not connected.
              </p>
              <button className="btn" onClick={() => setDialog("")}>
                Got it
              </button>
            </>
          )}
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
function ThreadList({
  threads,
  allThreads,
  setThreads,
  navigate,
  title,
  home = false,
}: {
  threads: DemoThread[];
  allThreads: DemoThread[];
  setThreads: (a: DemoThread[]) => void;
  navigate: (p: string) => void;
  title: string;
  home?: boolean;
}) {
  const [grid, setGrid] = useState(false),
    [filter, setFilter] = useState("Recent"),
    [text, setText] = useState(""),
    [filters, setFilters] = useState(false),
    [showArchived, setShowArchived] = useState(false),
    [projectFilter, setProjectFilter] = useState("");
  const items = threads.filter(
    (t) =>
      !!t.archived === showArchived &&
      (!projectFilter || t.project === projectFilter) &&
      (filter !== "Starred" || t.starred) &&
      (filter !== "Needs input" || t.messages?.at(-1)?.role === "user") &&
      t.title.toLowerCase().includes(text.toLowerCase()),
  );
  return (
    <section className="thread-list-section">
      <div className="page-header">
        <h2 className={home ? "" : "page-title"}>{title}</h2>
        <div className="actions">
          {!home && (
            <button
              className="btn primary small"
              onClick={() => navigate("/threads/new")}
            >
              <Plus size={14} />
              New thread
            </button>
          )}
          {home && (
            <>
              <div className="segmented">
                <IconButton
                  label="List view"
                  onClick={() => setGrid(false)}
                  className={!grid ? "selected" : ""}
                >
                  <List size={16} />
                </IconButton>
                <IconButton
                  label="Grid view"
                  onClick={() => setGrid(true)}
                  className={grid ? "selected" : ""}
                >
                  <Grid2X2 size={16} />
                </IconButton>
              </div>
              <button
                className="btn small"
                onClick={() => navigate("/threads")}
              >
                Show all
              </button>
            </>
          )}
        </div>
      </div>
      {!home && (
        <div className="list-controls">
          <input
            className="search-input"
            placeholder="Search by name or topic"
            aria-label="Search threads"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="actions">
            <label className="check-row">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Archived
            </label>
            {["Starred", "Needs input", "Recent"].map((n) => (
              <button
                className={"pill " + (filter === n ? "selected" : "")}
                key={n}
                onClick={() => setFilter(n)}
              >
                {n}
              </button>
            ))}
            <button className="btn small" onClick={() => setFilters(!filters)}>
              <SlidersHorizontal size={14} />
              Filters
            </button>
            <IconButton label="Toggle grid" onClick={() => setGrid(!grid)}>
              <Grid2X2 size={15} />
            </IconButton>
          </div>
        </div>
      )}
      {filters && (
        <div className="filter-strip">
          <label>
            Project
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
            >
              <option value="">All projects</option>
              {[
                ...new Set(allThreads.map((t) => t.project).filter(Boolean)),
              ].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <button
            className="plain"
            onClick={() => {
              setText("");
              setFilter("Recent");
              setFilters(false);
            }}
          >
            Clear filters
          </button>
        </div>
      )}
      <div className={"thread-cards " + (grid ? "grid" : "")}>
        {items.map((t, i) => (
          <article className="thread-card" key={t.id}>
            <a
              href={"/thread/" + t.id}
              onClick={(e) => {
                e.preventDefault();
                navigate("/thread/" + t.id);
              }}
            >
              {t.project && (
                <span className="thread-project">
                  <Folder size={14} />
                  {t.project}
                </span>
              )}
              <h3>{t.title}</h3>
              <p>{t.summary}</p>
              <small>{t.time}</small>
            </a>
            {t.id === "small-business" && (
              <img
                className="thread-thumbnail"
                src={asset("brand")}
                alt="Webpage preview"
              />
            )}
            <div className="thread-card-actions">
              <IconButton
                label={(t.starred ? "Unstar " : "Star ") + t.title}
                onClick={() =>
                  setThreads(
                    allThreads.map((x) =>
                      x.id === t.id ? { ...x, starred: !x.starred } : x,
                    ),
                  )
                }
              >
                <Star size={15} fill={t.starred ? "currentColor" : "none"} />
              </IconButton>
              <IconButton
                label={(t.archived ? "Restore " : "Archive ") + t.title}
                onClick={() => {
                  setThreads(
                    allThreads.map((x) =>
                      x.id === t.id ? { ...x, archived: !x.archived } : x,
                    ),
                  );
                }}
              >
                <Archive size={15} />
              </IconButton>
              {t.archived && (
                <IconButton
                  label={"Delete permanently " + t.title}
                  onClick={() => {
                    if (confirm("Permanently delete this local thread?")) {
                      setThreads(allThreads.filter((x) => x.id !== t.id));
                    }
                  }}
                >
                  <X size={15} />
                </IconButton>
              )}
            </div>
          </article>
        ))}
        {!items.length && (
          <div className="empty-state">
            <MessageSquare size={28} />
            <h3>No threads found</h3>
            <p>Try another search or start a new conversation.</p>
          </div>
        )}
      </div>
    </section>
  );
}
function SearchDialog({
  threads, projects, agents, onClose, navigate,
}: {
  threads: DemoThread[];
  projects: DemoProject[];
  agents: DemoAgent[];
  onClose: () => void;
  navigate: (p: string) => void;
}) {
  const workspace = useWorkspace();
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState("");
  const resultsRef = useRef<HTMLDivElement>(null);
  const query = q.trim().toLowerCase();
  const threadResults = threads.filter(t => !t.archived).map(t => ({
    title: t.title, path: "/thread/" + t.id, type: "Thread",
    group: /yesterday|h ago|days? ago/.test(t.time) ? "Past week" : "Today",
  }));
  const allResults = [
    ...threadResults,
    ...agents.filter(a => !a.archived).map(a => ({ title: a.name, path: "/agents/" + a.id, type: "Agent", group: "Agents" })),
    ...projects.filter(p => !p.archived).map(p => ({ title: p.name, path: "/projects/" + p.id, type: "Project", group: "Projects" })),
    ...workspace.data.skills.filter(s => !s.archived).map(s => ({ title: s.name, path: "/skills/" + s.id, type: "Skill", group: "Skills" })),
    ...workspace.data.rooms.filter(r => !r.archived).map(r => ({ title: r.name, path: "/rooms/" + r.id, type: "Room", group: "Rooms" })),
    ...workspace.data.artifacts.filter(a => !a.archived).map(a => ({ title: a.title, path: "/library?artifact=" + a.id, type: a.kind, group: "Library" })),
    ...gotoItems.map(([title, path]) => ({ title, path, type: "Go to", group: "Go to" })),
  ];
  const results = query
    ? allResults.filter(r => r.title.toLowerCase().includes(query))
    : allResults.filter(r => r.type === "Thread" || r.type === "Go to");
  useEffect(() => { setIndex(0); setStatus(""); }, [q]);
  useEffect(() => {
    resultsRef.current?.querySelector(`#search-result-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  const selected = results[Math.min(index, results.length - 1)];
  const open = (result: (typeof results)[number], newTab = false) => {
    if (newTab) window.open(result.path, "_blank", "noopener,noreferrer");
    else navigate(result.path);
    onClose();
  };
  const copy = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(new URL(selected.path, location.origin).href);
      setStatus("Link copied");
    } catch { setStatus("Clipboard unavailable in this browser"); }
  };
  const icon = (type: string, title: string) => {
    if (type === "Thread") return MessageSquare;
    if (type === "Agent" || title === "Agents") return Users;
    if (type === "Project" || title === "Projects") return Folder;
    if (type === "Skill" || title === "Skills") return Puzzle;
    if (title === "Inbox") return Inbox;
    if (type === "Room" || title === "Rooms") return MessageSquare;
    if (title === "Memories") return Brain;
    if (title === "Library") return BookOpen;
    if (title === "Marketplace") return Store;
    return Layers;
  };
  return (
    <Modal title="Search" onClose={onClose} headerless>
      <div className="search-dialog-content" onKeyDown={e => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setIndex(i => (i + (e.key === "ArrowDown" ? 1 : -1) + Math.max(results.length, 1)) % Math.max(results.length, 1));
        }
        if (e.key === "Enter" && selected) {
          e.preventDefault(); open(selected, e.ctrlKey || e.metaKey);
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
          const input = e.target as HTMLInputElement;
          if (input.tagName === "INPUT" && input.selectionStart !== input.selectionEnd) return;
          e.preventDefault(); void copy();
        }
      }}>
        <div className="search-dialog-input">
          <Search size={18} />
          <span className="search-scope"><Users size={14} />{workspace.activeName}</span>
          <input autoFocus aria-label="Search workspace" aria-controls="workspace-search-results"
            aria-activedescendant={selected ? `search-result-${Math.min(index, results.length - 1)}` : undefined}
            autoComplete="off" value={q} onChange={e => setQ(e.target.value)} placeholder={"Search in " + workspace.activeName + "..."} />
        </div>
        <div className="search-results" id="workspace-search-results" role="listbox" aria-label="Search results" ref={resultsRef}>
          {results.map((result, i) => {
            const Icon = icon(result.type, result.title);
            return <div key={result.path} role="presentation">
              {(i === 0 || result.group !== results[i - 1].group) && <div className="search-group-label" role="presentation">{result.group}</div>}
              <button type="button" role="option" id={`search-result-${i}`} data-kind={result.type} aria-selected={index === i} className={index === i ? "selected" : ""}
                onMouseEnter={() => setIndex(i)} onClick={e => open(result, e.ctrlKey || e.metaKey)}>
                <Icon size={19} /><span className="search-result-title">{result.title}</span>
                {i === index && <span className="search-result-shortcuts" aria-hidden="true"><span><kbd>Ctrl</kbd><kbd>↵</kbd> open in new tab</span><span><kbd>Ctrl</kbd><kbd>C</kbd> copy</span></span>}
              </button>
            </div>;
          })}
          {!results.length && <div className="empty-state">No matches found.</div>}
        </div>
        <div className="search-keyboard"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span><span role="status">{status}</span></div>
      </div>
    </Modal>
  );
}
function RoomPage({
  create,
  navigate,
  notify,
  agents,
}: {
  create: boolean;
  navigate: (p: string) => void;
  notify: (s: string) => void;
  agents: DemoAgent[];
}) {
  const [name, setName] = useState(""),
    [team, setTeam] = useState<string[]>([]),
    [members, setMembers] = useState(false);
  if (!create)
    return (
      <div className="standard-page">
        <div className="page-header">
          <h1 className="page-title">Rooms</h1>
          <button
            className="btn primary"
            onClick={() => navigate("/rooms/new")}
          >
            <Plus size={15} />
            New room
          </button>
        </div>
        <div className="empty-state">
          <Users size={32} />
          <h3>No rooms yet</h3>
          <p>Bring people and AI agents together.</p>
        </div>
      </div>
    );
  return (
    <div className="standard-page room-create">
      <div className="page-header">
        <div className="actions">
          <ArrowLeft size={16} />
          <input
            className="title-input"
            aria-label="Room name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name your room"
          />
        </div>
        <div className="actions">
          <span className="badge">Draft room</span>
          <button className="plain" onClick={() => navigate("/rooms")}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={() =>
              notify(
                "Room creation is a local UI preview; team collaboration is not connected.",
              )
            }
          >
            Create room
          </button>
        </div>
      </div>
      <div className="room-content">
        <h2>A shared room for this work.</h2>
        <p className="muted">
          Bring people and AI agents together. Discuss decisions in the room,
          and follow each agent’s work in a thread.
        </p>
        <label className="field">
          What will you work on? <span className="muted">(optional)</span>
          <textarea
            className="textarea"
            rows={3}
            placeholder="A project, a question, or a recurring workflow…"
          />
        </label>
        <div className="page-header">
          <h3>
            Room team <span className="muted">Optional</span>
          </h3>
          <button className="plain" onClick={() => setMembers(true)}>
            <Plus size={15} />
            Add members
          </button>
        </div>
        <div className="card room-member">
          <span className="avatar">D</span>
          <div>
            <strong>You</strong>
            <p className="muted">Room manager</p>
          </div>
        </div>
        {team.map((n) => (
          <div className="card room-member" key={n}>
            <Users size={20} />
            <strong>{n}</strong>
            <button
              className="plain"
              onClick={() => setTeam(team.filter((t) => t !== n))}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="empty-state small">
          <Users size={24} />
          <h3>{team.length ? "Your room team" : "Just you so far"}</h3>
          <p>
            Without AI agents, this is a space for people. Add agents when you
            want their help.
          </p>
        </div>
        <h3>How work happens here</h3>
        <div className="grid3">
          {["Talk together", "Work in threads", "Move it forward"].map(
            (s, i) => (
              <div className="card" key={s}>
                {i === 0 ? (
                  <Users size={18} />
                ) : i === 1 ? (
                  <MessageSquare size={18} />
                ) : (
                  <Check size={18} />
                )}
                <h4>{s}</h4>
                <small className="muted">
                  {
                    [
                      "People + AI agents",
                      "Follow each request",
                      "Review together",
                    ][i]
                  }
                </small>
              </div>
            ),
          )}
        </div>
        <div className="card schedule-card">
          <Clock size={21} />
          <div>
            <h3>A rhythm when you need one</h3>
            <p>
              Briefings, reviews, and recurring checks can land here. After
              creating the room, open Schedules to choose an agent.
            </p>
          </div>
        </div>
        <p className="muted">
          A name is enough to start. You can add your team and schedules later.
        </p>
      </div>
      {members && (
        <Modal title="Add members" onClose={() => setMembers(false)}>
          {agents.length ? (
            agents.map((a) => (
              <button
                className="btn"
                key={a.id}
                onClick={() => {
                  setTeam([...new Set([...team, a.name])]);
                  setMembers(false);
                }}
              >
                {a.name}
              </button>
            ))
          ) : (
            <div className="empty-state">
              <Users size={25} />
              <p>No agents available yet.</p>
              <button className="btn" onClick={() => navigate("/agents/new")}>
                Create an agent
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
function NotFound({ navigate }: { navigate: (p: string) => void }) {
  return (
    <div className="not-found">
      <FileText size={48} />
      <h1>404</h1>
      <p>This page could not be found.</p>
      <button className="btn primary" onClick={() => navigate("/threads/new")}>
        Go Home
      </button>
    </div>
  );
}
