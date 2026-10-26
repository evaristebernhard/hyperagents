import { useEffect, useState, type ReactNode } from 'react';
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, BookMarked, Brain, BriefcaseBusiness,
  CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleDot, Clock3, Compass,
  FileText, Folder, Globe, GraduationCap, Grid2X2, Headphones, Image as ImageIcon, Inbox,
  LayoutDashboard, Library, Link2, ListChecks, LockKeyhole, MessageSquare, Mic,
  MoreHorizontal, MousePointer2, PanelLeftClose, Plus, Puzzle, RotateCw, Search, Send,
  Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Square, Star, Table2, UploadCloud,
  WandSparkles, X, Zap, File, Bot,
} from 'lucide-react';

type View = 'home' | 'thread' | 'sessions' | 'agent';
type Panel = 'browser' | 'files';
type Message = { role: 'user' | 'assistant'; text: string };

const recentThreads = [
  { title: 'Small Biz Website Builder', icon: '✳', color: 'violet' },
  { title: 'Initial Conversation Greeting', icon: '✦', color: 'blue' },
  { title: 'Welcome to Hyperagent', icon: '◈', color: 'green' },
  { title: 'Velocity Theorem Explanation', icon: '∑', color: 'amber' },
];
const capabilities = [
  { title: 'Out-of-home campaign', text: 'Research billboard locations, develop creative strategy, and evaluate a campaign in real-world settings.', palette: 'sand' },
  { title: 'Podcast launch', text: 'Plan studio layouts, generate promo clips, and build the first media rollout.', palette: 'rose' },
  { title: 'Real estate listing kit', text: 'Generate a property listing kit with a video, editorial website, and branded assets.', palette: 'sage' },
  { title: 'Apparel launch', text: 'Research audiences and influencer strategy, then plan production, inventory, and distribution.', palette: 'clay' },
  { title: 'Product merchandising', text: 'Turn raw product photos into a beautiful marketing package.', palette: 'stone' },
  { title: 'Personalized prospect outreach', text: 'Find prospects with the right signals, draft outreach emails, and build a pitch deck.', palette: 'dark' },
  { title: 'Hiring command center', text: 'Source and rank candidates in a dashboard with skill filters.', palette: 'teal' },
  { title: 'Cinematic real estate video', text: 'Turn any listing into a stunning marketing package.', palette: 'gold' },
  { title: 'Startup investment research', text: 'Compare AI infrastructure startups, build a research deck, and draft an investor brief.', palette: 'blue' },
];

