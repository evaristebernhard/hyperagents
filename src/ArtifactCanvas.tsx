import { useState, type ReactNode, useRef } from "react";
import { Columns3, Grid2X2, PanelRight, Maximize2, Minus, ArrowLeft, ArrowRight, GripVertical, FileText, Globe, Table2, Image as ImageIcon, Download } from "lucide-react";
import type { Artifact } from "./local-model";
import type { CanvasPreferences } from "./types";
import { ArtifactView, exportArtifact } from "./LibraryManager";
import { IconButton, Modal } from "./ui";
import { moveVisibleArtifact } from "./canvas-order";
import "./artifact-canvas.css";

type Props = { artifacts: Artifact[]; allArtifacts: Artifact[]; selectedId: string; value?: CanvasPreferences; disabled?: boolean; onChange: (value: CanvasPreferences) => void; onSelect: (id: string) => boolean; children: ReactNode };
const icon = (kind: string) => kind === "Webpage" ? <Globe size={14} /> : kind === "Table" ? <Table2 size={14} /> : kind === "Image" ? <ImageIcon size={14} /> : <FileText size={14} />;
export default function ArtifactCanvas({ artifacts, allArtifacts, selectedId, value, disabled, onChange, onSelect, children }: Props) {
  const preferences: CanvasPreferences = value || { layout: "focus", hidden: [], order: [], collapsed: false };
  const { layout, hidden, order } = preferences;
  const [spotlightId, setSpotlightId] = useState("");
  const strip = useRef<HTMLDivElement>(null);
  const available = artifacts.filter(a => !hidden.includes(a.id));
  const rank = new Map(order.map((id, i) => [id, i]));
  const ordered = [...available].sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length));
  const docked = allArtifacts.filter(a => hidden.includes(a.id));
  const spotlight = allArtifacts.find(a => a.id === spotlightId && !hidden.includes(a.id));
  function change(patch: Partial<CanvasPreferences>) { onChange({ ...preferences, ...patch }); }
  function minimize(id: string) {
    if (hidden.includes(id)) return;
    if (selectedId === id && !onSelect(available.find(a => a.id !== id)?.id || "")) return;
    change({ hidden: [...hidden, id] });
  }
  function restore(id: string) { change({ hidden: hidden.filter(x => x !== id) }); }
  function move(id: string, destination: string) {
    const all = [...allArtifacts].sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length)).map(a => a.id);
    const next = moveVisibleArtifact(all, ordered.map(a => a.id), id, destination);
    if (next) change({ order: next });
  }
  function stepSpotlight(delta: number) {
    const index = ordered.findIndex(a => a.id === spotlightId);
    if (index >= 0 && ordered.length) setSpotlightId(ordered[(index + delta + ordered.length) % ordered.length].id);
  }
  return <div className="artifact-canvas">
    <div className="ac-toolbar" aria-label="Canvas layout">
      <div className="ac-layouts" role="group" aria-label="Artifact layout">
        <button type="button" aria-label="Focus layout" aria-pressed={layout === "focus"} disabled={disabled} onClick={() => change({ layout: "focus" })}><PanelRight size={15} />Focus</button>
        <button type="button" aria-label="Tile layout" aria-pressed={layout === "tiles"} disabled={disabled} onClick={() => change({ layout: "tiles" })}><Grid2X2 size={15} />Tiles</button>
        <button type="button" aria-label="Carousel layout" aria-pressed={layout === "carousel"} disabled={disabled} onClick={() => change({ layout: "carousel" })}><Columns3 size={15} />Carousel</button>
      </div>
      <span className="ac-count">{ordered.length} visible · {docked.length} docked</span>
      {!!order.length && <button className="btn small" disabled={disabled} onClick={() => change({ order: [] })}>Reset order</button>}
      {layout === "focus" && !!selectedId && available.some(a => a.id === selectedId) && <div className="ac-actions"><IconButton label="Spotlight selected artifact" onClick={() => setSpotlightId(selectedId)}><Maximize2 size={14} /></IconButton><button className="btn small" disabled={disabled} onClick={() => minimize(selectedId)}>Minimize selected</button></div>}
      {layout === "carousel" && ordered.length > 1 && <div className="ac-actions"><IconButton label="Scroll artifacts left" onClick={() => strip.current?.scrollBy({ left: -(strip.current.clientWidth * .85), behavior: "smooth" })}><ArrowLeft size={15} /></IconButton><IconButton label="Scroll artifacts right" onClick={() => strip.current?.scrollBy({ left: strip.current.clientWidth * .85, behavior: "smooth" })}><ArrowRight size={15} /></IconButton></div>}
    </div>
    {layout === "focus" ? (hidden.includes(selectedId) ? <div className="rt-empty"><h3>This artifact is in the dock</h3><p>Restore it below to view or edit it. Its content is unchanged.</p></div> : children) : ordered.length ? <div className={"ac-cards ac-" + layout} ref={strip} aria-label="Artifact canvas cards">
      {ordered.map((artifact, index) => <article className="ac-card" key={artifact.id} data-artifact-id={artifact.id} onDragOver={e => { if (!disabled && e.dataTransfer.types.includes("application/x-hyperagents-artifact")) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (!disabled) move(e.dataTransfer.getData("application/x-hyperagents-artifact"), artifact.id); }}>
        <header className="ac-card-header"><span className="ac-drag" draggable={!disabled} title="Drag to reorder" onDragStart={e => { e.dataTransfer.setData("application/x-hyperagents-artifact", artifact.id); e.dataTransfer.effectAllowed = "move"; }}><GripVertical size={14} /></span>{icon(artifact.kind)}<strong title={artifact.title}>{artifact.title}</strong><span className="ac-card-kind">{artifact.kind}</span></header>
        <div className="ac-card-controls"><button className="btn small" disabled={disabled} onClick={() => { if (onSelect(artifact.id)) change({ layout: "focus" }); }}>Open editor</button><div className="ac-actions"><button aria-label={"Move earlier: " + artifact.title} title="Move earlier" disabled={disabled || index === 0} onClick={() => move(artifact.id, ordered[index - 1].id)}><ArrowLeft size={14} /></button><button aria-label={"Move later: " + artifact.title} title="Move later" disabled={disabled || index === ordered.length - 1} onClick={() => move(artifact.id, ordered[index + 1].id)}><ArrowRight size={14} /></button><button aria-label={"Spotlight: " + artifact.title} title="Spotlight" onClick={() => setSpotlightId(artifact.id)}><Maximize2 size={14} /></button><button aria-label={"Minimize: " + artifact.title} title="Minimize to dock" disabled={disabled} onClick={() => minimize(artifact.id)}><Minus size={14} /></button></div></div>
        <div className="ac-preview"><ArtifactView artifact={artifact} /></div>
      </article>)}
    </div> : <div className="rt-empty"><h3>{docked.length ? "All matching artifacts are in the dock" : "No matching artifacts"}</h3><p>{docked.length ? "Restore an item below, or change your filters." : "Create an artifact or change the filters to show saved content."}</p></div>}
    {!!docked.length && <nav className="ac-dock" aria-label="Minimized artifacts"><span>Dock</span>{docked.map(a => <button key={a.id} disabled={disabled} title={"Restore " + a.title} aria-label={"Restore: " + a.title} onClick={() => restore(a.id)}>{icon(a.kind)}<span>{a.title}</span></button>)}<button className="ac-restore-all" disabled={disabled} onClick={() => change({ hidden: [] })}>Restore all</button></nav>}
    {spotlight && <Modal title={spotlight.title} onClose={() => setSpotlightId("")} wide><div className="ac-spotlight"><div className="ac-spotlight-toolbar"><span>{spotlight.kind} · Saved artifact</span><div className="ac-actions">{ordered.length > 1 && <><IconButton label="Previous spotlight artifact" onClick={() => stepSpotlight(-1)}><ArrowLeft size={15} /></IconButton><IconButton label="Next spotlight artifact" onClick={() => stepSpotlight(1)}><ArrowRight size={15} /></IconButton></>}<button className="btn small" onClick={() => exportArtifact(spotlight)}><Download size={14} />Download</button></div></div><div className="ac-spotlight-content"><ArtifactView artifact={spotlight} /></div></div></Modal>}
  </div>;
}
