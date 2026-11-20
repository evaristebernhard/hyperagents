import { Monitor, ShieldCheck, FolderClock } from 'lucide-react';
import { useWorkspace } from '../workspace';
import { api } from '../backend-client';
import BrowserSessionPanel from './BrowserSessionPanel';
import './browser-session.css';

export default function BrowserWorkspacePage() {
  const workspace = useWorkspace();
  return <main className="pb-workspace">
    <header className="pb-workspace-heading"><div><span className="pb-workspace-kicker"><Monitor size={15} /> {workspace.activeName}</span><h1>浏览器工作台</h1><p>在对话中开启 Browser 工具，agent 会使用这里的身份。登录时接管，完成后交还。</p></div><div className="pb-workspace-facts"><span><FolderClock size={15} />保留登录身份</span><span><ShieldCheck size={15} />随时人工接管</span></div></header>
    {workspace.mode === 'server' ? <BrowserSessionPanel key={workspace.state.active} apiBase="/api/browser" workspaceId={workspace.state.active} requestJson={(path, options) => api(path, options)} /> : <p className="pb-empty">浏览器工作台需要连接当前工作区服务。</p>}
  </main>;
}