function BrandMark() { return <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>; }
function Brand() { return <div className="brand"><BrandMark /><span>Hyperagent</span></div>; }
function IconButton({ children, label, onClick, className = '' }: { children: ReactNode; label: string; onClick?: () => void; className?: string }) {
  return <button type="button" className={'icon-button ' + className} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

function Sidebar({ view, selectedThread, onNavigate, onSelectThread, onSearch }: {
  view: View; selectedThread: string; onNavigate: (view: View) => void;
  onSelectThread: (title: string) => void; onSearch: () => void;
}) {
  const mainItems = [
    { label: 'New thread', icon: MessageSquare, action: () => onNavigate('home'), active: view === 'home' },
    { label: 'Search', icon: Search, action: onSearch, active: false },
    { label: 'Inbox', icon: Inbox, action: () => onNavigate('thread'), active: false },
  ];
  const resources = [
    { label: 'Skills', icon: Puzzle }, { label: 'Memories', icon: Brain },
    { label: 'Learning', icon: GraduationCap }, { label: 'New project', icon: BriefcaseBusiness },
    { label: 'Library', icon: Library }, { label: 'Marketplace', icon: Compass },
  ];
  return <aside className="sidebar">
    <div className="sidebar-brand-row"><Brand /><IconButton label="Collapse sidebar"><PanelLeftClose size={15} /></IconButton></div>
    <button className="workspace-select" type="button"><span className="workspace-avatar">P</span><span>Personal</span><ChevronDown size={14} /></button>
    <nav className="sidebar-nav">
      {mainItems.map((item) => { const Icon = item.icon; return <button type="button" key={item.label} className={'nav-row ' + (item.active ? 'active' : '')} onClick={item.action}><Icon size={16} strokeWidth={1.8} /><span>{item.label}</span></button>; })}
      <div className="nav-section"><div className="nav-section-label">Agents <ChevronDown size={12} /></div>
        <button type="button" className={'nav-row ' + (view === 'agent' ? 'active' : '')} onClick={() => onNavigate('agent')}><Plus size={16} /><span>New agent</span></button>
        <button type="button" className="nav-row" onClick={() => onNavigate('agent')}><ArrowUpRight size={16} /><span>View roster</span></button>
      </div>
      <div className="nav-section"><div className="nav-section-label">Recent threads <ChevronDown size={12} /></div>
        {recentThreads.map((thread) => <button type="button" key={thread.title} className={'nav-row thread-row ' + (selectedThread === thread.title ? 'active' : '')} onClick={() => onSelectThread(thread.title)}>
          <span className={'thread-glyph ' + thread.color}>{thread.icon}</span><span>{thread.title}</span>{selectedThread === thread.title && <Folder size={12} className="row-end-icon" />}
        </button>)}
        <button type="button" className="nav-row muted-row" onClick={() => onNavigate('thread')}><ArrowUpRight size={15} /><span>View all</span></button>
      </div>
      <div className="nav-section"><div className="nav-section-label">Recent rooms <ChevronDown size={12} /></div><button type="button" className="nav-row" onClick={() => onNavigate('thread')}><Plus size={16} /><span>New room</span></button></div>
      <div className="nav-section resources"><div className="nav-section-label">Resources</div>
        {resources.map((item) => { const Icon = item.icon; return <button type="button" className="nav-row" key={item.label} onClick={() => item.label === 'New project' && onNavigate('thread')}><Icon size={16} strokeWidth={1.7} /><span>{item.label}</span>{item.label === 'Learning' && <ChevronRight size={13} className="row-end-icon" />}</button>; })}
      </div>
    </nav>
    <button type="button" className="account-row"><span className="account-avatar">B</span><span className="account-copy"><strong>Bernhard</strong><small>chaoyucogito@inbox.lv</small></span><ChevronDown size={14} /></button>
  </aside>;
}

function HomePage({ onStart, onOpenAgent, onOpenThread }: { onStart: (prompt: string) => void; onOpenAgent: () => void; onOpenThread: (title: string) => void }) {
  const [draft, setDraft] = useState('');
  return <main className="home-page"><div className="home-content">
    <div className="home-hero"><p className="eyebrow"><Sparkles size={13} /> YOUR WORKSPACE, READY</p><h1>Let's get to work.</h1><p className="hero-subtitle">What would you like to make progress on today?</p>
      <div className="task-composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask anything or start a task..." rows={2} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onStart(draft.trim() || 'Help me plan my next project.'); } }} />
        <div className="composer-tools"><div className="composer-left-tools"><IconButton label="Add attachment"><Plus size={17} /></IconButton><button type="button" className="tool-select"><SlidersHorizontal size={13} /> Opus 5 <ChevronDown size={12} /></button><button type="button" className="tool-select"><Bot size={13} /> Agent <ChevronDown size={12} /></button></div>
          <div className="composer-right-tools"><button type="button" className="execute-button"><Zap size={14} /> Execute <ChevronDown size={12} /></button><IconButton label="Voice input"><Mic size={16} /></IconButton><button type="button" className="send-button" aria-label="Start task" onClick={() => onStart(draft.trim() || 'Help me plan my next project.')}><ArrowUpRight size={18} /></button></div></div>
        <div className="integrations-line"><span className="integration-dot">✦</span><span className="integration-dot green-dot">M</span><span className="integration-dot blue-dot">G</span><span>Connect your integrations</span><ChevronRight size={12} /></div>
      </div><button type="button" className="setup-agent-button" onClick={onOpenAgent}><WandSparkles size={14} /> Set up your agent</button>
    </div>
    <section className="recent-section"><div className="section-heading"><div><h2>Recent threads</h2><p>Pick up where you left off</p></div><div className="heading-actions"><IconButton label="List view"><ListChecks size={15} /></IconButton><IconButton label="Grid view"><Grid2X2 size={15} /></IconButton><button type="button" className="text-button" onClick={() => onOpenThread('Small Biz Website Builder')}>Show all <ArrowUpRight size={13} /></button></div></div>
      <div className="recent-thread-list">
        <button type="button" className="recent-thread-card" onClick={() => onOpenThread('Nads.fun Trading Strategy Analysis')}><span className="recent-icon violet"><Activity size={17} /></span><span className="recent-thread-copy"><strong>Nads.fun Trading Strategy Analysis</strong><small>Verified market data surfaces, API rate limits, contract events, and a practical trading strategy research plan.</small><em>just now · 3 tool calls</em></span><span className="mini-preview market-preview"><i /><i /><i /><i /></span><ChevronRight size={15} className="recent-chevron" /></button>
        <button type="button" className="recent-thread-card" onClick={() => onOpenThread('Introduction to NSAID Patches')}><span className="recent-icon blue"><FileText size={17} /></span><span className="recent-thread-copy"><strong>Introduction to NSAID Patches</strong><small>Exploring topical patch options and summarizing the available research.</small><em>last month</em></span><span className="mini-preview code-preview"><i /><i /><i /><i /><i /></span><ChevronRight size={15} className="recent-chevron" /></button>
        <button type="button" className="recent-thread-card" onClick={() => onOpenThread('Medicated Plasters for Back Sprains')}><span className="recent-icon green"><BookMarked size={17} /></span><span className="recent-thread-copy"><strong>Medicated Plasters for Back Sprains</strong><small>Compare product options and summarize safe usage guidance, pricing, and recovery considerations.</small><em>last month</em></span><span className="mini-preview blank-preview" /><ChevronRight size={15} className="recent-chevron" /></button>
      </div>
    </section>
    <section className="capability-section"><div className="capability-heading"><h2>See what Hyperagent is capable of building</h2><p>Start with a template and make it your own.</p></div><div className="capability-grid">
      {capabilities.map((item, index) => <button type="button" key={item.title} className="capability-card" onClick={() => onStart('Help me create: ' + item.title + '. ' + item.text)}>
        <div className={'capability-art ' + item.palette}><div className="art-column"><b>CAMPAIGN</b><span>STRATEGY</span><i /></div><div className="art-middle"><b>CREATIVE</b><span>STORY / WEB</span></div><div className="art-column"><b>ASSETS</b><span>BRAND KIT</span><i /></div></div>
        <div className="capability-copy"><strong>{item.title}</strong><p>{item.text}</p><div className="tag-row"><span>Example</span><span>Preview</span></div></div><span className="card-index">{String(index + 1).padStart(2, '0')}</span>
      </button>)}
    </div></section><footer className="home-footer">Thoughtful work, from first question to finished result.</footer>
  </div></main>;
}

