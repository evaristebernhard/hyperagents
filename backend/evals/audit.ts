// Reconcile evaluation reports against persisted PostgreSQL usage; makes no model calls.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { pool } from "@hyper/runtime";
for (const name of (await readdir("evals/results"))
  .filter((n) => /^2026.*\.json$/.test(n))
  .sort()) {
  const path = join("evals/results", name),
    report = JSON.parse(await readFile(path, "utf8"));
  const pg = new EmbeddedPostgres({
    databaseDir: join(report.root, "postgres"),
    port: 55440,
    user: "hyper",
    password: "hyper",
    persistent: true,
    autoRehydrateSymlinks: true,
    onLog: () => {},
    onError: () => {},
    postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
  });
  await pg.start();
  const db = pool("postgres://hyper:hyper@127.0.0.1:55440/hyper_eval");
  try {
    const usage = (
      await db.query(
        `SELECT count(*)::int attempts,COALESCE(sum((usage->>'input')::bigint),0)::text actual_input,COALESCE(sum((usage->>'output')::bigint),0)::text actual_output,count(*) FILTER (WHERE usage IS NULL)::int unknown_usage_attempts FROM model_attempts`,
      )
    ).rows[0];
    const totals = (
      await db.query(
        "SELECT COALESCE(sum(tokens),0)::text budget_charged_tokens,COALESCE(sum(transfer_bytes),0)::text transfer_bytes,COALESCE(sum(artifact_bytes),0)::text artifact_bytes FROM tasks WHERE parent_id IS NULL",
      )
    ).rows[0];
    report.audit = {
      ...usage,
      ...totals,
      artifactFileCount: (
        await db.query(
          "SELECT count(*)::int n FROM files WHERE task_id IS NOT NULL",
        )
      ).rows[0].n,
      auditedAt: new Date().toISOString(),
    };
    for (const row of report.results) {
      if (!row.taskId) continue;
      const ids = [
        row.taskId,
        ...(row.revisionTaskId ? [row.revisionTaskId] : []),
      ];
      row.usage = (
        await db.query(
          "SELECT id,model_calls,tool_calls,tokens,transfer_bytes,artifact_bytes FROM tasks WHERE id=ANY($1::uuid[])",
          [ids],
        )
      ).rows;
      row.artifacts = (
        await db.query(
          "SELECT id,name,format,sha256,bytes,storage_key FROM files WHERE task_id IN (SELECT id FROM tasks WHERE root_id=ANY($1::uuid[]))",
          [ids],
        )
      ).rows;
    }
    await writeFile(path, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: name, ...report.audit }));
  } finally {
    await db.end();
    await pg.stop();
  }
}
