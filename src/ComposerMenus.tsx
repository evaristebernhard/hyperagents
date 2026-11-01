import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Brain, Gauge, GitBranch, Blocks, Plug, ArrowUpRight, ChevronRight,
  Check, Search, PencilLine, Sparkles, Bot, Zap, Link, BookOpen, Grid3X3, History, Monitor, Table, FileText, Globe, Presentation, Image, Video, Volume2, Mic, User, MapPin, Folder, Users, Code, CloudSun, Landmark, GraduationCap, Camera,
} from "lucide-react";
import type { Navigate, ThreadSettings } from "./types";
import { currentModels } from "./llm-client";
import { api } from "./backend-client";

const toolNames = [
  "Search", "Find Similar", "Exa Research", "Exa Websets", "Thread Search",
  "Files", "Skills", "Delegation", "Browser", "Web Fetch", "Web Semantic Tree", "Web Eval", "Visual Output", "Webpages", "Slides", "Tables", "Documents", "Images", "Video",
  "Audio", "Transcribe", "Avatar", "Maps",
];
type Capability = { label: string; executable: boolean; reason?: string; surfaces?: { composer?: boolean } };
const toolGroups = [
  { label: "Research", names: ["Search", "Find Similar", "Exa Research", "Exa Websets", "Thread Search", "World Bank", "Weather", "OpenAlex"] },
  { label: "Browser", names: ["Browser", "Web Fetch", "Web Semantic Tree", "Web Eval", "Visual Output"] },
  { label: "Data", names: ["Tables", "Documents"] },
  { label: "Interactive", names: ["Webpages", "Slides"] },
  { label: "Media", names: ["Images", "Video", "Audio", "Transcribe", "Avatar", "Maps"] },
  { label: "Workspace", names: ["Files", "Skills", "Delegation"] },
] as const;
const toolIcons: Record<string, typeof Search> = {
  "Search": Search, "Find Similar": Link, "Exa Research": BookOpen, "Exa Websets": Grid3X3,
  "Thread Search": History, "World Bank": Landmark, "Weather": CloudSun, "OpenAlex": GraduationCap,
  "Browser": Monitor, "Web Fetch": Globe, "Web Semantic Tree": GitBranch, "Web Eval": Code, "Visual Output": Camera,
  "Tables": Table, "Documents": FileText, "Webpages": Globe, "Slides": Presentation,
  "Images": Image, "Video": Video, "Audio": Volume2, "Transcribe": Mic, "Avatar": User, "Maps": MapPin,
  "Files": Folder, "Skills": Sparkles, "Delegation": Users,
};
export const starterAgents = [
  ["Daily Briefing", "Structured morning briefing delivered to your inbox", "📋", "briefing"],
  ["Context Builder", "Auto-learn your projects, teammates, and tools from connected integrations", "🧠", "context"],
  ["Chief of Staff", "Inbox triage, meeting prep, and daily priorities", "☀️", "chief"],
  ["Developer", "Write, debug, and ship code from a conversation", "🚀", "developer"],
  ["Investment Analyst", "Research companies and draft investment memos", "📈", "analyst"],
  ["Recruiter", "Source candidates and craft personalized outreach", "🎯", "recruiter"],
  ["Sales Prospector", "Find prospects, enrich leads, and draft outreach", "📨", "sales"],
] as const;

type Props = {
  menu: string;
  close: () => void;
  navigate: Navigate;
  mode: string;
  setMode: (mode: string) => void;
  model: string;
  agent: string;
  setAgent: (agent: string) => void;
  agents: string[];
  settings?: ThreadSettings;
  onSettingsChange?: (settings: ThreadSettings) => void;
  savedAgents?: { id: string; name: string }[];
  onAgentSelection?: (id?: string, starter?: string) => void;
  dataOnly?: boolean;
};