function ThreadComposer({ onSend }: { onSend: (text: string) => void }) {
  const [draft, setDraft] = useState('');
  const send = () => { if (draft.trim()) { onSend(draft.trim()); setDraft(''); } };
  return <div className="thread-composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Add a follow-up..." rows={2} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} />
    <div className="thread-composer-tools"><div className="composer-left-tools"><IconButton label="Add attachment"><Plus size={17} /></IconButton><IconButton label="Add tools"><SlidersHorizontal size={16} /></IconButton></div><div className="composer-right-tools"><IconButton label="Execute"><Zap size={16} /></IconButton><IconButton label="Stop"><Square size={13} /></IconButton><button type="button" className="send-button" onClick={send} aria-label="Send follow-up"><ArrowUpRight size={18} /></button></div></div>
    <div className="integrations-line"><span className="integration-dot">✦</span><span className="integration-dot green-dot">M</span><span className="integration-dot blue-dot">G</span><span>Connect your integrations</span></div>
  </div>;
}

function ThreadConversation({ title, initialPrompt, onConsumePrompt, onNotify }: { title: string; initialPrompt: string; onConsumePrompt: () => void; onNotify: (message: string) => void }) {
  const [messages, setMessages] = useState<Message[]>([{ role: 'assistant', text: 'I’ve organized the work into a few clear steps. You can inspect the browser, files, and agent activity alongside this conversation.' }]);
  useEffect(() => { if (initialPrompt) { setMessages((current) => [...current, { role: 'user', text: initialPrompt }]); onConsumePrompt(); } }, [initialPrompt, onConsumePrompt]);
  const send = (text: string) => { setMessages((current) => [...current, { role: 'user', text }, { role: 'assistant', text: 'This is a static UI preview. The conversation and workspace are interactive, but no LLM or browser runtime is connected yet.' }]); onNotify('Demo mode · no agent runtime connected'); };
  return <section className="conversation-panel"><header className="thread-header"><div className="thread-title-wrap"><span className="project-folder"><Folder size={13} /></span><span className="thread-title">{title}</span><ChevronDown size={13} /><button type="button" className="star-button" aria-label="Star thread"><Star size={17} /></button></div><div className="thread-meta"><span className="live-dot" /> Live <button type="button" className="model-button">◉ Choose your model <ChevronDown size={12} /></button><IconButton label="Thread settings"><Settings2 size={16} /></IconButton></div></header>
    <div className="conversation-scroll"><div className="reasoning-row"><Clock3 size={13} /><span>Reasoned for 1s</span><ChevronRight size={12} /></div>
      <div className="status-stack">
        <div className="status-card"><span className="status-icon"><ListChecks size={14} /></span><div><strong>Working notes</strong><small>What the agent keeps for this thread: its plan, the numbers, and decisions.</small></div><ChevronRight size={13} /></div>
        <div className="status-card compact"><span className="status-icon loading"><RotateCw size={13} /></span><div><strong>Loading · {title}</strong><small>Preparing the workspace for this task</small></div><span className="status-pill">Preview</span></div>
        <div className="status-card"><span className="status-icon purple"><Sparkles size={14} /></span><div><strong>{title}</strong><small>End-to-end task workspace with browser, documents, and agent activity.</small></div><MoreHorizontal size={15} /></div>
      </div>
      <div className="activity-pills"><span><CircleDot size={11} /> Searching places</span><span>4 tool calls</span><span>·</span><span>3 agents dispatched</span></div>
      <div className="agent-activity"><div className="agent-row"><span className="agent-avatar plum">C</span><strong>Crumb</strong><span>Website Scout</span><em>Responding</em><MoreHorizontal size={14} /></div><div className="agent-row"><span className="agent-avatar pink">R</span><strong>Ratchet</strong><span>Website Scout</span><em>Viewing image</em><MoreHorizontal size={14} /></div><div className="agent-row"><span className="agent-avatar aqua">T</span><strong>Thimble</strong><span>Website Scout</span><em>Viewing page</em><MoreHorizontal size={14} /></div></div>
      <div className="assistant-copy"><div className="reasoning-row"><Clock3 size={13} /><span>Reasoning…</span><ChevronDown size={12} /></div><p>Agents coordinate their research and keep useful findings in view. The live browser area is ready for a session to be opened.</p></div>
      {messages.map((message, index) => <div key={index} className={'chat-message ' + message.role}>{message.role === 'assistant' && <span className="assistant-avatar"><BrandMark /></span>}<div className="message-body">{message.text}</div></div>)}
    </div><ThreadComposer onSend={send} />
  </section>;
}

