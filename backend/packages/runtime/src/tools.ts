import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DomainError,
  ToolSchemas,
  codeOf,
  type ToolName,
} from "@hyper/contracts";
import { getTask, tx, fenced, event, type Db, type Task } from "./db.js";
import { Storage, validate } from "./storage.js";
import { readWeb, search } from "./network.js";
import { RunnerClient } from "./runner-client.js";
import { hash } from "./auth.js";
import type { Config } from "./config.js";
export interface Operation {
  id: string;
  task_id: string;
  step: number;
  call_id: string;
  name: string;
  args: unknown;
  status: "prepared" | "running" | "completed" | "failed" | "obsolete";
  replay: "safe" | "uncertain";
  result: unknown;
}
export interface ToolResult {
  data: unknown;
  pause?: "waiting_children" | "waiting_user" | "waiting_approval";
  finish?: { summary: string; artifactIds: string[] };
}
export class ToolExecutor {
  readonly storage: Storage;
  readonly runner: RunnerClient;
  constructor(
    readonly db: Db,
    readonly config: Config,
  ) {
    this.storage = new Storage(config.DATA_DIR, db);
    this.runner = new RunnerClient(config);
  }
  async execute(
    task: Task,
    op: Operation,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const owner = task.lease_owner!;
    signal.throwIfAborted();
    if (!Object.hasOwn(ToolSchemas, op.name))
      throw new DomainError("UNKNOWN_TOOL");
    switch (op.name as ToolName) {
      case "web_search": {
        const a = ToolSchemas.web_search.parse(op.args),
          r = await search(a.query, a.limit, signal, this.config.EXA_API_KEY);
        const results = [];
        for (const source of r.results)
          results.push(await this.source(task, source));
        return { data: { ...r, results } };
      }
      case "web_read": {
        const a = ToolSchemas.web_read.parse(op.args);
        const failures = await this.db.query(
          "SELECT 1 FROM operations WHERE task_id=$1 AND name='web_read' AND status='failed' AND args->>'url'=$2 LIMIT 2",
          [task.id, a.url],
        );
        if (failures.rowCount === 2)
          throw new DomainError("WEB_REPEATED_FAILURE");
        return { data: await this.source(task, await readWeb(a.url, signal)) };
      }
      case "source_read": {
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
      }
      case "file_read": {
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
      }
      case "artifact_write": {
        const a = ToolSchemas.artifact_write.parse(op.args);
        return {
          data: await this.storage.artifact(
            task,
            op.id,
            { ...a, bytes: Buffer.from(a.content) },
            owner,
          ),
        };
      }
      case "code_execute": {
        const a = ToolSchemas.code_execute.parse(op.args);
        if (!(await this.runner.health()).available)
          throw new DomainError("SANDBOX_UNAVAILABLE");
        const inputs = [];
        let inputBytes = 0;
        for (const id of a.inputFileIds) {
          const file = await this.storage.get(task.workspace_id, id),
            bytes = await this.storage.bytes(file);
          inputBytes += bytes.length;
          if (inputBytes > 20 * 1024 * 1024)
            throw new DomainError("SANDBOX_INPUT_LIMIT");
          inputs.push({
            id,
            format: file.format,
            data: bytes.toString("base64"),
          });
        }
        const r = await this.runner.run(
          {
            operationId: op.id,
            taskId: task.id,
            language: a.language,
            code: a.code,
            inputs,
            outputs: a.outputs.map((o) => o.path),
          },
          signal,
        );
        const artifacts = [];
        for (const output of a.outputs) {
          const data = r.outputs.find((o) => o.path === output.path);
          if (!data) throw new DomainError("MISSING_OUTPUT");
          artifacts.push(
            await this.storage.artifact(
              task,
              op.id + ":" + output.path,
              {
                name: output.path,
                format: output.format,
                bytes: Buffer.from(data.data, "base64"),
                artifactId: output.artifactId,
                sourceIds: a.sourceIds,
              },
              owner,
            ),
          );
        }
        return { data: { stdout: r.stdout, stderr: r.stderr, artifacts } };
      }
      case "delegate": {
        const a = ToolSchemas.delegate.parse(op.args);
        if (task.parent_id) throw new DomainError("DELEGATION_DEPTH");
        return tx(this.db, async (c) => {
          await fenced(c, task.id, owner);
          const old = await c.query<{ id: string }>(
            "SELECT id FROM tasks WHERE parent_id=$1",
            [task.id],
          );
          if (old.rows.length)
            return {
              data: { taskIds: old.rows.map((t) => t.id) },
              pause: "waiting_children" as const,
            };
          const ids = [];
          for (const sub of a.tasks) {
            const id = randomUUID();
            ids.push(id);
            await c.query(
              "INSERT INTO tasks(id,workspace_id,conversation_id,parent_id,root_id,prompt,acceptance,input_file_ids,state,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9)",
              [
                id,
                task.workspace_id,
                task.conversation_id,
                task.id,
                task.root_id,
                sub.prompt,
                JSON.stringify(sub.acceptance),
                JSON.stringify(task.input_file_ids),
                task.deadline,
              ],
            );
            await event(c, id, { type: "state", state: "queued" });
          }
          return { data: { taskIds: ids }, pause: "waiting_children" as const };
        });
      }
      case "ask_user": {
        const a = ToolSchemas.ask_user.parse(op.args);
        return { data: a, pause: "waiting_user" };
      }
      case "request_approval": {
        const a = ToolSchemas.request_approval.parse(op.args);
        const digest = hash(JSON.stringify(a)),
          id = randomUUID();
        await this.db.query(
          "INSERT INTO approvals(id,task_id,operation_id,action,payload,digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(operation_id) DO NOTHING",
          [id, task.id, op.id, a.action, JSON.stringify(a.payload), digest],
        );
        return {
          data: {
            approvalId: id,
            digest,
            executed: false,
            executorAvailable: false,
          },
          pause: "waiting_approval",
        };
      }
      case "finish": {
        const a = ToolSchemas.finish.parse(op.args);
        // Resolve requested deliveries from persisted versions, including when
        // a model mentions only the most recently returned artifact ID.
        const persisted = await this.db.query<{ artifact_id: string }>(
          `SELECT DISTINCT ON (f.format) v.artifact_id FROM artifact_versions v
           JOIN files f ON f.id=v.file_id JOIN artifacts ar ON ar.id=v.artifact_id
           WHERE f.task_id=$1 AND f.workspace_id=$2 AND ar.conversation_id=$3
             AND f.format=ANY($4::text[])
             AND v.version=(SELECT max(v2.version) FROM artifact_versions v2 WHERE v2.artifact_id=v.artifact_id)
           ORDER BY f.format,v.created_at DESC`,
          [task.id,task.workspace_id,task.conversation_id,task.acceptance.formats]);
        a.artifactIds = [...new Set([...a.artifactIds, ...persisted.rows.map(row => row.artifact_id)])];
        return { data: a, finish: a };
      }
    }
  }
  async source(
    task: Task,
    source: { url: string; title: string; excerpt: string; read: boolean },
  ) {
    const id = randomUUID();
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO sources(id,workspace_id,task_id,url,title,excerpt,read) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(task_id,url) DO UPDATE SET title=EXCLUDED.title,excerpt=CASE WHEN EXCLUDED.read THEN EXCLUDED.excerpt ELSE sources.excerpt END,read=sources.read OR EXCLUDED.read RETURNING id`,
      [
        id,
        task.workspace_id,
        task.id,
        source.url,
        source.title,
        source.excerpt,
        source.read,
      ],
    );
    return {
      ...source,
      excerpt: source.excerpt.slice(0, 6000),
      sourceId: r.rows[0]!.id,
      totalChars: source.excerpt.length,
      nextOffset: source.excerpt.length > 6000 ? 6000 : null,
    };
  }
  async check(task: Task, artifactIds: string[], summary: string) {
    const issues: string[] = [],
      texts: string[] = [],
      formats = new Set<string>();
    const sources = await this.db.query<{
      id: string;
      url: string;
      read: boolean;
    }>(
      "SELECT id,url,read FROM sources WHERE workspace_id=$1 AND task_id IN (SELECT id FROM tasks WHERE root_id=$2)",
      [task.workspace_id, task.root_id],
    );
    const artifactInfo = [];
    for (const id of artifactIds) {
      const r = await this.db.query<{ file_id: string; source_ids: string[] }>(
        `SELECT v.file_id,v.source_ids FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE v.artifact_id=$1 AND v.workspace_id=$2 AND a.conversation_id=$3 ORDER BY version DESC LIMIT 1`,
        [id, task.workspace_id, task.conversation_id],
      );
      const version = r.rows[0];
      if (!version) {
        issues.push("Missing artifact " + id);
        continue;
      }
      try {
        const f = await this.storage.get(task.workspace_id, version.file_id),
          validation = await validate(await this.storage.bytes(f), f.format);
        formats.add(f.format);
        texts.push(validation.text);
        artifactInfo.push({
          id,
          name: f.name,
          format: f.format,
          text: validation.text.slice(0, 15000),
          downloadUrl: "/api/v1/files/" + f.id + "/download",
        });
        if (
          task.acceptance.requireSources &&
          !version.source_ids.some((s) =>
            sources.rows.some((x) => x.id === s && x.read),
          )
        )
          issues.push("Artifact lacks read source provenance: " + id);
      } catch (e) {
        issues.push(codeOf(e));
      }
    }
    for (const required of task.acceptance.formats)
      if (!formats.has(required)) issues.push("Missing format: " + required);
    const markdown = artifactInfo.filter(a => a.format === "md").map(a => a.text).join("\n");
    for (const pdf of artifactInfo.filter(a => a.format === "pdf"))
      if (markdown.includes("−") && !/[−-]/.test(pdf.text))
        issues.push("PDF is missing minus signs present in Markdown. Use ASCII '-' in equations or embed a font covering U+2212; preserve all equations.");
    const deliveredText = artifactIds.length ? texts.join("\n") : summary;
    for (const required of task.acceptance.requiredText)
      if (!deliveredText.includes(required))
        issues.push("Missing required content: " + required);
    if (task.acceptance.requireSources) {
      if (
        sources.rows.filter((s) => s.read && deliveredText.includes(s.url))
          .length < 2
      )
        issues.push(
          "At least two read sources must be cited in the deliverable",
        );
    }
    for (const match of summary.matchAll(
      /\/api\/v1\/(?:files|artifacts)\/([0-9a-f-]{36})/g,
    )) {
      const id = match[1]!;
      if (
        !artifactIds.includes(id) &&
        !artifactInfo.some((a) => a.downloadUrl.includes(id))
      )
        issues.push("Unknown artifact link");
    }
    return {
      passed: issues.length === 0,
      issues,
      artifactInfo,
      sources: sources.rows,
    };
  }
}
