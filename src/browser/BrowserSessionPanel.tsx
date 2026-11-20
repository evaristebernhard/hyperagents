import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import './browser-session.css';

export type BrowserSession = {
  id: string; profileId: string; label?: string; url: string; title?: string;
  status: 'open' | 'closed' | 'error' | 'reconnecting';
  control: 'agent' | 'human' | 'transferring' | 'paused'; epoch: number;
  viewport: { width: number; height: number };
  tabs: { id: string; url: string; title?: string }[]; activeTabId?: string; error?: string;
  createdAt?: string; lastSeen?: string; canGoBack?: boolean; canGoForward?: boolean; viewRevision?: number;
};
type BrowserCapabilities = { configured: boolean; available: boolean; reason?: string; persistent?: boolean };
type JsonRequest = (path: string, options: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }) => Promise<unknown>;
type Props = { apiBase?: string; workspaceId?: string; threadId?: string; initialSessionId?: string; requestJson?: JsonRequest };
type Frame = { src: string; sessionId: string; id: string; epoch: number; revision: number; width: number; height: number; capturedAt: number };
type Input = { type: 'click'; x: number; y: number } | { type: 'key'; key: string } | { type: 'text'; text: string } | { type: 'scroll'; deltaX: number; deltaY: number };
type Transition = { sessionId: string; action: 'takeover' | 'handback'; expectedEpoch: number; requestId: string };
const DEFAULT_URL = 'https://example.com';
const validSessionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(value);
const displayOrigin = (value: string) => { try { return new URL(value).hostname || '空白页'; } catch { return '空白页'; } };
const storageKey = (base: string, workspaceId?: string) => `hyperagents:browser-view:v1:${base}:${workspaceId || 'personal'}`;
function savedView(base: string, workspaceId?: string): { sessionId?: string; zoom?: string } {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(base, workspaceId)) || '{}');
    return { ...(validSessionId(value.sessionId) ? { sessionId: value.sessionId } : {}), ...(['fit', '1', '1.5'].includes(value.zoom) ? { zoom: value.zoom } : {}) };
  } catch { return {}; }
}
const controlLabel = { agent: 'AI 控制', human: '你正在接管', transferring: '正在交接', paused: '已暂停' };
const statusLabel = { open: '已连接', closed: '已关闭', error: '连接异常', reconnecting: '正在重连' };
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : '请求未完成，请刷新状态。';

