// Notes: Markdown bodies with titles and an explicit size limit, search and read; the notes a session read come back
// after a compaction with their current text, never in the system prompt; old pins are ignored; lessons saved before
// notes stay word for word.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { type Lesson, MemoryDoc, NotePinsDoc } from "../src/server/docs.ts";
import { MAX_LESSON } from "../src/server/memory.ts";

/**
 * "call TOOL JSON" calls a tool; "check WORD" answers whether WORD is in the system prompt; anything else is echoed.
 */
const route: FauxResponseStep = (request) => {
    const { role, text: written } = lastText(request as never);
    const text = written.replace(/^\[from: [^\]]+\] /, "");

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`ok: ${text}`)]);
    }

    const call = /^call (\S+) (.*)$/s.exec(text);

    if (call !== null) {
        return fauxAssistantMessage(
            [fauxToolCall(call[1]!, JSON.parse(call[2]!) as Parameters<typeof fauxToolCall>[1])],
            { stopReason: "toolUse" },
        );
    }

    // "seen WORD": whether WORD is in a message the model gets (the system prompt left out), before this one.
    if (text.startsWith("seen ")) {
        const word = text.slice(5);
        const { messages } = request as { messages: { role: string }[] };
        const given = JSON.stringify(
            messages.slice(0, -1).filter((message) => message.role !== "system"),
        );

        return fauxAssistantMessage([fauxText(`seen ${word}: ${given.includes(word)}`)]);
    }

    // "kept WORD": whether WORD is in the message with the notes read before a compaction, and that message's place.
    if (text.startsWith("kept ")) {
        const word = text.slice(5);
        const { messages } = request as { messages: { role: string; content: unknown }[] };
        const textOf = (message: { content: unknown }) =>
            JSON.stringify(message.content).replace(/\\"/g, '"');
        const at = messages.findIndex((message) =>
            textOf(message).includes("Notes you read with note_load before this compaction"),
        );
        const after = at > 0 && textOf(messages[at - 1]!).includes("<summary>");

        return fauxAssistantMessage([
            fauxText(
                `kept ${word}: ${at >= 0 && textOf(messages[at]!).includes(word)}${at >= 0 && !after ? " (misplaced)" : ""}`,
            ),
        ]);
    }

    // "system WORD": whether WORD is in any system message of the request.
    if (text.startsWith("system ")) {
        const word = text.slice(7);
        const { messages, systemPrompt } = request as {
            messages: { role: string }[];
            systemPrompt?: string;
        };
        const given = JSON.stringify([
            systemPrompt ?? "",
            ...messages.filter((message) => message.role === "system"),
        ]);

        return fauxAssistantMessage([fauxText(`system ${word}: ${given.includes(word)}`)]);
    }

    // The memory section as the model has it now: its latest version (a change is sent again as a later system message).
    if (text.startsWith("check ")) {
        const word = text.slice(6);
        const { messages } = request as {
            messages: { role: string; sections?: Record<string, string> }[];
        };
        const memory = messages.findLast((message) => message.sections?.memory !== undefined)
            ?.sections?.memory;

        return fauxAssistantMessage([fauxText(`has ${word}: ${memory?.includes(word) === true}`)]);
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const model = scriptedModel(route);
const data = join(root, "notes-data");
let app: App;
const folder = join(root, "notes-folder");

before(async () => {
    mkdirSync(folder, { recursive: true });
    app = await openApp(model, data);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** The memory section, rendered as the next request gets it. */
async function sectionText(id: ConversationId): Promise<string> {
    const agent = await (await app.conversation(id)).agent(context);
    const memory = agent.sections.find((section) => section.key === "memory")!;

    return (await memory.render(
        {
            conversationId: id,
            agent,
            env: undefined,
            shown: {},
            read: {
                snapshot: (...args: Parameters<App["harness"]["snapshot"]>) =>
                    app.harness.snapshot(...args),
            },
        } as never,
        context,
    )) as string;
}

async function answer(id: ConversationId): Promise<string> {
    const entries = await app.transcripts.allEntries(id, true);
    const last = entries.findLast((entry) => entry.kind === "assistant");

    return last?.kind === "assistant"
        ? last.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        : "";
}

const call = (tool: string, args: unknown) => `call ${tool} ${JSON.stringify(args)}`;
const person = () => ({ userId: owner(app).id, byPi: false, name: "Owner" });

async function clear(): Promise<void> {
    await app.harness.commit(async (tx) => {
        (await tx.doc(MemoryDoc)).items = {};
    }, context);
}

test("a note keeps its Markdown lines and its title; a body over the limit is refused, not cut", async () => {
    await clear();
    const id = await newSession(app, folder);
    const body =
        "## Ports\n\n- local: `8080`\n- proxy:\t`443`\n\n\n\n```sh\ncurl -s localhost:8080\n```";
    const note = await app.memory.remember(id, owner(app), {
        title: "Inference\u200B service ports",
        text: body,
        scope: "everywhere",
    });

    assert.equal(note.title, "Inference service ports");
    assert.equal(
        note.text,
        "## Ports\n\n- local: `8080`\n- proxy:    `443`\n\n```sh\ncurl -s localhost:8080\n```",
    );
    await assert.rejects(
        app.memory.remember(id, owner(app), { text: "x".repeat(MAX_LESSON + 1) }),
        (error: Error & { status?: number }) =>
            error.status === 413 && /4000 characters at most/.test(error.message),
    );
    await assert.rejects(
        app.memory.remember(id, owner(app), { text: "ok", title: "t".repeat(121) }),
        /A title is 120 characters at most/,
    );
    await clear();
});

test("the agent searches and reads notes; no note is in its prompt, and pending notes are never found", async () => {
    await clear();
    const id = await newSession(app, folder);

    await app.memory.add(id, folder, person(), {
        title: "Harness host folders",
        text: "Pia's code lives in ~/Dev/pi-pocket; its data in ~/.pi-pocket.",
        scope: "everywhere",
    });
    await app.memory.add(id, folder, person(), {
        title: "Decoy",
        text: "Something about gardening-tulips.",
        scope: "everywhere",
    });
    // The agent's own proposal waits: no search finds it.
    await app.memory.add(
        id,
        folder,
        { userId: owner(app).id, byPi: true, name: "the agent" },
        { text: "Unapproved-walrus fact.", scope: "everywhere" },
    );

    await say(app, id, "check ~/Dev/pi-pocket");
    assert.equal(await answer(id), "has ~/Dev/pi-pocket: false");
    await say(app, id, "check You have 2 notes");
    assert.equal(await answer(id), "has You have 2 notes: true");

    await say(app, id, call("note_search", { query: "where is the pi-pocket code" }));
    const partial = await answer(id);

    assert.match(partial, /some of them/);
    assert.match(partial, /Harness host folders/);
    await say(app, id, call("note_search", { query: "pi-pocket code" }));
    const found = await answer(id);

    assert.match(found, /1 note matches/);
    assert.doesNotMatch(found, /Decoy/);
    const noteId = /\[(\w+)\] Harness host folders/.exec(found)![1]!;

    await say(app, id, call("note_search", { query: "walrus" }));
    assert.match(await answer(id), /No note matches/);

    await say(app, id, call("note_load", { ids: [noteId, "nope"] }));
    const loaded = await answer(id);

    assert.match(loaded, new RegExp(`<note id="${noteId}" revision="1"`));
    assert.match(loaded, /~\/Dev\/pi-pocket/);
    assert.match(loaded, /No note nope here/);
    await say(app, id, "check ~/Dev/pi-pocket");
    assert.equal(
        await answer(id),
        "has ~/Dev/pi-pocket: false",
        "a read adds nothing to the prompt",
    );
    await clear();
});

test("note_load only reads: the old modes and their parameters are gone", async () => {
    await clear();
    const id = await newSession(app, folder);
    const tool = (await (await app.conversation(id)).agent(context)).tools.find(
        (each) => each.name === "note_load",
    )!;
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;

    assert.deepEqual(Object.keys(properties), ["ids"]);
    assert.doesNotMatch(tool.description, /pin|mode/i);
    const memory = app.memory as unknown as Record<string, unknown>;

    for (const gone of ["pin", "pinned", "pinFor"]) {
        assert.equal(memory[gone], undefined, `Memory has no ${gone}`);
    }

    const section = await sectionText(id);

    assert.doesNotMatch(section, /pin/i);
    assert.ok(section.split("\n").length >= 3 && section.split("\n").length <= 5, section);
    await clear();
});

test("the notes read before a compaction come back after it, with their current text, and not in the system prompt", async () => {
    await clear();
    app.settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
    const id = await newSession(app, folder);
    const kept = await app.memory.add(id, folder, person(), {
        title: "Deploy checklist",
        text: "Run make ship-heron before tagging.",
        scope: "project",
    });
    const gone = await app.memory.add(id, folder, person(), {
        title: "Old host",
        text: "The box is lynx-host.",
        scope: "everywhere",
    });

    await say(app, id, call("note_load", { ids: [kept.id, gone.id] }));
    assert.match(await answer(id), /ship-heron/);
    await say(app, id, "filler one");
    await say(app, id, "filler two");

    // The owner edits one note and forgets the other: after the compaction, the current text only.
    await app.memory.edit(id, owner(app), kept.id, {
        text: "Run make ship-eagle before tagging.",
        title: "Deploy checklist",
    });
    await app.memory.edit(id, owner(app), gone.id, "remove");
    await app.commands.compact(id, owner(app), undefined);
    await until(
        async () =>
            (await app.transcripts.allEntries(id, true)).some(
                (entry) => entry.kind === "compaction",
            ),
        "the compaction",
    );

    await say(app, id, "kept ship-eagle");
    assert.equal(await answer(id), "kept ship-eagle: true", "the read note is back, as it is now");
    await say(app, id, `kept ${kept.id}`);
    assert.equal(await answer(id), `kept ${kept.id}: true`, "with its id");
    await say(app, id, "kept Deploy checklist");
    assert.equal(await answer(id), "kept Deploy checklist: true", "and its title");
    await say(app, id, "kept ship-heron");
    assert.equal(await answer(id), "kept ship-heron: false", "not the old text");
    await say(app, id, `kept ${gone.id}`);
    assert.equal(await answer(id), `kept ${gone.id}: false`, "a deleted note stays out");
    await say(app, id, "system ship-eagle");
    assert.equal(await answer(id), "system ship-eagle: false", "never in the system prompt");

    // Through a restart too.
    await app.close();
    app = await openApp(model, data);
    app.settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
    await say(app, id, "kept ship-eagle");
    assert.equal(await answer(id), "kept ship-eagle: true", "after a restart");

    // A session that read nothing gets nothing.
    const other = await newSession(app, folder);

    await say(app, other, "filler");
    await app.commands.compact(other, owner(app), undefined);
    await until(
        async () =>
            (await app.transcripts.allEntries(other, true)).some(
                (entry) => entry.kind === "compaction",
            ),
        "the other compaction",
    );
    await say(app, other, "kept ship-eagle");
    assert.equal(await answer(other), "kept ship-eagle: false");
    app.settings.applyOverrides({ compaction: {} });
    await clear();
});

test("a session with pins stored before pins were removed loads and runs, and ignores them", async () => {
    await clear();
    const id = await newSession(app, folder);
    const note = await app.memory.add(id, folder, person(), {
        title: "Old pin",
        text: "Pinned-badger note.",
        scope: "project",
    });

    // As the old code stored a pin.
    await app.harness.commit(async (tx) => {
        (await tx.doc(NotePinsDoc, id)).items = {
            [note.id]: { at: 1, byPi: true, by: owner(app).id, reason: "old" },
        };
    }, context);
    await app.close();
    app = await openApp(model, data);

    // "seen" first: a later request has the "check" message itself.
    await say(app, id, "seen Pinned-badger");
    assert.equal(await answer(id), "seen Pinned-badger: false");
    await say(app, id, "check Pinned-badger");
    assert.equal(await answer(id), "has Pinned-badger: false", "the old pin is not in the prompt");
    const view = await app.memory.view(id, owner(app));

    assert.equal(view.lessons.find((each) => each.id === note.id)?.text, "Pinned-badger note.");
    assert.equal("pinned" in view.lessons[0]!, false, "the sheet has no pin mark");
    await clear();
});

test("lessons saved before notes keep their text, id, and approval, and an older tab's approval still holds", async () => {
    await clear();
    const id = await newSession(app, folder);
    // As the old system stored them: one line, no title or revision, some pending, one with a proposal.
    const legacy: Record<string, Lesson> = {
        d849b: {
            id: "d849b",
            text: "Any GitHub repo: task work in a worktree branch; push the branch, merge --no-ff.",
            by: owner(app).id,
            byPi: true,
            createdAt: 1,
        },
        a1b2c: {
            id: "a1b2c",
            text: "Waiting lesson text.",
            by: owner(app).id,
            byPi: true,
            createdAt: 2,
            pending: true,
        },
        e3f4g: {
            id: "e3f4g",
            text: "Old text in force.",
            by: owner(app).id,
            byPi: false,
            createdAt: 3,
            proposal: { text: "Proposed new text.", by: owner(app).id, byPi: true, at: 4 },
        },
    };

    await app.harness.commit(async (tx) => {
        (await tx.doc(MemoryDoc)).items = structuredClone(legacy);
    }, context);

    const view = await app.memory.view(id, owner(app));
    const byId = new Map(view.lessons.map((lesson) => [lesson.id, lesson]));

    for (const lesson of Object.values(legacy)) {
        assert.equal(byId.get(lesson.id)?.text, lesson.text, "the text is unchanged");
        assert.equal(byId.get(lesson.id)?.revision, 1);
        assert.equal(byId.get(lesson.id)?.title, undefined);
    }

    assert.equal(byId.get("a1b2c")?.pending, true);
    const hits = await app.memory.search(id, folder, "worktree branch");

    assert.equal(hits.hits[0]?.id, "d849b");
    assert.equal(hits.hits[0]?.title, legacy.d849b!.text);
    // An older tab sends only the text it saw: the approval holds, since no title waits.
    await app.memory.edit(id, owner(app), "e3f4g", "approve", { text: "Proposed new text." });
    const after = (await app.harness.snapshot(MemoryDoc, context))!.items;

    assert.equal(after.e3f4g?.text, "Proposed new text.");
    assert.equal(after.e3f4g?.revision, 2);
    assert.equal(after.d849b?.text, legacy.d849b!.text, "stored text never rewritten");
    assert.deepEqual(Object.keys(after.d849b!).sort(), Object.keys(legacy.d849b!).sort());
    await clear();
});

test("only the owner marks the model-choice note, and only one note for everywhere that is in force", async () => {
    await clear();
    const id = await newSession(app, folder);
    const guest = app.config.addUser("Gil", "guest").user;
    const one = await app.memory.add(id, folder, person(), {
        title: "Models",
        text: "Astra, then Sol.",
        scope: "everywhere",
    });
    const two = await app.memory.add(id, folder, person(), {
        text: "Other.",
        scope: "everywhere",
    });
    const local = await app.memory.add(id, folder, person(), { text: "Here.", scope: "project" });

    await assert.rejects(
        app.memory.setPurpose(id, guest, one.id, { purpose: "model-choice" }),
        /Only the owner/,
    );
    await assert.rejects(
        app.memory.setPurpose(id, owner(app), local.id, { purpose: "model-choice" }),
        /note for everywhere/,
    );
    await app.memory.setPurpose(id, owner(app), one.id, {
        purpose: "model-choice",
        models: ["luna", " Terra "],
        minThinking: "xhigh",
    });
    assert.deepEqual((await app.memory.modelGuidance())?.modelRule, {
        models: ["luna", "terra"],
        minThinking: "xhigh",
    });
    await app.memory.setPurpose(id, owner(app), two.id, { purpose: "model-choice" });
    assert.equal((await app.memory.modelGuidance())?.id, two.id, "one note at most");
    await app.memory.setPurpose(id, owner(app), two.id, {});
    assert.equal(await app.memory.modelGuidance(), undefined);
    await clear();
});
