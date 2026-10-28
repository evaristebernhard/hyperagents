import { useEffect, useState, type ReactNode } from "react";
import { api, getSession, fixtureMode, type SessionInfo } from "./backend-client";
import "./backend-ui.css";
export default function BackendGate({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setError("");
    try { const next = await getSession(); setInfo(next); if (next.authenticated) setUnlocked(true); }
    catch (e) { setError(e instanceof Error ? e.message : "The data service is unavailable."); }
  };
  useEffect(() => {
    if (fixtureMode()) return;
    void check();
    const expired = () => setInfo({ authenticated: false, setupRequired: false });
    const logout = () => { setUnlocked(false); setInfo({ authenticated: false, setupRequired: false }); };
    window.addEventListener("backend-session-expired", expired);
    window.addEventListener("backend-logout", logout);
    return () => { window.removeEventListener("backend-session-expired", expired); window.removeEventListener("backend-logout", logout); };
  }, []);
  if (fixtureMode()) return <>{children}</>;
  const authenticated = !!info?.authenticated;
  return <>
    {unlocked && children}
    {!authenticated && <div className="backend-auth" role={unlocked ? "dialog" : undefined} aria-modal={unlocked ? true : undefined} aria-label="Local workspace sign in">
      <form className="backend-auth-card" onSubmit={async e => {
        e.preventDefault(); if (busy || !info) return;
        if (info.setupRequired && password !== confirmation) { setError("Passwords do not match."); return; }
        setBusy(true); setError("");
        try {
          const next = await api<SessionInfo>(info.setupRequired ? "/api/setup" : "/api/login", { method: "POST", body: { password } });
          if (!next.authenticated) throw new Error("Sign-in did not establish a session.");
          setPassword(""); setConfirmation(""); setInfo(next); setUnlocked(true);
          window.dispatchEvent(new Event("backend-session-restored"));
        } catch (e) { setError(e instanceof Error ? e.message : "Could not sign in."); }
        finally { setBusy(false); }
      }}>
        <small>HYPERAGENTS · LOCAL DATA SERVICE</small>
        <h1>{!info ? "Connect your workspace" : info.setupRequired ? "Set up your private workspace" : "Sign in to your workspace"}</h1>
        <p>{!info ? "Start the project with npm run dev. The API and database must be available; sample data is not used as a fallback." : info.setupRequired ? "Create the single-owner password on this computer. It is hashed in the local database, never stored in the browser." : "Your conversations and files stay in your local data service. Model and browser execution are not connected."}</p>
        {info && <><label className="field">Password<input type="password" aria-label="Password" required minLength={info.setupRequired ? 12 : undefined} autoComplete={info.setupRequired ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} /></label>
          {info.setupRequired && <><label className="field">Confirm password<input type="password" aria-label="Confirm password" required autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label><small>Use at least 12 characters. Initial setup is only available through a local loopback origin.</small></>}
          <button className="btn primary" type="submit" disabled={busy || !password || (info.setupRequired && password.length < 12)}>{busy ? "Connecting…" : info.setupRequired ? "Create owner account" : "Sign in"}</button>
        </>}
        {error && <p role="alert" className="backend-error">{error}</p>}
        {!info && <button className="btn" type="button" onClick={() => void check()}>Retry connection</button>}
      </form>
    </div>}
  </>;
}
