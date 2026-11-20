import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, RotateCw } from "lucide-react";
import "./elys-project-panel.css";

const identities = [
  { id: "user-lin", name: "林" },
  { id: "user-man", name: "曼" },
  { id: "user-shan", name: "珊" },
] as const;
type IdentityId = (typeof identities)[number]["id"];
type Status = "checking" | "loading" | "ready" | "error";
const views = [{ id: "", label: "聊天" }, { id: "memory", label: "记忆" }, { id: "alignment", label: "对齐" }, { id: "browser", label: "浏览器" }] as const;
const validId = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);

export default function ElysProjectPanel({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const [identity, setIdentity] = useState<IdentityId>("user-lin");
  const [view, setView] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Status>("checking");
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const loadTimer = useRef(0);
  const prefix =
    validId(workspaceId) && validId(projectId)
      ? `/api/project-apps/elys/${workspaceId}/${projectId}/${identity}/`
      : "";
  const activeIdentity = identities.find((item) => item.id === identity)!;
  const entry = prefix + (view ? "?view=" + view : "");

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setStatus("checking");
    setSource("");
    setError("");
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    const open = async () => {
      try {
        if (!prefix) throw Error("项目地址无效，请返回项目列表重新打开。");
        const response = await fetch(entry, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw Error(
            response.status === 401
              ? "登录已过期，请重新登录后重载。"
              : "Elys 暂时无法打开，请重载后再试。",
          );
        }
        await response.text();
        if (disposed) return;
        window.clearTimeout(timeout);
        setSource(entry);
        setStatus("loading");
        loadTimer.current = window.setTimeout(() => {
          setStatus("error");
          setError("Elys 加载超时，请重载后再试。");
        }, 30000);
      } catch (reason) {
        if (!disposed) {
          setStatus("error");
          setError(
            controller.signal.aborted
              ? "Elys 连接超时，请重载后再试。"
              : reason instanceof Error
                ? reason.message
                : "Elys 暂时无法打开，请重载后再试。",
          );
        }
      } finally {
        window.clearTimeout(timeout);
      }
    };
    void open();
    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(timeout);
      window.clearTimeout(loadTimer.current);
    };
  }, [prefix, entry, attempt]);

  return (
    <section className="elys-project" aria-label="Elys 工作区">
      <header className="elys-project-header">
        <div className="elys-project-heading">
          <span className="elys-project-mark" aria-hidden="true">
            E
          </span>
          <div>
            <h2>Elys 工作区</h2>
            <p>动态 · 私信 · 记忆 · 对齐 · 浏览器</p>
          </div>
        </div>
        <div className="elys-project-actions">
          <label className="elys-project-identity">
            当前身份
            <select
              aria-label="Elys 身份"
              value={identity}
              onChange={(event) =>
                setIdentity(event.target.value as IdentityId)
              }
            >
              {identities.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.id}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn small"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RotateCw size={14} />
            重载
          </button>
          {prefix && (
            <a
              className="btn small"
              href={entry}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={14} />
              独立打开
            </a>
          )}
        </div>
      </header>
      <nav className="elys-project-tabs" aria-label="Elys 功能">{views.map((item) => <button key={item.id} className="btn small" aria-pressed={view === item.id} onClick={() => setView(item.id)}>{item.label}</button>)}</nav>
      <div
        className="elys-project-stage"
        aria-busy={status === "checking" || status === "loading"}
      >
        {source && status !== "error" && (
          <iframe
            key={source + ":" + attempt}
            className="elys-project-frame"
            src={source}
            title={`Elys · ${activeIdentity.name}`}
            allow="clipboard-read; clipboard-write"
            onLoad={() => {
              window.clearTimeout(loadTimer.current);
              setStatus("ready");
            }}
            onError={() => {
              window.clearTimeout(loadTimer.current);
              setStatus("error");
              setError("Elys 加载失败，请重载后再试。");
            }}
          />
        )}
        {(status === "checking" || status === "loading") && (
          <div className="elys-project-state" role="status">
            <LoaderCircle size={22} className="elys-project-spinner" />
            <p>正在打开{activeIdentity.name}的 Elys…</p>
          </div>
        )}
        {status === "error" && (
          <div className="elys-project-state" role="alert">
            <p>{error}</p>
            <button
              className="btn"
              onClick={() => setAttempt((value) => value + 1)}
            >
              <RotateCw size={14} />
              重新加载 Elys
            </button>
          </div>
        )}
      </div>
      <footer className="elys-project-footer">
        <span
          className={"elys-project-dot " + (status === "ready" ? "ready" : "")}
          aria-hidden="true"
        />
        <span>
          {status === "ready"
            ? `当前：${activeIdentity.name} · 可直接在上方操作 Elys`
            : status === "error"
              ? "Elys 尚未连接"
              : "正在连接 Elys"}
        </span>
        <span>项目对话与资料在下方</span>
      </footer>
    </section>
  );
}
