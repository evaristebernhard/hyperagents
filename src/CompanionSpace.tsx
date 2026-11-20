import { useEffect, useRef, useState } from "react";
import {
  ArrowRight, Bot, Brain, Check, ChevronRight, Clock, History,
  LockKeyhole, MessageSquare, Pencil, Plus, Search, ShieldCheck,
  Sparkles, Trash2, Undo2, Users, X,
} from "lucide-react";
import type { DemoMemory, Navigate } from "./types";
import { useWorkspace } from "./workspace";
import { uid, now } from "./local-model";
import { Modal } from "./ui";
import {
  companionCategories, companionSources, companionStatusLabels, companionThreads,
  createCompanionAgent, createCompanionMemory, createCompanionThread,
  personalCompanion, reviseCompanionMemory,
  type CompanionSource, type CompanionStatus, type CompanionVisibility,
} from "./companion-model";
import "./companion-space.css";

const defaultPrompt = "你是我的个人分身，用自然、真诚的中文交流。尊重我表达的喜好和边界；优先使用已确认且与当前话题相关的记忆。记忆可能过时或有误，不确定时先向我核实。不要编造我的经历，也不要声称已经替我联系他人或执行工具。";
const dateLabel = (value: string) => new Date(value).toLocaleString("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
});

export default function CompanionSpace({ navigate, notify }: {
  navigate: Navigate; notify: (message: string) => void;
}) {
  const w = useWorkspace();
  const agent = personalCompanion(w.data.agents);
  const threads = agent ? companionThreads(w.data.threads, agent.id) : [];
  const sources = agent ? companionSources(w.data.threads, agent.id) : [];
  const memories = w.data.memories.filter((memory) => !!agent && memory.companion?.agentId === agent.id);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<CompanionStatus | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [visibilityFilter, setVisibilityFilter] = useState("all");
  const [modal, setModal] = useState<"" | "profile" | "memory" | "source" | "history" | "delete">("");
  const [profileName, setProfileName] = useState("");
  const [profileDescription, setProfileDescription] = useState("");
  const [profilePrompt, setProfilePrompt] = useState(defaultPrompt);
  const [editId, setEditId] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("想法");
  const [visibility, setVisibility] = useState<CompanionVisibility>("private");
  const [source, setSource] = useState<CompanionSource>();
  const [sourceQuery, setSourceQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const draftId = useRef("");
  const activeWorkspace = useRef(w.state.active);
  activeWorkspace.current = w.state.active;
  const handledSource = useRef("");
  const currentSearch = location.search;

  const openMemory = (memory?: DemoMemory, original?: CompanionSource) => {
    draftId.current = memory?.id || uid("memory");
    setEditId(memory?.id || "");
    setContent(memory?.content || original?.quote.slice(0, 2000) || "");
    setCategory(memory?.category || "想法");
    setVisibility(memory?.companion?.visibility || "private");
    setSource(memory?.companion?.source || original);
    setError("");
    setModal("memory");
  };

  useEffect(() => {
    const params = new URLSearchParams(currentSearch);
    const threadId = params.get("sourceThread"), messageId = params.get("sourceMessage");
    if (!threadId || !messageId || !agent) return;
    const key = w.state.active + ":" + threadId + ":" + messageId;
    if (handledSource.current === key) return;
    handledSource.current = key;
    const match = sources.find((item) => item.source.threadId === threadId && item.source.messageId === messageId);
    if (match) openMemory(undefined, match.source);
    else setError("未找到这条自聊原话。请从当前分身的自聊中选择一条自己的消息。");
  }, [currentSearch, agent?.id, w.state.active]);

  const save = async (label: string, update: () => void, after?: () => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setError("");
    const workspaceId = w.state.active;
    try {
      update();
      await w.flush();
      if (activeWorkspace.current !== workspaceId) return;
      notify(label);
      after?.();
    } catch (problem) {
      if (activeWorkspace.current === workspaceId)
        setError(problem instanceof Error ? problem.message : "保存失败，请重试。");
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  };

  const openProfile = () => {
    setProfileName(agent?.name || "我的分身");
    setProfileDescription(agent?.description || "陪我梳理想法，也记住我的日常。");
    setProfilePrompt(agent?.prompt || defaultPrompt);
    setError(""); setModal("profile");
  };

  const saveProfile = () => {
    if (!profileName.trim() || !profilePrompt.trim()) {
      setError("请填写分身名字和交流方式。"); return;
    }
    const id = agent?.id || uid("agent");
    void save("分身设定已保存", () => w.set("agents", (items) => {
      const current = personalCompanion(items);
      if (current && current.id !== id) throw Error("当前工作区已有个人分身，请刷新后编辑。");
      const input = { id, name: profileName, description: profileDescription, prompt: profilePrompt };
      return current ? items.map((item) => item.id === id ? {
        ...item, name: profileName.trim(), description: profileDescription.trim(), prompt: profilePrompt.trim(),
      } : item) : [...items, createCompanionAgent(input)];
    }), () => setModal(""));
  };

  const openChat = (newThread = false) => {
    if (!agent) return;
    const thread = !newThread && threads[0] || createCompanionThread(agent, {
      id: uid("thread"), at: now(), settings: w.data.preferences?.defaultThreadSettings,
    });
    void save("自聊已就绪", () => {
      if (newThread || !threads.length) w.set("threads", (items) => [...items, thread]);
    }, () => navigate("/thread/" + encodeURIComponent(thread.id)));
  };

  const saveMemory = () => {
    if (!agent) return;
    if (!content.trim() || content.trim().length > 2000) {
      setError("记忆内容需为1至2000字。"); return;
    }
    const id = draftId.current;
    void save(editId ? "记忆已更新" : "候选记忆已保存，请确认后使用", () => {
      w.set("memories", (items) => {
        const current = items.find((memory) => memory.id === id);
        if (current && current.companion?.agentId !== agent.id) throw Error("这条记忆不属于当前分身。");
        const next = current ? reviseCompanionMemory(current, { content, category, visibility }, "编辑", now()) :
          createCompanionMemory({ id, agentId: agent.id, content, category, visibility, source, at: now() });
        return current ? items.map((memory) => memory.id === id ? next : memory) : [...items, next];
      });
    }, () => setModal(""));
  };

  const changeStatus = (memory: DemoMemory, status: CompanionStatus, action: string) => {
    void save(`记忆${action}已保存`, () => w.set("memories", (items) => items.map((item) =>
      item.id === memory.id ? reviseCompanionMemory(item, {
        status, ...(status !== "active" ? { visibility: "private" } : {}),
      }, action, now()) : item,
    )));
  };

  const selected = memories.find((memory) => memory.id === selectedId);
  const filtered = memories.filter((memory) =>
    (statusFilter === "all" || memory.companion!.status === statusFilter) &&
    (categoryFilter === "all" || memory.category === categoryFilter) &&
    (visibilityFilter === "all" || memory.companion!.visibility === visibilityFilter) &&
    (!query.trim() || (memory.content + " " + (memory.companion!.source?.quote || "")).toLowerCase().includes(query.trim().toLowerCase())),
  ).sort((a, b) => b.companion!.updatedAt.localeCompare(a.companion!.updatedAt));

  if (w.mode !== "server") return <div className="companion-space"><p>个人分身需要连接工作区服务。</p></div>;

  return (
    <div className="companion-space">
      <header className="companion-header">
        <div><div className="companion-eyebrow"><Sparkles size={14} /> ELYS · 个人空间</div>
          <h1>让分身慢慢认识你</h1>
          <p>从一次聊天、一条经过确认的记忆开始。</p></div>
        <span className="companion-save-status" role="status">
          {busy || w.persistence === "saving" ? "正在保存…" :
            w.persistence === "error" || w.persistence === "conflict" ? "更改尚未保存" : "已保存到工作区"}
        </span>
      </header>
      {error && <div className="companion-error" role="alert">{error}</div>}
      <div className="companion-layout">
        <aside className="companion-aside">
          <section className="companion-identity">
            <div className="companion-avatar"><Bot size={28} /></div>
            <div className="companion-eyebrow">你的专属分身</div>
            <h2>{agent?.name || "先认识一下"}</h2>
            <p>{agent?.description || "给分身一个名字，告诉它你喜欢怎样交流。"}</p>
            {agent ? <>
              <button className="btn primary" disabled={!!busy} onClick={() => openChat()}>
                <MessageSquare size={16} />{threads.length ? "继续自聊" : "和分身聊聊"}<ArrowRight size={15} />
              </button>
              <div className="companion-identity-actions">
                <button className="btn small" disabled={!!busy} onClick={openProfile}><Pencil size={13} />编辑分身</button>
                {threads.length > 0 && <button className="btn small" disabled={!!busy} onClick={() => openChat(true)}><Plus size={13} />新自聊</button>}
              </div>
              {["off", "linked"].includes(agent.memoryReadScope || "") && <div className="companion-memory-disabled">
                <p>当前分身未开启相关记忆的自动检索。</p>
                <button className="btn small" disabled={!!busy} onClick={() => void save("已启用相关记忆", () => w.set("agents", (items) => items.map((item) => item.id === agent.id ? { ...item, memoryReadScope: "all" } : item)))}>启用相关记忆</button>
              </div>}
            </> : <button className="btn primary" onClick={openProfile}><Plus size={16} />创建个人分身</button>}
          </section>
          <section className="companion-note">
            <ShieldCheck size={18} />
            <div><h3>记住什么，由你决定</h3>
              <p>候选记忆经你确认后，分身会在新一轮的相关话题中使用。撤回后，新一轮不再提供这条记忆；历史记录仍保留。</p>
              <p>私有记忆用于自聊；选择可共享时，也允许用于该分身的其他聊天。</p>
            </div>
          </section>
          {threads.length > 0 && <section className="companion-conversations">
            <h3>最近的自聊</h3>
            {threads.slice(0, 5).map((thread) => <button key={thread.id} disabled={!!busy}
              onClick={() => void save("自聊已就绪", () => {}, () => navigate("/thread/" + encodeURIComponent(thread.id)))}>
              <MessageSquare size={14} /><span>{thread.title}</span><ChevronRight size={14} />
            </button>)}
          </section>}
        </aside>

        <section className="companion-memories" aria-labelledby="companion-memories-title">
          <div className="companion-section-header">
            <div><h2 id="companion-memories-title"><Brain size={20} />记忆库</h2>
              <p>{memories.filter((memory) => memory.companion!.status === "active").length} 条已确认
                <span aria-hidden="true"> · </span>{memories.filter((memory) => memory.companion!.status === "pending").length} 条待确认</p>
            </div>
            <div className="companion-toolbar">
              <button className="btn small" disabled={!agent || !!busy || !sources.length} onClick={() => {
                setSourceQuery(""); setError(""); setModal("source");
              }}><MessageSquare size={14} />从自聊整理</button>
              <button className="btn primary small" disabled={!agent || !!busy} onClick={() => openMemory()}>
                <Plus size={14} />添加候选</button>
            </div>
          </div>
          <div className="companion-tabs" aria-label="记忆状态筛选">
            {(["all", "pending", "active", "rejected"] as const).map((status) => <button key={status}
              aria-pressed={statusFilter === status} className={statusFilter === status ? "active" : ""}
              onClick={() => setStatusFilter(status)}>{status === "all" ? "全部记忆" : companionStatusLabels[status]}</button>)}
          </div>
          <div className="companion-filters">
            <label className="companion-search"><Search size={15} /><input aria-label="搜索记忆和来源原话"
              placeholder="搜索记忆和原话" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            <select aria-label="记忆类别" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
              <option value="all">所有类别</option>{companionCategories.map((value) => <option key={value}>{value}</option>)}
            </select>
            <select aria-label="记忆可见范围" value={visibilityFilter} onChange={(event) => setVisibilityFilter(event.target.value)}>
              <option value="all">所有范围</option><option value="private">仅自聊</option><option value="shared">该分身的其他聊天</option>
            </select>
          </div>
          <div className="companion-memory-list">
            {!filtered.length && <div className="companion-empty"><Brain size={30} />
              <h3>{memories.length ? "没有符合筛选的记忆" : "把值得记住的事留在这里"}</h3>
              <p>{memories.length ? "试试其他关键词或筛选条件。" : agent ?
                "写下你的喜好、表达习惯或最近的想法，保存候选后再确认。" : "创建个人分身后，就可以开始整理记忆。"}</p>
              {agent && !memories.length && <button className="btn small" disabled={!!busy} onClick={() => openMemory()}><Plus size={14} />写下第一条候选</button>}
            </div>}
            {filtered.map((memory) => <article className="companion-memory" key={memory.id}>
              <div className="companion-memory-meta"><span className="companion-category">{memory.category}</span>
                <span className={`companion-state ${memory.companion!.status}`}>{companionStatusLabels[memory.companion!.status]}</span>
                <span className="companion-visibility">{memory.companion!.visibility === "private" ? <LockKeyhole size={12} /> : <Users size={12} />}
                  {memory.companion!.visibility === "private" ? "仅自聊" : "该分身的其他聊天"}</span>
              </div>
              <p className="companion-memory-content">{memory.content}</p>
              {memory.companion!.source && <details className="companion-source-details"><summary>查看来源原话</summary>
                <blockquote>{memory.companion!.source.quote}</blockquote>
                {threads.some((thread) => thread.id === memory.companion!.source!.threadId) && <button className="btn small" disabled={!!busy}
                  onClick={() => void save("自聊已就绪", () => {}, () => navigate("/thread/" + encodeURIComponent(memory.companion!.source!.threadId)))}>打开来源自聊<ArrowRight size={12} /></button>}
              </details>}
              <footer><span className="companion-timestamp"><Clock size={12} />{dateLabel(memory.companion!.updatedAt)}</span>
                <div className="companion-memory-actions">
                  {memory.companion!.status === "pending" && <>
                    <button className="btn small companion-confirm" disabled={!!busy} onClick={() => changeStatus(memory, "active", "确认")}><Check size={13} />确认</button>
                    <button className="btn small" disabled={!!busy} onClick={() => changeStatus(memory, "rejected", "拒绝")}><X size={13} />拒绝</button>
                  </>}
                  {memory.companion!.status === "active" && <button className="btn small" disabled={!!busy} onClick={() => changeStatus(memory, "pending", "撤回")}><Undo2 size={13} />撤回</button>}
                  {memory.companion!.status === "rejected" && <button className="btn small" disabled={!!busy} onClick={() => changeStatus(memory, "pending", "重新整理")}><Undo2 size={13} />重新整理</button>}
                  <button className="btn small" disabled={!!busy} onClick={() => openMemory(memory)}><Pencil size={13} />编辑</button>
                  <button className="companion-icon-button" aria-label="查看记忆操作历史" title="操作历史" disabled={!!busy} onClick={() => { setSelectedId(memory.id); setModal("history"); }}><History size={15} /></button>
                  <button className="companion-icon-button" aria-label="删除记忆" title="删除记忆" disabled={!!busy} onClick={() => { setSelectedId(memory.id); setError(""); setModal("delete"); }}><Trash2 size={15} /></button>
                </div>
              </footer>
            </article>)}
          </div>
        </section>
      </div>

      {modal === "profile" && <Modal title={agent ? "编辑个人分身" : "创建个人分身"} onClose={() => { if (!busy) setModal(""); }} footer={<>
        <button className="btn" disabled={!!busy} onClick={() => setModal("")}>取消</button>
        <button className="btn primary" disabled={!!busy} onClick={saveProfile}>{busy ? "正在保存…" : "保存分身"}</button>
      </>}>
        <div className="companion-form">
          <label>分身名字<input aria-label="分身名字" maxLength={80} value={profileName} onChange={(event) => setProfileName(event.target.value)} /></label>
          <label>一句介绍<textarea aria-label="一句介绍" rows={2} maxLength={500} value={profileDescription} onChange={(event) => setProfileDescription(event.target.value)} /></label>
          <label>你希望它怎样交流<textarea aria-label="你希望它怎样交流" rows={7} maxLength={8000} value={profilePrompt} onChange={(event) => setProfilePrompt(event.target.value)} /></label>
          <p className="companion-help">名字和交流方式会用于真实自聊。记忆需要你逐条确认。</p>
          {error && <p className="companion-error" role="alert">{error}</p>}
        </div>
      </Modal>}

      {modal === "memory" && <Modal title={editId ? "编辑记忆" : "整理候选记忆"} onClose={() => { if (!busy) setModal(""); }} footer={<>
        <button className="btn" disabled={!!busy} onClick={() => setModal("")}>取消</button>
        <button className="btn primary" disabled={!!busy || !content.trim()} onClick={saveMemory}>{busy ? "正在保存…" : editId ? "保存更改" : "保存候选"}</button>
      </>}>
        <div className="companion-form">
          <label>要记住的内容<textarea aria-label="要记住的内容" rows={5} maxLength={2000} placeholder="例如：我更喜欢直接、简短的回复。"
            value={content} onChange={(event) => setContent(event.target.value)} /></label>
          <div className="companion-form-row"><label>类别<select aria-label="类别" value={category} onChange={(event) => setCategory(event.target.value)}>
            {companionCategories.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>可见范围<select aria-label="可见范围" value={visibility} onChange={(event) => setVisibility(event.target.value as CompanionVisibility)}>
              <option value="private">仅自聊（私有）</option><option value="shared">可用于该分身的其他聊天</option>
            </select></label></div>
          <p className="companion-help">{editId ? "已确认的记忆在保存后用于新一轮回答；可以在记忆卡片上撤回。" : "保存为待确认候选。你确认后，分身才会用于之后的回答。"}</p>
          {visibility === "shared" && <p className="companion-help"><Users size={14} />确认后，也允许用于选择此分身的其他聊天。内容不会自动发布。</p>}
          {source && <div className="companion-form-source"><span>来源：你的自聊原话</span><blockquote>{source.quote}</blockquote>
            <p className="companion-help">请自行整理上方内容，保存时保留这段原话供核对。</p></div>}
          {error && <p className="companion-error" role="alert">{error}</p>}
        </div>
      </Modal>}

      {modal === "source" && <Modal title="从自聊原话整理" onClose={() => setModal("")}>
        <div className="companion-form"><p className="companion-help">选择自己说过的一句话，手动整理成候选记忆。这一步由你编辑和确认。</p>
          <label className="companion-search"><Search size={15} /><input aria-label="搜索自聊原话" placeholder="搜索自己的原话"
            value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} /></label>
          <div className="companion-source-list">{sources.filter((item) => !sourceQuery || item.source.quote.toLowerCase().includes(sourceQuery.toLowerCase())).slice(0, 100).map((item) =>
            <button key={item.source.threadId + ":" + item.source.messageId} onClick={() => openMemory(undefined, item.source)}>
              <span>{item.threadTitle}</span><p>{item.source.quote}</p><span className="companion-source-select">整理这条原话<ArrowRight size={13} /></span>
            </button>)}
            {!sources.some((item) => !sourceQuery || item.source.quote.toLowerCase().includes(sourceQuery.toLowerCase())) && <p className="companion-help">没有找到匹配的原话。</p>}
          </div>
        </div>
      </Modal>}

      {modal === "history" && selected && <Modal title="记忆操作历史" onClose={() => setModal("")}>
        <div className="companion-history">{[...(selected.companion!.history || [])].reverse().map((entry, index) => <div key={index}>
          <div><strong>{entry.action}</strong><time>{dateLabel(entry.at)}</time></div>
          <p>{entry.content}</p><span>{companionStatusLabels[entry.status]} · {entry.visibility === "private" ? "仅自聊" : "该分身的其他聊天"}</span>
        </div>)}{!selected.companion!.history?.length && <p>这条记忆还没有操作记录。</p>}
          <p className="companion-help">保留最近50次操作。</p></div>
      </Modal>}

      {modal === "delete" && selected && <Modal title="删除这条记忆？" dialogRole="alertdialog" onClose={() => { if (!busy) setModal(""); }} footer={<>
        <button className="btn" disabled={!!busy} onClick={() => setModal("")}>取消</button>
        <button className="btn danger" disabled={!!busy} onClick={() => void save("记忆已删除", () => w.set("memories", (items) => items.filter((memory) => memory.id !== selected.id)), () => setModal(""))}>{busy ? "正在删除…" : "删除记忆"}</button>
      </>}><p>记忆及其操作历史会一并删除。想暂时停止使用，可以选择撤回。</p>
        <blockquote className="companion-delete-preview">{selected.content}</blockquote>
        {error && <p className="companion-error" role="alert">{error}</p>}
      </Modal>}
    </div>
  );
}
