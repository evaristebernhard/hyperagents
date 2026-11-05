import Fastify from "fastify";
import { z } from "zod";
import {
  DomainError,
  Id,
  Limits,
  ToolSchemas,
  type Message,
  type ModelAdapter,
  type ModelInput,
  type ToolName,
} from "@hyper/contracts";
import { Engine } from "./engine.js";
import { DeepSeek } from "./model.js";
import { fenced, getTask, tx, type Db } from "./db.js";
import type { Config } from "./config.js";
const Fence = z.object({
  protocol: z.literal(1),
  taskId: Id,
  owner: Id,
  epoch: z.string().regex(/^\d+$/),
});
const Content = z.record(z.string(), z.unknown());
const Completion = z.object({
  preamble: z.string().nullable().optional(),
  chat_history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.array(Content),
      }),
    )
    .max(2000),
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        parameters: z.unknown(),
      }),
    )
    .max(80),
  max_tokens: z.number().nullable().optional(),
  additional_params: z.unknown().optional(),
});
const builtinArgs: Record<string, z.ZodType> = {
  spawn_thread: z.object({
    instructions: z.string().min(1).max(20000),
    child_of: z.array(Id).max(2),
    fresh_context: z.boolean().optional(),
  }),
  close_thread: z.object({
    thread_id: Id,
    report_to_parent: z.string().max(40000).optional(),
  }),
  report_to_parent: z.object({ report: z.string().max(40000) }),
  send_message_to_child: z.object({
    thread_id: Id,
    message: z.string().max(20000),
  }),
  cancel_subscription: z.object({ tool_call_id: z.string().min(1) }),
  sleep: z.object({
    seconds: z.number().min(0).max(86400),
    reason: z.string().optional(),
  }),
  sleep_until_event_or_input: z.object({}),
};
export function infinityMessages(
  request: z.infer<typeof Completion>,
): Message[] {
  const messages: Message[] = [];
  if (request.preamble)
    messages.push({ role: "system", content: request.preamble });
  for (const m of request.chat_history) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((c) => typeof c.text === "string")
        .map((c) => c.text)
        .join("");
      const calls = m.content
        .filter((c) => c.function)
        .map((c) => {
          const f = c.function as { name: string; arguments: unknown };
          return {
            id: String(c.id),
            name: f.name,
            arguments: JSON.stringify(f.arguments),
          };
        });
      const reasoning = m.content
        .filter((c) => Array.isArray(c.content))
        .flatMap(
          (c) => c.content as { type: string; content?: { text?: string } }[],
        )
        .filter((c) => c.type === "text")
        .map((c) => c.content?.text ?? "")
        .join("");
      messages.push({
        role: "assistant",
        content: text,
        ...(calls.length ? { toolCalls: calls } : {}),
        ...(reasoning
          ? { privateContext: { reasoning_content: reasoning } }
          : {}),
      });
    } else {
      for (const c of m.content) {
        if (c.type === "toolresult") {
          const result = c as { id: string; content: { text?: string }[] };
          messages.push({
            role: "tool",
            toolCallId: result.id,
            content: result.content
              .map((c) => c.text ?? "[image omitted]")
              .join("\n"),
          });
        } else
          messages.push({
            role: "user",
            content: String(c.text ?? "[image omitted]"),
          });
      }
    }
  }
  return messages;
}
export async function createKernelBridge(
  db: Db,
  cfg: Config,
  factory?: () => ModelAdapter,
) {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  const engine = new Engine(db, cfg);
  const active = new Map<string, AbortController>();
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code(error instanceof DomainError ? error.status : 400)
      .send({
        error:
          error instanceof DomainError ? error.code : "KERNEL_BRIDGE_ERROR",
      }),
  );
  const verify = async (value: z.infer<typeof Fence>) => {
    const task = await getTask(db, value.taskId);
    if (
      task.runtime_kind !== "rust" ||
      task.runtime_phase !== "model" ||
      task.state !== "running" ||
      task.lease_owner !== value.owner ||
      task.lease_epoch !== value.epoch ||
      !task.lease_until ||
      task.lease_until.getTime() <= Date.now()
    )
      throw new DomainError("LEASE_LOST", 409);
    return task;
  };
  app.post("/v1/context", async (req) => {
    const fence = Fence.parse(req.body),
      task = await verify(fence);
    const context = await engine.modelContext(
      task,
      await engine.initialMessages(task),
    );
    const instructions = await db.query(
      "SELECT message FROM instructions WHERE task_id=$1 ORDER BY id",
      [task.id],
    );
    return {
      protocol: 1,
      model: cfg.DEEPSEEK_MODEL,
      outputTokens: Limits.outputTokens,
      messages: context.messages,
      tools: context.toolNames.map((name) => ({
        name,
        description: `Workspace tool: ${name}`,
        parameters: z.toJSONSchema(ToolSchemas[name], { target: "draft-7" }),
      })),
      corrections: instructions.rows.map((r) => r.message),
    };
  });
  app.post("/v1/model", async (req, reply) => {
    const input = Fence.extend({
      attemptId: Id,
      request: Completion,
      maxTokens: z.number().int().min(1).max(Limits.outputTokens),
    }).parse(req.body);
    const task = await verify(input);
    const attempt = await db.query(
      "SELECT 1 FROM model_attempts WHERE id=$1 AND task_id=$2 AND status='running' AND bridge_started_at IS NULL",
      [input.attemptId, task.id],
    );
    if (!attempt.rowCount)
      throw new DomainError("ATTEMPT_ALREADY_DISPATCHED", 409);
    const consumed = await db.query(
      "UPDATE model_attempts SET bridge_started_at=now() WHERE id=$1 AND bridge_started_at IS NULL AND status='running' RETURNING id",
      [input.attemptId],
    );
    if (!consumed.rowCount)
      throw new DomainError("ATTEMPT_ALREADY_DISPATCHED", 409);
    const controller = new AbortController();
    active.set(input.attemptId, controller);
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void verify(input)
        .catch(() => controller.abort())
        .finally(() => {
          polling = false;
        });
    }, 1000);
    reply.raw.on("close", () => controller.abort());
    reply.raw.writeHead(200, { "content-type": "application/x-ndjson" });
    const send = (chunk: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(JSON.stringify(chunk) + "\n");
    };
    let streamed = false;
    try {
      if (!factory && !cfg.DEEPSEEK_API_KEY)
        throw new DomainError("MODEL_NOT_CONFIGURED");
      const adapter =
        factory?.() ??
        new DeepSeek({
          key: cfg.DEEPSEEK_API_KEY!,
          model: cfg.DEEPSEEK_MODEL,
          baseUrl: cfg.DEEPSEEK_BASE_URL,
          maxAttempts: 1,
        });
      const result = await adapter.complete({
        messages: infinityMessages(input.request),
        tools: input.request.tools.map((t) => t.name as ToolName),
        definitions: input.request.tools,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(240000),
        ]),
        maxTokens: input.maxTokens,
        onEvent: (e) => {
          if (e.type === "text") {
            streamed = true;
            send({ Text: e.text });
          }
        },
      });
      if (!streamed && result.message.content)
        send({ Text: result.message.content });
      // Some controlled adapters do not stream text; the final result is authoritative.
      const reasoning = result.message.privateContext?.reasoning_content;
      if (typeof reasoning === "string" && reasoning)
        send({
          Reasoning: {
            id: null,
            content: [{ type: "text", content: { text: reasoning } }],
          },
        });
      for (const call of result.message.toolCalls ?? []) {
        if (!input.request.tools.some((t) => t.name === call.name))
          throw new DomainError("MODEL_UNKNOWN_TOOL");
        const args = JSON.parse(call.arguments);
        builtinArgs[call.name]?.parse(args);
        send({
          ToolCall: {
            id: call.id,
            function: { name: call.name, arguments: args },
          },
        });
      }
      send({
        Final: {
          usage: {
            input_tokens: result.usage.input,
            output_tokens: result.usage.output,
            total_tokens: result.usage.input + result.usage.output,
          },
          transport_bytes: result.bytes,
        },
      });
    } catch (error) {
      send({
        error:
          error instanceof DomainError ? error.code : "MODEL_TRANSPORT_ERROR",
      });
    } finally {
      clearInterval(timer);
      active.delete(input.attemptId);
      reply.raw.end();
    }
    return reply;
  });
  app.addHook("onClose", async () => {
    for (const c of active.values()) c.abort();
  });
  return app;
}
