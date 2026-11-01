import type { ToolRun } from './types';
import { formatToolActivity, type ActivityModel } from './tool-activity-model';
import './tool-activity.css';

function StatusIcon({ model }: { model: ActivityModel }) {
  const kind = model.state === 'error' ? 'error' : model.state === 'running' ? 'running' : model.outcome || 'success';
  return (
    <svg className={`tool-activity__icon tool-activity__icon--${kind}`} width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {kind === 'running' ? <><circle cx="10" cy="10" r="7" opacity=".25" /><path d="M10 3a7 7 0 0 1 7 7" /></> :
        kind === 'success' ? <><circle cx="10" cy="10" r="7" /><path d="m6.5 10 2.3 2.3 4.7-4.7" /></> :
        kind === 'error' ? <><circle cx="10" cy="10" r="7" /><path d="m7.5 7.5 5 5m0-5-5 5" /></> :
        kind === 'approval' ? <><circle cx="10" cy="10" r="7" /><path d="M8 7v6m4-6v6" /></> :
        <><path d="M5 3h7l3 3v11H5zM11 3v4h4M8 11h4m-4 3h3" /></>}
    </svg>
  );
}

/** Native details/summary provides keyboard expansion without extra UI dependencies. */
export default function ToolActivity({ runs }: { runs: ToolRun[] }) {
  if (!runs.length) return null;
  return (
    <section className="tool-activity" aria-label="Tool activity">
      <ul className="tool-activity__list">
        {runs.map((run) => {
          const model = formatToolActivity(run);
          return (
            <li key={run.id} className="tool-activity__item">
              <details className={`tool-activity__chip tool-activity__chip--${model.state}`}>
                <summary className="tool-activity__summary">
                  <StatusIcon model={model} />
                  <span className="tool-activity__label">{model.label}</span>
                  {model.query && <span className="tool-activity__query">· {model.query}</span>}
                  <span className="tool-activity__status" role="status">{model.statusText}</span>
                  <span className="tool-activity__chevron" aria-hidden="true">⌄</span>
                </summary>
                <div className="tool-activity__body">
                  {model.text && <p className="tool-activity__text">{model.text}</p>}
                  {model.results.length > 0 && (
                    <ol className="tool-activity__results" aria-label="Returned items">
                      {model.results.map((result, index) => (
                        <li key={index}>
                          <div className="tool-activity__result-title">
                            {result.initial && <span className="tool-activity__domain-icon" aria-hidden="true">{result.initial}</span>}
                            {result.url ? <a href={result.url} target="_blank" rel="noopener noreferrer">{result.title}<span className="tool-activity__sr-only"> (opens in a new tab)</span></a> : <span>{result.title}</span>}
                          </div>
                          {result.domain && <span className="tool-activity__domain">{result.domain}</span>}
                          {result.excerpt && <p className="tool-activity__excerpt">{result.excerpt}</p>}
                        </li>
                      ))}
                    </ol>
                  )}
                  {model.omittedResults > 0 && <p className="tool-activity__more">{model.omittedResults} additional items not shown.</p>}
                  {model.raw && <details className="tool-activity__raw"><summary>Raw details (bounded)</summary><pre>{model.raw}</pre></details>}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
