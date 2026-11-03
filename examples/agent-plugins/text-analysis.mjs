/** A complete server-authored plugin example. Register with
 * createApp({ ...options, agentPlugins: [textAnalysisPlugin] }).
 * No module loading or execution is accepted from task/HTTP input.
 */
export const textAnalysisPlugin = {
  id: 'text-analysis',
  name: 'Text analysis',
  description: 'Count Unicode code points, lines and whitespace-delimited tokens in supplied text.',
  available: true,
  defaultEnabled: false,
  tools: [{
    definition: {
      type: 'function',
      function: {
        name: 'text_stats',
        description: 'Measure supplied text. Token count here means whitespace-delimited segments, not model tokens or linguistic words.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', maxLength: 10000 } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    effect: 'read-only',
    replay: 'safe',
    approvalRequired: false,
    capability: 'Documents',
  }],
  bind({ workspaceId, taskId }) {
    return {
      async execute(name, { text }, { signal }) {
        signal?.throwIfAborted();
        if (name !== 'text_stats') throw Error('Unknown text analysis tool.');
        return {
          workspaceId,
          taskId,
          characters: Array.from(text).length,
          lines: text.length ? text.split(/\r\n|\r|\n/).length : 0,
          whitespaceTokens: text.trim() ? text.trim().split(/\s+/u).length : 0,
        };
      },
      async close() { /* This pure plugin has no owned resources. */ },
    };
  },
};
