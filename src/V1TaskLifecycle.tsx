import type { TaskOverview } from "./v1-client";

const labels = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  blocked: "Blocked",
  skipped: "Skipped",
};
export function TaskLifecycle({ overview: o }: { overview: TaskOverview }) {
  return (
    <div className="v1-task-lifecycle">
      {o.control === "pause_requested" && (
        <p role="status">
          Finishing the current operation and saving its result before pausing.
        </p>
      )}
      {o.plan && (
        <details className="v1-task-plan" open>
          <summary>
            Task plan · {o.completedSteps}/{o.totalSteps} completed
          </summary>
          <ol>
            {o.plan.steps.map((step) => (
              <li
                key={step.id}
                data-plan-step={step.id}
                data-step-status={step.status}
              >
                <span>{step.title}</span>
                <small>{labels[step.status]}</small>
              </li>
            ))}
          </ol>
          <p className="muted">
            Version {o.plan.version} · {o.plan.reason}
          </p>
        </details>
      )}
      {o.diagnosis && (
        <div className="v1-task-diagnosis" role="status">
          <strong>{o.diagnosis.message}</strong>
          <p>
            Stage: {o.diagnosis.stage} · {o.diagnosis.code}
          </p>
          {o.diagnosis.lastOperation && (
            <p>
              Last operation: {o.diagnosis.lastOperation.name} ·{" "}
              {o.diagnosis.lastOperation.status}
            </p>
          )}
          {o.diagnosis.issues.map((issue, i) => (
            <p key={i}>{issue}</p>
          ))}
          <p>
            Budget used: {o.budget.modelCalls}/{o.budget.limits.modelCalls}{" "}
            model calls · {o.budget.toolCalls}/{o.budget.limits.toolCalls} tools
            · {o.budget.tokens.toLocaleString()}/
            {o.budget.limits.tokens.toLocaleString()} tokens ·{" "}
            {Math.round(o.budget.activeMs / 1000)}s active
          </p>
        </div>
      )}
      {o.currentOperations.length > 0 && (
        <p className="muted">
          Current operation:{" "}
          {o.currentOperations.map((op) => op.name).join(", ")}
        </p>
      )}
      {o.children.length > 0 && (
        <details>
          <summary>Subtasks · {o.children.length}</summary>
          {o.children.map((child) => (
            <p key={child.id}>
              {child.prompt} · {child.state}
              {child.plan
                ? ` · ${child.plan.steps.filter((s) => s.status === "completed").length}/${child.plan.steps.length} steps`
                : ""}
            </p>
          ))}
        </details>
      )}
      {o.deliverables.length > 0 && (
        <details className="v1-deliverables" open>
          <summary>Saved deliverables · {o.deliverables.length}</summary>
          <ul>
            {o.deliverables.map((file) => (
              <li key={file.fileId}>
                <a href={file.downloadUrl} download>
                  {file.name} · v{file.version}
                </a>
                <span className="badge">
                  {
                    {
                      passed: "Passed",
                      failed: "Failed acceptance",
                      unverified: "Not verified",
                    }[file.validation]
                  }
                </span>
                <small>{file.bytes.toLocaleString()} bytes</small>
                {file.sources.map((source) => (
                  <a
                    key={source.id}
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {source.title || source.url}
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </details>
      )}
      {o.validation.length > 0 && (
        <details>
          <summary>Acceptance history · {o.validation.length}</summary>
          {o.validation.map((v) => (
            <div key={v.id}>
              <p>
                {new Date(v.createdAt).toLocaleString()} · {v.status} ·{" "}
                {v.artifacts.length} saved versions
              </p>
              {v.issues.map((issue, i) => (
                <p key={i}>{issue}</p>
              ))}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
