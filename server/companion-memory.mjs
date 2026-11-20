/** Companion records share workspace storage, but never share implicit read authority. */
export const COMPANION_MEMORY_LIMITS = Object.freeze({ content: 2000, quote: 4000, history: 50, action: 80, items: 4, bytes: 6000, itemBytes: 1600 });
export const SCNET_COMPANION_LIMITS = Object.freeze({ items: 2, bytes: 500, personaBytes: 400 });

export function canReadCompanionThread(target, { thread, agent, selectedAgentId = agent?.id } = {}) {
  if (target?.companionAgentId === undefined) return true;
  return Boolean(thread && target.id === thread.id && agent?.companion === true && !agent.archived
    && selectedAgentId === agent.id && target.companionAgentId === agent.id
    && thread.companionAgentId === agent.id && target.config?.agentId === agent.id
    && thread.config?.agentId === agent.id && target.roomId === undefined && thread.roomId === undefined);
}

export function canReadCompanionMemory(memory, { agent, thread, selectedAgentId = agent?.id, selectedMemoryIds = [] } = {}) {
  const companion = memory?.companion;
  if (companion === undefined) return true;
  if (!companion || companion.status !== 'active' || agent?.companion !== true || agent.archived
    || agent.id !== selectedAgentId || companion.agentId !== agent.id || agent.memoryReadScope === 'off') return false;
  if (agent.memoryReadScope === 'linked' && !new Set(selectedMemoryIds || []).has(memory.id)) return false;
  if (companion.visibility === 'shared') return true;
  return companion.visibility === 'private' && thread?.companionAgentId === agent.id
    && canReadCompanionThread(thread, { thread, agent, selectedAgentId });
}

export function clipCompanionText(value, budget) {
  let text = '', used = 0;
  for (const character of String(value || '')) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > budget) break;
    text += character; used += size;
  }
  return text;
}

const stop = new Set(['喜欢', '自己', '本人', '分身', '什么', '如何', '可以', '帮我', '请问', '今天', '我们', '这个', '那个', 'the', 'and', 'you', 'your', 'with', 'that', 'this', 'for', 'are']);
function terms(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase();
  const result = new Set((text.match(/[a-z0-9]{2,}/g) || []).filter(word => !stop.has(word)));
  const normalized = text.replace(/我(?:的)?|本人|自己|分身|喜欢|什么|如何|可以|帮我|请问|一个|这个|那个|我们|今天/g, ' ');
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    for (const character of run) if ('茶辣甜糖猫狗书酒奶饭肉鱼鸟咸酸苦'.includes(character)) result.add(character);
    for (let index = 0; index < run.length - 1; index++) {
      const word = run.slice(index, index + 2);
      if (!stop.has(word)) result.add(word);
    }
  }
  if (/饮品|饮料|喝什么|喝的|想喝/.test(text)) for (const word of ['茶', '咖啡', '牛奶', '果汁', '饮料']) result.add(word);
  return result;
}
const style = memory => [memory.category, ...(memory.tags || [])].some(value => /^(?:口吻|语气|风格|style|tone|voice)$/i.test(value));

/** Only confirmed, authorized and actually supplied text earns a knowledge hint. */
export function selectCompanionMemories(memories, { query, agent, thread, selectedAgentId = agent?.id, selectedMemoryIds = [], maxItems = COMPANION_MEMORY_LIMITS.items, byteBudget = COMPANION_MEMORY_LIMITS.bytes, itemByteBudget = COMPANION_MEMORY_LIMITS.itemBytes } = {}) {
  const explicit = new Set(selectedMemoryIds || []), queryTerms = terms(query);
  const ranked = (memories || []).filter(memory => memory.companion && !memory.archived
    && canReadCompanionMemory(memory, { agent, thread, selectedAgentId, selectedMemoryIds: explicit }))
    .map(memory => {
      const matched = [...terms(memory.content)].filter(term => queryTerms.has(term));
      return { memory, matched, explicit: explicit.has(memory.id), style: style(memory), score: matched.length / Math.sqrt(Math.max(1, terms(memory.content).size)) };
    }).filter(row => row.explicit || row.style || row.score > 0)
    .sort((a, b) => Number(b.explicit) - Number(a.explicit) || Number(b.style) - Number(a.style)
      || b.score - a.score || String(b.memory.companion.updatedAt).localeCompare(String(a.memory.companion.updatedAt)) || a.memory.id.localeCompare(b.memory.id));
  const selected = []; let remaining = Math.min(byteBudget,COMPANION_MEMORY_LIMITS.bytes), includedStyle = false;
  for (const row of ranked) {
    if (selected.length >= Math.min(maxItems,COMPANION_MEMORY_LIMITS.items) || remaining < 80) break;
    if (row.style && includedStyle && !row.explicit) continue;
    const budget = Math.min(itemByteBudget, COMPANION_MEMORY_LIMITS.itemBytes, remaining - 80);
    let content = clipCompanionText(row.memory.content, budget);
    if (!row.explicit && !row.style && !row.matched.some(term => content.toLowerCase().includes(term))) {
      const offset = String(row.memory.content).toLowerCase().indexOf(row.matched[0]);
      content = clipCompanionText(String(row.memory.content).slice(Math.max(0, offset - 60)), budget);
    }
    if (!content.trim() || (!row.explicit && !row.style && !row.matched.some(term => content.toLowerCase().includes(term)))) continue;
    selected.push({ memory: row.memory, content }); remaining -= Buffer.byteLength(content, 'utf8') + 80;
    includedStyle ||= row.style;
  }
  return selected;
}