function BrowserFrame({ onShowSessions, onNotify }: { onShowSessions: () => void; onNotify: (message: string) => void }) {
  const [address, setAddress] = useState('');
  const [submittedAddress, setSubmittedAddress] = useState('');
  return <div className="browser-frame"><div className="browser-mode-pill"><Globe size={12} /> Browser <ChevronDown size={11} /><span className="live-dot" /></div>
    <div className="browser-chrome"><div className="browser-controls"><IconButton label="Back"><ChevronLeft size={14} /></IconButton><IconButton label="Forward"><ChevronRight size={14} /></IconButton><IconButton label="Refresh" onClick={() => onNotify('Browser preview refreshed')}><RotateCw size={13} /></IconButton></div>
      <form className="address-bar" onSubmit={(event) => { event.preventDefault(); setSubmittedAddress(address); onNotify('Browser preview only · navigation is not connected'); }}><input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Go to a site..." aria-label="Browser address" /><button type="submit" aria-label="Go to site"><ArrowUpRight size={13} /></button></form>
      <button type="button" className="signed-in-button" onClick={() => onNotify('Signed-in sites are not connected in this preview')}><LockKeyhole size={12} /> Signed-in sites <ChevronDown size={11} /></button><IconButton label="Open in new window" onClick={onShowSessions}><ArrowUpRight size={14} /></IconButton>
    </div><div className="browser-viewport"><div className="browser-empty-icon"><MousePointer2 size={16} /></div><strong>{submittedAddress ? 'Ready to open this page' : 'No browser session yet'}</strong><p>{submittedAddress ? 'A real browser runtime will render ' + submittedAddress + ' when connected.' : 'The live view appears when the agent browses — or go to a site yourself in the address bar above.'}</p><button type="button" className="outline-button" onClick={onShowSessions}><Grid2X2 size={14} /> View browser sessions</button></div>
    <div className="browser-switcher"><button type="button" className="switcher-tile active"><Grid2X2 size={16} /><span>Workspace</span></button><button type="button" className="switcher-tile" onClick={onShowSessions}><Globe size={16} /><span>Sessions</span></button><button type="button" className="switcher-tile" onClick={() => onNotify('Browser controls are a visual prototype')}><Square size={13} /><span>Controls</span></button></div>
  </div>;
}

