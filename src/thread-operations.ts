import type { useWorkspace } from "./workspace";
import { api } from "./backend-client";
export async function deleteThreadData(store: ReturnType<typeof useWorkspace>, id: string) {
  const workspaceId = store.state.active;
  await store.flush();
  const { shares } = await api<{ shares: { id: string; revokedAt?: string }[] }>("/api/shares?workspaceId=" + encodeURIComponent(workspaceId) + "&threadId=" + encodeURIComponent(id));
  for (const share of shares.filter(s => !s.revokedAt)) await api("/api/shares/" + encodeURIComponent(share.id), { method: "DELETE" });
  store.set("artifacts", items => items.map(a => a.threadId === id ? { ...a, threadId: undefined } : a));
  store.set("threads", items => items.filter(t => t.id !== id));
  await store.flush();
}