async function defaultRequest(path: string, options: Parameters<JsonRequest>[1]) {
  const response = await fetch(path, { method: options.method, credentials: 'same-origin', cache: 'no-store', signal: options.signal, ...(options.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : `浏览器请求失败（${response.status}）。`);
  return result;
}

export default function BrowserSessionPanel({ apiBase = '/api/agent/browser', workspaceId, threadId, initialSessionId, requestJson = defaultRequest }: Props) {
  const [sessions, setSessions] = useState<BrowserSession[]>([]), [session, setSession] = useState<BrowserSession | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [capabilities, setCapabilities] = useState<BrowserCapabilities | null>(null), [connection, setConnection] = useState<'checking' | 'connected' | 'disconnected'>('checking');
  const [lastSyncedAt, setLastSyncedAt] = useState<number>(), [showSessions, setShowSessions] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null), [frameError, setFrameError] = useState('');
  const [address, setAddress] = useState(DEFAULT_URL), [remoteText, setRemoteText] = useState(''), [unconfirmed, setUnconfirmed] = useState<Transition | null>(null);
  const [zoom, setZoom] = useState('fit');
  const current = useRef<BrowserSession | null>(null), frameRef = useRef<Frame | null>(null), selectedId = useRef('');
  const alive = useRef(true), lifecycle = useRef(0), mutationVersion = useRef(0), pending = useRef(false), typingRevision = useRef(0);
  const screen = useRef<HTMLDivElement>(null), image = useRef<HTMLImageElement>(null), keyboardCapture = useRef<HTMLTextAreaElement>(null), scopeAbort = useRef<AbortController | null>(null), imageBusy = useRef(false);
  const composing = useRef(false), compositionCommit = useRef<string | null>(null);
  const wheel = useRef({ x: 0, y: 0, timer: 0 }), inputRef = useRef<(input: Input) => Promise<boolean>>(async () => false);
  const transitionRef = useRef<Transition | null>(null), requestRef = useRef(requestJson);
  const inputTail = useRef(Promise.resolve(false)), inputGeneration = useRef(0), inputCount = useRef(0), captureStarted = useRef(0);
  requestRef.current = requestJson;
  const base = apiBase.replace(/\/$/, '');
  const scope = `${base}\n${workspaceId || ''}\n${threadId || ''}\n${initialSessionId || ''}`;

  const path = useCallback((suffix: string) => {
    if (!base.startsWith('/api/') || base.startsWith('//') || /[?#]/.test(base)) throw new Error('浏览器 API 必须使用本站地址。');
    const url = new URL(base + suffix, window.location.origin);
    if (workspaceId) url.searchParams.set('workspaceId', workspaceId);
    if (threadId) url.searchParams.set('threadId', threadId);
    return url.pathname + url.search;
  }, [base, workspaceId, threadId]);
  const json = useCallback(async <T,>(suffix: string, body?: unknown, signal = scopeAbort.current?.signal) => {
    const life = lifecycle.current, abort = new AbortController();
    const cancel = () => abort.abort(); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) abort.abort();
    let timer = 0;
    try {
      const result = await Promise.race([
        requestRef.current(path(suffix), { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body }), signal: abort.signal }),
        new Promise<never>((_, reject) => { timer = window.setTimeout(() => { abort.abort(); reject(new Error('浏览器请求超时，请先刷新核对状态。')); }, 20000); }),
      ]);
      if (!alive.current || life !== lifecycle.current || abort.signal.aborted) throw new DOMException('Viewer changed', 'AbortError');
      return result as T;
    } finally { window.clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }, [path]);
  const clearWheel = useCallback(() => {
    window.clearTimeout(wheel.current.timer); wheel.current = { x: 0, y: 0, timer: 0 };
  }, []);
  const clearFrame = useCallback(() => { frameRef.current = null; setFrame(null); setFrameError(''); }, []);
  const apply = useCallback((next: BrowserSession, select = true) => {
    if (!alive.current) return;
    setSessions(previous => [next, ...previous.filter(item => item.id !== next.id)]);
    if (!select && selectedId.current !== next.id) return;
    if (current.current?.id === next.id && current.current.epoch > next.epoch) return;
    const previous = current.current;
    const changed = previous?.id !== next.id || previous.epoch !== next.epoch;
    selectedId.current = next.id; current.current = next; setSession(next);
    if (changed) { inputGeneration.current++; clearWheel(); clearFrame(); typingRevision.current++; setRemoteText(''); composing.current = false; compositionCommit.current = null; if (keyboardCapture.current) keyboardCapture.current.value = ''; }
    if (next.status !== 'open') clearFrame();
    if (previous?.id !== next.id || previous.url !== next.url) setAddress(next.url && next.url !== 'about:blank' ? next.url : DEFAULT_URL);
    try { const old = savedView(base, workspaceId); localStorage.setItem(storageKey(base, workspaceId), JSON.stringify({ ...old, sessionId: next.id })); } catch {}
    const transfer = transitionRef.current;
    if (transfer?.sessionId === next.id && next.epoch > transfer.expectedEpoch && next.control === (transfer.action === 'takeover' ? 'human' : 'agent')) {
      transitionRef.current = null; setUnconfirmed(null); setError('');
      setNotice(next.control === 'human' ? '已核对：接管成功，可以操作当前画面。' : '已核对：浏览器已交还 AI。');
    }
  }, [base, workspaceId, clearFrame, clearWheel]);

  const refreshSession = useCallback(async () => {
    const id = selectedId.current, version = mutationVersion.current, epoch = lifecycle.current;
    if (!id) return;
    const { session: next } = await json<{ session: BrowserSession }>(`/sessions/${encodeURIComponent(id)}`);
    if (alive.current && epoch === lifecycle.current && id === selectedId.current && version === mutationVersion.current) apply(next, false);
  }, [apply, json]);
  const refreshList = useCallback(async (choose = false) => {
    const epoch = lifecycle.current, version = mutationVersion.current;
    const result = await json<{ items?: BrowserSession[]; sessions?: BrowserSession[] }>('/sessions');
    if (!alive.current || epoch !== lifecycle.current || version !== mutationVersion.current) return;
    const items = result.items || result.sessions || [];
    setSessions(items); setLoading(false);
    const preferredId = initialSessionId || savedView(base, workspaceId).sessionId;
    if (choose && !selectedId.current && preferredId) {
      const owned = items.find(item => item.id === preferredId);
      if (owned) apply(owned);
      else if (initialSessionId) { const { session: next } = await json<{ session: BrowserSession }>(`/sessions/${encodeURIComponent(initialSessionId)}`); if (alive.current && epoch === lifecycle.current) apply(next); }
      else if (items.length) apply(items.find(item => item.status === 'open') || items[0]);
    } else if (choose && !selectedId.current && items.length) apply(items.find(item => item.status === 'open') || items[0]);
  }, [apply, json, initialSessionId, base, workspaceId]);
  const refreshCapabilities = useCallback(async () => {
    const value = await json<BrowserCapabilities>('/capabilities');
    setCapabilities(value);
    if (!value.available) setConnection('disconnected');
    return value;
  }, [json]);

  const capture = useCallback(async () => {
    const value = current.current, life = lifecycle.current;
    if (connection !== 'connected' || imageBusy.current || !value || value.status !== 'open' || document.hidden || Date.now() - captureStarted.current < 500) return;
    imageBusy.current = true; captureStarted.current = Date.now();
    let objectUrl = '';
    try {
      const response = await fetch(path(`/sessions/${encodeURIComponent(value.id)}/screenshot`), { credentials: 'same-origin', cache: 'no-store', signal: scopeAbort.current?.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.error === 'string' ? body.error : `画面读取失败（${response.status}）。`);
      }
      const id = response.headers.get('X-Browser-Frame'), epoch = Number(response.headers.get('X-Browser-Epoch'));
      const revision = Number(response.headers.get('X-Browser-Revision') || 0);
      const width = Number(response.headers.get('X-Browser-Width')), height = Number(response.headers.get('X-Browser-Height'));
      if (!id || !response.headers.has('X-Browser-Epoch') || !Number.isFinite(epoch) || width <= 0 || height <= 0 || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('画面缺少会话校验信息，请刷新重试。');
      objectUrl = URL.createObjectURL(await response.blob());
      const decoded = new Image(); decoded.src = objectUrl; await decoded.decode();
      if (!alive.current || life !== lifecycle.current || current.current?.id !== value.id || current.current.epoch !== epoch || !['open', 'reconnecting'].includes(current.current.status)) return;
      setFrame({ src: objectUrl, sessionId: value.id, id, epoch, revision, width, height, capturedAt: Date.now() }); objectUrl = '';
      setFrameError('');
    } catch (reason) {
      if (alive.current && life === lifecycle.current && !scopeAbort.current?.signal.aborted && selectedId.current === value.id) setFrameError(errorText(reason));
    } finally { if (objectUrl) URL.revokeObjectURL(objectUrl); imageBusy.current = false; }
  }, [path, connection]);

  useEffect(() => {
    alive.current = true; const life = ++lifecycle.current, abort = new AbortController(); scopeAbort.current = abort;
    selectedId.current = ''; current.current = null; mutationVersion.current++; pending.current = false;
    transitionRef.current = null; setUnconfirmed(null); setSession(null); setSessions([]); setLoading(true); setBusy(''); setError(''); setNotice(''); setCapabilities(null); setConnection('checking'); setLastSyncedAt(undefined); setShowSessions(false); setZoom('fit'); clearFrame();
    let timer = 0, cycles = 0;
    const update = async (initial = false) => {
      try {
        if (initial || cycles++ % 5 === 0) {
          const health = await refreshCapabilities();
          if (!health.available) { setLoading(false); return; }
        }
        if (initial || !selectedId.current) await refreshList(true); else await Promise.all([refreshSession(), ...(cycles % 5 === 0 ? [refreshList()] : [])]);
        if (!abort.signal.aborted && life === lifecycle.current) { setConnection('connected'); setLastSyncedAt(Date.now()); }
      }
      catch (reason) { if (!abort.signal.aborted && life === lifecycle.current) { setConnection('disconnected'); setError(errorText(reason)); setLoading(false); } }
      finally { if (!abort.signal.aborted) timer = window.setTimeout(() => void update(), document.hidden ? 10000 : 2000); }
    };
    void update(true);
    return () => { alive.current = false; lifecycle.current++; inputGeneration.current++; abort.abort(); window.clearTimeout(timer); clearWheel(); frameRef.current = null; };
  }, [scope, refreshList, refreshSession, refreshCapabilities, clearFrame, clearWheel, base, workspaceId]);

  useEffect(() => {
    let timer = 0, disposed = false;
    const update = async () => { await capture(); if (!disposed) timer = window.setTimeout(() => void update(), document.hidden ? 5000 : 750); };
    const visible = () => { if (!document.hidden) { window.clearTimeout(timer); void update(); } };
    void update(); document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [capture, session?.id, session?.status, session?.epoch]);
  useEffect(() => () => { if (frame) URL.revokeObjectURL(frame.src); }, [frame]);

  const perform = async (label: string, operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; mutationVersion.current++; setBusy(label); setError(''); setNotice(''); clearWheel();
    const life = lifecycle.current;
    try { await operation(); }
    catch (reason) {
      if (alive.current && lifecycle.current === life) {
        setError(errorText(reason));
        await refreshSession().catch(() => undefined);
      }
    } finally {
      if (alive.current && lifecycle.current === life) { pending.current = false; setBusy(''); void capture(); }
    }
  };
  const create = (profileId?: string, url = address.trim() || DEFAULT_URL) => void perform('正在打开浏览器…', async () => {
    const { session: next } = await json<{ session: BrowserSession }>('/sessions', { ...(profileId ? { profileId } : { url }), label: '持久浏览器' });
    apply(next); setConnection('connected'); await refreshList(); setNotice(profileId ? '已恢复同一浏览器身份。登录资料保留，网页是否仍登录由网站决定。' : '浏览器已打开。点击接管后，可在画面中自行登录。');
  });
  const switchSession = (id: string) => void perform('正在切换会话…', async () => {
    const { session: next } = await json<{ session: BrowserSession }>(`/sessions/${encodeURIComponent(id)}`);
    apply(next); transitionRef.current = null; setUnconfirmed(null);
  });
  const transition = (action: Transition['action'], retry = false) => {
    const value = current.current; if (!value || value.status !== 'open') return;
    const transfer = retry && transitionRef.current?.sessionId === value.id ? transitionRef.current : { sessionId: value.id, action, expectedEpoch: value.epoch, requestId: crypto.randomUUID() };
    transitionRef.current = transfer; setUnconfirmed(transfer);
    void perform(action === 'takeover' ? '正在请求接管…' : '正在交还 AI…', async () => {
      const { session: next } = await json<{ session: BrowserSession }>(`/sessions/${encodeURIComponent(transfer.sessionId)}/${transfer.action}`, { expectedEpoch: transfer.expectedEpoch, requestId: transfer.requestId });
      apply(next);
      if (next.control !== (transfer.action === 'takeover' ? 'human' : 'agent')) throw new Error('控制交接尚未完成，请核对控制状态。');
      transitionRef.current = null; setUnconfirmed(null);
      setNotice(next.control === 'human' ? '接管已确认，可以操作下方画面。' : '已交还 AI；浏览器和登录资料继续保留。');
    });
  };

  const inputOnce = async (input: Input, displayed: Frame) => {
    const value = current.current;
    if (pending.current || !value || value.status !== 'open' || value.control !== 'human' || !displayed || displayed.sessionId !== value.id || displayed.epoch !== value.epoch || transitionRef.current) return false;
    let saved = false;
    await perform('正在发送操作…', async () => {
      const { session: next } = await json<{ session: BrowserSession }>(`/sessions/${encodeURIComponent(value.id)}/input`, { expectedEpoch: value.epoch, frameId: displayed.id, ...input });
      apply(next, false); saved = true;
    });
    return saved;
  };
  const sendInput = async (input: Input) => {
    const value = current.current, displayed = frameRef.current, generation = inputGeneration.current;
    if (connection !== 'connected' || !value || value.status !== 'open' || value.control !== 'human' || !displayed || displayed.sessionId !== value.id || displayed.epoch !== value.epoch || transitionRef.current) return false;
    if (inputCount.current >= 200) { setError('输入太快，请等待网页响应后继续。'); return false; }
    inputCount.current++;
    const run = inputTail.current.catch(() => false).then(async () => {
      if (generation !== inputGeneration.current || current.current?.id !== value.id || current.current.epoch !== value.epoch) return false;
      const saved = await inputOnce(input, displayed);
      if (!saved) inputGeneration.current++; // A failed/ambiguous operation cancels the remaining queue; never replay it.
      return saved;
    }).finally(() => { inputCount.current--; });
    inputTail.current = run; return run;
  };
  inputRef.current = sendInput;
  const canControl = connection === 'connected' && !!session && session.status === 'open' && session.control === 'human' && !busy && !unconfirmed && !!frame && frame.epoch === session.epoch;
  const canInteract = connection === 'connected' && !!session && session.status === 'open' && session.control === 'human' && (!busy || busy === '正在发送操作…') && !unconfirmed && !!frame && frame.epoch === session.epoch;
  const canClick = canInteract && frame!.revision >= (session!.viewRevision || 0);
  useEffect(() => {
    const element = screen.current; if (!element) return;
    const listener = (event: WheelEvent) => {
      const value = current.current, displayed = frameRef.current;
      if (connection !== 'connected' || event.shiftKey || pending.current || value?.control !== 'human' || value.status !== 'open' || displayed?.epoch !== value.epoch || transitionRef.current) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? value.viewport.height : 1;
      wheel.current.x += event.deltaX * scale; wheel.current.y += event.deltaY * scale;
      if (!wheel.current.timer) wheel.current.timer = window.setTimeout(() => {
        const { x, y } = wheel.current; wheel.current = { x: 0, y: 0, timer: 0 };
        void inputRef.current({ type: 'scroll', deltaX: Math.max(-1600, Math.min(1600, x)), deltaY: Math.max(-1600, Math.min(1600, y)) });
      }, 100);
    };
    element.addEventListener('wheel', listener, { passive: false });
    return () => { element.removeEventListener('wheel', listener); clearWheel(); };
  }, [session?.id, frame?.sessionId, connection, clearWheel]);

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canInteract || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.key === 'Process' || event.key === 'Dead' || ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    if (event.key === 'Tab' && event.shiftKey) return; // Shift+Tab leaves the remote canvas for accessible local controls.
    compositionCommit.current = null;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return; // Browser paste event owns the text, never send Control+V remotely.
    const key = event.key === ' ' ? 'Space' : event.key;
    const shortcut = (event.ctrlKey || event.metaKey) && key.toLowerCase() === 'a' ? (event.metaKey ? 'Meta+A' : 'Control+A') : key;
    if ((event.ctrlKey || event.metaKey || event.altKey) && !['Meta+A', 'Control+A'].includes(shortcut)) return;
    if (!(!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) && !['Enter','Tab','Backspace','Delete','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Space','Meta+A','Control+A'].includes(shortcut)) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) void sendInput({ type: 'text', text: event.key });
    else void sendInput({ type: 'key', key: shortcut });
  };
  const commitDirectText = (text: string) => { if (text && canInteract) void sendInput({ type: 'text', text }); };
  const submitText = async (event: FormEvent) => {
    event.preventDefault(); if (!remoteText || !canControl) return;
    const revision = typingRevision.current, submitted = remoteText;
    if (await sendInput({ type: 'text', text: submitted })) {
      if (typingRevision.current === revision) { typingRevision.current++; setRemoteText(''); }
      keyboardCapture.current?.focus({ preventScroll: true });
    }
  };
  const navigate = (url: string) => void perform('正在打开网址…', async () => {
    const value = current.current; if (!value || value.control !== 'human') return;
    const { session: next } = await json<{ session: BrowserSession }>(`/sessions/${encodeURIComponent(value.id)}/navigate`, { url, expectedEpoch: value.epoch });
    apply(next); clearFrame();
  });
  const activateTab = (tabId: string) => void perform('正在切换标签页…', async () => {
    const value = current.current; if (!value || value.control !== 'human') return;
    const { session: next } = await json<{ session: BrowserSession }>(`/sessions/${encodeURIComponent(value.id)}/activate-tab`, { tabId, expectedEpoch: value.epoch });
    apply(next); clearFrame();
  });
  const history = (direction: 'back' | 'forward' | 'reload') => void perform('正在切换页面…', async () => {
    const value = current.current; if (!value || value.control !== 'human') return;
    const { session: next } = await json<{ session: BrowserSession }>(`/sessions/${encodeURIComponent(value.id)}/history`, { direction, expectedEpoch: value.epoch });
    apply(next); clearFrame();
  });
  const tab = (action: 'new' | 'close', tabId?: string) => void perform(action === 'new' ? '正在新建标签页…' : '正在关闭标签页…', async () => {
    const value = current.current; if (!value || value.control !== 'human') return;
    const { session: next } = await json<{ session: BrowserSession }>(`/sessions/${encodeURIComponent(value.id)}/tab`, { action, ...(tabId ? { tabId } : {}), ...(action === 'new' ? { url: address.trim() || DEFAULT_URL } : {}), expectedEpoch: value.epoch });
    apply(next); clearFrame();
  });
  const reconnect = () => void perform('正在重新连接…', async () => {
    const health = await refreshCapabilities();
    if (!health.available) throw new Error(health.reason || '浏览器服务尚未连接。');
    await refreshList(true); await refreshSession(); setConnection('connected'); setError(''); setLastSyncedAt(Date.now());
    setNotice('已重新连接。浏览器控制权按服务端状态恢复。');
  });

  return <section className="pb-panel" aria-label="持久浏览器">
    <header className="pb-heading"><div><h2>持久浏览器</h2><p>网页、标签页和登录资料留在同一身份中。关闭面板后，下次可以继续。</p></div><button type="button" className="pb-button" disabled={!!busy} onClick={reconnect}>重新连接</button></header>
    <div className={`pb-connection pb-connection-${connection}`} role="status"><span className="pb-connection-dot" aria-hidden="true" /><strong>{connection === 'checking' ? '正在检查浏览器服务' : connection === 'connected' ? '浏览器服务已连接' : '浏览器连接已中断'}</strong><span>{lastSyncedAt ? `最近同步 ${new Date(lastSyncedAt).toLocaleTimeString()}` : capabilities?.reason || '正在读取当前工作区的浏览器状态'}</span></div>
    {capabilities && !capabilities.available && <div className="pb-pending"><p>{capabilities.reason || '浏览器控制器暂不可达。恢复连接后，原身份仍可继续使用。'}</p><button type="button" className="pb-button" disabled={!!busy} onClick={reconnect}>检查并重连</button></div>}
    {error && <p className="pb-error" role="alert">{error} 输入和点击不会自动重试。</p>}
    {notice && <p className="pb-notice" role="status">{notice}</p>}
    <details className="pb-session-details" open={!session}><summary>会话与身份 · {sessions.length}</summary><div className="pb-session-row"><label>浏览器会话<select aria-label="浏览器会话" disabled={!!busy || !sessions.length} value={session?.id || ''} onChange={event => switchSession(event.target.value)}>{!session && <option value="">选择会话</option>}{sessions.map(item => <option key={item.id} value={item.id}>{item.label || item.title || '浏览器'} · {displayOrigin(item.url)} · {statusLabel[item.status]}</option>)}</select></label><button type="button" className="pb-button" disabled={!!busy || loading || connection !== 'connected'} onClick={() => create()}>连接个人浏览器</button><button type="button" className="pb-button" disabled={!!busy} aria-expanded={showSessions} onClick={() => setShowSessions(value => !value)}>查看已保存会话</button></div>
    {showSessions && <div className="pb-saved-sessions" aria-label="已保存浏览器会话">{sessions.length ? sessions.map(item => <button type="button" key={item.id} className={`pb-session-card ${session?.id === item.id ? 'pb-selected' : ''}`} disabled={!!busy || connection !== 'connected'} aria-pressed={session?.id === item.id} onClick={() => switchSession(item.id)}><strong>{item.title || item.label || '个人浏览器'}</strong><span>{displayOrigin(item.url)} · {statusLabel[item.status]}</span><small>身份 {item.profileId.slice(0, 8)} · 会话 {item.id.slice(0, 8)}{item.lastSeen ? ` · ${new Date(item.lastSeen).toLocaleString()}` : ''}</small></button>) : <p className="pb-muted">还没有保存的浏览器会话。打开一个网页即可开始。</p>}</div>}</details>
    {loading && <p role="status" className="pb-muted">正在读取持久会话…</p>}
    {!loading && !session && <div className="pb-empty"><h3>从一个网页开始</h3><p>输入公开网址，打开后可以接管操作；登录时直接在浏览器里完成。</p><form className="pb-start-form" onSubmit={event => { event.preventDefault(); create(); }}><input aria-label="打开网页地址" type="url" required value={address} onChange={event => setAddress(event.target.value)} placeholder="https://example.com" /><button type="submit" className="pb-button pb-primary" disabled={!!busy || connection !== 'connected'}>打开网页</button></form></div>}
    {session && <>
      <div className="pb-control-bar"><div><strong className={`pb-state pb-${session.control}`} role="status">{controlLabel[session.control]}</strong><span className="pb-muted">{statusLabel[session.status]} · {session.tabs.length} 个标签页</span></div><div className="pb-actions">{session.status === 'closed' ? <button type="button" className="pb-button pb-primary" disabled={!!busy || connection !== 'connected'} onClick={() => create(session.profileId)}>使用原登录资料重开</button> : ['error', 'reconnecting'].includes(session.status) ? <button type="button" className="pb-button pb-primary" disabled={!!busy || connection !== 'connected'} onClick={() => create(session.profileId)}>恢复原浏览器</button> : session.control === 'human' ? <button type="button" className="pb-button pb-primary" disabled={!!busy || !!unconfirmed || connection !== 'connected' || session.status !== 'open'} onClick={() => transition('handback')}>交还 AI</button> : <button type="button" className="pb-button pb-primary" disabled={!!busy || !!unconfirmed || connection !== 'connected' || session.status !== 'open' || session.control === 'transferring'} onClick={() => transition('takeover')}>接管浏览器</button>}</div></div>
      {unconfirmed && !busy && <div className="pb-pending" role="status"><p>交接结果尚未确认，输入已暂停。先刷新状态；仍未确认时可安全重试本次交接。</p><button type="button" className="pb-button" onClick={() => void perform('正在核对控制状态…', refreshSession)}>核对控制状态</button><button type="button" className="pb-button" onClick={() => transition(unconfirmed.action, true)}>重试本次交接</button></div>}
      <details className="pb-page-details"><summary>网址与标签页 · {displayOrigin(session.url)}</summary><form className="pb-address" onSubmit={event => { event.preventDefault(); if (canControl) navigate(address); }}><div className="pb-navigation" role="group" aria-label="网页导航"><button type="button" className="pb-button" aria-label="后退一页" title="后退" disabled={!canControl || session.canGoBack === false} onClick={() => history('back')}>←</button><button type="button" className="pb-button" aria-label="前进一页" title="前进" disabled={!canControl || session.canGoForward === false} onClick={() => history('forward')}>→</button><button type="button" className="pb-button" aria-label="重新加载网页" title="重新加载" disabled={!canControl} onClick={() => history('reload')}>↻</button></div><label className="pb-sr-only" htmlFor={`pb-url-${session.id}`}>当前网址</label><input id={`pb-url-${session.id}`} aria-label="浏览器网址" type="url" value={address} onChange={event => setAddress(event.target.value)} disabled={!canControl} autoComplete="off" spellCheck={false} /><button className="pb-button" disabled={!canControl || !address.trim()}>前往</button></form>
      <div className="pb-tabs" role="group" aria-label="浏览器标签页">{session.tabs.map(item => <div className={`pb-tab ${session.activeTabId === item.id ? 'pb-active' : ''}`} key={item.id}><button type="button" className="pb-button" aria-pressed={session.activeTabId === item.id} disabled={!canControl || session.activeTabId === item.id} onClick={() => activateTab(item.id)} title={item.title || item.url}>{item.title || displayOrigin(item.url) || '标签页'}</button><button type="button" className="pb-tab-close" aria-label={`关闭标签页 ${item.title || displayOrigin(item.url)}`} disabled={!canControl} onClick={() => tab('close', item.id)}>×</button></div>)}<button type="button" className="pb-button pb-tab-new" aria-label="新建标签页" title="在新标签页打开地址栏网址" disabled={!canControl} onClick={() => tab('new')}>＋</button></div></details>
      {session.error && <p className="pb-error" role="alert">{session.error}</p>}
      <div className="pb-view-options"><label>画面缩放<select aria-label="画面缩放" value={zoom} onChange={event => setZoom(event.target.value)}><option value="fit">小屏适应</option><option value="1">原尺寸</option><option value="1.5">150%</option></select></label><button type="button" className="pb-button" onClick={() => setZoom(zoom === 'fit' ? '1' : 'fit')}>{zoom === 'fit' ? '放大查看' : '返回小屏'}</button></div>
      <div className={`pb-screen ${canClick ? 'pb-interactive' : ''} ${zoom !== 'fit' ? 'pb-zoomed' : ''}`} data-click-ready={canClick ? 'true' : 'false'} ref={screen} tabIndex={-1} role="application" aria-label="浏览器实时画面" aria-description="接管后点击网页目标，即可直接输入中文或粘贴。Shift加Tab返回本地控制按钮。" onKeyDown={keyDown} onFocus={event => { if (event.target === event.currentTarget && canInteract) keyboardCapture.current?.focus({ preventScroll: true }); }}>
        {frame ? <img ref={image} style={zoom === 'fit' ? undefined : { width: frame.width * Number(zoom), maxWidth: 'none' }} src={frame.src} alt="当前持久浏览器的实时截图" draggable={false} onLoad={event => { if (event.currentTarget.currentSrc === frame.src && current.current?.id === frame.sessionId && current.current.epoch === frame.epoch) frameRef.current = frame; }} onClick={event => {
          if (!canClick || !frameRef.current || frameRef.current.src !== frame.src) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const x = Math.min(frame.width - 1, Math.max(0, (event.clientX - rect.left) / rect.width * frame.width));
          const y = Math.min(frame.height - 1, Math.max(0, (event.clientY - rect.top) / rect.height * frame.height));
          keyboardCapture.current?.focus({ preventScroll: true }); void sendInput({ type: 'click', x: Math.round(x), y: Math.round(y) });
        }} onContextMenu={event => event.preventDefault()} /> : <div className="pb-screen-empty" role="status">{session.status === 'closed' ? '浏览器已关闭，登录资料仍保留。' : frameError ? '暂时无法读取画面。' : '正在读取浏览器画面…'}</div>}
        {session.status === 'open' && session.control !== 'human' && <div className="pb-takeover-overlay"><strong>{session.control === 'transferring' ? '正在交接控制权' : '画面只读，开始操作后可输入'}</strong><button type="button" className="pb-button pb-primary" disabled={!!busy || !!unconfirmed || connection !== 'connected' || session.control === 'transferring'} onClick={event => { event.stopPropagation(); transition('takeover'); }}>点击开始操作</button><span>接管后，再点击网页中的输入框</span></div>}
        <textarea ref={keyboardCapture} className="pb-direct-input" aria-label="直接输入到远程网页" tabIndex={canInteract ? 0 : -1} disabled={!canInteract} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-lpignore="true" onCompositionStart={event => { composing.current = true; compositionCommit.current = null; event.currentTarget.value = ''; }} onCompositionEnd={event => { const text = event.data || event.currentTarget.value; composing.current = false; compositionCommit.current = text; event.currentTarget.value = ''; commitDirectText(text); }} onInput={event => { const native = event.nativeEvent as InputEvent; if (composing.current || native.isComposing) return; const text = event.currentTarget.value; event.currentTarget.value = ''; if (compositionCommit.current && (native.data === compositionCommit.current || text === compositionCommit.current)) { compositionCommit.current = null; return; } compositionCommit.current = null; commitDirectText(text); }} onPaste={event => { event.preventDefault(); event.stopPropagation(); compositionCommit.current = null; event.currentTarget.value = ''; commitDirectText(event.clipboardData.getData('text/plain')); }} />
      </div>
      <div className="pb-frame-status"><span>{frame ? `${frame.width}×${frame.height} · ${new Date(frame.capturedAt).toLocaleTimeString()} 更新` : '等待会话画面'}{connection !== 'connected' ? ' · 等待重新连接' : session.control !== 'human' ? ' · 只读画面' : canClick ? ' · 可点击、键盘输入、滚动' : ' · 正在更新画面，稍后可点击'}</span><span>{busy || (frameError ? '画面暂时中断' : '')}</span></div>
      {frameError && <p className="pb-error" role="alert">{frameError}<button type="button" className="pb-button" disabled={!!busy} onClick={() => void capture()}>刷新画面</button></p>}
      <form className="pb-text-form" onSubmit={event => void submitText(event)}><label htmlFor={`pb-input-${session.id}`}>向网页输入（仅发往当前浏览器）</label><div><input id={`pb-input-${session.id}`} aria-label="向网页输入" type="password" value={remoteText} onChange={event => { typingRevision.current++; setRemoteText(event.target.value); }} disabled={connection !== 'connected' || session.control !== 'human' || session.status !== 'open' || !!unconfirmed} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} placeholder="先点击画面中的目标输入框" /><button className="pb-button" disabled={!canControl || !remoteText}>输入到网页</button></div></form>
      <div className="pb-keys" role="group" aria-label="远程键盘和滚动">{['Tab', 'Enter', 'Backspace', 'Escape'].map(key => <button key={key} type="button" className="pb-button" disabled={!canControl} onClick={() => void sendInput({ type: 'key', key })}>{key}</button>)}<button type="button" className="pb-button" disabled={!canControl} onClick={() => void sendInput({ type: 'scroll', deltaX: 0, deltaY: -500 })}>向上滚动</button><button type="button" className="pb-button" disabled={!canControl} onClick={() => void sendInput({ type: 'scroll', deltaX: 0, deltaY: 500 })}>向下滚动</button></div>
      <footer className="pb-footer"><span>会话 {session.id.slice(0, 8)} · 登录资料 {session.profileId.slice(0, 8)}</span><button type="button" className="pb-button" disabled={!!busy || session.status === 'closed'} onClick={() => void perform('正在关闭浏览器…', async () => { const value = current.current; if (!value) return; const { session: next } = await json<{ session: BrowserSession }>(`/sessions/${encodeURIComponent(value.id)}/close`, { expectedEpoch: value.epoch }); apply(next); setNotice('浏览器已关闭，登录资料保留，可使用原身份重开。'); })}>关闭浏览器（保留登录资料）</button></footer>
    </>}
  </section>;
}
