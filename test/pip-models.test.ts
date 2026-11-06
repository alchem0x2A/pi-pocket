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
import { indexed, modelsNamed, personNamed } from "../src/server/model-names.ts";
import { rankModels } from "../src/server/models.ts";

/** When set, PiP's next request that carries "hold on" waits for it: PiP stays at work until then. */
let holding: Promise<void> | undefined;

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text: written } = lastText(request as never);
    const text = written.replace(/^\[from: [^\]]+\] /, "");

    if (!all.includes("You are PiP")) {
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
        ? fauxAssistantMessage([fauxText(`pip: ${text}`)])
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

/** A second provider signed in, with faux-z8 too: which of the two pays is the person's to say. */
const hub = {
    ...fauxProvider({ provider: "hub-copilot", models: [{ id: "faux-z8" }] }).provider,
    name: "Hub Copilot",
};

const { PocketApp } = await import("../src/server/app.ts");

let app: App;

before(async () => {
    app = await PocketApp.open({
        dataDir: join(root, "pip-models-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => {
            models.registerNativeProvider(faux.provider);
            models.registerNativeProvider(hub as never);
        },
    });
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** A fresh PiP context for the owner, on the scripted model. */
async function pip(): Promise<ConversationId> {
    const id = await app.pip.ensure(owner(app));

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    // What the person said in an earlier test is out of its context.
    await app.commands.reset(id, owner(app), undefined);

    return id;
}

/** What PiP said last. */
async function last(id: ConversationId): Promise<string> {
    const entries = await app.transcripts.allEntries(id, true);
    const answer = entries.findLast((entry) => entry.kind === "assistant");

    return answer?.kind === "assistant"
        ? answer.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        : "";
}

const model = (provider: string, id: string, name = id) =>
    ({ provider, id, name, input: ["text"] }) as unknown as Model<Api>;

test("a model's name that runs on into another's names only the longer one", () => {
    const alpha = model("acme", "alpha", "Alpha");
    const mini = model("acme", "alpha-mini", "Alpha Mini");
    const all = [alpha, mini];

    // "acme alpha" names alpha, but in "acme alpha mini" it is the start of alpha-mini's name.
    assert.deepEqual(modelsNamed("use acme/alpha-mini", all, true), [mini]);
    assert.equal(personNamed("use acme/alpha-mini", alpha, all), false);
    assert.equal(personNamed("use acme/alpha-mini", mini, all), true);
    // The shorter one is named on its own.
    assert.deepEqual(modelsNamed("use acme/alpha", all, true), [alpha]);
    assert.equal(personNamed("use acme/alpha", alpha, all), true);
});

test("a two-character short name counts only with its family's word in the same message", () => {
    const zeta = model("acme", "zeta-z9", "Zeta Z9");
    const all = [zeta];

    // With it, in the same message, they name it.
    assert.deepEqual(modelsNamed("use Zeta's Z9", all, true), [zeta]);
    // In another message, they do not.
    assert.deepEqual(modelsNamed(indexed(["I like zeta", "use Z9"]), all, true), []);
});

test("a model's name, and who pays after on or via, stay in one message", () => {
    const four = model("acme", "zeta-4o", "Zeta 4o");
    const all = [four];

    // From the end of one message into the start of the next, they name nothing.
    for (const messages of [["I like zeta", "4o apps"]]) {
        assert.deepEqual(modelsNamed(indexed(messages), all, true), [], messages.join(" | "));
    }

    // In one message, they do.
    assert.deepEqual(modelsNamed(indexed(["hello", "I like zeta 4o"]), all, true), [four]);

    const names: Record<string, string> = { "acme-go": "Acme Go", "kiwi-coding": "Kiwi Coding" };
    const at = Object.keys(names).map((provider) => model(provider, "kiwi-k3", "Kiwi K3"));
    const pays = (messages: string[]) =>
        at
            .filter((each) =>
                personNamed(indexed(messages), each, at, (provider) => names[provider]!),
            )
            .map((each) => each.provider);

    assert.deepEqual(pays(["use kiwi k3 on", "acme go is fine"]), []);
    assert.deepEqual(pays(["use kiwi k3 on acme go", "thanks"]), ["acme-go"]);
});

test("words that name a model not signed in name no shorter one that is", () => {
    const zeta = model("acme", "zeta-5", "Zeta 5");
    const nano = model("acme", "zeta-5-nano", "Zeta 5 Nano");
    const signedIn = [zeta];
    const known = [zeta, nano];

    assert.deepEqual(modelsNamed("use zeta-5-nano", signedIn, true, known), []);
    assert.equal(personNamed("use zeta-5-nano", zeta, signedIn, undefined, known), false);

    // Said on its own, it is named.
    assert.deepEqual(modelsNamed("use zeta-5", signedIn, true, known), [zeta]);
});

test("a model's name that touches Chinese, Japanese or Korean text names it", () => {
    const sol = model("openai-codex", "gpt-6.1-sol", "GPT-6.1 Sol");
    const opus = model("anthropic", "claude-opus-5", "Claude Opus 5");
    const all = [sol, opus];

    // Such a script writes no spaces between words: text glued to the name, before it or after it, still names it.
    assert.equal(personNamed("以后默认模型都用gpt-6.1 sol吧", sol, all), true);
    assert.equal(personNamed("新会话可以用opus5试试", opus, all), true);
    // Its words name no model on their own: an ordinary sentence such as this one names none.
    assert.deepEqual(modelsNamed("我的M3电脑跑不动", all, true), []);
});

test("PiP acts on a session only after it looked at it, and sees how it stands after", async () => {
    const id = await pip();
    const session = Number(await newSession(app));

    await assert.rejects(
        app.pip.send(id, session, "run the tests", false, "unread-1"),
        /Check \/s\/\d+ first with session_read/,
    );
    await assert.rejects(app.pip.stop(id, session), /Check \/s\/\d+ first/);
    await assert.rejects(app.pip.archive(id, session, true), /Check \/s\/\d+ first/);
    await assert.rejects(
        app.pip.schedule(id, session, "tomorrow 9:00", "check CI", "unread-2"),
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
    const started = await app.pip.start(id, {});

    await app.pip.send(id, Number(started), "first task", false, "started-1");

    // Following a session's own run is acting too: a report starts a run of PiP's.
    const busy = Number(await newSession(app));

    await app.commands.submit(busy as unknown as ConversationId, owner(app), {
        text: "work a while",
        requestId: "busy-1",
    });
    await until(() => app.isBusy(busy as unknown as ConversationId), "the session at work");
    await assert.rejects(app.pip.follow(id, busy, undefined, "follow-1"), /Check \/s\/\d+ first/);
    await until(() => !app.isBusy(busy as unknown as ConversationId), "the session at rest");
});

test("PiP starts a session on a model from a loose name, and switches a session's model", async () => {
    const id = await pip();
    const before = app.sessions().length;

    // No word of its person's needed; "faux 2" is enough to infer faux/faux-2.
    const made = await app.pip.start(id, { model: "faux 2" });

    assert.equal(app.sessions().length, before + 1);
    assert.equal((await app.agentState(made))?.model?.modelId, "faux-2");
    await assert.rejects(app.pip.start(id, { model: "no such thing" }), /No signed-in model fits "no such thing"[\s\S]*faux\/faux-2/);

    // A session PiP did not start must be read first.
    const session = Number(await newSession(app));

    await assert.rejects(app.pip.setModel(id, session, "faux-1"), /Check \/s\/\d+ first/);
    await app.pip.read(id, session);
    await app.pip.setModel(id, session, "faux-1");
    assert.equal((await app.agentState(session as unknown as ConversationId))?.model?.modelId, "faux-1");
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
