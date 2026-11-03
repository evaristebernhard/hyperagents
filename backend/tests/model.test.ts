import test from "node:test";
import assert from "node:assert/strict";
import {
  DeepSeek,
  providerMessages,
  publicAddress,
  publicUrl,
  validate,
} from "@hyper/runtime";
import type { ModelInput } from "@hyper/contracts";
const input: ModelInput = {
  messages: [{ role: "user", content: "test" }],
  tools: ["artifact_write"],
  maxTokens: 2000,
  signal: new AbortController().signal,
};
const sse = (delta: unknown, finish = "tool_calls", end = true) =>
  "data: " +
  JSON.stringify({
    choices: [{ index: 0, delta, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  }) +
  "\n\n" +
  (end ? "data: [DONE]\n\n" : "");
const response = (s: string) =>
  new Response(s, { headers: { "content-type": "text/event-stream" } });
test("DeepSeek preserves reasoning privately and assembles split tool arguments", async () => {
  const stream =
    sse(
      {
        reasoning_content: "private-marker",
        tool_calls: [
          {
            index: 0,
            id: "c1",
            function: { name: "artifact_write", arguments: '{"name":' },
          },
        ],
      },
      "",
    ) +
    sse({
      tool_calls: [
        {
          index: 0,
          function: { arguments: '"x.md","format":"md","content":"ok"}' },
        },
      ],
    });
  const model = new DeepSeek({
    key: "test",
    model: "test",
    fetch: async () => response(stream),
  });
  const r = await model.complete(input);
  assert.equal(r.message.toolCalls?.[0]?.name, "artifact_write");
  assert.equal(r.message.privateContext?.reasoning_content, "private-marker");
  assert.deepEqual(r.usage, { input: 10, output: 20 });
  assert.equal(
    providerMessages([r.message])[0]?.reasoning_content,
    "private-marker",
  );
});
for (const status of [429, 503])
  test("bounded pre-stream retry HTTP " + status, async () => {
    let count = 0,
      attempts = 0;
    const m = new DeepSeek({
      key: "secret",
      model: "test",
      onAttempt: async () => {
        attempts++;
      },
      fetch: async () =>
        ++count < 3
          ? new Response("secret provider body", { status })
          : response(sse({ content: "ok" }, "stop")),
    });
    assert.equal((await m.complete(input)).message.content, "ok");
    assert.equal(count, 3);
    assert.equal(attempts, 3);
  });
test("auth errors do not retry or reveal provider body", async () => {
  let count = 0;
  const m = new DeepSeek({
    key: "secret",
    model: "test",
    fetch: async () => {
      count++;
      return new Response("sensitive", { status: 401 });
    },
  });
  await assert.rejects(m.complete(input), { message: "MODEL_AUTH" });
  assert.equal(count, 1);
});
for (const [name, body, error] of [
  [
    "truncation",
    sse(
      {
        tool_calls: [
          {
            index: 0,
            id: "x",
            function: { name: "artifact_write", arguments: '{"' },
          },
        ],
      },
      "length",
    ),
    "MODEL_TRUNCATED",
  ],
  [
    "incomplete JSON",
    sse({
      tool_calls: [
        {
          index: 0,
          id: "x",
          function: { name: "artifact_write", arguments: '{"' },
        },
      ],
    }),
    "MODEL_INVALID_TOOL_JSON",
  ],
  [
    "missing DONE",
    sse({ content: "half" }, "stop", false),
    "MODEL_STREAM_INTERRUPTED",
  ],
] as const)
  test(name + " cannot execute or retry tools", async () => {
    let n = 0;
    const m = new DeepSeek({
      key: "x",
      model: "test",
      fetch: async () => {
        n++;
        return response(body);
      },
    });
    await assert.rejects(m.complete(input), { message: error });
    assert.equal(n, 1);
  });
test("mid-stream network failure is not retried", async () => {
  let calls = 0;
  const m = new DeepSeek({
    key: "x",
    model: "t",
    fetch: async () => {
      calls++;
      let n = 0;
      return new Response(
        new ReadableStream({
          pull(c) {
            if (n++ === 0)
              c.enqueue(new TextEncoder().encode('data: {"choices":'));
            else c.error(new Error("secret"));
          },
        }),
      );
    },
  });
  await assert.rejects(m.complete(input), {
    message: "MODEL_STREAM_INTERRUPTED",
  });
  assert.equal(calls, 1);
});
test("cancelled models do not call transport", async () => {
  const c = new AbortController();
  c.abort();
  let calls = 0;
  const m = new DeepSeek({
    key: "x",
    model: "t",
    fetch: async () => {
      calls++;
      return response("");
    },
  });
  await assert.rejects(m.complete({ ...input, signal: c.signal }));
  assert.equal(calls, 0);
});
test("private, metadata, encoded and mapped IPs are blocked", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "0.0.0.0",
    "100.64.0.1",
    "224.0.0.1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  for (const url of [
    "http://2130706433",
    "http://0x7f000001",
    "http://[::ffff:127.0.0.1]",
    "http://a.local",
    "http://user:pass@example.com",
    "file:///etc/passwd",
  ])
    assert.throws(() => publicUrl(url));
  assert.equal(publicAddress("8.8.8.8"), true);
});
test("CSV JSON HTML PNG reject malformed and mismatched data", async () => {
  await assert.rejects(validate(Buffer.from("a,b\n1,2,3"), "csv"));
  await assert.rejects(validate(Buffer.from("{bad}"), "json"));
  await assert.rejects(validate(Buffer.from("not html"), "html"));
  await assert.rejects(validate(Buffer.from("png"), "png"));
  assert.equal((await validate(Buffer.from("a,b\n1,2"), "csv")).passed, true);
});
test("HTTP 402 reports model quota and never retries", async () => {
  let attempts = 0;
  const model = new DeepSeek({
    key: "x",
    model: "test",
    fetch: async () => {
      attempts++;
      return new Response("private billing details", { status: 402 });
    },
  });
  await assert.rejects(model.complete(input), { message: "MODEL_QUOTA" });
  assert.equal(attempts, 1);
});
test("failed sandbox code returns bounded actionable stderr for repair", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { randomUUID } = await import("node:crypto");
  const { RunnerClient, config } = await import("@hyper/runtime");
  const { ToolFailure } = await import("@hyper/contracts");
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "failed",
        stdout: "",
        stderr: "NameError: missing_variable\n" + "x".repeat(9000),
        exitCode: 1,
        outputs: [],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    const runner = new RunnerClient(
      config({
        RUNNER_URL: "http://127.0.0.1:" + address.port,
        RUNNER_TOKEN: "r".repeat(40),
      }),
    );
    await assert.rejects(
      runner.run(
        {
          operationId: randomUUID(),
          taskId: randomUUID(),
          language: "python",
          code: "placeholder",
          inputs: [],
          outputs: [],
        },
        new AbortController().signal,
      ),
      (e) =>
        e instanceof ToolFailure &&
        e.code === "CODE_FAILED" &&
        e.details.stderr.startsWith("NameError") &&
        e.details.stderr.length === 8000,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});