function MiniBrowser({ variant, name, url, onClick }: { variant: 'ratchet' | 'thimble' | 'crumb'; name: string; url: string; onClick?: () => void }) {
  return <button type="button" className={'mini-browser ' + variant} onClick={onClick}><div className="mini-browser-top"><span className={'mini-browser-avatar ' + variant}>{variant === 'ratchet' ? '✣' : variant === 'thimble' ? '✦' : '✚'}</span><strong>{name}</strong><span className="mini-browser-open"><ArrowUpRight size={12} /></span><div className="mini-browser-controls"><ChevronLeft size={12} /><ChevronRight size={12} /><RotateCw size={11} /><span>{url}</span><Globe size={11} /></div></div>
    {variant === 'ratchet' && <div className="mock-site ratchet-site"><div className="mock-site-nav"><b>DOORSTEP AUTO CARE</b><span>Home　 About　 Services　 Booking</span><em>Call Now</em></div><div className="ratchet-hero"><small>DOORSTEP AUTO CARE · MOBILE MECHANIC</small><h3>Mobile mechanic in your neighbourhood.</h3><p>Reliable car repair at your doorstep.</p><span>Call Now</span><span>Book Appointment</span></div><div className="ratchet-ribbon">Same-Day Mobile Mechanic Available — No Towing Needed!</div><div className="mock-site-footer"><b>Meet Your Mechanic</b><p>Diagnostics, maintenance and reliable repairs.</p></div></div>}
    {variant === 'thimble' && <div className="mock-site thimble-site"><div className="mock-site-nav"><b>FOREVER YOUNG</b><span>HOME　 SERVICES　 GALLERY</span><em>Call Us</em></div><div className="thimble-hero"><div className="photo-shape"><span>✦</span><span>✦</span><span>🐾</span></div><h3>We're your stress-free dog grooming solution!</h3><span className="fake-cta">Let's Get Started</span></div><div className="mock-site-footer"><b>Why choose our service</b><p>Professional care for every pet.</p></div></div>}
    {variant === 'crumb' && <div className="mock-site crumb-site"><div className="crumb-photo"><span>CAFÉ</span><b>Good food, good company.</b></div><div className="mock-login"><span className="social-mark">f</span><b>Log into Facebook</b><i>Email or mobile number</i><i>Password</i><em>Log In</em><small>Forgot password?</small><hr /><em className="create-account">Create new account</em></div></div>}
  </button>;
}

function SessionsWorkspace({ onNotify }: { onNotify: (message: string) => void }) {
  return <div className="sessions-workspace"><div className="sessions-heading"><div className="sessions-title"><span className="live-dot" /><h2>Browser Sessions <span>(3)</span></h2></div><button type="button" className="browser-select" onClick={() => onNotify('Browser mode is a static prototype')}><Globe size={13} /> Browser <span className="live-dot" /></button></div>
    <div className="sessions-grid"><MiniBrowser variant="ratchet" name="Ratchet" url="doorstep-auto-c..." onClick={() => onNotify('Ratchet session selected')} /><MiniBrowser variant="thimble" name="Thimble" url="foreveryounggro..." onClick={() => onNotify('Thimble session selected')} /><MiniBrowser variant="crumb" name="Crumb" url="www.facebook.co..." onClick={() => onNotify('Crumb session selected')} /></div>
  </div>;
}

