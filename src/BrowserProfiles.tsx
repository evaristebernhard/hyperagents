import { useEffect, useState } from "react";
import { useWorkspace } from "./workspace";
import { v1 } from "./v1-client";
import BrowserPanel, {
  type BrowserProfile,
  type BrowserSession,
} from "./BrowserPanel";
export default function BrowserProfiles() {
  const w = useWorkspace();
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [members, setMembers] = useState<
    { id: string; email: string; role: string }[]
  >([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const admin = w.role === "admin",
    available = w.capabilities?.browser?.available;
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      v1<BrowserProfile[]>("/browser/profiles", { signal: controller.signal }),
      v1<BrowserSession[]>("/browser/sessions", { signal: controller.signal }),
      admin
        ? v1<{ id: string; email: string; role: string }[]>("/members", {
            signal: controller.signal,
          }).catch(() => [])
        : Promise.resolve([]),
    ])
      .then(([p, s, m]) => {
        if (!controller.signal.aborted) {
          setProfiles(p);
          setSessions(s);
          setMembers(m);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [reload, admin, w.state.active]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setReload((x) => x + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="browser-profiles">
      <h2>Browser identities</h2>
      <p>
        {available
          ? "Browser service connected"
          : "Browser unavailable · The isolated browser service is not connected."}
      </p>
      <p className="muted">
        Each identity keeps its own website logins. Team identities are separate
        from personal identities. Closing a session keeps its logins; deleting
        an identity removes them.
      </p>
      {error && <p role="alert">{error}</p>}
      {admin && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await v1("/browser/profiles", { method: "POST", body: { name } });
              setName("");
            });
          }}
        >
          <label>
            Identity name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
            />
          </label>
          <button className="btn" disabled={busy || !name.trim()}>
            Create identity
          </button>
        </form>
      )}
      {profiles.map((p) => {
        const session = sessions.find(
          (s) =>
            s.profile_id === p.id && ["open", "starting"].includes(s.state),
        );
        return (
          <article className="card" key={p.id}>
            <h3>{p.name}</h3>
            <p>
              {p.kind} · {session ? session.state : "Closed"}
            </p>
            <div className="browser-controls">
              <button
                className="btn small"
                disabled={busy || !available}
                onClick={() =>
                  void run(async () => {
                    const s =
                      session ||
                      (await v1<BrowserSession>("/browser/sessions", {
                        method: "POST",
                        body: { profileId: p.id },
                      }));
                    setSelected(s.id);
                  })
                }
              >
                Open / sign in
              </button>
              {session && (
                <button
                  className="btn small"
                  disabled={busy || !available}
                  onClick={() =>
                    void run(() =>
                      v1(`/browser/sessions/${session.id}/close`, {
                        method: "POST",
                      }),
                    )
                  }
                >
                  Close session
                </button>
              )}
              {admin && (
                <>
                  <button
                    className="btn small"
                    disabled={busy}
                    onClick={() => {
                      const next = window.prompt("Identity name", p.name);
                      if (next?.trim())
                        void run(() =>
                          v1(`/browser/profiles/${p.id}`, {
                            method: "PATCH",
                            body: { name: next },
                          }),
                        );
                    }}
                  >
                    Rename
                  </button>
                  <button
                    className="btn small"
                    disabled={busy || !!session || !available}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete ${p.name} and its saved website logins?`,
                        )
                      )
                        void run(() =>
                          v1(`/browser/profiles/${p.id}`, { method: "DELETE" }),
                        );
                    }}
                  >
                    Delete identity
                  </button>
                </>
              )}
            </div>
            {admin && p.kind === "team" && (
              <fieldset>
                <legend>Members allowed to use this identity</legend>
                {members
                  .filter((m) => m.role !== "viewer")
                  .map((m) => (
                    <label key={m.id}>
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={!!p.grants?.includes(m.id)}
                        onChange={(e) =>
                          void run(() =>
                            v1(`/browser/profiles/${p.id}/grants`, {
                              method: "PUT",
                              body: {
                                userIds: e.target.checked
                                  ? [...(p.grants || []), m.id]
                                  : (p.grants || []).filter(
                                      (id) => id !== m.id,
                                    ),
                              },
                            }),
                          )
                        }
                      />
                      {m.email}
                    </label>
                  ))}
              </fieldset>
            )}
          </article>
        );
      })}
      {selected && <BrowserPanel key={selected} sessionId={selected} />}
    </section>
  );
}
