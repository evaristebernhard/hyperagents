import { z } from "zod";
export const Id = z.uuid();
export const State = z.enum([
  "queued",
  "running",
  "waiting_children",
  "waiting_user",
  "waiting_approval",
  "uncertain",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskState = z.infer<typeof State>;
export const terminal = new Set<TaskState>([
  "succeeded",
  "failed",
  "cancelled",
]);
export const Limits = Object.freeze({
  taskMs: 1_200_000,
  codeMs: 120_000,
  modelCalls: 32,
  toolCalls: 64,
  tokens: 200_000,
  outputTokens: 32768,
  transferBytes: 8 * 1024 * 1024,
  fileBytes: 20 * 1024 * 1024,
  artifactBytes: 100 * 1024 * 1024,
  contextChars: 180_000,
  children: 2,
  globalTasks: 2,
});
export const Format = z.enum([
  "txt",
  "md",
  "csv",
  "json",
  "html",
  "png",
  "pdf",
  "py",
  "js",
]);
export type Format = z.infer<typeof Format>;
export const mime: Record<Format, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  png: "image/png",
  pdf: "application/pdf",
  py: "text/x-python",
  js: "text/javascript",
};
export const Acceptance = z
  .object({
    formats: z.array(Format).max(9).default([]),
    requiredText: z.array(z.string().min(1).max(200)).max(30).default([]),
    requireSources: z.boolean().default(false),
  })
  .strict();
export const ResourceId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const TaskContext = z
  .object({
    agentId: ResourceId.optional(),
    projectId: ResourceId.optional(),
    roomId: ResourceId.optional(),
    skillIds: z.array(ResourceId).max(20).default([]),
    memoryIds: z.array(ResourceId).max(20).default([]),
    artifactIds: z.array(Id).max(20).default([]),
    rubricIds: z.array(ResourceId).max(10).default([]),
  })
  .strict();
export type TaskContext = z.infer<typeof TaskContext>;
export const CreateTask = z
  .object({
    prompt: z.string().min(1).max(30000),
    conversationId: Id.optional(),
    inputFileIds: z.array(Id).max(20).default([]),
    context: TaskContext.optional(),
    acceptance: Acceptance.default({
      formats: [],
      requiredText: [],
      requireSources: false,
    }),
  })
  .strict();
export type CreateTask = z.infer<typeof CreateTask>;
export const Credentials = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    password: z.string().min(12).max(256),
  })
  .strict();
export const Register = Credentials.extend({
  invite: z.string().min(32).max(128),
});
export const Followup = z
  .object({ message: z.string().min(1).max(30000) })
  .strict();
export const ToolSchemas = {
  image_search: z
    .object({
      query: z.string().min(1).max(300),
      limit: z.number().int().min(1).max(5).default(3),
    })
    .strict(),
  thread_search: z.object({ query: z.string().min(1).max(500) }).strict(),
  knowledge_search: z.object({ query: z.string().min(1).max(500) }).strict(),
  learning_propose: z
    .object({
      kind: z.enum(["memories", "skills", "wiki"]),
      name: z.string().min(1).max(160),
      content: z.string().min(1).max(12000),
      reason: z.string().min(1).max(1000),
    })
    .strict(),
  web_search: z
    .object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(10).default(5),
    })
    .strict(),
  web_read: z.object({ url: z.url().max(2000) }).strict(),
  source_read: z
    .object({
      sourceId: Id,
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(16000).default(6000),
    })
    .strict(),
  file_read: z
    .object({
      fileId: Id,
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(16000).default(16000),
    })
    .strict(),
  artifact_write: z
    .object({
      name: z
        .string()
        .min(1)
        .max(160)
        .regex(/^[^/\\\x00-\x1f]+$/),
      format: Format.exclude(["pdf", "png"]),
      content: z.string().max(2_000_000),
      artifactId: Id.optional(),
      sourceIds: z.array(Id).max(30).default([]),
    })
    .strict(),
  code_execute: z
    .object({
      language: z.enum(["python", "node"]),
      code: z.string().min(1).max(100000),
      inputFileIds: z.array(Id).max(20).default([]),
      outputs: z
        .array(
          z.object({
            path: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$/),
            format: Format,
            artifactId: Id.optional(),
          }),
        )
        .max(10)
        .default([]),
      sourceIds: z.array(Id).max(30).default([]),
    })
    .strict(),
  delegate: z
    .object({
      tasks: z
        .array(
          z.object({
            prompt: z.string().min(1).max(15000),
            acceptance: Acceptance,
          }),
        )
        .min(1)
        .max(2),
    })
    .strict(),
  ask_user: z.object({ question: z.string().min(1).max(2000) }).strict(),
  request_approval: z
    .object({
      action: z.string().min(1).max(2000),
      payload: z.record(z.string(), z.unknown()),
    })
    .strict(),
  finish: z
    .object({
      summary: z.string().min(1).max(15000),
      artifactIds: z.array(Id).max(30),
    })
    .strict(),
};
export type ToolName = keyof typeof ToolSchemas;
export const ToolCall = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  arguments: z.string().max(2_000_000),
});
export type ToolCall = z.infer<typeof ToolCall>;
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  privateContext?: Record<string, unknown>;
}
export interface Usage {
  input: number;
  output: number;
}
export interface ModelResult {
  message: Message;
  usage: Usage;
  finishReason: "stop" | "tool_calls";
  bytes: number;
}
export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "tool"; call: ToolCall };
export interface ModelInput {
  messages: Message[];
  tools: ToolName[];
  maxTokens: number;
  signal: AbortSignal;
  onEvent?: (event: ModelEvent) => void;
}
export interface ModelAdapter {
  readonly name: string;
  complete(input: ModelInput): Promise<ModelResult>;
}
export const Event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), state: State }),
  z.object({
    type: z.literal("model"),
    step: z.number(),
    model: z.string(),
    finishReason: z.string(),
    usage: z.object({ input: z.number(), output: z.number() }),
    elapsedMs: z.number(),
  }),
  z.object({
    type: z.literal("tool"),
    operationId: Id,
    name: z.string(),
    status: z.enum(["prepared", "completed", "failed", "obsolete"]),
    result: z.unknown().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal("message"), message: z.string() }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    step: z.number(),
    model: z.string().optional(),
    elapsedMs: z.number().optional(),
    finishReason: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal("checkpoint"), summary: z.string() }),
  z.object({ type: z.literal("instruction"), message: z.string() }),
  z.object({
    type: z.literal("validation"),
    passed: z.boolean(),
    issues: z.array(z.string()),
  }),
]);
export type TaskEvent = z.infer<typeof Event>;
export const TaskResponse = z.object({
  id: Id,
  conversationId: Id,
  state: State,
  prompt: z.string(),
  result: z.unknown().nullable(),
  context: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        name: z.string(),
        revision: z.number(),
      }),
    )
    .default([]),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code);
    this.name = "DomainError";
  }
}
export class ToolFailure extends DomainError {
  constructor(
    code: string,
    public readonly details: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
    },
  ) {
    super(code);
  }
}
export const codeOf = (e: unknown): string =>
  e instanceof DomainError
    ? e.code
    : e instanceof z.ZodError
      ? "INVALID_ARGUMENTS"
      : e instanceof Error && e.name === "AbortError"
        ? "CANCELLED"
        : "INTERNAL_ERROR";
