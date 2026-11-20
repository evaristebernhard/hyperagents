import { ToolSchemas, type ToolName } from "@hyper/contracts";

import type { ToolHandler } from "../tools.js";

export const filesHandlers = {
  file_read: async function (task, op, signal) {
    const owner = task.lease_owner!;

    const a = ToolSchemas.file_read.parse(op.args),
      text = await this.storage.readText(task.workspace_id, a.fileId);
    return {
      data: {
        text: text.slice(a.offset, a.offset + a.length),
        totalChars: text.length,
        nextOffset:
          a.offset + a.length < text.length ? a.offset + a.length : null,
      },
    };
  },
  artifact_write: async function (task, op, signal) {
    const owner = task.lease_owner!;

    const a = ToolSchemas.artifact_write.parse(op.args);
    return {
      data: await this.storage.artifact(
        task,
        op.id,
        { ...a, bytes: Buffer.from(a.content) },
        owner,
      ),
    };
  },
} satisfies Partial<Record<ToolName, ToolHandler>>;
