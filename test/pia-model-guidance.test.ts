// Pia's model choices and the owner's guidance note: with a note marked for model choices, session_start and
// session_model do nothing until Pia has read its latest revision for this decision, a start with the default model
// included; the owner's thinking rule is checked against the level the session would really think at.
import { cleanUp, home, lastText, newSession, owner, root, say, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";

const route: FauxResponseStep = (request) => {
    const { role, text: written } = lastText(request as never);
    const text = written.replace(/^\[from: [^\]]+\] /, "");

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`done: ${text}`)]);
    }

    const call = /^call (\S+) (.*)$/s.exec(text);

    return call === null
        ? fauxAssistantMessage([fauxText(`pia: ${text}`)])
        : fauxAssistantMessage(
              [fauxToolCall(call[1]!, JSON.parse(call[2]!) as Parameters<typeof fauxToolCall>[1])],
              { stopReason: "toolUse" },
          );
};

// "luna" thinks, but only up to high: an asked xhigh is lowered to high.
const faux = fauxProvider({
    tokensPerSecond: 2000,
    models: [{ id: "faux-1" }, { id: "faux-luna", reasoning: true }, { id: "faux-sol" }],
});

faux.setResponses(Array.from({ length: 1000 }, () => route));

const { PocketApp } = await import("../src/server/app.ts");

let app: Awaited<ReturnType<typeof PocketApp.open>>;

before(async () => {
    app = await PocketApp.open({
        dataDir: join(root, "pia-guidance-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => {
            models.registerNativeProvider(faux.provider);
        },
    });
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function pia(): Promise<ConversationId> {
    const id = await app.pia.ensure(owner(app));

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

async function last(id: ConversationId): Promise<string> {
    const entries = await app.transcripts.allEntries(id, true);
    const answer = entries.findLast((entry) => entry.kind === "assistant");

    return answer?.kind === "assistant"
        ? answer.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        : "";
}

/** The guidance code in a refusal. */
const codeIn = (error: unknown) => /guidance: "(\w+)"/.exec(String(error))?.[1];

async function refusal(run: () => Promise<unknown>): Promise<string> {
    try {
        await run();
    } catch (error) {
        return String(error);
    }

    throw new Error("expected a refusal");
}

test("without a guidance note, Pia starts and switches as before", async () => {
    const id = await pia();
    const made = await app.pia.start(id, { model: "faux sol" });

    assert.equal((await app.agentState(made))?.model?.modelId, "faux-sol");
});

test("with a guidance note, a start or a switch first returns the note and changes nothing", async () => {
    const id = await pia();
    const session = await newSession(app);
    const note = await app.memory.remember(session, owner(app), {
        title: "Model ranking",
        text: "Sol is stronger than Luna.\n\nLuna needs `xhigh` or `max`.",
        scope: "everywhere",
    });

    await app.memory.setPurpose(session, owner(app), note.id, {
        purpose: "model-choice",
        models: ["luna"],
        minThinking: "xhigh",
    });
    const before = app.sessions().length;

    // A start with the default model is a choice too.
    const first = await refusal(() => app.pia.start(id, {}));

    assert.match(first, /Nothing was started/);
    assert.match(first, /Sol is stronger than Luna/);
    assert.match(first, new RegExp(`<note id="${note.id}" revision="1"`));
    assert.match(first, /faux\/faux-luna: thinking off\/minimal\/low\/medium\/high/);
    assert.match(first, /Without a model, a new session gets/);
    assert.equal(app.sessions().length, before, "nothing made");

    // With the code, the start goes ahead, and says which revision guided it; the code is spent.
    const code = codeIn(first)!;
    const made = await app.pia.start(id, { guidance: code });

    assert.equal(app.sessions().length, before + 1);
    const again = await refusal(() => app.pia.start(id, { guidance: code }));

    assert.match(again, /not valid now/);

    // A switch, too: and a level the model lowers (xhigh to high) is checked as the level it thinks at.
    const session2 = Number(made);
    const switchCode = codeIn(
        await refusal(() => app.pia.setModel(id, session2, "faux luna xhigh")),
    )!;
    const lowered = await refusal(() =>
        app.pia.setModel(id, session2, "faux luna xhigh", switchCode),
    );

    assert.match(lowered, /would think at high \(it lowers xhigh to that\)/);
    assert.match(lowered, /This model has no level that high/);
    assert.notEqual((await app.agentState(made))?.model?.modelId, "faux-luna", "not switched");

    // A model outside the rule switches with a valid code, and the answer names the revision.
    const okCode = codeIn(await refusal(() => app.pia.setModel(id, session2, "faux sol")))!;
    const used = await app.pia.setModel(id, session2, "faux sol", okCode);

    assert.match(used, new RegExp(`guided by the owner's note \\[${note.id}\\] rev 1`));
    assert.equal((await app.agentState(made))?.model?.modelId, "faux-sol");

    // An approved edit makes an older code stale.
    const staleCode = codeIn(await refusal(() => app.pia.setModel(id, session2, "faux 1")))!;

    await app.memory.edit(session, owner(app), note.id, {
        text: "Sol is stronger than Luna.\n\nLuna needs `max`.",
    });
    assert.match(
        await refusal(() => app.pia.setModel(id, session2, "faux 1", staleCode)),
        /changed since you read it[\s\S]*revision="2"/,
    );
    await app.memory.setPurpose(session, owner(app), note.id, {});
});

test("a default model the rule refuses is refused before the session is made", async () => {
    const id = await pia();
    const session = await newSession(app);
    const note = await app.memory.remember(session, owner(app), {
        text: "Luna needs xhigh.",
        scope: "everywhere",
    });

    await app.memory.setPurpose(session, owner(app), note.id, {
        purpose: "model-choice",
        models: ["luna"],
        minThinking: "xhigh",
    });
    await app.setDefaultModel(owner(app), {
        provider: "faux",
        modelId: "faux-luna",
        thinkingLevel: "high",
    });
    const before = app.sessions().length;
    const code = codeIn(await refusal(() => app.pia.start(id, {})))!;
    const refused = await refusal(() => app.pia.start(id, { guidance: code }));

    assert.match(refused, /faux\/faux-luna would think at high/);
    assert.equal(app.sessions().length, before, "nothing made");

    // Through the tool: the first call answers with the note, and Pia calls again with the code.
    await app.setDefaultModel(owner(app), null);
    await say(app, id, `call session_start ${JSON.stringify({ model: "faux sol" })}`);
    const answered = await last(id);

    assert.match(answered, /Nothing was started/);
    const toolCode = /guidance: \\?"(\w+)/.exec(answered)![1]!;

    await say(
        app,
        id,
        `call session_start ${JSON.stringify({ model: "faux sol", guidance: toolCode })}`,
    );
    assert.match(await last(id), /done: Started session \/s\/\d+/);
    await app.memory.setPurpose(session, owner(app), note.id, {});
});
