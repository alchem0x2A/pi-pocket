import assert from "node:assert/strict";
import test from "node:test";
import { rewriteInitialRequest } from "../src/claude-cli.ts";

const marker = { type: "ephemeral", ttl: "1h" };

function countCacheControl(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + countCacheControl(child), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value).reduce(
    (sum, [key, child]) => sum + (key === "cache_control" ? 1 : countCacheControl(child)),
    0,
  );
}

test("caps five markers from Claude Code prefix, tools, system, and replay boundaries", () => {
  const prefix = [{ type: "text", text: "Claude Code prefix", cache_control: marker }];
  const canonical = [{ type: "text", text: "first query" }];
  const body = {
    system: [
      { type: "text", text: "identity", cache_control: marker },
      { type: "text", text: "prompt", cache_control: marker },
    ],
    tools: [{ name: "mcp__pi__read", input_schema: { type: "object" }, cache_control: marker }],
    messages: [
      { role: "user", content: [...prefix, ...canonical] },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      { role: "user", content: [{ type: "text", text: "previous query" }] },
      { role: "assistant", content: [{ type: "text", text: "second answer" }] },
      { role: "user", content: [{ type: "text", text: "current query" }] },
    ],
  };
  const rewritten = JSON.parse(
    rewriteInitialRequest(Buffer.from(JSON.stringify(body)), prefix, canonical, undefined, []).toString("utf8"),
  );

  assert.ok(countCacheControl(rewritten) <= 4, `found ${countCacheControl(rewritten)} cache_control markers`);
  assert.equal(rewritten.messages[0].content[0].cache_control, undefined);
  assert.deepEqual(rewritten.system.at(-1).cache_control, marker);
  assert.deepEqual(rewritten.tools[0].cache_control, marker);
  assert.deepEqual(rewritten.messages[2].content.at(-1).cache_control, marker);
  assert.deepEqual(rewritten.messages.at(-1).content.at(-1).cache_control, marker);
});

test("does not double-mark a pre-marked final system message", () => {
  const body = {
    system: [
      { type: "text", text: "billing" },
      { type: "text", text: "identity", cache_control: marker },
      { type: "text", text: "prompt", cache_control: marker },
    ],
    tools: [{ name: "mcp__pi__bash", input_schema: { type: "object" }, cache_control: marker }],
    messages: [
      { role: "user", content: [{ type: "text", text: "run it" }] },
      { role: "system", content: "environment" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "mcp__pi__bash", input: {} }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "hi" }] },
      {
        role: "system",
        content: [
          { type: "text", text: "date reminder", cache_control: marker },
          { type: "text", text: "parallel tool nudge" },
        ],
      },
    ],
  };
  const rewritten = JSON.parse(
    rewriteInitialRequest(
      Buffer.from(JSON.stringify(body)),
      undefined,
      body.messages[0].content as unknown[],
      [
        {
          role: "system",
          content: [{ type: "text", text: "environment", cache_control: marker }],
        },
      ],
      [],
    ).toString("utf8"),
  );
  const final = rewritten.messages.at(-1).content;

  assert.ok(countCacheControl(rewritten) <= 4, `found ${countCacheControl(rewritten)} cache_control markers`);
  assert.equal(final[0].cache_control, undefined);
  assert.deepEqual(final.at(-1).cache_control, marker);
});
