import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bot, Check, ChevronLeft, ChevronRight, ExternalLink, FileText, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import type { PageProps } from "./types";
import { api } from "./backend-client";
import { now, uid } from "./local-model";
import { useWorkspace } from "./workspace";
import { marketplaceCatalog, marketplaceCategories } from "./marketplace-catalog";
import "./marketplace.css";

type Entry = (typeof marketplaceCatalog)[number];
type Capability = { available: boolean; reason: string };
type Capabilities = Record<string, Capability>;
type Readiness = "all" | "ready" | "blocked" | "source" | "installed";
type Kind = "all" | "skill" | "agent";
type PendingInstall = { sourceId: string; workspaceId: string; id: string };
const PAGE_SIZE = 24;
const entryPath = (entry: Entry) => `/marketplace/${entry.kind === "skill" ? "s" : "a"}/${encodeURIComponent(entry.sourceId)}`;
const agentId = (entry: Entry) => "agent-market-" + entry.sourceId;
const categoryName = (id: string) => marketplaceCategories.find(category => category.id === id)?.name || id;
const problemMessage = (error: unknown) => error instanceof Error ? error.message : "The server could not complete this request. Please try again.";
function decode(value: string) { try { return decodeURIComponent(value); } catch { return ""; } }
function internalClick(event: MouseEvent<HTMLAnchorElement>, action: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); action();
}

