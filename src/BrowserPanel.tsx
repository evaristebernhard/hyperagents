import { useEffect, useRef, useState } from "react";
import { v1, type Identity } from "./v1-client";
import "./browser-panel.css";
export type BrowserSession = {
  id: string;
  profile_id: string;
  profile_name?: string;
  task_id: string | null;
  state: string;
  control: "agent" | "transferring" | "human" | "paused";
  control_epoch: number;
  controller_id: string | null;
  tabs: { tabId: string; title: string; url: string; active: boolean }[];
};
export type BrowserProfile = {
  id: string;
  name: string;
  kind: string;
  grants: string[] | null;
};
export default function BrowserPanel({
  taskId,
  sessionId,
}: {
  taskId?: string;
  sessionId?: string;
}) {
  const [session, setSession] = useState<BrowserSession>();
  const [identity, setIdentity] = useState<Identity>();
  const [error, setError] = useState("");
  const [connection, setConnection] = useState("Disconnected");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState(false);
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<{ disconnect(): void }>();
  const connectEpoch = useRef(0);
  const transition = useRef<{
    key: string;
    action: string;
    epoch: number;
    note: string;
  }>();
  const disconnect = () => {
    connectEpoch.current++;
    rfb.current?.disconnect();
    rfb.current = undefined;
    setConnection("Disconnected");
  };
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const [sessions, user] = await Promise.all([
          sessionId
            ? v1<BrowserSession>(`/browser/sessions/${sessionId}`, {
                signal: abort.signal,
              }).then((s) => [s])
            : v1<BrowserSession[]>(
                `/browser/sessions${taskId ? "?taskId=" + taskId : ""}`,
                { signal: abort.signal },
              ),
          v1<Identity>("/auth/session", { signal: abort.signal }),
        ]);
        if (!abort.signal.aborted) {
          setSession(sessions[0]);
          setIdentity(user);
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          disconnect();
          setError(e instanceof Error ? e.message : "Connection failed");
        }
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(poll, 2000);
      }
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
      connectEpoch.current++;
      rfb.current?.disconnect();
    };
  }, [taskId, sessionId]);
  useEffect(() => {
    disconnect();
  }, [session?.id, session?.control_epoch, session?.state]);
  async function connectView(permission: "observe" | "write") {
    if (!session || !screen.current) return;
    disconnect();
    const generation = connectEpoch.current;
    setError("");
    setConnection("Connecting…");
    try {
      const [{ ticket }, { default: RFB }] = await Promise.all([
        v1<{ ticket: string }>(`/browser/sessions/${session.id}/view-ticket`, {
          method: "POST",
          body: { permission },
        }),
        import("@novnc/novnc"),
      ]);
      if (generation !== connectEpoch.current || !screen.current) return;
      const url = new URL(
        `/api/v1/browser/sessions/${session.id}/view`,
        location.href,
      );
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket);
      const client = new RFB(screen.current, url.href);
      client.viewOnly = permission === "observe";
      client.scaleViewport = true;
      client.resizeSession = false;
      client.addEventListener("connect", () =>
        setConnection(
          permission === "write"
            ? "Connected · You control this browser"
            : "Connected · Read only",
        ),
      );
      client.addEventListener("disconnect", () => {
        if (generation === connectEpoch.current)
          setConnection("Disconnected · Control has not been handed back");
      });
      rfb.current = client;
    } catch (e) {
      if (generation === connectEpoch.current) {
        setConnection("Disconnected");
        setError(e instanceof Error ? e.message : "Connection failed");
      }
    }
  }
  async function control(action: "takeover" | "handback") {
    if (!session) return;
    disconnect();
    setBusy(true);
    setError("");
    // Retain the exact key/body after a lost response so retry completes the same transition.
    const prior = transition.current;
    const request =
      prior?.action === action
        ? prior
        : {
            key: crypto.randomUUID(),
            action,
            epoch: session.control_epoch,
            note,
          };
    transition.current = request;
    try {
      const next = await v1<BrowserSession>(
        `/browser/sessions/${session.id}/${action}`,
        {
          method: "POST",
          key: request.key,
          body: { expectedEpoch: request.epoch, note: request.note },
        },
      );
      setSession(next);
      transition.current = undefined;
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Control change failed. Retry the same action.",
      );
    } finally {
      setBusy(false);
    }
  }
  const mine = session?.controller_id === identity?.userId;
  return (
    <section
      className={`browser-panel ${expanded ? "browser-expanded" : ""}`}
      aria-label="Persistent browser"
    >
      <div className="browser-heading">
        <strong>{session?.profile_name || "Browser"}</strong>
        <button className="btn small" onClick={() => setExpanded((x) => !x)}>
          {expanded ? "Exit expanded view" : "Expand"}
        </button>
      </div>
      {session ? (
        <>
          <p className="browser-address">
            {session.tabs.find((t) => t.active)?.url ||
              session.tabs[0]?.url ||
              "No page yet"}
          </p>
          <p role="status">
            {connection} · {session.state} ·{" "}
            {mine
              ? "You"
              : session.controller_id
                ? `User ${session.controller_id.slice(0, 8)}`
                : "Agent"}{" "}
            · {session.control}
          </p>
          <div className="browser-controls">
            {taskId && ["closed", "error"].includes(session.state) && (
              <button
                className="btn small"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void v1<BrowserSession>("/browser/sessions", {
                    method: "POST",
                    body: {
                      profileId: session.profile_id,
                      ...(taskId ? { taskId } : {}),
                    },
                  })
                    .then(setSession)
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                Reopen browser
              </button>
            )}
            <button
              className="btn small"
              disabled={
                session.state !== "open" || session.control === "transferring"
              }
              onClick={() => void connectView("observe")}
            >
              View only
            </button>
            {session.control === "human" && mine ? (
              <>
                <button
                  className="btn small primary"
                  onClick={() => void connectView("write")}
                >
                  Connect controls
                </button>
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() => void control("handback")}
                >
                  Hand back to agent
                </button>
              </>
            ) : (
              <button
                className="btn small primary"
                disabled={
                  busy ||
                  session.state !== "open" ||
                  (session.control === "human" && !mine) ||
                  (session.control === "transferring" && !transition.current)
                }
                onClick={() =>
                  void control(
                    (transition.current?.action as "takeover" | "handback") ||
                      "takeover",
                  )
                }
              >
                {session.control === "transferring"
                  ? "Retry control transfer"
                  : "Take over"}
              </button>
            )}
            <button className="btn small" onClick={disconnect}>
              Disconnect view
            </button>
          </div>
          {mine && session.control === "human" && (
            <label>
              Note for the agent (optional)
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                placeholder="What changed or what to do next"
              />
            </label>
          )}
          <p className="muted">
            Sign in directly in the browser. Disconnecting keeps the agent
            paused. Use Hand back to agent when you are ready.
          </p>
        </>
      ) : (
        <p className="muted">
          Select a browser identity when sending a task. Its session will appear
          here when the agent opens the browser.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div
        className="browser-screen"
        ref={screen}
        aria-label="Remote browser screen"
      />
    </section>
  );
}
