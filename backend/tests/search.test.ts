import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearch, allowedTools } from "@hyper/runtime";
test("public RSS parsing skips unsafe URLs and does not mark snippets as read", () => {
  const r = parseSearch(
    "<rss><channel><item><title>private</title><link>http://127.0.0.1/</link></item><item><title>Evidence</title><link>https://example.com/a</link><description>Snippet</description></item><item><link>https://example.com/a</link></item></channel></rss>",
    "bing",
    5,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0]?.read, false);
  assert.equal(r[0]?.excerpt, "Snippet");
  assert.throws(() => parseSearch("<!DOCTYPE x><rss/>", "bing", 5));
});
test("public HTML fallback unwraps result redirects and preserves source URLs", () => {
  const r = parseSearch(
    '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fevidence">Result</a><div class="result__snippet">Source extract</div></div>',
    "duckduckgo",
    5,
  );
  assert.equal(r[0]?.url, "https://example.com/evidence");
  assert.equal(r[0]?.read, false);
});
test("agent tool selection restricts execution without allowing skill privilege expansion", () => {
  const context = {
    selection: {
      agentId: "a",
      skillIds: [],
      memoryIds: [],
      artifactIds: [],
      rubricIds: [],
    },
    items: [
      {
        id: "a",
        kind: "agents" as const,
        revision: 1,
        value: { tools: ["Documents"] },
      },
    ],
    memoryMode: "read-only",
  };
  const tools = allowedTools(context);
  assert.ok(tools.includes("code_execute"));
  assert.ok(!tools.includes("web_search"));
  assert.ok(!tools.includes("learning_propose"));
});
test("common runtime spellings normalize without guessing from program contents", async () => {
  const { normalizeCodeArguments } = await import("@hyper/runtime");
  assert.deepEqual(
    normalizeCodeArguments({ language: "Python3", code: "print(1)" }),
    { language: "python", code: "print(1)" },
  );
  assert.deepEqual(
    normalizeCodeArguments({ language: "JavaScript", code: "console.log(1)" }),
    { language: "node", code: "console.log(1)" },
  );
  assert.deepEqual(
    normalizeCodeArguments({ language: "python", code: "console.log(1)" }),
    { language: "python", code: "console.log(1)" },
  );
});
test("public image results retain license and attribution while stripping metadata markup", async () => {
  const { parseImages } = await import("@hyper/runtime");
  const r = parseImages({
    query: {
      pages: {
        "1": {
          title: "File:Example.png",
          imageinfo: [
            {
              url: "https://upload.wikimedia.org/example.png",
              descriptionurl:
                "https://commons.wikimedia.org/wiki/File:Example.png",
              extmetadata: {
                Artist: { value: '<a href="https://example.com">Author</a>' },
                LicenseShortName: { value: "CC BY-SA 4.0" },
              },
            },
          ],
        },
      },
    },
  });
  assert.equal(r[0]?.artist, "Author");
  assert.equal(r[0]?.license, "CC BY-SA 4.0");
  assert.ok(r[0]?.excerpt.includes("License:"));
});