/** Local UI state only. Never invokes a model, connector or browser tool. */
export default function ComposerMenus({ menu, close, navigate, mode, setMode, model, agent, setAgent, agents, settings: controlled, onSettingsChange, savedAgents, onAgentSelection, dataOnly = false }: Props) {
  const [sub, setSub] = useState("");
  const [localEffort, setLocalEffort] = useState("Medium");
  const [localProvider, setLocalProvider] = useState("Any");
  const [localTools, setLocalTools] = useState<string[]>(toolNames);
  const [capabilities, setCapabilities] = useState<Capability[] | null>(null);
  const [capabilitiesFailed, setCapabilitiesFailed] = useState(false);
  useEffect(() => { let alive = true; void api<{ capabilities?: Capability[] }>("/api/capabilities").then(result => { if (alive) setCapabilities(result.capabilities || []); }).catch(() => { if (alive) setCapabilitiesFailed(true); }); return () => { alive = false; }; }, []);
  const effort = controlled?.reasoning ?? localEffort;
  const provider = controlled?.provider ?? localProvider;
  const tools = controlled?.tools ?? localTools;
  const capabilityByName = new Map((capabilities || []).map(item => [item.label, item]));
  const canSelectTool = (name: string) => !dataOnly || capabilityByName.get(name)?.executable === true;
  const allToolNames = [...new Set([...toolNames, "World Bank", "Weather", "OpenAlex", ...(capabilities || []).filter(item => item.surfaces?.composer !== false).map(item => item.label)])];
  const setEffort = (value: string) => controlled ? onSettingsChange?.({ ...controlled, reasoning: value }) : setLocalEffort(value);
  const setProvider = (value: string) => controlled ? onSettingsChange?.({ ...controlled, provider: value }) : setLocalProvider(value);
  const setTools = (value: string[]) => controlled ? onSettingsChange?.({ ...controlled, tools: value }) : setLocalTools(value);
  const [agentQuery, setAgentQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const previousMenu = useRef("");
  useEffect(() => {
    setSub("");
    setAgentQuery("");
    if (menu && menu !== previousMenu.current) {
      const first = root.current?.querySelector<HTMLElement>("input")
        || root.current?.querySelector<HTMLElement>('[role^="menuitem"][aria-checked="true"]')
        || root.current?.querySelector<HTMLElement>('[role^="menuitem"]');
      first?.focus();
    }
    previousMenu.current = menu;
  }, [menu]);
  useLayoutEffect(() => {
    const position = () => {
      const el = root.current;
      if (!el) return;
      el.style.transform = "none";
      el.style.maxHeight = `${Math.max(80, innerHeight - 16)}px`;
      const rect = el.getBoundingClientRect();
      const dx = Math.max(8 - rect.left, Math.min(0, innerWidth - 8 - rect.right));
      const dy = Math.max(8 - rect.top, Math.min(0, innerHeight - 8 - rect.bottom));
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      const panel = el.querySelector<HTMLElement>(".composer-submenu");
      if (panel) {
        panel.style.transform = "none";
        panel.style.maxHeight = `${Math.max(80, Math.min(sub === "tools" ? 560 : 400, innerHeight - 16))}px`;
        const bounds = panel.getBoundingClientRect();
        const x = Math.max(8 - bounds.left, Math.min(0, innerWidth - 8 - bounds.right));
        const y = Math.max(8 - bounds.top, Math.min(0, innerHeight - 8 - bounds.bottom));
        panel.style.transform = `translate(${x}px, ${y}px)`;
      }
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [menu, sub, agentQuery]);
  const closeSub = (key = sub) => {
    setSub("");
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-submenu="${key}"]`)?.focus());
  };
  const openSub = (key: string, enter = false) => {
    setSub(key);
    if (enter) requestAnimationFrame(() => {
      const panel = root.current?.querySelector<HTMLElement>(".composer-submenu");
      (panel?.querySelector<HTMLElement>('[role^="menuitem"][aria-checked="true"]:not(:disabled)')
        || panel?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)'))?.focus();
    });
  };
  const closeMenu = () => {
    const label = menu === "model" ? "Model settings" : menu === "mode" ? "Execution mode" : "Use an agent";
    close();
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.focus());
  };
  const go = (path: string) => { close(); navigate(path); };
  const settings = (section: string) => go(location.pathname + "?settings=" + section);
  const keyboard = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (sub) closeSub();
      else closeMenu();
      return;
    }
    if (e.key === "ArrowLeft" && sub) {
      e.preventDefault(); e.stopPropagation();
      closeSub(); return;
    }
    if (e.key === "ArrowRight") {
      const key = (document.activeElement as HTMLElement)?.dataset.submenu;
      if (key) {
        e.preventDefault(); openSub(key, true);
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    if ((e.target as HTMLElement).tagName === "INPUT" && ["Home", "End"].includes(e.key)) return;
    const region = (document.activeElement as HTMLElement)?.closest(".composer-submenu") || root.current;
    const visible = [...(region?.querySelectorAll<HTMLElement>('[role^="menuitem"]') || [])]
      .filter(el => !el.hasAttribute("disabled") && el.getClientRects().length && (region?.classList.contains("composer-submenu") || !el.closest(".composer-submenu")));
    if (!visible.length) return;
    e.preventDefault();
    const current = visible.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? visible.length - 1 : (current + (e.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length;
    visible[next]?.focus();
  };
  const row = (key: string, label: string, value: string, Icon: typeof Brain) => (
    <button type="button" role="menuitem" data-submenu={key} aria-haspopup="menu" aria-expanded={sub === key}
      className={sub === key ? "submenu-open" : ""}
      onMouseEnter={() => setSub(key)} onClick={e => openSub(key, e.detail === 0)}>
      <Icon size={16} /><span>{label}</span><span className="menu-current">{value}</span><ChevronRight size={14} />
    </button>
  );
  if (menu === "model") return (
    <div ref={root} className="popover fidelity-model-menu" role="menu" aria-label="Model settings menu" onKeyDown={keyboard}>
      {row("model", "Model", model, Brain)}
      {row("effort", "Reasoning effort", effort, Gauge)}
      {row("provider", "Provider", provider, GitBranch)}
      {row("tools", "Tools", String(tools.length), Blocks)}
      {row("integrations", "Integrations", "Any", Plug)}
      <div className="menu-separator" />
      <button type="button" role="menuitem" onMouseEnter={() => setSub("")} onClick={() => {
        go(location.pathname + (location.pathname.startsWith("/thread/") ? "?panel=settings" : "?settings=thread-defaults"));
      }}><ArrowUpRight size={16} />Open full settings</button>
      {sub && <div className={"popover composer-submenu" + (sub === "tools" ? " tool-picker" : "")} role="menu" aria-label={sub + " options"}>
        {sub === "model" && dataOnly && <><small className="menu-local-note">DeepSeek · requires a server-side API key</small>{["", ...currentModels].map(value => <button type="button" role="menuitemradio" aria-checked={(controlled?.model || "") === value} key={value} onClick={() => { if (controlled) onSettingsChange?.({ ...controlled, model: value, provider: "DeepSeek" }); closeSub("model"); }}><span>{value || "Default · DeepSeek Flash"}</span>{(controlled?.model || "") === value && <Check size={14} />}</button>)}</>}
        {sub === "model" && !dataOnly && <button type="button" role="menuitem" className="model-unlock" onClick={() => settings("billing")}>
          <span className="unlock-icon"><Sparkles size={18} /></span>
          <span><strong>Unlock every model</strong><small>Subscribe to a plan to pick more powerful models</small></span><ChevronRight size={14} />
        </button>}
        {sub === "effort" && ["Low", "Medium", "High"].map(value => <button type="button" role="menuitemradio" aria-checked={effort === value} key={value} onClick={() => { setEffort(value); closeSub("effort"); }}>
          <span>{value}</span>{effort === value && <Check size={14} />}
        </button>)}
        {sub === "provider" && <>
          <small className="menu-local-note">{dataOnly ? "Only DeepSeek is connected in this build" : "Local preview choices"}</small>
          {(dataOnly ? ["DeepSeek"] : ["Any", "OpenAI", "Anthropic", "Google"]).map(value => <button type="button" role="menuitemradio" aria-checked={provider === value} key={value} onClick={() => { setProvider(value); closeSub("provider"); }}>
            <span>{value}</span>{provider === value && <Check size={14} />}
          </button>)}
        </>}
        {sub === "tools" && <>
          {dataOnly && <p className="tool-picker-note">{capabilitiesFailed ? "Availability could not be checked; unavailable tools cannot be enabled." : capabilities ? "Only configured tools can be enabled. Selection alone does not grant approval." : "Checking tool availability…"}</p>}
          {toolGroups.map(group => {
            const names = group.names.filter(name => allToolNames.includes(name));
            if (!names.length) return null;
            return <section className="tool-picker-group" role="group" aria-label={group.label} key={group.label}>
              <div className="tool-picker-heading">{group.label}</div><div className="tool-picker-chips">{names.map(name => {
                const Icon = toolIcons[name] || Blocks, selected = tools.includes(name), available = canSelectTool(name);
                const reason = capabilityByName.get(name)?.reason || (capabilitiesFailed ? "Could not check availability" : capabilities ? "Not configured or not implemented" : "Checking availability");
                return <button type="button" role="menuitemcheckbox" aria-checked={selected} aria-label={name} key={name}
                  className={"tool-chip tool-chip-" + group.label.toLowerCase() + (selected && available ? " selected" : "") + (!available ? " unavailable" : "")}
                  disabled={!available && !selected} title={!available ? reason + (selected ? "; select to remove" : "") : selected ? "Selected" : "Not selected"}
                  onClick={() => setTools(selected ? tools.filter(t => t !== name) : [...tools, name])}>
                  <Icon size={13} aria-hidden="true" /><span>{name}</span>
                </button>;
              })}</div>
            </section>;
          })}
          {allToolNames.filter(name => !toolGroups.some(group => (group.names as readonly string[]).includes(name))).length > 0 && <section className="tool-picker-group" role="group" aria-label="Other tools"><div className="tool-picker-heading">Other tools</div><div className="tool-picker-chips">{allToolNames.filter(name => !toolGroups.some(group => (group.names as readonly string[]).includes(name))).map(name => {
            const selected = tools.includes(name), available = canSelectTool(name);
            return <button type="button" role="menuitemcheckbox" aria-checked={selected} aria-label={name} className={"tool-chip tool-chip-workspace" + (selected && available ? " selected" : "") + (!available ? " unavailable" : "")} disabled={!available && !selected} title={!available ? "Not configured or not implemented" : selected ? "Selected" : "Not selected"} key={name} onClick={() => setTools(selected ? tools.filter(t => t !== name) : [...tools, name])}><Blocks size={13} aria-hidden="true"/><span>{name}</span></button>;
          })}</div></section>}
          {dataOnly && <p className="tool-picker-note tool-picker-footnote">Dashed, faded tools are unavailable on this server. Hover for details.</p>}
        </>}
        {sub === "integrations" && <>
          <button type="button" role="menuitem" onClick={() => settings("integrations")}><Plug size={16} />Manage integrations<ArrowUpRight size={14} /></button>
          <small className="menu-local-note">Manage server API credentials and test actual account access. Writes require explicit confirmation.</small>
        </>}
      </div>}
    </div>
  );
  if (menu === "mode") return (
    <div ref={root} className="popover fidelity-mode-menu" role="menu" aria-label="Execution mode menu" onKeyDown={keyboard}>
      <button type="button" role="menuitemradio" aria-checked={mode === "Plan first"} onMouseEnter={() => setSub("")} onClick={() => { setMode("Plan first"); closeMenu(); }}>
        <span className="mode-check">{mode === "Plan first" && <Check size={15} />}</span>
        <span><strong>Plan first</strong><small>Think through an approach and get user clarification before taking action</small></span>
      </button>
      <div className="execute-menu-row">
        <button type="button" role="menuitemradio" aria-checked={mode === "Execute"} onClick={() => { setMode("Execute"); closeMenu(); }}>
          <span className="mode-check">{mode === "Execute" && <Check size={15} />}</span>
          <span><strong>Execute</strong><small>Act immediately without a plan</small></span>
        </button>
        <button type="button" className="execution-policy" role="menuitem" data-submenu="policy" aria-label="Execution policy: Auto" aria-haspopup="menu" aria-expanded={sub === "policy"} onMouseEnter={() => setSub("policy")} onClick={e => openSub("policy", e.detail === 0)}>Auto<ChevronRight size={14} /></button>
      </div>
      {sub === "policy" && <div className="popover composer-submenu" role="menu" aria-label="Execution policy options">
        <button type="button" role="menuitemradio" aria-checked="true" onClick={() => closeSub("policy")}><Zap size={15} />Auto<Check size={14} /></button>
        <small className="menu-local-note">Text generation only. No browser or external action is performed.</small>
      </div>}
    </div>
  );
  if (menu === "agents") {
    const query = agentQuery.trim().toLowerCase();
    const starters = starterAgents.filter(([name, description]) => (name + " " + description).toLowerCase().includes(query));
    const saved = (savedAgents || agents.map(name => ({ id: "", name }))).filter(item => item.name.toLowerCase().includes(query));
    const choose = (name: string, id?: string, starter = false) => { setAgent(name); onAgentSelection?.(id || undefined, starter ? name : undefined); closeMenu(); };
    return <div ref={root} className="popover fidelity-agent-menu" role="menu" aria-label="Agent picker" onKeyDown={keyboard}>
      <label className="agent-picker-search"><Search size={16} /><input aria-label="Search agents" placeholder="Search agents..." value={agentQuery} onChange={e => setAgentQuery(e.target.value)} /></label>
      <div className="agent-picker-list">
        {saved.length > 0 && <><small className="agent-picker-heading">YOUR AGENTS</small>{saved.map(item => <button type="button" role="menuitem" key={item.id || item.name} onClick={() => choose(item.name, item.id)}><span className="starter-avatar saved"><Bot size={16} /></span><span className="agent-picker-copy"><strong>{item.name}</strong><small>Saved in this workspace</small></span>{agent === item.name && <Check size={14} />}</button>)}</>}
        {starters.length > 0 && <small className="agent-picker-heading">STARTER AGENTS</small>}
        {starters.map(([name, description, emoji, color]) => <button type="button" role="menuitem" key={name} onClick={() => choose(name, undefined, true)}>
          <span className={"starter-avatar " + color} aria-hidden="true">{emoji}</span><span className="agent-picker-copy"><strong>{name}</strong><small>{description}</small></span>{agent === name && <Check size={14} />}
        </button>)}
        {!starters.length && !saved.length && <p className="agent-picker-empty" role="status">No agents found</p>}
      </div>
      <div className="menu-separator" />
      <button type="button" role="menuitem" onClick={() => go("/agents/new")}><PencilLine size={16} />Create from scratch</button>
    </div>;
  }
  return null;
}
