// A room's view keeps the whole active context over Pi Durable 1.5's windowed view watch.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, type ConversationId, UserEntry } from "@earendil-works/pi-durable";
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

const context = BACKGROUND_CONTEXT;
let app: App | undefined;

after(async () => {
    await app?.close();
    cleanUp();
});

/** The ids of the active context, as the model sees it. */
async function activeIds(id: ConversationId): Promise<number[]> {
    const conversation = (await app!.harness.conversation(id, context))!;

    return (await conversation.context(context)).entries.map((entry) => Number(entry.id));
}

test("a room's entries follow the active context past the watch's window and across a compaction", async () => {
    app = await openApp(scriptedModel(), join(root, "room-view"));
    app.settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
    const id = await newSession(app);
    const room = await app.room(id);

    try {
        // 60 turns are 120 entries and more: past the watch's 100, so its window moved while the room was open.
        for (let n = 1; n <= 60; n++) {
            await say(app, id, `message ${n}`);
        }

        await until(
            async () =>
                JSON.stringify(room.value!.entries.map((entry) => Number(entry.id))) ===
                JSON.stringify(await activeIds(id)),
            "the room to hold the whole active context",
        );
        assert.ok(room.value!.entries.length > 100);

        await app.commands.compact(id, owner(app), undefined);
        await until(
            () => room.value!.entries[0]?.kind === "pi.compaction",
            "the compaction to cut the room's entries",
        );
        await until(
            async () =>
                JSON.stringify(room.value!.entries.map((entry) => Number(entry.id))) ===
                JSON.stringify(await activeIds(id)),
            "the room to match the context after the compaction",
        );
        assert.ok(room.value!.entries.length < 100, "the entries before the head are gone");

        await say(app, id, "after the compaction");
        await until(
            async () =>
                JSON.stringify(room.value!.entries.map((entry) => Number(entry.id))) ===
                JSON.stringify(await activeIds(id)),
            "a new entry to join after the head",
        );
    } finally {
        app.releaseRoom(room);
    }
});

test("codemode's hooks read history as the task runtime does: one visible entry, and a fork-aware page", async () => {
    const id = await newSession(app!);

    await say(app!, id, "first words");
    const conversation = (await app!.harness.conversation(id, context))!;
    const newest = (await conversation.entries({}, 10, undefined, context)).items;
    const user = newest.find((entry) => entry.kind === "pi.user")!;
    const history = app!.history(id);

    assert.deepEqual(await history.entry(user.id, context), user);
    assert.deepEqual(await history.entry(UserEntry, user.id, context), user);
    assert.equal(await history.entry(AssistantEntry, user.id, context), undefined);
    assert.deepEqual((await history.entries({}, 10, undefined, context)).items, newest);

    // An entry of another conversation is not visible from this one.
    const other = await newSession(app!);

    assert.equal(await app!.history(other).entry(user.id, context), undefined);
});
