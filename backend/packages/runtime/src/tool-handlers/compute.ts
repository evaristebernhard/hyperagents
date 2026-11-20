import { allowedTools } from "../resources.js";

import {
  DomainError,
  ToolSchemas,
  codeOf,
  type ToolName,
} from "@hyper/contracts";

import type { ToolHandler } from "../tools.js";

const executeCode: ToolHandler = async function (task, op, signal) {
  const owner = task.lease_owner!;

  let skillFiles: Record<string, string> | undefined;
  let args = op.args;
  if (op.name === "skill_run") {
    if (!allowedTools(task.context).includes("code_execute"))
      throw new DomainError("TOOL_DISABLED_FOR_AGENT", 403);
    const a = ToolSchemas.skill_run.parse(op.args),
      pinned = task.context.skills?.find((s) => s.id === a.id);
    if (!pinned) throw new DomainError("SKILL_NOT_IN_TASK", 404);
    const v = (
      await this.db.query(
        "SELECT files,requirements FROM skill_versions WHERE workspace_id=$1 AND package_id=$2 AND digest=$3",
        [task.workspace_id, a.id, pinned.digest],
      )
    ).rows[0];
    if (!v || !Object.hasOwn(v.files, a.path))
      throw new DomainError("NOT_FOUND", 404);
    if (
      v.requirements.tools.some(
        (t: string) => !allowedTools(task.context).includes(t as ToolName),
      )
    )
      throw new DomainError("SKILL_TOOL_REQUIREMENT_DENIED", 403);
    skillFiles = v.files;
    const python = a.path.endsWith(".py"),
      path = "/inputs/skill/" + a.path;
    const code = python
      ? "import runpy,sys,importlib.util\n" +
        v.requirements.python
          .map(
            (m: string) =>
              "assert importlib.util.find_spec(" +
              JSON.stringify(m) +
              ") is not None, " +
              JSON.stringify("MISSING_DEPENDENCY: " + m),
          )
          .join("\n") +
        "\nsys.argv=" +
        JSON.stringify([path, ...a.args]) +
        '\nsys.path.insert(0,"/inputs/skill/scripts")\nrunpy.run_path(' +
        JSON.stringify(path) +
        ',run_name="__main__")'
      : 'import { createRequire } from "node:module"; const require=createRequire(import.meta.url);' +
        v.requirements.node
          .map((m: string) => "require.resolve(" + JSON.stringify(m) + ");")
          .join("") +
        "process.argv=" +
        JSON.stringify(["node", path, ...a.args]) +
        "; await import(" +
        JSON.stringify(path) +
        ");";
    args = {
      language: python ? "python" : "node",
      code,
      inputFileIds: a.inputFileIds,
      outputs: a.outputs,
    };
  }
  const a = ToolSchemas.code_execute.parse(normalizeCodeArguments(args));
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
      format:
        file.format === "py" || file.format === "js" ? "txt" : file.format,
      data: bytes.toString("base64"),
    });
  }
  const r = await this.runner.run(
    {
      protocol: 1,
      threadId: task.id,
      eventId: op.call_id,
      leaseEpoch: task.lease_epoch,
      operationId: op.id,
      taskId: task.id,
      language: a.language,
      code: a.code,
      inputs,
      skillFiles,
      outputs: a.outputs.map((o) => o.path),
    },
    signal,
  );
  const artifacts = [];
  const outputErrors: { path: string; error: string }[] = [];
  for (const output of a.outputs) {
    const data = r.outputs.find((o) => o.path === output.path);
    try {
      if (!data) throw new DomainError("MISSING_OUTPUT");
      artifacts.push(
        await this.storage.artifact(
          task,
          op.id + ":" + output.path,
          {
            name: output.path,
            format:
              output.format === "txt" && /\.(py|js)$/.test(output.path)
                ? output.path.endsWith(".py")
                  ? "py"
                  : "js"
                : output.format,
            bytes: Buffer.from(data.data, "base64"),
            artifactId: output.artifactId,
            sourceIds: a.sourceIds,
          },
          owner,
        ),
      );
    } catch (e) {
      if (["LEASE_LOST", "CANCELLED"].includes(codeOf(e))) throw e;
      outputErrors.push({ path: output.path, error: codeOf(e) });
    }
  }
  return {
    data: {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: 0,
      computationSucceeded: true,
      artifacts,
      outputErrors,
      ...(outputErrors.length
        ? {
            warning:
              "Computation succeeded but some files were not saved. Correct the declared formats or write the missing artifacts; do not report them as delivered.",
          }
        : {}),
    },
  };
};
export const computeHandlers = {
  code_execute: executeCode,
  skill_run: executeCode,
};
export function normalizeCodeArguments(raw: unknown) {
  if (!raw || typeof raw !== "object") return raw;
  const a = raw as Record<string, unknown>,
    aliases: Record<string, string> = {
      python: "python",
      python3: "python",
      node: "node",
      nodejs: "node",
      javascript: "node",
      js: "node",
    };
  const language =
    typeof a.language === "string"
      ? aliases[a.language.trim().toLowerCase()] || a.language
      : a.language;
  return { ...a, language };
}
