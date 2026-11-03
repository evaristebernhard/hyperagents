import { z } from "zod";
import { DomainError, ToolFailure, Format, Id, Limits } from "@hyper/contracts";
import { type Config } from "./config.js";
export const RunRequest = z
  .object({
    operationId: Id,
    taskId: Id,
    language: z.enum(["python", "node"]),
    code: z.string().min(1).max(100000),
    inputs: z
      .array(
        z
          .object({ id: Id, format: Format, data: z.string().max(28_000_000) })
          .strict(),
      )
      .max(20),
    outputs: z
      .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$/))
      .max(10),
  })
  .strict();
export const RunResponse = z.object({
  status: z.enum(["completed", "failed", "cancelled", "uncertain"]),
  stdout: z.string().max(100000),
  stderr: z.string().max(100000),
  exitCode: z.number().nullable(),
  outputs: z.array(
    z.object({ path: z.string(), data: z.string().max(28_000_000) }),
  ),
});
export type RunRequest = z.infer<typeof RunRequest>;
export class RunnerClient {
  constructor(private config: Config) {}
  async health() {
    if (!this.config.RUNNER_URL || !this.config.RUNNER_TOKEN)
      return { available: false, reason: "RUNNER_NOT_CONFIGURED" };
    try {
      const r = await fetch(this.config.RUNNER_URL + "/health", {
        headers: { authorization: "Bearer " + this.config.RUNNER_TOKEN },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) return { available: false, reason: "RUNNER_UNREACHABLE" };
      return z
        .object({ available: z.boolean(), reason: z.string().optional() })
        .parse(await r.json());
    } catch {
      return { available: false, reason: "RUNNER_UNREACHABLE" };
    }
  }
  async run(input: RunRequest, signal: AbortSignal) {
    if (!this.config.RUNNER_URL || !this.config.RUNNER_TOKEN)
      throw new DomainError("SANDBOX_UNAVAILABLE");
    const headers = {
      authorization: "Bearer " + this.config.RUNNER_TOKEN,
      "content-type": "application/json",
    };
    const cancel = () => {
      void fetch(
        this.config.RUNNER_URL + "/operations/" + input.operationId + "/cancel",
        { method: "POST", headers, signal: AbortSignal.timeout(5000) },
      ).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const response = await fetch(this.config.RUNNER_URL + "/run", {
        method: "POST",
        headers,
        body: JSON.stringify(RunRequest.parse(input)),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(Limits.codeMs + 15000),
        ]),
      });
      if (!response.ok)
        throw new DomainError(
          response.status === 503 ? "SANDBOX_UNAVAILABLE" : "RUNNER_ERROR",
        );
      const result = RunResponse.parse(await response.json());
      if (result.status === "uncertain")
        throw new DomainError("OPERATION_UNCERTAIN");
      if (result.status === "cancelled") throw new DomainError("CANCELLED");
      if (result.status === "failed")
        throw new ToolFailure("CODE_FAILED", {
          stdout: result.stdout.slice(0, 8000),
          stderr: result.stderr.slice(0, 8000),
          exitCode: result.exitCode,
        });
      return result;
    } catch (e) {
      if (e instanceof DomainError) throw e;
      throw new DomainError(
        signal.aborted ? "CANCELLED" : "OPERATION_UNCERTAIN",
      );
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}