export const TaskCreated = z.object({ taskId: Id });
export const FileMetadata = z.object({
  id: Id,
  name: z.string(),
  format: Format,
  bytes: z.coerce.number(),
  sha256: z.string(),
});
export const EventPage = z.object({
  events: z.array(
    z.object({ id: z.string(), payload: Event, created_at: z.string() }),
  ),
  nextCursor: z.string(),
});
export class Client {
  constructor(
    readonly baseUrl: string,
    private headers: Record<string, string> = {},
  ) {}
  setSession(cookie: string, csrf: string) {
    this.headers = { ...this.headers, cookie, "x-csrf-token": csrf };
  }
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
  ): Promise<T> {
    const r = await fetch(this.baseUrl + "/api/v1" + path, {
      ...init,
      credentials: "include",
      headers: {
        origin: new URL(this.baseUrl).origin,
        "content-type": "application/json",
        ...this.headers,
        ...init.headers,
      },
    });
    if (!r.ok) throw new DomainError("HTTP_" + r.status, r.status);
    const value: unknown = await r.json();
    return schema.parse(value);
  }
  async login(input: z.infer<typeof Credentials>) {
    const r = await fetch(this.baseUrl + "/api/v1/auth/login", {
      method: "POST",
      credentials: "include",
      headers: {
        origin: new URL(this.baseUrl).origin,
        "content-type": "application/json",
      },
      body: JSON.stringify(Credentials.parse(input)),
    });
    if (!r.ok) throw new DomainError("HTTP_" + r.status, r.status);
    const data = z.object({ csrfToken: z.string() }).parse(await r.json());
    const cookie = r.headers.get("set-cookie")?.split(";")[0];
    this.headers = {
      ...this.headers,
      "x-csrf-token": data.csrfToken,
      ...(cookie ? { cookie } : {}),
    };
    return data;
  }
  register(input: z.infer<typeof Register>) {
    return this.request(
      "/auth/register",
      z.object({ registered: z.boolean() }),
      { method: "POST", body: JSON.stringify(Register.parse(input)) },
    );
  }
  createTask(input: CreateTask, key: string) {
    return this.request("/tasks", TaskCreated, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify(CreateTask.parse(input)),
    });
  }
  task(id: string) {
    return this.request("/tasks/" + Id.parse(id), TaskResponse);
  }
  tasks() {
    return this.request("/tasks", z.array(TaskResponse));
  }
  events(id: string, after = "0") {
    return this.request(
      "/tasks/" + Id.parse(id) + "/events?after=" + encodeURIComponent(after),
      EventPage,
    );
  }
  instruct(id: string, message: string) {
    return this.request(
      "/tasks/" + Id.parse(id) + "/instructions",
      z.object({ accepted: z.boolean() }),
      { method: "POST", body: JSON.stringify(Followup.parse({ message })) },
    );
  }
  cancel(id: string) {
    return this.request(
      "/tasks/" + Id.parse(id) + "/cancel",
      z.object({ cancelled: z.boolean() }),
      { method: "POST" },
    );
  }
  retry(id: string) {
    return this.request(
      "/tasks/" + Id.parse(id) + "/retry",
      z.object({ queued: z.boolean() }),
      { method: "POST" },
    );
  }
  async upload(name: string, bytes: Blob) {
    const body = new FormData();
    body.set("file", bytes, name);
    const r = await fetch(this.baseUrl + "/api/v1/files", {
      method: "POST",
      credentials: "include",
      headers: { origin: new URL(this.baseUrl).origin, ...this.headers },
      body,
    });
    if (!r.ok) throw new DomainError("HTTP_" + r.status, r.status);
    return FileMetadata.parse(await r.json());
  }
  async download(id: string) {
    const r = await fetch(
      this.baseUrl + "/api/v1/files/" + Id.parse(id) + "/download",
      { credentials: "include", headers: this.headers },
    );
    if (!r.ok) throw new DomainError("HTTP_" + r.status, r.status);
    return r.blob();
  }
}
