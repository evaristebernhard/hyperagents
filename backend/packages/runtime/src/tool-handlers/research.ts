import { DomainError, ToolSchemas, type ToolName } from "@hyper/contracts";

import { readWeb, search, searchImages } from "../network.js";

import type { ToolHandler } from "../tools.js";

export const researchHandlers = {
  image_search: async function (task, op, signal) {
    const owner = task.lease_owner!;

    const a = ToolSchemas.image_search.parse(op.args),
      r = await searchImages(a.query, a.limit, signal);
    return {
      data: {
        provider: r.provider,
        results: await Promise.all(r.results.map((s) => this.source(task, s))),
      },
    };
  },
  web_search: async function (task, op, signal) {
    const owner = task.lease_owner!;

    const a = ToolSchemas.web_search.parse(op.args),
      r = await search(a.query, a.limit, signal);
    const results = [];
    for (const source of r.results)
      results.push(await this.source(task, source));
    return { data: { ...r, results } };
  },
  web_read: async function (task, op, signal) {
    const owner = task.lease_owner!;

    const a = ToolSchemas.web_read.parse(op.args);
    const failures = await this.db.query(
      "SELECT 1 FROM operations WHERE task_id=$1 AND name='web_read' AND status='failed' AND args->>'url'=$2 LIMIT 2",
      [task.id, a.url],
    );
    if (failures.rowCount === 2) throw new DomainError("WEB_REPEATED_FAILURE");
    return { data: await this.source(task, await readWeb(a.url, signal)) };
  },
  source_read: async function (task, op, signal) {
    const owner = task.lease_owner!;

    const a = ToolSchemas.source_read.parse(op.args);
    const r = await this.db.query<{ excerpt: string }>(
      "SELECT excerpt FROM sources WHERE id=$1 AND workspace_id=$2",
      [a.sourceId, task.workspace_id],
    );
    if (!r.rows[0]) throw new DomainError("NOT_FOUND", 404);
    const text = r.rows[0].excerpt;
    return {
      data: {
        sourceId: a.sourceId,
        text: text.slice(a.offset, a.offset + a.length),
        totalChars: text.length,
        nextOffset:
          a.offset + a.length < text.length ? a.offset + a.length : null,
      },
    };
  },
} satisfies Partial<Record<ToolName, ToolHandler>>;
