// A separate summary model can review compactions without changing the model that continues a session.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import { UsageDoc, type ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";

const context = BACKGROUND_CONTEXT;
let app: App | undefined;

after(async () => {
    await app?.close();
    cleanUp();
});

function summaryEntries(id: ConversationId) {
    return app!.transcripts
        .allEntries(id, true)
        .then((entries) => entries.filter((entry) => entry.kind === "compaction"));
}

async function sessionWithOneTurn(): Promise<ConversationId> {
    const id = await newSession(app!);

    await say(app!, id, "Keep this project moving.");

    return id;
}

function responder(_context: unknown, _options: unknown, _state: unknown, model: { id: string }) {
    return fauxAssistantMessage([fauxText(`summary from ${model.id}`)]);
}

test("the owner's review model writes summaries and leaves the session model unchanged", async () => {
    app = await openApp(scriptedModel(responder), join(root, "compaction-review-default"));
    app.settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
    await app.setCompactionModel(owner(app), {
        provider: "faux",
        modelId: "faux-2",
        thinkingLevel: "high",
    });
    const id = await sessionWithOneTurn();

    await app.commands.compact(id, owner(app), "Keep the open work.");
    await until(async () => (await summaryEntries(id)).length > 0, "the summary model to compact");

    const entries = await summaryEntries(id);
    const agent = await app.agentState(id);
    const usage = await app.harness.snapshot(UsageDoc, id, context);

    assert.match(JSON.stringify(entries[0]), /summary from faux-2/);
    assert.equal(agent?.model?.modelId, "faux-1");
    assert.ok(usage?.models["faux/faux-2"]);
});

test("the owner's default model is the compaction model when no override is set", async () => {
    app!.config.compactionModel = undefined;
    await app!.setDefaultModel(owner(app!), {
        provider: "faux",
        modelId: "faux-2",
        thinkingLevel: "off",
    });
    const id = await sessionWithOneTurn();

    await app!.commands.compact(id, owner(app!), undefined);
    await until(async () => (await summaryEntries(id)).length > 0, "the default model to compact");

    const entries = await summaryEntries(id);
    const agent = await app!.agentState(id);

    assert.match(JSON.stringify(entries[0]), /summary from faux-2/);
    assert.equal(agent?.model?.modelId, "faux-1");
});

test("a /compact model choice overrides the configured review model", async () => {
    app!.config.compactionModel = {
        provider: "faux",
        modelId: "faux-1",
        thinkingLevel: "off",
    };
    const id = await sessionWithOneTurn();

    await app!.commands.compact(id, owner(app!), undefined, {
        provider: "faux",
        modelId: "faux-2",
        thinkingLevel: "off",
    });
    await until(async () => (await summaryEntries(id)).length > 0, "the selected model to compact");

    const entries = await summaryEntries(id);
    const usage = await app!.harness.snapshot(UsageDoc, id, context);

    assert.match(JSON.stringify(entries[0]), /summary from faux-2/);
    assert.ok(usage?.models["faux/faux-2"]);
});