function DocumentSection({ title, value, onChange }: { title: string; value: string; onChange: (value: string) => void }) {
  return <section className="document-section"><h3>{title}</h3><textarea value={value} onChange={(event) => onChange(event.target.value)} rows={2} aria-label={title} /></section>;
}
function ProjectDocument({ onNotify }: { onNotify: (message: string) => void }) {
  const [title, setTitle] = useState('hello');
  const [goals, setGoals] = useState('Define your project goals here.');
  const [facts, setFacts] = useState('Record important facts that agents should remember.');
  const [findings, setFindings] = useState('Accumulated research and discoveries.');
  const [decisions, setDecisions] = useState('Important decisions made during this project.');
  const [tasks, setTasks] = useState('Track the next steps for this project.');
  return <div className="document-workspace"><div className="document-topline"><span className="document-file-icon"><FileText size={14} /></span><span>{title || 'Untitled document'}</span><ChevronRight size={12} /><span className="muted">Project-wide</span><div className="document-actions"><IconButton label="Download" onClick={() => onNotify('Document export is not connected')}><ArrowDownToLine size={14} /></IconButton><IconButton label="Document options"><MoreHorizontal size={15} /></IconButton></div></div>
    <div className="document-canvas"><div className="document-sheet"><div className="document-heading"><span className="document-emoji">📋</span><input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Document title" /><span className="document-badge">PROJECT</span></div><p className="document-subtitle">Project document for {title || 'your project'}</p>
      <DocumentSection title="Goals" value={goals} onChange={setGoals} /><DocumentSection title="Critical Facts" value={facts} onChange={setFacts} /><DocumentSection title="Research & Findings" value={findings} onChange={setFindings} /><DocumentSection title="Decisions" value={decisions} onChange={setDecisions} /><DocumentSection title="Tasks" value={tasks} onChange={setTasks} /><div className="document-save-note"><CheckCircle2 size={13} /> Changes stay in this local preview.</div>
    </div></div></div>;
}

function WorkspacePanel({ view, panel, onPanelChange, onShowSessions, onShowBrowser, onNotify }: { view: View; panel: Panel; onPanelChange: (panel: Panel) => void; onShowSessions: () => void; onShowBrowser: () => void; onNotify: (message: string) => void }) {
  return <section className="workspace-panel"><div className="workspace-toolbar"><div className="workspace-filter-pills"><button type="button" className="filter-pill active">All <span>5</span></button><button type="button" className="filter-pill" onClick={() => onNotify('Image filter selected')}><ImageIcon size={12} /> Images <span>4</span></button><button type="button" className="filter-pill" onClick={() => onPanelChange('files')}><FileText size={12} /> Documents <span>1</span></button></div>
    <div className="workspace-view-tools"><IconButton label="Split view"><PanelLeftClose size={14} /></IconButton><IconButton label="Grid view"><Grid2X2 size={14} /></IconButton><IconButton label="Workspace settings"><Settings2 size={14} /></IconButton></div>
    <div className="workspace-mode-toggle"><button type="button" className={panel === 'browser' ? 'selected' : ''} onClick={() => { onPanelChange('browser'); if (view === 'sessions') onShowBrowser(); }}><Globe size={12} /> Browser <span className="live-dot" /></button><button type="button" className={panel === 'files' ? 'selected' : ''} onClick={() => onPanelChange('files')}><FileText size={12} /> Files</button></div><IconButton label="Open workspace"><ArrowUpRight size={14} /></IconButton>
  </div>{view === 'sessions' ? <SessionsWorkspace onNotify={onNotify} /> : panel === 'files' ? <ProjectDocument onNotify={onNotify} /> : <BrowserFrame onShowSessions={onShowSessions} onNotify={onNotify} />}</section>;
}

function ThreadPage({ view, panel, onPanelChange, conversationWidth, onResizeStart, selectedThread, initialPrompt, onConsumePrompt, onNotify, onShowSessions, onShowBrowser }: {
  view: View; panel: Panel; onPanelChange: (panel: Panel) => void; conversationWidth: number; onResizeStart: () => void;
  selectedThread: string; initialPrompt: string; onConsumePrompt: () => void; onNotify: (message: string) => void; onShowSessions: () => void; onShowBrowser: () => void;
}) {
  return <main className="thread-layout"><div className="conversation-width" style={{ width: conversationWidth, flexBasis: conversationWidth }}><ThreadConversation title={selectedThread} initialPrompt={initialPrompt} onConsumePrompt={onConsumePrompt} onNotify={onNotify} /></div><button type="button" className="resize-handle" onMouseDown={onResizeStart} aria-label="Resize conversation panel"><span /></button><WorkspacePanel view={view} panel={panel} onPanelChange={onPanelChange} onShowSessions={onShowSessions} onShowBrowser={onShowBrowser} onNotify={onNotify} /></main>;
}

