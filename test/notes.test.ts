// Notes: Markdown bodies with titles and an explicit size limit, search and load, session pins that last through
// compaction, a restart, and a model change and follow approved edits; lessons saved before notes stay word for word.
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

test("the agent searches and reads notes; nothing unpinned is in its prompt, and pending notes are never found", async () => {
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
    // A read pins nothing.
    assert.deepEqual(
        (await app.harness.snapshot(NotePinsDoc, id, context))?.items ?? {},
        {},
        "read mode stores no pin",
    );
    await clear();
});

test("a pin lasts through compaction, a restart, and a model change, follows approved edits, and goes with unpin", async () => {
    await clear();
    const id = await newSession(app, folder);
    const note = await app.memory.add(id, folder, person(), {
        title: "Deploy checklist",
        text: "Run make ship-heron before tagging.",
        scope: "project",
    });

    await say(app, id, call("note_load", { ids: [note.id], mode: "session", reason: "deploy" }));
    assert.match(await answer(id), /Pinned .* for this session/);
    await say(app, id, "check ship-heron");
    assert.equal(await answer(id), "has ship-heron: true");

    await app.commands.compact(id, owner(app), undefined);
    await say(app, id, "check ship-heron");
    assert.equal(await answer(id), "has ship-heron: true", "after compaction");

    await app.close();
    app = await openApp(model, data);
    await say(app, id, "check ship-heron");
    assert.equal(await answer(id), "has ship-heron: true", "after a restart");

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
    });
    await say(app, id, "check ship-heron");
    assert.equal(await answer(id), "has ship-heron: true", "after a model change");

    // The agent's proposed edit waits: the pin keeps the approved text. The owner's edit reaches the next request.
    await app.memory.change(
        id,
        folder,
        { userId: owner(app).id, byPi: true, name: "the agent" },
        note.id,
        {
            text: "Run make ship-eagle before tagging.",
        },
    );
    await say(app, id, "check ship-eagle");
    assert.equal(await answer(id), "has ship-eagle: false", "a proposal is not approved text");
    await app.memory.edit(id, owner(app), note.id, "approve", {
        text: "Run make ship-eagle before tagging.",
        title: "Deploy checklist",
    });
    await say(app, id, "check ship-eagle");
    assert.equal(await answer(id), "has ship-eagle: true", "the pin follows the approved edit");
    assert.equal((await app.harness.snapshot(MemoryDoc, context))?.items[note.id]?.revision, 2);

    await say(app, id, call("note_load", { mode: "list" }));
    assert.match(await answer(id), /Deploy checklist · rev 2/);
    await say(app, id, call("note_load", { ids: [note.id], mode: "unpin" }));
    await say(app, id, "check ship-eagle");
    assert.equal(await answer(id), "has ship-eagle: false");

    // Another session never had the pin.
    const other = await newSession(app, folder);

    await say(app, other, "check ship-eagle");
    assert.equal(await answer(other), "has ship-eagle: false");
    await clear();
});

test("a forgotten note leaves the pinned prompt; pins over the budget are refused with nothing pinned", async () => {
    await clear();
    const id = await newSession(app, folder);
    const small = await app.memory.add(id, folder, person(), {
        text: "Small-kiwi note.",
        scope: "project",
    });

    await app.memory.pin(id, folder, person(), [small.id], true);
    await say(app, id, "check Small-kiwi");
    assert.equal(await answer(id), "has Small-kiwi: true");
    await app.memory.edit(id, owner(app), small.id, "remove");
    await say(app, id, "check Small-kiwi");
    assert.equal(await answer(id), "has Small-kiwi: false");

    const big = [];

    for (let index = 0; index < 5; index++) {
        big.push(
            await app.memory.add(id, folder, person(), {
                text: `${String(index)} ${"y".repeat(MAX_LESSON - 10)}`,
                scope: "project",
            }),
        );
    }

    await app.memory.pin(id, folder, person(), [big[0]!.id, big[1]!.id, big[2]!.id], true);
    await assert.rejects(
        app.memory.pin(id, folder, person(), [big[3]!.id, big[4]!.id], true),
        /Nothing was pinned/,
    );
    assert.deepEqual(
        (await app.memory.pinned(id, folder)).map((note) => note.id),
        [big[0]!.id, big[1]!.id, big[2]!.id],
    );
    // A small model's context gets a smaller budget.
    await assert.rejects(
        app.memory.pin(id, folder, person(), [big[3]!.id], true, { window: 8000 }),
        /budget is 3200/,
    );
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
