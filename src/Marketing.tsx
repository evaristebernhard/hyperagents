import { useState } from "react";
import {
  ArrowUp,
  ArrowLeft,
  ArrowRight,
  Clock,
  ChevronRight,
} from "lucide-react";
import { examples, asset } from "./data";
import type { Navigate } from "./types";
import "./marketing.css";
export default function Marketing({
  navigate,
  path,
}: {
  navigate: Navigate;
  path: string;
}) {
  const [step, setStep] = useState(0),
    [format, setFormat] = useState("Websites"),
    [prompt, setPrompt] = useState("");
  const link = (url: string, text: string, cls = "") => (
    <a
      href={url}
      className={cls}
      onClick={(e) => {
        e.preventDefault();
        navigate(url);
      }}
    >
      {text}
    </a>
  );
  return (
    <div className="marketing-page">
      <header className="marketing-header">
        {link("/marketing", "Hyperagent", "marketing-logo")}
        <nav>
          {link("/login", "Log in")}
          {link("/login", "Sign up", "marketing-dark")}
        </nav>
      </header>
      {path === "/terms" || path === "/privacy" ? (
        <article className="marketing-legal">
          <h1>{path === "/terms" ? "Terms of Service" : "Privacy Policy"}</h1>
          <p className="muted">
            Independent frontend recreation · demo legal page
          </p>
          <h2>About this preview</h2>
          <p>
            This project is a UI demonstration, not the official Hyperagent
            service. No authentication, payment, model, or external tool service
            is connected.
          </p>
          <h2>Local data</h2>
          <p>
            Demo conversations, agents, projects, memories, and preferences are
            saved in your browser’s local storage. Clearing site data removes
            this local state.
          </p>
          <h2>Reference assets</h2>
          <p>
            Public showcase crops are used for visual reference. They remain the
            property of their respective owners. No private account screenshots
            or credentials are included.
          </p>
          {link("/marketing", "← Back to homepage")}
        </article>
      ) : (
        <>
          <section className="marketing-hero">
            <h1>Agents that ship real, powerful work.</h1>
            <p>
              Deliverables that stay alive, using your data, your tools, and
              your style.
              <br />
              Available wherever your team already works.
            </p>
            {link("/login", "Start shipping", "marketing-dark")}
            <div className="marketing-cases">
              {examples.slice(0, 4).map((x) => (
                <a
                  href={"/featured/" + x.slug}
                  className="marketing-case"
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
          <section className="marketing-steps">
            <h2>Brief once. Ship forever.</h2>
            <p>
              Hand your fleet an assignment. They research, build, deliver, and
              keep the work current as your world changes.
            </p>
            <div className="marketing-step-card">
              <div className="marketing-mock">
                <span className="badge">
                  {["Your workspace", "Agent activity", "Deliverables"][step]}
                </span>
                <h3>
                  {
                    [
                      "Start with an assignment",
                      "The fleet gets building",
                      "Work that keeps moving",
                    ][step]
                  }
                </h3>
                <div className="marketing-task-preview">
                  {
                    [
                      "Build a clear launch plan, research the audience, and create a beautiful landing page.",
                      "Researching sources · Preparing working notes · Building your deliverables",
                      "Your project is ready to review. Keep the context, artifacts, and next steps together.",
                    ][step]
                  }
                  <span>Search　 Webpage　 Slides　 Doc</span>
                </div>
              </div>
              <h3>
                {
                  [
                    "Tell your agents what you need to build.",
                    "The fleet gets building.",
                    "Review, refine, and keep it current.",
                  ][step]
                }
              </h3>
              <p>
                {
                  [
                    "Seriously — whatever you’re cooking up, send it over.",
                    "Real tools, clear context, and visible progress.",
                    "Your work stays organized in a shared workspace.",
                  ][step]
                }
              </p>
            </div>
            <div className="marketing-step-controls">
              <div>
                {[0, 1, 2].map((i) => (
                  <button
                    aria-label={"Go to step " + (i + 1)}
                    className={step === i ? "selected" : ""}
                    onClick={() => setStep(i)}
                    key={i}
                  />
                ))}
              </div>
              <button
                aria-label="Previous step"
                disabled={step === 0}
                onClick={() => setStep(step - 1)}
              >
                <ArrowLeft size={17} />
              </button>
              <button
                aria-label="Next step"
                disabled={step === 2}
                onClick={() => setStep(step + 1)}
              >
                <ArrowRight size={17} />
              </button>
            </div>
          </section>
          <section className="marketing-formats">
            <h2>Real work in every format.</h2>
            <p>Apps, sites, decks, docs, video, whatever you get into next.</p>
            <div className="marketing-format-tabs">
              {["Websites", "Video", "Slides", "Documents", "Dashboards"].map(
                (n) => (
                  <button
                    key={n}
                    className={format === n ? "active" : ""}
                    onClick={() => setFormat(n)}
                  >
                    {n}
                  </button>
                ),
              )}
            </div>
            <div className="marketing-format-preview">
              <img
                src={asset(
                  format === "Dashboards"
                    ? "hiring"
                    : format === "Websites"
                      ? "brand"
                      : format === "Documents"
                        ? "campaign"
                        : "property",
                )}
                alt={format + " showcase reference"}
              />
            </div>
            <div className="marketing-format-caption">
              <h3>
                {format === "Websites"
                  ? "Fully functional websites"
                  : format + " that move work forward"}
              </h3>
              <p>Built to review and share — not pasted into a chat.</p>
            </div>
          </section>
          <section className="marketing-fleet">
            <h2>Your personal fleet of agents.</h2>
            <p>Deploy, connect, and manage — all from one command center.</p>
            <div className="marketing-fleet-grid">
              {[
                [
                  "Infrastructure that’s already running.",
                  "Each powerful agent comes with its own computing environment.",
                  "hiring",
                ],
                [
                  "Transparent execution",
                  "See every decision and every artifact as it’s built.",
                  "campaign",
                ],
                [
                  "Works where you work",
                  "Bring the work into the tools your team already uses.",
                  "brand",
                ],
              ].map(([n, t, img]) => (
                <article key={n}>
                  <h3>{n}</h3>
                  <p>{t}</p>
                  <img src={asset(img)} alt={n} />
                </article>
              ))}
            </div>
          </section>
          <section className="marketing-try">
            <h2>Try it now.</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                navigate("/login");
              }}
            >
              <textarea
                aria-label="Try a task"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Hyperagent, create me a deck…"
              />
              <button aria-label="Try it now" disabled={!prompt.trim()}>
                <ArrowUp size={22} />
              </button>
            </form>
          </section>
        </>
      )}
      <footer>
        {link("/terms", "Terms")}
        {link("/privacy", "Privacy")}
        <span>Independent UI demo · not affiliated with Hyperagent</span>
        {link("/threads/new", "Open workspace →")}
      </footer>
    </div>
  );
}
