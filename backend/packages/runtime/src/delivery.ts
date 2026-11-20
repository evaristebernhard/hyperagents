import { randomUUID } from "node:crypto";
import { codeOf } from "@hyper/contracts";
import { tx, fenced, event, type Db, type Task } from "./db.js";
import { Storage, validate } from "./storage.js";
export class DeliveryService {
  constructor(
    readonly db: Db,
    readonly storage: Storage,
  ) {}
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
    const references: {
      artifactId: string;
      fileId: string;
      version: number;
    }[] = [];
    for (const id of artifactIds) {
      const r = await this.db.query<{
        file_id: string;
        source_ids: string[];
        version: number;
      }>(
        `SELECT v.file_id,v.source_ids,v.version FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE v.artifact_id=$1 AND v.workspace_id=$2 AND a.conversation_id=$3 ORDER BY version DESC LIMIT 1`,
        [id, task.workspace_id, task.conversation_id],
      );
      const version = r.rows[0];
      if (!version) {
        issues.push("Missing artifact " + id);
        continue;
      }
      references.push({
        artifactId: id,
        fileId: version.file_id,
        version: version.version,
      });
      try {
        const f = await this.storage.get(task.workspace_id, version.file_id),
          validation = await validate(await this.storage.bytes(f), f.format);
        formats.add(f.format);
        texts.push(validation.text);
        artifactInfo.push({
          id,
          fileId: version.file_id,
          version: version.version,
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
    const markdown = artifactInfo
      .filter((a) => a.format === "md")
      .map((a) => a.text)
      .join("\n");
    for (const pdf of artifactInfo.filter((a) => a.format === "pdf"))
      if (markdown.includes("−") && !/[−-]/.test(pdf.text))
        issues.push(
          "PDF is missing minus signs present in Markdown. Use ASCII '-' in equations or embed a font covering U+2212; preserve all equations.",
        );
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
      references,
      passed: issues.length === 0,
      issues,
      artifactInfo,
      sources: sources.rows,
    };
  }
  async cached(
    task: Task,
    operationId: string,
  ): Promise<Awaited<ReturnType<DeliveryService["check"]>> | null> {
    const r = await this.db.query(
      "SELECT * FROM delivery_checks WHERE task_id=$1 AND operation_id=$2",
      [task.id, operationId],
    );
    const row = r.rows[0];
    return row
      ? {
          passed: row.status === "passed",
          issues: row.issues,
          references: row.artifacts,
          artifactInfo: row.artifact_info.map((a: Record<string, unknown>) => ({
            ...a,
            text: "",
          })),
          sources: [],
        }
      : null;
  }
  async record(
    task: Task,
    operationId: string,
    checked: Awaited<ReturnType<DeliveryService["check"]>>,
  ) {
    await tx(this.db, async (c) => {
      await fenced(c, task.id, task.lease_owner!);
      const saved = await c.query(
        "INSERT INTO delivery_checks(id,task_id,operation_id,status,issues,artifacts,artifact_info) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(operation_id) DO NOTHING RETURNING id",
        [
          randomUUID(),
          task.id,
          operationId,
          checked.passed ? "passed" : "failed",
          JSON.stringify(checked.issues),
          JSON.stringify(checked.references),
          JSON.stringify(checked.artifactInfo.map(({ text, ...a }) => a)),
        ],
      );
      if (saved.rowCount)
        await event(c, task.id, {
          type: "validation",
          passed: checked.passed,
          issues: checked.issues,
        });
    });
  }
}