function SettingsGroup({ title, count, icon }: { title: string; count: string; icon: ReactNode }) {
  return <button type="button" className="settings-group collapsed"><ChevronRight size={12} /><span className="settings-group-icon">{icon}</span><strong>{title}</strong><span className="settings-count">{count}</span><Settings2 size={13} /></button>;
}
function AgentSettingsPanel() {
  const tools = [
    { name: 'Exa', icon: Search }, { name: 'Webpages', icon: Globe }, { name: 'Slides', icon: LayoutDashboard },
    { name: 'Tables', icon: Table2 }, { name: 'Search', icon: Search }, { name: 'Browser', icon: MousePointer2 },
    { name: 'Images', icon: ImageIcon }, { name: 'Video', icon: File }, { name: 'Audio', icon: Headphones },
    { name: 'Transcribe', icon: Mic }, { name: 'Avatar', icon: Bot }, { name: 'Find Similar', icon: Search },
    { name: 'Exa Research', icon: Compass }, { name: 'Exa Websites', icon: Link2 }, { name: 'Maps', icon: Compass },
    { name: 'Documents', icon: FileText }, { name: 'Thread Search', icon: MessageSquare },
  ];
  return <aside className="agent-settings-panel"><div className="agent-profile-chip"><span className="profile-spark"><Sparkles size={14} /></span><div><strong>Model</strong><small>Low cost · Auto</small></div><ChevronDown size={13} /></div>
    <SettingsGroup title="Automations" count="0" icon={<Clock3 size={14} />} /><SettingsGroup title="Integrations" count="" icon={<Link2 size={14} />} />
    <div className="settings-group expanded"><div className="settings-group-heading"><ChevronDown size={12} /><strong>Tools</strong><span>0</span><Settings2 size={13} /></div><div className="settings-tool-list">{tools.map((tool) => { const Icon = tool.icon; return <button type="button" key={tool.name}><Icon size={13} /><span>{tool.name}</span></button>; })}</div></div>
    <SettingsGroup title="Skills" count="0" icon={<Puzzle size={14} />} /><SettingsGroup title="Memory" count="0" icon={<Brain size={14} />} /><SettingsGroup title="Library" count="0" icon={<Library size={14} />} />
  </aside>;
}
function CreateAgentPage({ onCreate, onNotify }: { onCreate: (name: string) => void; onNotify: (message: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('Research options, compare evidence, and turn the findings into a clear recommendation.');
  const [step, setStep] = useState('Identity');
  const steps = ['Identity', 'Model', 'Tools & integrations', 'Instructions', 'Knowledge'];
  return <main className="agent-page"><header className="agent-topbar"><button type="button" className="back-button" onClick={() => onNotify('You are already in the agent creation flow')}><ArrowLeft size={14} /> Create agent</button><div className="agent-stepper">{steps.map((item, index) => <button type="button" key={item} className={'step-item ' + (step === item ? 'current' : '')} onClick={() => setStep(item)}><span className="step-icon">{index === 0 ? <Sparkles size={15} /> : index === 1 ? <SlidersHorizontal size={14} /> : index === 2 ? <Puzzle size={14} /> : index === 3 ? <FileText size={14} /> : <Brain size={14} />}</span><span>{item}</span></button>)}</div><button type="button" className="create-agent-button" onClick={() => { if (name.trim()) onCreate(name.trim()); else onNotify('Add an agent name to continue'); }}>Create Agent</button></header>
    <div className="agent-setup-layout"><section className="agent-identity-area"><div className="identity-title-row"><span className="identity-icon"><Sparkles size={18} /></span><div><h1>{step}</h1><p>Name, description, and system prompt</p></div></div>
      <p className="identity-intro">Build the agent that should do well. We'll draft a starter name, description, and system prompt — you can refine each below, or fill them in manually.</p>
      <label className="field-label" htmlFor="agent-name">Agent name</label><input id="agent-name" className="agent-name-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Research Analyst" />
      <label className="field-label" htmlFor="agent-description">Describe the job</label><textarea id="agent-description" className="agent-description-input" value={description} onChange={(event) => setDescription(event.target.value)} rows={4} /><p className="field-hint">Who they are, what they watch, what they never do without you.</p>
      <div className="manual-fill-row"><button type="button" className="text-button" onClick={() => onNotify('Manual identity editor is already open')}>Fill these in manually <ArrowUpRight size={13} /></button><span>Or add an agent another way</span><button type="button" className="draft-identity-button" onClick={() => onNotify('Draft identity is a visual prototype')}><WandSparkles size={14} /> Draft identity</button></div>
      <div className="agent-source-cards"><button type="button" className="agent-source-card" onClick={() => { setName(name || 'Research Companion'); setDescription('A helpful agent that turns a question into a structured plan and follows through with research.'); }}><span><MessageSquare size={17} /></span><strong>Describe it in a thread</strong><small>Tell the agent what you need and let it draft its identity.</small></button>
        <button type="button" className="agent-source-card" onClick={() => onNotify('Importing an existing agent is not connected yet')}><span><UploadCloud size={17} /></span><strong>Import an agent</strong><small>Bring in an agent you exported from another tool.</small></button><button type="button" className="agent-source-card" onClick={() => onNotify('Marketplace browsing is not connected yet')}><span><Compass size={17} /></span><strong>Browse the marketplace</strong><small>Agents other people have published, ready to add.</small></button></div>
      <div className="agent-next-step"><span><ShieldCheck size={14} /> Identity details are saved in this preview only.</span><button type="button" onClick={() => setStep(steps[Math.min(steps.indexOf(step) + 1, steps.length - 1)])}>Continue <ArrowRight size={14} /></button></div>
    </section><AgentSettingsPanel /></div>
  </main>;
}

function SearchOverlay({ onClose, onOpenThread }: { onClose: () => void; onOpenThread: (title: string) => void }) {
  const [query, setQuery] = useState('');
  const filtered = recentThreads.filter((thread) => thread.title.toLowerCase().includes(query.toLowerCase()));
  return <div className="search-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="search-dialog"><div className="search-input-row"><Search size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search threads, agents, and files..." /><kbd>ESC</kbd><IconButton label="Close search" onClick={onClose}><X size={15} /></IconButton></div><div className="search-results-label">RECENT THREADS</div>{filtered.map((thread) => <button type="button" className="search-result" key={thread.title} onClick={() => { onOpenThread(thread.title); onClose(); }}><MessageSquare size={15} /><span>{thread.title}</span><ArrowUpRight size={13} /></button>)}{filtered.length === 0 && <p className="empty-search">No matching threads.</p>}</div></div>;
}

export default function App() {
  const [view, setView] = useState<View>('home');
  const [panel, setPanel] = useState<Panel>('browser');
  const [selectedThread, setSelectedThread] = useState('Small Biz Website Builder');
  const [initialPrompt, setInitialPrompt] = useState('');
  const [conversationWidth, setConversationWidth] = useState(465);
  const [isResizing, setIsResizing] = useState(false);
  const [toast, setToast] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    if (!isResizing) return;
    const move = (event: MouseEvent) => setConversationWidth(Math.max(350, Math.min(620, event.clientX - 250)));
    const stop = () => setIsResizing(false);
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', stop);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', stop); };
  }, [isResizing]);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(''), 2800); return () => window.clearTimeout(timeout); }, [toast]);
  const startPrompt = (prompt: string) => { setInitialPrompt(prompt); setPanel('browser'); setView('thread'); };
  const openThread = (title: string) => { setSelectedThread(title); setInitialPrompt(''); setPanel('browser'); setView('thread'); };
  const createAgent = (name: string) => { setSelectedThread(name); setPanel('browser'); setView('thread'); setToast('Agent identity saved locally · backend not connected'); };
  const notify = (message: string) => setToast(message);
  return <div className="app-shell">
    <Sidebar view={view} selectedThread={selectedThread} onNavigate={(next) => { setView(next); if (next === 'home') setInitialPrompt(''); }} onSelectThread={openThread} onSearch={() => setSearchOpen(true)} />
    <div className="app-main">{view === 'home' && <HomePage onStart={startPrompt} onOpenAgent={() => setView('agent')} onOpenThread={openThread} />}{view === 'agent' && <CreateAgentPage onCreate={createAgent} onNotify={notify} />}{(view === 'thread' || view === 'sessions') && <ThreadPage view={view} panel={panel} onPanelChange={setPanel} conversationWidth={conversationWidth} onResizeStart={() => setIsResizing(true)} selectedThread={selectedThread} initialPrompt={initialPrompt} onConsumePrompt={() => setInitialPrompt('')} onNotify={notify} onShowSessions={() => setView('sessions')} onShowBrowser={() => setView('thread')} />}</div>
    {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} onOpenThread={openThread} />}{toast && <div className="toast"><CheckCircle2 size={15} /><span>{toast}</span></div>}
  </div>;
}