import {
    type App,
    cleanUp,
    home,
    lastText,
    newSession,
    owner,
    root,
    say,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Api, FauxResponseStep, Model } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { rankModels } from "../src/server/models.ts";

/** When set, Pia's next request that carries "hold on" waits for it: Pia stays at work until then. */
let holding: Promise<void> | undefined;

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text: written } = lastText(request as never);
    const text = written.replace(/^\[from: [^\]]+\] /, "");

    if (!all.includes("You are Pia")) {
        return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    }

    if (holding !== undefined && all.includes("hold on")) {
        const held = holding;

        holding = undefined;

        return held.then(() => fauxAssistantMessage([fauxText("held")]));
    }

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

const faux = fauxProvider({
    tokensPerSecond: 2000,
    models: [
        { id: "faux-1" },
        { id: "faux-2" },
        { id: "faux-z8" },
        { id: "faux-vision", input: ["text", "image"] },
        { id: "o3" },
    ],
});

faux.setResponses(Array.from({ length: 1000 }, () => route));

const { PocketApp } = await import("../src/server/app.ts");

let app: App;

before(async () => {
    app = await PocketApp.open({
        dataDir: join(root, "pia-models-data"),
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

/** A fresh Pia context for the owner, on the scripted model. */
async function pia(): Promise<ConversationId> {
    const id = await app.pia.ensure(owner(app));

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    // What the person said in an earlier test is out of its context.
    await app.commands.reset(id, owner(app), undefined);

    return id;
}

/** What Pia said last. */
async function last(id: ConversationId): Promise<string> {
    const entries = await app.transcripts.allEntries(id, true);
    const answer = entries.findLast((entry) => entry.kind === "assistant");

    return answer?.kind === "assistant"
        ? answer.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        : "";
}

const model = (provider: string, id: string, name = id) =>
    ({ provider, id, name, input: ["text"] }) as unknown as Model<Api>;

test("Pia acts on a session only after it looked at it, and sees how it stands after", async () => {
    const id = await pia();
    const session = Number(await newSession(app));

    await assert.rejects(
        app.pia.send(id, session, "run the tests", false, "unread-1"),
        /Check \/s\/\d+ first with session_read/,
    );
    await assert.rejects(app.pia.stop(id, session), /Check \/s\/\d+ first/);
    await assert.rejects(app.pia.archive(id, session, true), /Check \/s\/\d+ first/);
    await assert.rejects(
        app.pia.schedule(id, session, "tomorrow 9:00", "check CI", "unread-2"),
        /Check \/s\/\d+ first/,
    );

    // Once it read it, it may; its tool says how the session stands now.
    await say(app, id, `call session_read ${JSON.stringify({ session, entries: 4 })}`);
    await say(
        app,
        id,
        `call session_send ${JSON.stringify({ session, message: "run the tests", report: false })}`,
    );
    assert.match(
        await last(id),
        /done: Sent to \/s\/\d+\.\n\/s\/\d+ now: (working|about to start|idle)(, 1 message waiting)?, last active/,
    );
    await until(() => !app.isBusy(session as unknown as ConversationId), "the session at rest");

    // A session it started is one it knows.
    const started = await app.pia.start(id, {});

    await app.pia.send(id, Number(started), "first task", false, "started-1");

    // Following a session's own run is acting too: a report starts a run of Pia's.
    const busy = Number(await newSession(app));

    await app.commands.submit(busy as unknown as ConversationId, owner(app), {
        text: "work a while",
        requestId: "busy-1",
    });
    await until(() => app.isBusy(busy as unknown as ConversationId), "the session at work");
    await assert.rejects(app.pia.follow(id, busy, undefined, "follow-1"), /Check \/s\/\d+ first/);
    await until(() => !app.isBusy(busy as unknown as ConversationId), "the session at rest");
});

test("Pia starts a session on a model from a loose name, and switches a session's model", async () => {
    const id = await pia();
    const before = app.sessions().length;

    // No word of its person's needed; "faux 2" is enough to infer faux/faux-2.
    const made = await app.pia.start(id, { model: "faux 2" });

    assert.equal(app.sessions().length, before + 1);
    assert.equal((await app.agentState(made))?.model?.modelId, "faux-2");
    await assert.rejects(
        app.pia.start(id, { model: "no such thing" }),
        /No signed-in model fits "no such thing"[\s\S]*faux\/faux-2/,
    );

    // A session Pia did not start must be read first.
    const session = Number(await newSession(app));

    await assert.rejects(app.pia.setModel(id, session, "faux-1"), /Check \/s\/\d+ first/);
    await app.pia.read(id, session);
    await app.pia.setModel(id, session, "faux-1");
    assert.equal(
        (await app.agentState(session as unknown as ConversationId))?.model?.modelId,
        "faux-1",
    );
});

test("rankModels infers a loose name and its thinking level", () => {
    const luna = model("openai", "gpt-6-luna", "GPT-6 Luna");
    const codexLuna = model("openai-codex", "gpt-6-luna", "GPT-6 Luna");
    const sol = model("openai", "gpt-6.1-sol", "GPT-6.1 Sol");
    const all = [luna, codexLuna, sol];

    assert.deepEqual(rankModels("luna max", all), { models: [luna, codexLuna], level: "max" });
    assert.equal(rankModels("codex luna", all).models[0], codexLuna);
    assert.equal(rankModels("sol", all).models[0], sol);
    assert.deepEqual(rankModels("zzz", all).models, []);
});
