export type AgentCreationDraft = {
  name?: string;
  description?: string;
  prompt?: string;
  promptHtml?: string;
  job?: string;
  manual?: boolean;
  model?: string;
  provider?: string;
  reasoning?: string;
  tools?: string[];
  skillIds?: string[];
  library?: boolean;
  memoryMode?: string;
  memoryReadScope?: string;
  memorySaveTarget?: string;
  learnsAutomatically?: boolean;
  learning?: Record<string, string>;
  casting?: { job: string; lens: string; world: string };
};
const key = (workspace: string) => "hyperagents-demo:agent-creation:" + workspace;
export function readAgentDraft(workspace: string): AgentCreationDraft {
  try {
    const value = JSON.parse(localStorage.getItem(key(workspace)) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: AgentCreationDraft = {};
    for (const name of ["name", "description", "prompt", "promptHtml", "job", "model", "provider", "reasoning", "memoryMode", "memoryReadScope", "memorySaveTarget"] as const) {
      if (typeof value[name] === "string" && value[name].length <= 250000) out[name] = value[name];
    }
    for (const name of ["manual", "library", "learnsAutomatically"] as const) {
      if (typeof value[name] === "boolean") out[name] = value[name];
    }
    for (const name of ["tools", "skillIds"] as const) {
      if (Array.isArray(value[name]) && value[name].length < 1000 && value[name].every((v: unknown) => typeof v === "string")) out[name] = value[name];
    }
    if (value.learning && typeof value.learning === "object" && !Array.isArray(value.learning)) {
      const learning: Record<string, string> = Object.create(null);
      for (const [name, entry] of Object.entries(value.learning)) {
        if (name !== "__proto__" && typeof entry === "string") learning[name] = entry;
      }
      out.learning = learning;
    }
    if (value.casting && ["job", "lens", "world"].every(n => typeof value.casting[n] === "string")) {
      out.casting = { job: value.casting.job.slice(0, 10000), lens: value.casting.lens, world: value.casting.world.slice(0, 1000) };
    }
    return out;
  } catch { return {}; }
}
export function writeAgentDraft(workspace: string, patch: AgentCreationDraft): boolean {
  try {
    localStorage.setItem(key(workspace), JSON.stringify({ ...readAgentDraft(workspace), ...patch }));
    return true;
  } catch { return false; }
}
export function clearAgentDraft(workspace: string) {
  try { localStorage.removeItem(key(workspace)); } catch { /* Current form can still be saved locally. */ }
}
export const knowledgeProfiles = [
  ["Connected memory", "Reads the whole memory library and adds what it learns to it, so every other agent with Connected memory benefits."],
  ["Read-only memory", "Reads only the memories linked to it, plus its own, and never changes them."],
  ["Separate memory", "Reads only the memories linked to it, plus its own, and keeps what it learns in its own memory."],
  ["Custom memory", "Choose what it reads and where it saves what it learns."],
] as const;
export function normalizeMemoryProfile(value?: string) {
  if (knowledgeProfiles.some(([name]) => name === value)) return value!;
  return value === "Recall-only memory" ? "Read-only memory" : "Custom memory";
}
