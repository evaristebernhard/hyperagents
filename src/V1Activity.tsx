import { useState } from "react";
import {
  CheckCircle2,
  Circle,
  Code2,
  FileText,
  Globe,
  Search,
  AlertCircle,
  ChevronDown,
} from "lucide-react";
import { type Task, type TaskEvent, stateLabel, terminal } from "./v1-client";
const titles: Record<string, string> = {
  image_search: "Finding public images",
  web_search: "Searching the web",
  web_read: "Reading a webpage",
  source_read: "Reading source evidence",
  file_read: "Reading a file",
  code_execute: "Running a calculation",
  artifact_write: "Saving a document",
  delegate: "Delegating work",
  ask_user: "Waiting for your answer",
  finish: "Checking the result",
  knowledge_search: "Retrieving workspace knowledge",
  learning_propose: "Suggesting a learning",
};
const problems: Record<string, string> = {
  MODEL_UNAVAILABLE:
    "The model service is temporarily unavailable. Resume this saved run to try again.",
  MODEL_QUOTA: "The configured model account has no available quota.",
  MODEL_NETWORK: "The model connection could not be established.",
  MODEL_TIMEOUT:
    "The model did not finish responding within four minutes. Your saved files are preserved; resume this saved run to continue.",
  MIME_MISMATCH: "The file extension and declared format did not match.",
  CODE_FAILED:
    "The program returned an error. Expand the calculation to see its output.",
  CANCELLED: "The execution request was interrupted.",
  TIME_BUDGET: "This run reached its time limit.",
  MODEL_BUDGET: "This run reached its model-call limit.",
  TOKEN_BUDGET: "This run reached its token limit.",
  DELIVERY_CHECK_FAILED: "The deliverables did not pass verification.",
  SEARCH_UNAVAILABLE:
    "Public search sources were unavailable. Try again later or provide a source URL.",
  WEB_TIMEOUT: "The source did not respond in time.",
  SANDBOX_UNAVAILABLE: "The calculation sandbox is unavailable.",
};
export function TaskActivity({
  task,
  events,
  onCancel,
  onRetry,
  busy,
  readonly,
}: {
  task: Task;
  events: TaskEvent[];
  onCancel: () => void;
  onRetry: () => void;
  busy: boolean;
  readonly: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const running = !terminal(task.state) && task.state !== "uncertain";
  const operations = new Map<string, TaskEvent["payload"]>();
  for (const e of events) {
    if (e.payload.type !== "tool") continue;
    const key = e.payload.operationId || e.id;
    operations.set(key, { ...operations.get(key), ...e.payload });
  }
  const tools = [...operations.entries()].filter(
    ([, p]) => p.name !== "finish" && p.status !== "obsolete",
  );
  const question = [...tools]
    .reverse()
    .find(([, p]) => p.name === "ask_user")?.[1].result?.question;
  const validations = events.filter(
    (e) => e.payload.type === "validation" && e.payload.passed === false,
  );
  return (
    <article
      className={"rt-message assistant v1-run " + (running ? "is-running" : "")}
      aria-label="Task progress"
      data-run-id={task.id}
    >
      <div className="v1-run-heading">
        <span className="v1-run-symbol">
          {task.state === "succeeded" ? (
            <CheckCircle2 size={16} />
          ) : task.state === "failed" ? (
            <AlertCircle size={16} />
          ) : (
            <Circle size={16} />
          )}
        </span>
        <strong role="status">{stateLabel[task.state] || task.state}</strong>
        <button
          className="plain"
          aria-expanded={expanded || running}
          onClick={() => setExpanded((x) => !x)}
        >
          {tools.length} activities <ChevronDown size={13} />
        </button>
        {running && (
          <button
            className="btn small"
            disabled={busy || readonly}
            onClick={onCancel}
          >
            Cancel task
          </button>
        )}
      </div>
      {!!task.context?.length && (
        <details className="rt-context">
          <summary>Context used · {task.context.length} resources</summary>
          {task.context.map((c) => (
            <p key={c.kind + c.id}>
              <span className="badge">
                {c.kind} · v{c.revision}
              </span>{" "}
              {c.name}
            </p>
          ))}
        </details>
      )}
      {running && !tools.length && (
        <p className="muted">Preparing the next step…</p>
      )}
      {task.state === "failed" &&
        [
          "MODEL_TIMEOUT",
          "MODEL_NETWORK",
          "MODEL_UNAVAILABLE",
          "MODEL_STREAM_INTERRUPTED",
          "MODEL_RATE_LIMIT",
        ].includes(task.errorCode || "") && (
          <button
            className="btn small"
            disabled={busy || readonly}
            onClick={onRetry}
          >
            Resume saved run
          </button>
        )}
      {task.errorCode && (
        <p className="rt-error" role="alert">
          {problems[task.errorCode] || "This run could not finish."} Saved files
          remain available. <small>{task.errorCode}</small>
        </p>
      )}
      {task.state === "uncertain" && (
        <p className="rt-notice">
          The execution outcome could not be confirmed. Check saved files before
          starting another run.
        </p>
      )}
      {task.state === "waiting_user" && question && (
        <p className="v1-agent-question">{question}</p>
      )}
      {(running || expanded) && (
        <div className="v1-activity-list">
          {tools.map(([id, p]) => {
            const result = p.result,
              problem =
                result?.error ||
                (result?.outputErrors?.length
                  ? "OUTPUT_SAVE_FAILED"
                  : undefined);
            const icon =
              p.name === "code_execute" ? (
                <Code2 size={15} />
              ) : p.name === "web_search" ? (
                <Search size={15} />
              ) : p.name === "web_read" ? (
                <Globe size={15} />
              ) : (
                <FileText size={15} />
              );
            const summary =
              p.input?.query ||
              p.input?.url ||
              p.input?.name ||
              result?.title ||
              p.input?.language;
            const stdout = result?.stdout || result?.details?.stdout,
              stderr = result?.stderr || result?.details?.stderr;
            return (
              <details
                className={"v1-activity " + (problem ? "has-error" : "")}
                key={id}
                data-operation-id={id}
                data-event-id={id}
              >
                <summary>
                  {icon}
                  <span>
                    <strong>{titles[p.name || ""] || p.name}</strong>
                    {summary && <small>{summary}</small>}
                  </span>
                  <em>
                    {problem
                      ? "Needs attention"
                      : p.status === "completed"
                        ? "Done"
                        : terminal(task.state)
                          ? "Stopped"
                          : "In progress"}
                  </em>
                </summary>
                <div className="v1-activity-body">
                  {p.input?.code && (
                    <details>
                      <summary>
                        {p.input.language === "node" ? "JavaScript" : "Python"}{" "}
                        program
                      </summary>
                      <pre>{p.input.code}</pre>
                    </details>
                  )}
                  {stdout && (
                    <>
                      <small>Output</small>
                      <pre>{stdout}</pre>
                    </>
                  )}
                  {stderr && (
                    <>
                      <small>Program messages</small>
                      <pre>{stderr}</pre>
                    </>
                  )}
                  {problem && (
                    <p role="alert">{problems[problem] || problem}</p>
                  )}
                  {!!result?.outputErrors?.length && (
                    <p role="alert">
                      The calculation succeeded; file delivery needs repair:{" "}
                      {result.outputErrors
                        .map((e) => e.path + " (" + e.error + ")")
                        .join(", ")}
                    </p>
                  )}
                  {result?.results?.map((s) => (
                    <a
                      key={s.url}
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {s.title || s.url}
                    </a>
                  ))}
                  {result?.url && /^https?:/.test(result.url) && (
                    <a href={result.url} target="_blank" rel="noreferrer">
                      {result.title || result.url}
                    </a>
                  )}
                  {task.state !== "waiting_user" && result?.question && (
                    <p>{result.question}</p>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}
      {task.state === "failed" && validations.length > 0 && (
        <details className="rt-run-details">
          <summary>What still needs fixing</summary>
          {validations.at(-1)?.payload.issues?.map((s, i) => (
            <p key={i}>{s}</p>
          ))}
        </details>
      )}
    </article>
  );
}
