import { useEffect, useState } from "react";
import { ArrowLeft, Sparkles } from "lucide-react";
import type { Navigate } from "./types";
import { useWorkspace } from "./workspace";
import { readAgentDraft, writeAgentDraft } from "./agent-draft";
import "./agent-creation.css";

const jobs = [
  "Run the inbox so no customer waits past lunch for an answer",
  "Greet the morning regulars by name so every one of them feels known",
  "Chase every wholesale reorder before the shelf runs dry",
  "Run the standup so every blocker has an owner by ten",
];
const lenses = {
  Archetype: "Original characters, not based on any movie or show.",
  "One Universe": "Every character drawn from one world you pick — space opera, film noir, cozy fantasy…",
  "Mixed Reel": "Each character from a different world, for the widest spread of settings.",
  "Casting Director": "Bold, original characters, each one a blend of two famous ones.",
};
const worlds = ["Big-hearted animation", "Hand-drawn wonder", "Space opera", "Film noir", "Felt-puppet variety hour", "Deadpan pastel storybook", "Cozy fantasy", "Saturday-morning cartoon"];
export default function AgentCasting({ navigate }: { navigate: Navigate }) {
  const w = useWorkspace();
  const [initial] = useState(() => readAgentDraft(w.state.active));
  const [job, setJob] = useState(initial.casting?.job || initial.job || "");
  const [lens, setLens] = useState<keyof typeof lenses>(initial.casting?.lens && Object.hasOwn(lenses, initial.casting.lens) ? initial.casting.lens as keyof typeof lenses : "Archetype");
  const [world, setWorld] = useState(initial.casting?.world || "");
  const [status, setStatus] = useState("");
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    setStorageError(!writeAgentDraft(w.state.active, { casting: { job, lens, world } }));
  }, [job, lens, world, w.state.active]);
  return <div className="casting-page">
    <button className="plain" onClick={() => navigate("/agents/new")}><ArrowLeft size={16} />Back</button>
    <header><Sparkles size={26} /><h1>Hire a coworker</h1><p>Describe the job. We’ll hold auditions for a few candidates — pick the one you’d hire, or set one up yourself.</p></header>
    <form onSubmit={e => { e.preventDefault(); setStatus("Casting is not connected in this local preview. No candidates or portraits were generated, and no agent was created."); }}>
      <label className="field">What should this agent do?
        <textarea className="textarea" aria-label="What should this agent do?" rows={5} value={job} onChange={e => { setJob(e.target.value); setStatus(""); }} placeholder="Run the inbox for a neighborhood bike shop so no customer waits past lunch for an answer and every regular feels known" />
      </label>
      <section><h3>Need a starting point?</h3><div className="casting-job-chips">{jobs.map(value => <button type="button" key={value} onClick={() => { setJob(value); setStatus(""); }}>{value}</button>)}</div></section>
      <section><h3>Casting lens</h3><div className="casting-lenses" role="group" aria-label="Casting lens">{(Object.keys(lenses) as (keyof typeof lenses)[]).map(value => <button type="button" className={lens === value ? "selected" : ""} aria-pressed={lens === value} key={value} onClick={() => setLens(value)}>{value}</button>)}</div><p className="muted">{lenses[lens]}</p></section>
      {lens !== "Archetype" && <section><label className="field">World <span className="muted">(optional)</span>
        <input className="input" aria-label="World" placeholder="World (optional) — pick above or type your own" value={world} onChange={e => setWorld(e.target.value)} />
      </label><div className="casting-world-chips">{worlds.map(value => <button type="button" className={world === value ? "selected" : ""} aria-pressed={world === value} key={value} onClick={() => setWorld(value)}>{value}</button>)}</div><p className="muted">Pick a universe to cast from, or leave blank and we’ll pick one that fits.</p></section>}
      {storageError && <p role="alert" className="creation-warning">Draft storage is unavailable. Keep this page open to retain your inputs.</p>}
      {status && <p role="status" className="creation-notice">{status}</p>}
      <footer><a href="/agents/new?creation=manual" onClick={e => {
        e.preventDefault(); writeAgentDraft(w.state.active, { manual: true, job }); navigate("/agents/new?creation=manual");
      }}>Skip — configure manually</a><button type="submit" className="btn primary" disabled={!job.trim()}>Cast</button></footer>
      <p className="demo-note">Local UI preview. Casting generation is not connected; the button never starts an external run.</p>
    </form>
  </div>;
}
