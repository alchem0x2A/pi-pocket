import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { VERIFIED_FABLE_52, withClaudeExtras } from "../src/server/extensions/tt-providers.ts";
import {
    modelFromDiscovery,
    nativeModel,
} from "../src/server/extensions/pi-claude-code/src/model-catalog.ts";

test("Fable 5.2 extras preserve metadata and account identity without duplicates", () => {
    const metadata = VERIFIED_FABLE_52.metadata!;

    assert.equal(metadata.id, "claude-fable-5-2");
    assert.equal(metadata.contextWindow, 1_000_000);
    assert.equal(metadata.maxTokens, 128_000);
    assert.equal(metadata.reasoning, true);
    assert.deepEqual(metadata.cost, { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 });

    for (const id of ["claude-code", "claude-code-personal"]) {
        const provider = { id, getModels: () => [metadata] } as unknown as Provider;
        const older = { ...metadata, provider: id, id: "claude-fable-5-1" };
        const added = withClaudeExtras(provider, [older], [VERIFIED_FABLE_52, VERIFIED_FABLE_52]);
        const fable = added.filter((model) => model.id === "claude-fable-5-2");

        assert.equal(fable.length, 1);
        assert.equal(fable[0]!.provider, id);
        assert.equal(fable[0]!.api, "claude-code-stream-json");
        assert.equal(fable[0]!.baseUrl, "process://claude-code");
        assert.deepEqual(fable[0]!.cost, metadata.cost);
        assert.deepEqual(withClaudeExtras(provider, [], [VERIFIED_FABLE_52]), []);

        const discovered = { ...metadata, provider: id, name: "Discovered Fable" } as Model<Api>;

        assert.equal(withClaudeExtras(provider, [discovered], [VERIFIED_FABLE_52])[0], discovered);
    }
});

test("the org default alias gets Fable 5.2 metadata without redirecting personal explicit requests", () => {
    const result = modelFromDiscovery({
        value: "default",
        resolvedModel: "claude-fable-5-2",
        displayName: "Default",
        description: "Fable",
        supportsAdaptiveThinking: true,
    });

    assert.equal(result.id, "default");
    assert.equal(result.name, "Default (Claude Fable 5.2)");
    assert.equal(result.contextWindow, 1_000_000);
    assert.equal(nativeModel("default"), "default");
    assert.equal(nativeModel("claude-fable-5-2"), "claude-fable-5-2");
});