/** Server-mode catalog. Original source metadata is never treated as executable instructions. */
export default function Marketplace({ path, navigate, notify }: PageProps) {
  const workspace = useWorkspace();
  const [capabilities, setCapabilities] = useState<Capabilities>({});
  const [capabilityState, setCapabilityState] = useState<"loading" | "ready" | "error">("loading");
  const [capabilityError, setCapabilityError] = useState("");
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [readiness, setReadiness] = useState<Readiness>("all");
  const [page, setPage] = useState(1);
  const [dialogEntry, setDialogEntry] = useState<Entry | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [pending, setPending] = useState<PendingInstall | null>(null);
  const operation = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const currentRoute = useRef(path);
  currentRoute.current = path;
  const currentWorkspace = useRef(workspace.state.active);
  currentWorkspace.current = workspace.state.active;
  const route = path.split("?")[0].replace(/\/$/, "").split("/");
  const routeKind = route[2];
  const routeId = decode(route[3] || "");
  const category = routeKind === "c" ? marketplaceCategories.find(item => item.id === routeId) : undefined;
  const isDetail = routeKind === "s" || routeKind === "a";
  const detail = isDetail ? marketplaceCatalog.find(entry => entry.sourceId === routeId && entry.kind === (routeKind === "s" ? "skill" : "agent")) : undefined;
  const validRoute = !routeKind || (routeKind === "c" ? !!category : isDetail && !!detail);

  useEffect(() => {
    let cancelled = false;
    setCapabilityState("loading"); setCapabilityError("");
    api<{ capabilities: Capabilities }>("/api/marketplace/capabilities").then(reply => {
      if (!reply || !reply.capabilities || typeof reply.capabilities !== "object" || Array.isArray(reply.capabilities)) throw new Error("The capability service returned an invalid response.");
      const checked: Capabilities = {};
      for (const [name, capability] of Object.entries(reply.capabilities)) {
        if (capability && typeof capability.available === "boolean") checked[name] = { available: capability.available, reason: typeof capability.reason === "string" ? capability.reason : "" };
      }
      if (!cancelled) { setCapabilities(checked); setCapabilityState("ready"); }
    }).catch(error => {
      if (!cancelled) { setCapabilities({}); setCapabilityError(problemMessage(error)); setCapabilityState("error"); }
    });
    return () => { cancelled = true; };
  }, [capabilityAttempt, workspace.state.active]);

  useEffect(() => { setPage(1); }, [path, query, kind, readiness, workspace.state.active]);
  useEffect(() => {
    setDialogEntry(null); setSaveError("");
    headingRef.current?.focus({ preventScroll: true });
  }, [path, workspace.state.active]);
  useEffect(() => {
    if (!dialogEntry) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !operation.current) { event.preventDefault(); setDialogEntry(null); }
      if (event.key !== "Tab") return;
      const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]') || []);
      const first = elements[0], last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("keydown", keyboard); previous?.focus(); };
  }, [dialogEntry]);

  const installed = (entry: Entry) => entry.kind === "skill"
    ? workspace.data.skills.find(skill => skill.sourceId === entry.sourceId)
    : workspace.data.agents.find(agent => agent.id === agentId(entry));
  const isPending = (entry: Entry) => pending?.sourceId === entry.sourceId && pending.workspaceId === workspace.state.active;
  const toolStatus = (name: string): Capability => {
    if (capabilityState === "loading") return { available: false, reason: "Checking server capability…" };
    if (capabilityState === "error") return { available: false, reason: "Capability status could not be verified. Retry the server check." };
    return capabilities[name] || { available: false, reason: "No supported capability is registered for this tool or dependency." };
  };
  const ready = (entry: Entry) => !!entry.implementation && capabilityState === "ready" && entry.implementation.tools.filter(tool => tool !== "LLM").every(tool => toolStatus(tool).available);
  const status = (entry: Entry): { text: string; tone: string } => {
    if (isPending(entry) && workspace.persistence !== "saved") return { text: "Save not confirmed", tone: "warning" };
    const saved = installed(entry);
    if (saved) return { text: saved.archived ? "Installed · archived" : "Installed", tone: "installed" };
    if (!entry.implementation) return { text: "Source listing", tone: "source" };
    if (capabilityState === "loading") return { text: "Checking tools", tone: "source" };
    return ready(entry) ? { text: entry.implementation?.coverage === "partial" ? "Partial · installable" : "Ready to install", tone: "ready" } : { text: "Setup needed", tone: "warning" };
  };
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return marketplaceCatalog.filter(entry => {
      if (category && !entry.categories.includes(category.id)) return false;
      if (kind !== "all" && entry.kind !== kind) return false;
      if (search && ![entry.name, entry.creator, entry.summary, ...entry.categories.map(categoryName), ...entry.dependencies].join(" ").toLowerCase().includes(search)) return false;
      if (readiness === "ready" && !ready(entry)) return false;
      if (readiness === "blocked" && (!entry.implementation || ready(entry))) return false;
      if (readiness === "source" && entry.implementation) return false;
      if (readiness === "installed" && !installed(entry)) return false;
      return true;
    });
  }, [category?.id, query, kind, readiness, capabilities, capabilityState, workspace.data.skills, workspace.data.agents]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const cards = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const implementedCount = marketplaceCatalog.filter(entry => entry.implementation).length;

  const openInstalled = async (entry: Entry) => {
    if (operation.current) return;
    const saved = installed(entry);
    if (!saved) return;
    operation.current = true; setSaving(true); setSaveError("");
    const workspaceId = workspace.state.active, originPath = path;
    try {
      if (workspace.persistence === "error" || workspace.persistence === "conflict") await workspace.retrySave();
      else await workspace.flush();
      if (currentWorkspace.current !== workspaceId || currentRoute.current !== originPath) return;
      setPending(null); setDialogEntry(null);
      notify(saved.archived ? "Opening the existing archived item. It has not been unarchived." : "Opening your existing installation; no duplicate was created.");
      navigate(`/${entry.kind === "skill" ? "skills" : "agents"}/${encodeURIComponent(saved.id)}`);
    } catch (error) { setSaveError(problemMessage(error)); setDialogEntry(entry); }
    finally { operation.current = false; setSaving(false); }
  };
  const install = async (entry: Entry) => {
    if (operation.current) return;
    if (installed(entry)) { await openInstalled(entry); return; }
    if (!entry.implementation || !ready(entry) || workspace.mode !== "server") return;
    operation.current = true; setSaving(true); setSaveError("");
    const workspaceId = workspace.state.active, originPath = path;
    let id = entry.kind === "skill" ? uid("skill") : agentId(entry);
    try {
      if (entry.kind === "skill") {
        const timestamp = now();
        const item = { id, sourceId: entry.sourceId, name: entry.name, description: entry.summary, documentation: entry.implementation.documentation, whenToUse: entry.summary, tags: [...entry.categories], author: "Independent replica implementation", createdAt: timestamp, updatedAt: timestamp };
        workspace.set("skills", items => {
          const existing = items.find(skill => skill.sourceId === entry.sourceId);
          if (existing) { id = existing.id; return items; }
          return [...items, item];
        });
      } else {
        const item = { id, name: entry.name, description: entry.summary, prompt: entry.implementation.documentation, tools: [...entry.implementation.tools], skillIds: [] as string[] };
        workspace.set("agents", items => items.some(agent => agent.id === id) ? items : [...items, item]);
      }
      setPending({ id, sourceId: entry.sourceId, workspaceId });
      await workspace.flush();
      if (currentWorkspace.current !== workspaceId || currentRoute.current !== originPath) return;
      setPending(null); setDialogEntry(null);
      notify(entry.kind === "skill" ? "Independent skill implementation saved to your workspace." : "Independent agent implementation saved to your workspace.");
      navigate(`/${entry.kind === "skill" ? "skills" : "agents"}/${encodeURIComponent(id)}`);
    } catch (error) { setSaveError(problemMessage(error)); }
    finally { operation.current = false; setSaving(false); }
  };
  const beginInstall = (entry: Entry) => { setSaveError(""); setDialogEntry(entry); };
  const actionLabel = (entry: Entry) => installed(entry) ? `Open installed ${entry.kind}` : entry.kind === "skill" ? "Install skill" : "Create agent";
  const dependencyList = (names: string[], empty: string): ReactNode => names.length ? <ul className="mp-dependencies">{Array.from(new Set(names)).map(name => {
    const capability = toolStatus(name);
    return <li key={name}><span className={`mp-dependency-icon ${capability.available ? "available" : "unavailable"}`} aria-hidden="true">{capability.available ? <Check size={13} /> : "—"}</span><div><strong>{name}</strong><span>{capability.available ? "Available" : capabilityState === "loading" ? "Checking" : "Unavailable"}{capability.reason ? ` · ${capability.reason}` : ""}</span></div></li>;
  })}</ul> : <p className="mp-muted">{empty}</p>;
  const runtimeWarning = capabilityState === "ready" && capabilities.LLM?.available !== true;
  const capabilitiesNotice = capabilityState === "error" ? <div className="mp-notice mp-notice-warning" role="alert"><div><strong>Could not verify server capabilities</strong><p>{capabilityError} Installation is paused until the check succeeds.</p></div><button className="mp-button" onClick={() => setCapabilityAttempt(attempt => attempt + 1)}>Retry capability check</button></div> : runtimeWarning ? <div className="mp-notice mp-notice-warning"><Sparkles size={17} aria-hidden="true" /><div><strong>Runtime setup required</strong><p>{capabilities.LLM?.reason || "No LLM runtime is configured."} You can save supported implementations now; configure a model before running them.</p></div></div> : null;

  const detailView = (entry: Entry) => {
    const saved = installed(entry);
    const entryStatus = status(entry);
    return <>
      <nav className="mp-breadcrumb" aria-label="Breadcrumb"><a href="/marketplace" onClick={event => internalClick(event, () => navigate("/marketplace"))}><ArrowLeft size={15} />Marketplace</a><span aria-hidden="true">/</span><span>{entry.kind === "skill" ? "Skill" : "Agent"}</span></nav>
      <header className="mp-detail-heading"><div className={`mp-entry-icon ${entry.kind}`} aria-hidden="true">{entry.kind === "skill" ? <FileText size={25} /> : <Bot size={27} />}</div><div><div className="mp-eyebrow">{entry.kind} · <span>Source publisher: {entry.creator}</span></div><h1 ref={headingRef} tabIndex={-1}>{entry.name}</h1><p className="mp-lede">{entry.summary}</p><div className="mp-tags">{entry.categories.map(id => <a key={id} href={`/marketplace/c/${encodeURIComponent(id)}`} onClick={event => internalClick(event, () => navigate(`/marketplace/c/${encodeURIComponent(id)}`))}>{categoryName(id)}</a>)}</div></div></header>
      {capabilitiesNotice}
      <div className="mp-detail-grid"><div className="mp-detail-main"><section className="mp-panel mp-independent"><ShieldCheck size={20} aria-hidden="true" /><div><h2>{entry.implementation ? "An independent implementation" : "A source listing, not an installable implementation"}</h2><p>{entry.implementation ? "This workspace implementation is independently authored. The source publisher is credited for the original listing, not for the instructions below. It is not an official agent, original system prompt, or endorsement." : "Catalog metadata describes the original listing. No independent implementation is available here, and the original publisher’s full prompt has not been copied. This listing cannot add a working skill or agent to your workspace."}</p></div></section>
        {entry.implementation ? <section className="mp-panel mp-document-section"><div className="mp-section-heading"><div><span className="mp-eyebrow">Full preview</span><h2>{entry.kind === "skill" ? "Implementation documentation" : "Independent agent instructions"}</h2></div><span className="mp-small-label">Exact saved content</span></div><p className="mp-muted">{entry.kind === "skill" ? "These are the complete instructions that will be saved as this skill’s documentation." : "This complete, independently authored text will be saved as the agent’s prompt. It does not impersonate the source publisher or an official character."}</p><pre className="mp-document" tabIndex={0} aria-label="Exact implementation documentation">{entry.implementation.documentation}</pre></section> : <section className="mp-panel"><h2>About this listing</h2><p>The source may require tools or services that this server does not provide. Review the dependency list and visit the original source to evaluate its offering. No install action is available for an unimplemented listing.</p><a className="mp-source-link" href={entry.sourceUrl} target="_blank" rel="noopener noreferrer">View original source <ExternalLink size={14} aria-hidden="true" /></a></section>}
        {entry.implementation && <section className="mp-panel"><h2>{entry.implementation.coverage === "partial" ? "Partial implementation — limitations" : "Limitations"}</h2><p className="mp-limitations">{entry.implementation.limitations || "No additional limitations are documented. Capability availability does not guarantee a particular result."}</p></section>}
      </div><aside className="mp-detail-aside" aria-label="Installation and dependencies"><section className="mp-panel mp-install-panel"><span className={`mp-status ${entryStatus.tone}`}><span aria-hidden="true" />{entryStatus.text}</span><h2>{entry.implementation ? "Add to your workspace" : "Explore the original"}</h2><p>{entry.implementation ? `Save an editable, independent ${entry.kind} implementation to ${workspace.activeName}.` : "This catalog entry is informational. No working implementation is available to install."}</p>
        {saved && <p className="mp-installed-note">{saved.archived ? "An archived installation already exists. Opening it will not unarchive it or create a duplicate." : "Already in this workspace. Opening it preserves your edits and does not create a duplicate."}</p>}
        {(entry.implementation || saved) && <button className="mp-button mp-primary mp-wide" disabled={saving || (!saved && (!ready(entry) || workspace.mode !== "server"))} onClick={() => saved ? void openInstalled(entry) : beginInstall(entry)}>{saving ? "Saving…" : actionLabel(entry)}{!saving && <ArrowRight size={15} aria-hidden="true" />}</button>}
        {entry.implementation && !saved && !ready(entry) && <p className="mp-help">{capabilityState === "loading" ? "Checking required tools with your server…" : "Required tools must be available before installation. See the status below."}</p>}
        <a className="mp-source-link" href={entry.sourceUrl} target="_blank" rel="noopener noreferrer">Original source <ExternalLink size={14} aria-hidden="true" /></a><small className="mp-publisher">Published at source by {entry.creator}</small>
      </section>{entry.implementation && <section className="mp-panel"><h2>Implementation tools</h2><p className="mp-help">Installation checks these exact tools. Unknown tools are blocked.</p>{dependencyList(entry.implementation.tools.filter(tool => tool !== "LLM"), "No additional tools are required by this implementation.")}</section>}<section className="mp-panel"><h2>Original listing dependencies</h2><p className="mp-help">Dependencies are inferred from the visible source listing, not an official package manifest. Source requirements may differ from the independent implementation.</p>{dependencyList(entry.dependencies, "No source dependencies are listed.")}</section></aside></div>
    </>;
  };

  return <main className="mp-page" aria-label="Marketplace">
    <div aria-hidden={dialogEntry ? true : undefined}>
    {!validRoute ? <section className="mp-not-found"><h1 ref={headingRef} tabIndex={-1}>Listing not found</h1><p>This marketplace address does not match a catalog entry or category.</p><button className="mp-button" onClick={() => navigate("/marketplace")}><ArrowLeft size={15} />Back to marketplace</button></section> : detail ? detailView(detail) : <>
      <header className="mp-topbar"><a className="mp-title" href="/marketplace" onClick={event => internalClick(event, () => navigate("/marketplace"))}>Marketplace</a><span className="mp-local-label"><ShieldCheck size={14} aria-hidden="true" />Independent catalog</span></header>
      <section className="mp-hero"><div className="mp-eyebrow">A little expertise goes a long way</div><h1 ref={headingRef} tabIndex={-1}>{category ? category.name : "Find your next capability."}</h1><p>{category ? "Explore skills and agents in this category, with honest implementation and tool status." : "Discover skills and agents. Preview the instructions, check the tools, and make them your own."}</p><div className="mp-catalog-facts"><span>{marketplaceCatalog.length} original listings</span><span>{implementedCount} independent implementations</span><span>{marketplaceCategories.length} categories</span></div></section>
      {capabilitiesNotice}
      <div className="mp-catalog-layout"><aside className="mp-categories" aria-label="Marketplace categories"><h2>Categories</h2><nav><a className={!category ? "selected" : ""} href="/marketplace" aria-current={!category ? "page" : undefined} onClick={event => internalClick(event, () => navigate("/marketplace"))}><span>All categories</span><small>{marketplaceCatalog.length}</small></a>{marketplaceCategories.map(item => <a key={item.id} className={category?.id === item.id ? "selected" : ""} href={`/marketplace/c/${encodeURIComponent(item.id)}`} aria-current={category?.id === item.id ? "page" : undefined} onClick={event => internalClick(event, () => navigate(`/marketplace/c/${encodeURIComponent(item.id)}`))}><span>{item.name}</span><small>{marketplaceCatalog.filter(entry => entry.categories.includes(item.id)).length}</small></a>)}</nav><div className="mp-catalog-note"><ShieldCheck size={17} aria-hidden="true" /><p>Source credited.<br />Implementation transparent.<br />Your workspace, your edits.</p></div></aside>
      <section className="mp-results" aria-label="Catalog results"><div className="mp-filter-row"><div className="mp-kind-filter" role="group" aria-label="Listing type">{([["all", "All"], ["skill", "Skills"], ["agent", "Agents"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={kind === value} className={kind === value ? "selected" : ""} onClick={() => setKind(value)}>{label}</button>)}</div><label className="mp-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="Search marketplace" placeholder="Search skills, agents, publishers…" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      <div className="mp-result-meta"><p role="status" aria-live="polite"><strong>{filtered.length}</strong> {filtered.length === 1 ? "listing" : "listings"}{category ? ` in ${category.name}` : " to explore"}</p><label className="mp-readiness-filter"><span>Readiness</span><select aria-label="Filter by readiness" value={readiness} onChange={event => setReadiness(event.target.value as Readiness)}><option value="all">All listings</option><option value="ready">Ready to install</option><option value="blocked">Setup needed</option><option value="source">Source listings only</option><option value="installed">Installed in this workspace</option></select></label></div>
      {cards.length ? <div className="mp-card-grid">{cards.map(entry => {
        const entryStatus = status(entry);
        return <article className="mp-card" key={entry.sourceId}><div className="mp-card-top"><div className={`mp-entry-icon ${entry.kind}`} aria-hidden="true">{entry.kind === "skill" ? <FileText size={20} /> : <Bot size={22} />}</div><span className="mp-kind-label">{entry.kind}</span></div><h2><a href={entryPath(entry)} onClick={event => internalClick(event, () => navigate(entryPath(entry)))}>{entry.name}</a></h2><p className="mp-card-publisher">Source: {entry.creator}</p><p className="mp-card-summary">{entry.summary}</p><div className="mp-tags">{entry.categories.slice(0, 2).map(id => <span key={id}>{categoryName(id)}</span>)}{entry.categories.length > 2 && <span title={entry.categories.slice(2).map(categoryName).join(", ")}>+{entry.categories.length - 2}</span>}</div><div className="mp-card-bottom"><span className={`mp-status ${entryStatus.tone}`}><span aria-hidden="true" />{entryStatus.text}</span><a href={entryPath(entry)} aria-label={`View ${entry.name}`} onClick={event => internalClick(event, () => navigate(entryPath(entry)))}>Details <ArrowRight size={14} aria-hidden="true" /></a></div></article>;
      })}</div> : <div className="mp-empty"><Search size={28} aria-hidden="true" /><h2>No matching listings</h2><p>Try a different search or broaden your filters.</p><button className="mp-button" onClick={() => { setQuery(""); setKind("all"); setReadiness("all"); }}>Clear search and filters</button></div>}
      {pages > 1 && <nav className="mp-pagination" aria-label="Catalog pagination"><button className="mp-button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={15} aria-hidden="true" />Previous</button><span aria-live="polite">Page {currentPage} of {pages} <small>· {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length}</small></span><button className="mp-button" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Next<ChevronRight size={15} aria-hidden="true" /></button></nav>}
      <footer className="mp-footer">Catalog counts reflect the listings shown here, not installs or reviews. Source listings are not promises of local functionality.</footer></section></div>
    </>}
    </div>
    {dialogEntry && <div className="mp-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setDialogEntry(null); }}><div className="mp-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="mp-install-title" aria-describedby="mp-install-description" aria-busy={saving}><button ref={closeRef} className="mp-dialog-close" aria-label="Close installation dialog" disabled={saving} onClick={() => setDialogEntry(null)}><X size={19} /></button><span className="mp-eyebrow">Your workspace · {workspace.activeName}</span><h2 id="mp-install-title">{installed(dialogEntry) ? "Existing installation" : dialogEntry.kind === "skill" ? "Install this skill?" : "Create this agent?"}</h2><p id="mp-install-description"><strong>{dialogEntry.name}</strong> {installed(dialogEntry) ? "is already present in this workspace. No duplicate will be created, and archived items will stay archived." : "will be saved as an editable independent implementation. The source publisher’s original prompt is not included."}</p><div className="mp-dialog-summary"><span>{dialogEntry.kind === "skill" ? "Documentation" : "Prompt"}</span><strong>Independent replica implementation</strong><span>Required tools</span><strong>{dialogEntry.implementation?.tools.join(", ") || "None"}</strong></div>{runtimeWarning && <p className="mp-dialog-runtime">A model runtime must be configured before execution. Saving the instructions is still supported.</p>}{saveError && <div className="mp-save-error" role="alert"><strong>Save not confirmed</strong><p>{saveError}</p><p>No success has been recorded. Any staged changes remain unsaved until the server acknowledges them. Retry after resolving the server error; use the workspace save bar to reload the server version if necessary.</p></div>}<div className="mp-dialog-actions"><button className="mp-button" disabled={saving} onClick={() => setDialogEntry(null)}>{saveError ? "Keep details open" : "Cancel"}</button><button className="mp-button mp-primary" disabled={saving || (!installed(dialogEntry) && !ready(dialogEntry))} onClick={() => void install(dialogEntry)}>{saving ? "Saving to server…" : saveError && installed(dialogEntry) ? "Retry save and open" : actionLabel(dialogEntry)}</button></div></div></div>}
  </main>;
}
