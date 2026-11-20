import type { DemoAgent, DemoMemory, DemoThread, ThreadSettings } from "./types";
import { defaultThreadSettings } from "./types";

export const companionCategories = ["想法", "口吻", "喜好", "习惯", "近况"] as const;
export type CompanionDetails = NonNullable<DemoMemory["companion"]>;
export type CompanionStatus = CompanionDetails["status"];
export type CompanionVisibility = CompanionDetails["visibility"];
export type CompanionSource = NonNullable<CompanionDetails["source"]>;
export const companionStatusLabels: Record<CompanionStatus, string> = {
  pending: "待确认", active: "已确认", rejected: "已拒绝",
};

export function personalCompanion(agents: DemoAgent[]): DemoAgent | undefined {
  return agents.find((agent) => agent.companion === true && !agent.archived);
}

export function createCompanionAgent(input: {
  id: string; name: string; description: string; prompt: string;
}): DemoAgent {
  if (!input.name.trim() || !input.prompt.trim()) throw Error("请填写分身名字和交流方式。");
  return {
    ...input, name: input.name.trim(), description: input.description.trim(),
    prompt: input.prompt.trim(), companion: true, tools: ["Thread Search", "Documents"],
    memoryReadScope: "all", memorySaveTarget: "agent", learnsAutomatically: false,
    memoryMode: "Separate memory", libraryEnabled: false, skillIds: [],
  };
}

export function companionThreads(threads: DemoThread[], agentId: string): DemoThread[] {
  return threads.filter((thread) => !thread.archived && !thread.roomId &&
    thread.companionAgentId === agentId && thread.config?.agentId === agentId)
    .sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""));
}

export function createCompanionThread(agent: DemoAgent, input: {
  id: string; at: string; settings?: ThreadSettings;
}): DemoThread {
  if (!agent.companion || agent.archived) throw Error("个人分身暂不可用。");
  const settings = input.settings || defaultThreadSettings;
  return {
    id: input.id, title: `和${agent.name}聊聊`, summary: "", time: "刚刚",
    companionAgentId: agent.id, messages: [], createdAt: input.at, updatedAt: input.at,
    config: {
      ...settings, agentId: agent.id, model: agent.model || settings.model,
      reasoning: agent.reasoning || settings.reasoning,
      provider: agent.provider || settings.provider, mode: "Execute",
      tools: [...(agent.tools || defaultThreadSettings.tools)],
    },
  };
}

export function companionSources(threads: DemoThread[], agentId: string) {
  return companionThreads(threads, agentId).flatMap((thread) =>
    (thread.messages || []).filter((message) => message.role === "user" && !message.runContinuation && message.id && message.text.trim())
      .map((message) => ({ threadTitle: thread.title, source: {
        threadId: thread.id, messageId: message.id!, quote: message.text.slice(0, 4000),
      } })),
  );
}

export function createCompanionMemory(input: {
  id: string; agentId: string; content: string; category: string; at: string;
  visibility?: CompanionVisibility; source?: CompanionSource;
}): DemoMemory {
  if (!input.content.trim() || input.content.trim().length > 2000) throw Error("记忆内容需为1至2000字。");
  if (!companionCategories.includes(input.category as typeof companionCategories[number]))
    throw Error("请选择有效的记忆类别。");
  const content = input.content.trim();
  const visibility = input.visibility || "private";
  return {
    id: input.id, content, category: input.category, importance: 3, pinned: false,
    scope: input.agentId, companion: {
      agentId: input.agentId, status: "pending", visibility,
      createdAt: input.at, updatedAt: input.at, ...(input.source ? { source: input.source } : {}),
      history: [{ action: "创建候选", content, status: "pending", visibility, at: input.at }],
    },
  };
}

export function reviseCompanionMemory(memory: DemoMemory, patch: {
  content?: string; category?: string; status?: CompanionStatus; visibility?: CompanionVisibility;
}, action: string, at: string): DemoMemory {
  if (!memory.companion) throw Error("这条记忆不属于个人分身。");
  const content = (patch.content ?? memory.content).trim();
  if (!content || content.length > 2000) throw Error("记忆内容需为1至2000字。");
  const category = patch.category ?? memory.category;
  if (!companionCategories.includes(category as typeof companionCategories[number]))
    throw Error("请选择有效的记忆类别。");
  const status = patch.status ?? memory.companion.status;
  const visibility = patch.visibility ?? memory.companion.visibility;
  return {
    ...memory, content, category, companion: {
      ...memory.companion, status, visibility, updatedAt: at,
      history: [...(memory.companion.history || []).slice(-49), {
        action, content, status, visibility, at,
      }],
    },
  };
}
