import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_CODE_MODELS,
  modelFromDiscovery,
  nativeModel,
  supportsNativeToolChanges,
} from "../src/model-catalog.ts";

test("fallback catalog matches Claude Code's selectable model families", () => {
  assert.deepEqual(
    CLAUDE_CODE_MODELS.map((model) => model.id),
    [
      "default",
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ],
  );
  assert.equal(nativeModel("default"), "default");
  assert.equal(nativeModel("claude-opus-5-5"), "opus[1m]");
  assert.equal(nativeModel("claude-sonnet-5"), "sonnet");
  assert.equal(supportsNativeToolChanges("default"), true);
  assert.equal(supportsNativeToolChanges("claude-opus-5-5"), true);
  assert.equal(supportsNativeToolChanges("claude-fable-5-1"), true);
  assert.equal(supportsNativeToolChanges("claude-sonnet-5"), false);
});

test("maps discovered aliases to stable canonical the agent model ids", () => {
  const opus = modelFromDiscovery({
    value: "opus[1m]",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Opus (1M context)",
    description: "Opus 5.5 with 1M context",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high", "max"],
    supportsAdaptiveThinking: true,
  });
  assert.equal(opus.id, "claude-opus-5-5");
  assert.equal(opus.name, "Claude Opus 5.5");
  assert.equal(opus.contextWindow, 1_000_000);
  assert.deepEqual(opus.cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.deepEqual(opus.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });

  const future = modelFromDiscovery({
    value: "future",
    resolvedModel: "claude-future-1",
    displayName: "Future",
    description: "A newly available model",
  });
  assert.equal(future.id, "claude-future-1");
  assert.equal(future.cost.input, 0);
});

test("a discovered Fable 5.2 gets its published metadata while the fallback keeps Fable 5.1", () => {
  // The installed CLI cannot select Fable 5.2 until it is updated: the fallback list must not offer it.
  assert.ok(!CLAUDE_CODE_MODELS.some((model) => model.id === "claude-fable-5-2"));
  assert.ok(CLAUDE_CODE_MODELS.some((model) => model.id === "claude-fable-5-1"));

  const fable = modelFromDiscovery({
    value: "claude-fable-5-2[1m]",
    resolvedModel: "claude-fable-5-2",
    displayName: "Fable",
    description: "Fable 5.2 · Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  });
  assert.equal(fable.id, "claude-fable-5-2");
  assert.equal(fable.name, "Claude Fable 5.2");
  assert.equal(fable.api, "claude-code-stream-json");
  assert.equal(fable.baseUrl, "process://claude-code");
  // No "1M context" in the description: the window comes from the metadata, not from the text.
  assert.equal(fable.contextWindow, 1_000_000);
  assert.deepEqual(fable.cost, { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 });
  assert.equal(fable.maxTokens, 128_000);
  assert.equal(fable.reasoning, true);
  assert.equal(nativeModel("claude-fable-5-2"), "claude-fable-5-2[1m]");
  assert.equal(supportsNativeToolChanges("claude-fable-5-2"), true);

  // Fable 5.1 keeps the SDK's own metadata.
  const older = modelFromDiscovery({
    value: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable",
    description: "Fable 5.1 · Most capable for your hardest and longest-running tasks",
    supportsAdaptiveThinking: true,
  });
  assert.equal(older.name, "Claude Fable 5.1");
  assert.deepEqual(older.cost, { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
});
