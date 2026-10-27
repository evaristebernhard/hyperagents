import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Brain, Gauge, GitBranch, Blocks, Plug, ArrowUpRight, ChevronRight,
  Check, Search, PencilLine, Sparkles, Bot, Zap,
} from "lucide-react";
import type { Navigate } from "./types";

const toolNames = [
  "Search", "Find Similar", "Exa Research", "Exa Websets", "Thread Search",
  "Browser", "Webpages", "Slides", "Tables", "Documents", "Images", "Video",
  "Audio", "Transcribe", "Avatar", "Maps",
];
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
};

/** Local UI state only. Never invokes a model, connector or browser tool. */
export default function ComposerMenus({ menu, close, navigate, mode, setMode, model, agent, setAgent, agents }: Props) {
  const [sub, setSub] = useState("");
  const [effort, setEffort] = useState("Medium");
  const [provider, setProvider] = useState("Any");
  const [tools, setTools] = useState<string[]>(toolNames);
  const [agentQuery, setAgentQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const previousMenu = useRef("");
  useEffect(() => {
    setSub("");
    setAgentQuery("");
    if (menu && menu !== previousMenu.current) {
      root.current?.querySelector<HTMLElement>("input, [role=menuitem]")?.focus();
    }
    previousMenu.current = menu;
  }, [menu]);
  const go = (path: string) => { close(); navigate(path); };
  const settings = (section: string) => go(location.pathname + "?settings=" + section);
  const keyboard = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (sub) {
        root.current?.querySelector<HTMLElement>(`[data-submenu="${sub}"]`)?.focus();
        setSub("");
      } else {
        close();
        const label = menu === "model" ? "Model settings" : menu === "mode" ? "Execution mode" : "Use an agent";
        document.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.focus();
      }
      return;
    }
    if (e.key === "ArrowLeft" && sub) {
      e.preventDefault(); e.stopPropagation();
      root.current?.querySelector<HTMLElement>(`[data-submenu="${sub}"]`)?.focus();
      setSub(""); return;
    }
    if (e.key === "ArrowRight") {
      const key = (document.activeElement as HTMLElement)?.dataset.submenu;
      if (key) {
        e.preventDefault(); setSub(key);
        requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".composer-submenu [role^=menuitem]")?.focus());
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    if ((e.target as HTMLElement).tagName === "INPUT" && ["Home", "End"].includes(e.key)) return;
    const region = (document.activeElement as HTMLElement)?.closest(".composer-submenu") || root.current;
    const visible = [...(region?.querySelectorAll<HTMLElement>('[role^="menuitem"]') || [])]
      .filter(el => el.getClientRects().length && (region?.classList.contains("composer-submenu") || !el.closest(".composer-submenu")));
    if (!visible.length) return;
    e.preventDefault();
    const current = visible.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? visible.length - 1 : (current + (e.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length;
    visible[next]?.focus();
  };
  const row = (key: string, label: string, value: string, Icon: typeof Brain) => (
    <button type="button" role="menuitem" data-submenu={key} aria-haspopup="menu" aria-expanded={sub === key}
      className={sub === key ? "submenu-open" : ""}
      onMouseEnter={() => setSub(key)} onClick={() => setSub(key)}>
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
      {sub && <div className="popover composer-submenu" role="menu" aria-label={sub + " options"}>
        {sub === "model" && <button type="button" role="menuitem" className="model-unlock" onClick={() => settings("billing")}>
          <span className="unlock-icon"><Sparkles size={18} /></span>
          <span><strong>Unlock every model</strong><small>Subscribe to a plan to pick more powerful models</small></span><ChevronRight size={14} />
        </button>}
        {sub === "effort" && ["Low", "Medium", "High"].map(value => <button type="button" role="menuitemradio" aria-checked={effort === value} key={value} onClick={() => { setEffort(value); setSub(""); }}>
          <span>{value}</span>{effort === value && <Check size={14} />}
        </button>)}
        {sub === "provider" && <>
          <small className="menu-local-note">Local preview choices</small>
          {["Any", "OpenAI", "Anthropic", "Google"].map(value => <button type="button" role="menuitemradio" aria-checked={provider === value} key={value} onClick={() => { setProvider(value); setSub(""); }}>
            <span>{value}</span>{provider === value && <Check size={14} />}
          </button>)}
        </>}
        {sub === "tools" && <>
          <small className="menu-local-note">Local preview · no tools execute</small>
          {toolNames.map(value => <button type="button" role="menuitemcheckbox" aria-checked={tools.includes(value)} key={value} onClick={() => setTools(tools.includes(value) ? tools.filter(t => t !== value) : [...tools, value])}>
            <span>{value}</span>{tools.includes(value) && <Check size={14} />}
          </button>)}
        </>}
        {sub === "integrations" && <>
          <button type="button" role="menuitem" onClick={() => settings("integrations")}><Plug size={16} />Manage integrations<ArrowUpRight size={14} /></button>
          <small className="menu-local-note">Connection settings only. No OAuth is started.</small>
        </>}
      </div>}
    </div>
  );
  if (menu === "mode") return (
    <div ref={root} className="popover fidelity-mode-menu" role="menu" aria-label="Execution mode menu" onKeyDown={keyboard}>
      <button type="button" role="menuitemradio" aria-checked={mode === "Plan first"} onMouseEnter={() => setSub("")} onClick={() => { setMode("Plan first"); close(); }}>
        <span className="mode-check">{mode === "Plan first" && <Check size={15} />}</span>
        <span><strong>Plan first</strong><small>Think through an approach and get user clarification before taking action</small></span>
      </button>
      <div className="execute-menu-row">
        <button type="button" role="menuitemradio" aria-checked={mode === "Execute"} onClick={() => { setMode("Execute"); close(); }}>
          <span className="mode-check">{mode === "Execute" && <Check size={15} />}</span>
          <span><strong>Execute</strong><small>Act immediately without a plan</small></span>
        </button>
        <button type="button" className="execution-policy" role="menuitem" data-submenu="policy" aria-label="Execution policy: Auto" aria-haspopup="menu" aria-expanded={sub === "policy"} onMouseEnter={() => setSub("policy")} onClick={() => setSub("policy")}>Auto<ChevronRight size={14} /></button>
      </div>
      {sub === "policy" && <div className="popover composer-submenu" role="menu" aria-label="Execution policy options">
        <button type="button" role="menuitemradio" aria-checked="true" onClick={() => setSub("")}><Zap size={15} />Auto<Check size={14} /></button>
        <small className="menu-local-note">Only the observed Auto state is shown. Execution is not connected.</small>
      </div>}
    </div>
  );
  if (menu === "agents") {
    const query = agentQuery.trim().toLowerCase();
    const starters = starterAgents.filter(([name, description]) => (name + " " + description).toLowerCase().includes(query));
    const saved = agents.filter(name => name.toLowerCase().includes(query));
    const choose = (name: string) => { setAgent(name); close(); };
    return <div ref={root} className="popover fidelity-agent-menu" role="menu" aria-label="Agent picker" onKeyDown={keyboard}>
      <label className="agent-picker-search"><Search size={16} /><input aria-label="Search agents" placeholder="Search agents..." value={agentQuery} onChange={e => setAgentQuery(e.target.value)} /></label>
      <div className="agent-picker-list">
        {saved.length > 0 && <><small className="agent-picker-heading">YOUR AGENTS</small>{saved.map(name => <button type="button" role="menuitem" key={name} onClick={() => choose(name)}><span className="starter-avatar saved"><Bot size={16} /></span><span className="agent-picker-copy"><strong>{name}</strong><small>Saved in this local workspace</small></span>{agent === name && <Check size={14} />}</button>)}</>}
        {starters.length > 0 && <small className="agent-picker-heading">STARTER AGENTS</small>}
        {starters.map(([name, description, emoji, color]) => <button type="button" role="menuitem" key={name} onClick={() => choose(name)}>
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
