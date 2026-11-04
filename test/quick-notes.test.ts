// Device-side idea capture and inbox-only synchronization (`web/quick-notes.js`).
import assert from "node:assert/strict";
import { test } from "node:test";

type Note = {
    id: string;
    text: string;
    createdAt: number;
    state: "local" | "synced" | "archived";
    pendingSync?: boolean;
    archivePending?: boolean;
};
type Storage = {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
};
type Result = { note: Note };
type Inbox = {
    notes: Note[];
    readonly ready: Promise<void>;
    readonly syncStatus: { error: string | null; attempted: boolean };
    subscribe(
        listener: (notes: Note[], status: { error: string | null; attempted: boolean }) => void,
    ): () => void;
    add(text: string): Promise<Note>;
    refresh(): Note[];
    flush(): Promise<number>;
    setArchived(id: string, archived: boolean): Promise<void>;
    continueNote(id: string): Promise<Result & { conversationId: number }>;
};
type Options = {
    storage: Storage;
    key: string;
    legacyKey?: string;
    sync?(note: Note): Promise<Result>;
    list?(): Promise<{ notes: Note[] }>;
    archive?(id: string, archived: boolean): Promise<Result>;
    continueNote?(id: string): Promise<Result & { conversationId: number }>;
    makeId(): string;
    now?(): number;
};
const { createQuickNotes, readInboxAccount, rememberInboxAccount, forgetInboxAccount } =
    (await import(new URL("../web/quick-notes.js", import.meta.url).href)) as {
        createQuickNotes(options: Options): Inbox;
        readInboxAccount(storage: Storage): { id: string } | null;
        rememberInboxAccount(storage: Storage, user: { id: string; role: string } | null): void;
        forgetInboxAccount(storage: Storage): void;
    };

class MemoryStorage implements Storage {
    values = new Map<string, string>();

    getItem(key: string) {
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string) {
        this.values.set(key, value);
    }

    removeItem(key: string) {
        this.values.delete(key);
    }
}

function setup(options: Partial<Options> = {}) {
    const storage = options.storage ?? new MemoryStorage();
    let nextId = 0;
    const remote = new Map<string, Note>();
    const calls: string[] = [];
    const inbox = createQuickNotes({
        storage,
        key: "owner-notes",
        makeId: () => `note-${++nextId}`,
        now: () => 1234,
        sync: async (note) => {
            calls.push(`inbox:${note.id}`);
            const saved = remote.get(note.id) ?? {
                id: note.id,
                text: note.text,
                createdAt: note.createdAt,
                state: "synced" as const,
            };

            remote.set(note.id, saved);

            return { note: saved };
        },
        list: async () => ({ notes: [...remote.values()] }),
        archive: async (id, archived) => {
            calls.push(`archive:${id}:${archived}`);
            const note = {
                ...remote.get(id)!,
                state: archived ? ("archived" as const) : ("synced" as const),
            };

            remote.set(id, note);

            return { note };
        },
        continueNote: async (id) => {
            calls.push(`continue:${id}`);
            const note = { ...remote.get(id)!, state: "archived" as const };

            remote.set(id, note);

            return { note, conversationId: 42 };
        },
        ...options,
    });

    return { inbox, storage, calls, remote };
}

test("capture persists before network synchronization and survives a reload", async () => {
    const { inbox, storage, calls } = setup();

    assert.ok(inbox.ready instanceof Promise, "initialization exposes its storage-lock promise");
    const note = await inbox.add("  Check the build later  ");

    assert.equal(note.state, "local");
    assert.equal(JSON.parse(storage.getItem("owner-notes")!)[0].text, "Check the build later");
    assert.deepEqual(calls, []);
    const reloaded = setup({ storage }).inbox;

    await reloaded.ready;
    assert.deepEqual(reloaded.notes, [note]);
});

test("simultaneous captures from independent models retain both notes in shared storage", async () => {
    const storage = new MemoryStorage();
    const key = "simultaneous-captures";
    const first = createQuickNotes({ storage, key, makeId: () => "first-tab" });
    const second = createQuickNotes({ storage, key, makeId: () => "second-tab" });
    const notes = await Promise.all([
        first.add("First tab's idea"),
        second.add("Second tab's idea"),
    ]);
    const reloaded = createQuickNotes({ storage, key, makeId: () => "unused" });

    await reloaded.ready;
    assert.deepEqual(
        reloaded.notes.map((note) => [note.id, note.text]).sort(),
        notes.map((note) => [note.id, note.text]).sort(),
    );
    assert.equal(reloaded.notes.length, 2);
    assert.ok(reloaded.notes.every((note) => note.state === "local" && note.pendingSync));
});

test("legacy migration racing another model's capture retains both under the same key", async () => {
    const storage = new MemoryStorage();
    const key = "migration-and-capture";
    const legacyKey = "legacy-race";
    const legacy = JSON.stringify([
        { id: "legacy-note", text: "Old cached idea", createdAt: 1, state: "cached" },
    ]);

    storage.setItem(legacyKey, legacy);
    const capturing = createQuickNotes({ storage, key, makeId: () => "new-note" });
    const capture = capturing.add("New idea during migration");
    const migrating = createQuickNotes({
        storage,
        key,
        legacyKey,
        makeId: () => "unused-migration",
    });

    await Promise.all([capture, migrating.ready]);
    const reloaded = createQuickNotes({ storage, key, makeId: () => "unused-reload" });

    await reloaded.ready;
    assert.deepEqual(reloaded.notes.map((note) => [note.id, note.text]).sort(), [
        ["legacy-note", "Old cached idea"],
        ["new-note", "New idea during migration"],
    ]);
    assert.ok(reloaded.notes.every((note) => note.state === "local" && note.pendingSync));
    assert.equal(storage.getItem(legacyKey), legacy, "migration keeps the legacy cache intact");
});

test("synchronization uses the inbox only, never continues a conversation, and preserves order", async () => {
    const { inbox, calls } = setup();

    await inbox.add("First idea");
    await inbox.add("Second idea");
    assert.equal(await inbox.flush(), 2);
    assert.deepEqual(calls, ["inbox:note-1", "inbox:note-2"]);
    assert.deepEqual(
        inbox.notes.map((note) => note.state),
        ["synced", "synced"],
    );
    await inbox.flush();
    assert.deepEqual(calls, ["inbox:note-1", "inbox:note-2"]);
});

test("offline synchronization retries the same note id without marking it synced early", async () => {
    let offline = true;
    const ids: string[] = [];
    const { inbox } = setup({
        list: undefined,
        sync: async (note) => {
            ids.push(note.id);

            if (offline) {
                throw new Error("offline");
            }

            return { note: { ...note, pendingSync: undefined, state: "synced" } };
        },
    });

    await inbox.add("Idea");
    assert.equal(await inbox.flush(), 0);
    assert.equal(inbox.notes[0]!.state, "local");
    offline = false;
    assert.equal(await inbox.flush(), 1);
    assert.deepEqual(ids, ["note-1", "note-1"]);
    assert.equal(inbox.notes[0]!.state, "synced");
});

test("concurrent flush calls share one synchronization pass and retain another tab's capture", async () => {
    let accept!: () => void;
    const gate = new Promise<void>((resolve) => {
        accept = resolve;
    });
    const storage = new MemoryStorage();
    const { inbox } = setup({
        storage,
        list: undefined,
        sync: async (note) => {
            await gate;

            return {
                note: { id: note.id, text: note.text, createdAt: note.createdAt, state: "synced" },
            };
        },
    });

    await inbox.add("First");
    const first = inbox.flush();

    assert.equal(first, inbox.flush());
    const other = setup({ storage, makeId: () => "other-tab" }).inbox;

    await other.add("Second");
    accept();
    assert.equal(await first, 2);
    assert.deepEqual(inbox.notes.map((note) => note.id).sort(), ["note-1", "other-tab"]);
});

test("a capture during an in-flight list is synchronized by the requested flush", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const listing = new Promise<void>((resolve) => {
        started = resolve;
    });
    const { inbox, remote } = setup({
        list: async () => {
            started();
            await gate;

            return { notes: [...remote.values()] };
        },
    });
    const initial = inbox.flush();

    await listing;
    const note = await inbox.add("Captured while listing");
    const requested = inbox.flush();

    release();
    await Promise.all([initial, requested]);
    assert.equal(
        remote.get(note.id)?.text,
        note.text,
        "the requested flush synchronizes the new capture",
    );
    assert.equal(inbox.notes[0]!.state, "synced");
});

test("archive and restore keep notes recoverable and never create a conversation", async () => {
    const { inbox, calls } = setup();
    const note = await inbox.add("Idea to review");

    await inbox.flush();
    await inbox.setArchived(note.id, true);
    assert.equal(inbox.notes[0]!.state, "archived");
    await inbox.setArchived(note.id, false);
    assert.equal(inbox.notes[0]!.state, "synced");
    assert.equal(inbox.notes[0]!.text, "Idea to review");
    assert.ok(calls.every((call) => !call.startsWith("continue:")));
});

test("offline archive survives reload and synchronizes without becoming a pending idea", async () => {
    let online = false;
    const storage = new MemoryStorage();
    const { inbox, remote, calls } = setup({
        storage,
        sync: async (note) => {
            if (!online) {
                throw new Error("offline");
            }

            const saved: Note = {
                id: note.id,
                text: note.text,
                createdAt: note.createdAt,
                state: "synced",
            };

            remote.set(note.id, saved);

            return { note: saved };
        },
    });
    const note = await inbox.add("Archived while offline");

    await inbox.setArchived(note.id, true);
    assert.equal(inbox.notes[0]!.state, "archived");
    assert.equal(inbox.notes[0]!.pendingSync, true);
    const reloaded = setup({ storage }).inbox;

    await reloaded.ready;
    assert.equal(reloaded.notes[0]!.state, "archived");
    online = true;
    await inbox.flush();
    assert.equal(remote.get(note.id)!.state, "archived");
    assert.equal(inbox.notes[0]!.archivePending, undefined);
    assert.deepEqual(calls, ["archive:note-1:true"]);
});

test("only an explicit Continue action creates a conversation and archives the original", async () => {
    const { inbox, calls } = setup();
    const note = await inbox.add("Discuss this later");

    await inbox.flush();
    assert.ok(!calls.some((call) => call.startsWith("continue:")));
    const result = await inbox.continueNote(note.id);

    assert.equal(result.conversationId, 42);
    assert.equal(inbox.notes[0]!.state, "archived");
    assert.equal(calls.filter((call) => call.startsWith("continue:")).length, 1);
});

test("a failed Continue action leaves the original pending", async () => {
    const { inbox } = setup({
        continueNote: async () => {
            throw new Error("creation failed");
        },
    });
    const note = await inbox.add("Keep this idea");

    await assert.rejects(inbox.continueNote(note.id), /creation failed/);
    assert.equal(inbox.notes[0]!.state, "synced");
});

test("server archives from another device replace the local synced view without resurrection", async () => {
    const { inbox, remote } = setup();
    const note = await inbox.add("Review");

    await inbox.flush();
    remote.set(note.id, { ...remote.get(note.id)!, state: "archived" });
    await inbox.flush();
    assert.equal(inbox.notes[0]!.state, "archived");
});

test("legacy delivered chat notes become archives; cached notes remain local ideas", async () => {
    const storage = new MemoryStorage();

    storage.setItem(
        "legacy",
        JSON.stringify([
            { id: "old", text: "Already sent to chat", createdAt: 1, state: "delivered" },
            { id: "pending", text: "Not sent", createdAt: 2, state: "cached" },
        ]),
    );
    const { inbox } = setup({ storage, legacyKey: "legacy" });

    await inbox.ready;
    assert.deepEqual(
        inbox.notes.map((note) => note.state),
        ["archived", "local"],
    );
    assert.equal(inbox.notes[0]!.archivePending, true);
    assert.ok(storage.getItem("legacy"));
});

test("sync failures remain visible through retries and clear only after successful inbox synchronization", async () => {
    let fail = true;
    let release!: () => void;
    const retry = new Promise<void>((resolve) => {
        release = resolve;
    });
    const { inbox } = setup({
        list: undefined,
        sync: async (note) => {
            if (fail) {
                throw new Error(
                    "HTTP 404: The inbox endpoint is unavailable. The server may need a restart.",
                );
            }

            await retry;

            return {
                note: { id: note.id, text: note.text, createdAt: note.createdAt, state: "synced" },
            };
        },
    });
    const changes: (string | null)[] = [];
    const unsubscribe = inbox.subscribe((_notes, status) => changes.push(status.error));

    await inbox.add("Keep this idea locally");
    assert.deepEqual(inbox.syncStatus, { error: null, attempted: false });
    assert.equal(await inbox.flush(), 0);
    assert.equal(inbox.notes[0]!.state, "local");
    assert.equal(inbox.syncStatus.attempted, true);
    assert.match(inbox.syncStatus.error!, /HTTP 404.*endpoint.*restart/);
    const failure = inbox.syncStatus.error;

    fail = false;
    const flushing = inbox.flush();

    await Promise.resolve();
    assert.equal(inbox.syncStatus.error, failure, "a retry does not hide the last failure");
    release();
    assert.equal(await flushing, 1);
    assert.equal(inbox.notes[0]!.state, "synced");
    assert.deepEqual(inbox.syncStatus, { error: null, attempted: true });
    assert.ok(changes.includes(failure));
    assert.equal(changes.at(-1), null);
    unsubscribe();
});

test("a failed retry after capture during listing does not clear its failure reason", async () => {
    const { inbox } = setup({
        list: async () => {
            await inbox.add("Captured during the list");

            return { notes: [] };
        },
        sync: async () => {
            throw new Error("HTTP 503: Inbox synchronization is unavailable.");
        },
    });

    assert.equal(await inbox.flush(), 0);
    assert.equal(inbox.notes[0]!.state, "local");
    assert.match(inbox.syncStatus.error!, /HTTP 503/);
});

test("failure status survives creation, reload and refresh until a complete successful sync", async () => {
    const storage = new MemoryStorage();
    let fail = true;

    const sync: NonNullable<Options["sync"]> = async (note) => {
        if (fail) {
            throw new Error("offline status");
        }

        return {
            note: { id: note.id, text: note.text, createdAt: note.createdAt, state: "synced" },
        };
    };

    const first = setup({ storage, sync, list: undefined }).inbox;

    await first.add("Pending");
    await first.flush();
    const failure = { error: "offline status", attempted: true };

    assert.deepEqual(first.syncStatus, failure);
    assert.deepEqual(JSON.parse(storage.getItem("owner-notes.sync-status")!), failure);
    const reloaded = setup({ storage, sync, list: undefined }).inbox;

    assert.deepEqual(reloaded.syncStatus, failure, "status is available before ready or flush");
    await reloaded.ready;
    assert.deepEqual(reloaded.syncStatus, failure);
    const observer = setup({ storage, sync, list: undefined }).inbox;

    await observer.ready;
    storage.setItem(
        "owner-notes.sync-status",
        JSON.stringify({ error: "other tab", attempted: true }),
    );
    observer.refresh();
    assert.deepEqual(observer.syncStatus, { error: "other tab", attempted: true });
    fail = false;
    assert.equal(await reloaded.flush(), 1);
    assert.deepEqual(reloaded.syncStatus, { error: null, attempted: true });
    observer.refresh();
    assert.deepEqual(observer.syncStatus, { error: null, attempted: true });
    assert.deepEqual(JSON.parse(storage.getItem("owner-notes.sync-status")!), observer.syncStatus);
});

test("legacy delivered notes archive remotely and cached notes sync without Continue", async () => {
    const storage = new MemoryStorage();

    storage.setItem(
        "legacy",
        JSON.stringify([
            { id: "sent-1", text: "Sent one", createdAt: 1, state: "delivered" },
            { id: "sent-2", text: "Sent two", createdAt: 2, state: "delivered" },
            { id: "cached", text: "Not sent", createdAt: 3, state: "cached" },
        ]),
    );
    const { inbox, remote, calls } = setup({ storage, legacyKey: "legacy" });

    await inbox.ready;
    assert.deepEqual(
        inbox.notes.map((note) => note.state),
        ["archived", "archived", "local"],
    );
    assert.equal(await inbox.flush(), 3);
    assert.equal(remote.get("sent-1")?.state, "archived");
    assert.equal(remote.get("sent-2")?.state, "archived");
    assert.equal(remote.get("cached")?.state, "synced");
    assert.equal(inbox.notes.filter((note) => note.state === "archived").length, 2);
    assert.equal(inbox.notes.filter((note) => note.state === "synced").length, 1);
    assert.ok(calls.every((call) => !call.startsWith("continue:")));
});

test("migration merges later legacy captures into an existing v2 inbox without resurrection", async () => {
    const storage = new MemoryStorage();
    const legacy = [
        { id: "known", text: "Already continued", createdAt: 1, state: "cached" },
        { id: "old", text: "Old cache", createdAt: 2, state: "cached" },
    ];

    storage.setItem(
        "owner-notes",
        JSON.stringify([
            { id: "known", text: "Already continued", createdAt: 1, state: "archived" },
            {
                id: "existing",
                text: "Existing capture",
                createdAt: 3,
                state: "local",
                pendingSync: true,
            },
        ]),
    );
    storage.setItem("legacy", JSON.stringify(legacy));
    const first = setup({ storage, legacyKey: "legacy" }).inbox;

    await first.ready;
    assert.equal(first.notes.find((note) => note.id === "known")?.state, "archived");
    assert.equal(first.notes.find((note) => note.id === "old")?.state, "local");
    legacy.push({ id: "new", text: "Later cache", createdAt: 4, state: "cached" });
    storage.setItem("legacy", JSON.stringify(legacy));
    const second = setup({ storage, legacyKey: "legacy" }).inbox;

    await second.ready;
    assert.deepEqual(second.notes.map((note) => note.id).sort(), [
        "existing",
        "known",
        "new",
        "old",
    ]);
    assert.equal(second.notes.find((note) => note.id === "known")?.state, "archived");
    assert.equal(second.notes.find((note) => note.id === "new")?.pendingSync, true);
    assert.equal(new Set(second.notes.map((note) => note.id)).size, 4);
});

test("an empty server list cannot hide an unsynchronized local capture", async () => {
    const { inbox } = setup({ sync: undefined, list: async () => ({ notes: [] }) });
    const note = await inbox.add("Keep this capture");

    await inbox.flush();
    assert.deepEqual(inbox.notes, [note]);
});

test("a lost capture response retries the same id without a duplicate durable note", async () => {
    const remote = new Map<string, Note>();
    let loseResponse = true;
    const { inbox } = setup({
        list: async () => ({ notes: [...remote.values()] }),
        sync: async (note) => {
            const saved: Note = remote.get(note.id) ?? {
                id: note.id,
                text: note.text,
                createdAt: note.createdAt,
                state: "synced",
            };

            remote.set(note.id, saved);

            if (loseResponse) {
                loseResponse = false;

                throw new Error("The capture response was lost.");
            }

            return { note: saved };
        },
    });

    await inbox.add("Synthetic capture");
    assert.equal(await inbox.flush(), 0);
    assert.equal(remote.size, 1);
    assert.equal(inbox.notes[0]!.state, "local");
    assert.equal(await inbox.flush(), 1);
    assert.equal(remote.size, 1);
    assert.equal(inbox.notes.length, 1);
    assert.equal(inbox.notes[0]!.state, "synced");
});

test("a legacy capture appended after initialization syncs without recreating the model", async () => {
    const storage = new MemoryStorage();

    storage.setItem("owner-notes", "[]");
    storage.setItem("legacy", "[]");
    const { inbox, remote } = setup({ storage, legacyKey: "legacy" });

    await inbox.ready;
    storage.setItem(
        "legacy",
        JSON.stringify([
            { id: "late", text: "Synthetic legacy capture", createdAt: 1, state: "cached" },
        ]),
    );
    assert.equal(await inbox.flush(), 1);
    assert.equal(remote.size, 1);
    assert.equal(inbox.notes[0]!.state, "synced");
    assert.equal(inbox.notes[0]!.pendingSync, undefined);
});

test("a missing server record is retried rather than removing the cached idea", async () => {
    const storage = new MemoryStorage();

    storage.setItem(
        "owner-notes",
        JSON.stringify([
            { id: "receipt", text: "Synthetic receipt", createdAt: 1, state: "synced" },
        ]),
    );
    const { inbox, remote } = setup({ storage });

    await inbox.ready;
    assert.equal(await inbox.flush(), 1);
    assert.equal(remote.size, 1);
    assert.equal(inbox.notes.length, 1);
    assert.equal(inbox.notes[0]!.state, "synced");
});

test("an acknowledgement for another note cannot discard a local capture", async () => {
    const { inbox } = setup({
        list: undefined,
        sync: async () => ({
            note: { id: "different", text: "Synthetic response", createdAt: 1, state: "synced" },
        }),
    });
    const saved = await inbox.add("Synthetic capture");

    assert.equal(await inbox.flush(), 0);
    assert.deepEqual(inbox.notes, [saved]);
    assert.match(inbox.syncStatus.error!, /exact note/);
});

test("a failed pending note does not block later captures and its failure persists", async () => {
    const attempted: string[] = [];
    const { inbox, storage } = setup({
        list: async () => ({ notes: [] }),
        sync: async (note) => {
            attempted.push(note.id);

            if (note.id === "note-1") {
                throw new Error("first failed");
            }

            return {
                note: { id: note.id, text: note.text, createdAt: note.createdAt, state: "synced" },
            };
        },
    });

    await inbox.add("Fails");
    await inbox.add("Succeeds");
    assert.equal(await inbox.flush(), 1);
    assert.deepEqual(attempted, ["note-1", "note-2"]);
    assert.equal(inbox.notes.find((note) => note.id === "note-1")?.state, "local");
    assert.equal(inbox.notes.find((note) => note.id === "note-2")?.state, "synced");
    assert.equal(inbox.syncStatus.error, "first failed");
    assert.equal(JSON.parse(storage.getItem("owner-notes.sync-status")!).error, "first failed");
});

test("an unreadable legacy cache cannot block a valid current capture", async () => {
    const storage = new MemoryStorage();

    storage.setItem("legacy", "{");
    const { inbox, remote } = setup({ storage, legacyKey: "legacy" });

    await inbox.ready;
    await inbox.add("Synthetic current capture");
    assert.equal(await inbox.flush(), 1);
    assert.equal(remote.size, 1);
    assert.equal(inbox.notes[0]!.state, "synced");
    assert.equal(storage.getItem("legacy"), "{");
    assert.match(inbox.syncStatus.error!, /older note cache/);
});

test("a failed migration upload does not block a pending capture", async () => {
    const storage = new MemoryStorage();
    const attempted: string[] = [];

    storage.setItem(
        "legacy",
        JSON.stringify([{ id: "sent", text: "Sent before", createdAt: 1, state: "delivered" }]),
    );
    const { inbox } = setup({
        storage,
        legacyKey: "legacy",
        list: undefined,
        sync: async (note) => {
            attempted.push(note.id);

            if (note.id === "sent") {
                throw new Error("migration upload failed");
            }

            return {
                note: { id: note.id, text: note.text, createdAt: note.createdAt, state: "synced" },
            };
        },
    });

    await inbox.ready;
    await inbox.add("New capture");
    assert.equal(await inbox.flush(), 1);
    assert.deepEqual(attempted.sort(), ["note-1", "sent"]);
    assert.equal(inbox.notes.find((note) => note.id === "sent")?.state, "archived");
    assert.equal(inbox.notes.find((note) => note.id === "note-1")?.state, "synced");
    assert.equal(inbox.syncStatus.error, "migration upload failed");
});

test("a migration archive failure does not block a pending capture", async () => {
    const storage = new MemoryStorage();
    const attempted: string[] = [];

    storage.setItem(
        "legacy",
        JSON.stringify([{ id: "sent", text: "Sent before", createdAt: 1, state: "delivered" }]),
    );
    const { inbox } = setup({
        storage,
        legacyKey: "legacy",
        list: undefined,
        sync: async (note) => {
            attempted.push(`sync:${note.id}`);

            return {
                note: { id: note.id, text: note.text, createdAt: note.createdAt, state: "synced" },
            };
        },
        archive: async (id) => {
            attempted.push(`archive:${id}`);

            throw new Error("archive failed");
        },
    });

    await inbox.ready;
    await inbox.add("New capture");
    assert.equal(await inbox.flush(), 2);
    assert.ok(attempted.includes("sync:note-1"));
    assert.ok(attempted.includes("archive:sent"));
    assert.equal(inbox.notes.find((note) => note.id === "note-1")?.state, "synced");
    assert.equal(inbox.notes.find((note) => note.id === "sent")?.state, "archived");
    assert.equal(inbox.syncStatus.error, "archive failed");
});

test("a stale list cannot undo another tab's completed archive", async () => {
    const { inbox, storage, remote } = setup();
    const note = await inbox.add("Synthetic archive race");

    await inbox.flush();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const listing = new Promise<void>((resolve) => {
        started = resolve;
    });
    const stale = setup({
        storage,
        list: async () => {
            const snapshot = [...remote.values()];

            started();
            await gate;

            return { notes: snapshot };
        },
    }).inbox;
    const pending = stale.flush();

    await listing;
    await inbox.setArchived(note.id, true);
    release();
    await pending;
    assert.equal(stale.notes.find((item) => item.id === note.id)?.state, "archived");
});

test("a stale upload cannot undo another tab's completed archive", async () => {
    const storage = new MemoryStorage();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const sending = new Promise<void>((resolve) => {
        started = resolve;
    });
    const { inbox } = setup({
        storage,
        list: undefined,
        sync: async (note) => {
            started();
            await gate;

            return {
                note: { id: note.id, text: note.text, createdAt: note.createdAt, state: "synced" },
            };
        },
    });
    const note = await inbox.add("Synthetic capture race");
    const pending = inbox.flush();

    await sending;
    const peer = setup({ storage }).inbox;

    await peer.setArchived(note.id, true);
    release();
    await pending;
    assert.equal(inbox.notes.find((item) => item.id === note.id)?.state, "archived");
});

test("an inexact archive acknowledgement leaves the change queued", async () => {
    const { inbox } = setup({
        list: undefined,
        archive: async (id) => ({
            note: {
                id,
                text: "Synthetic archive acknowledgement",
                createdAt: 1234,
                state: "synced",
            },
        }),
    });
    const note = await inbox.add("Synthetic archive acknowledgement");

    await inbox.flush();
    await inbox.setArchived(note.id, true);
    assert.equal(inbox.notes[0]!.state, "archived");
    assert.equal(inbox.notes[0]!.archivePending, true);
    assert.match(inbox.syncStatus.error!, /exact archive change/);
});

test("an offline archive followed by restore can synchronize its first capture", async () => {
    let online = false;
    const { inbox, remote } = setup({
        sync: async (note) => {
            if (!online) {
                throw new Error("offline");
            }

            const saved: Note = {
                id: note.id,
                text: note.text,
                createdAt: note.createdAt,
                state: "synced",
            };

            remote.set(note.id, saved);

            return { note: saved };
        },
    });
    const note = await inbox.add("Synthetic restore");

    await inbox.setArchived(note.id, true);
    await inbox.setArchived(note.id, false);
    online = true;
    await inbox.flush();
    assert.equal(inbox.notes[0]!.state, "synced");
    assert.equal(inbox.notes[0]!.pendingSync, undefined);
    assert.equal(inbox.notes[0]!.archivePending, undefined);
    assert.equal(inbox.syncStatus.error, null);
});

test("account hints clear for logout, guests and viewers, without exposing another account's notes", async () => {
    const storage = new MemoryStorage();
    const first = setup({ storage, key: "owner-a" }).inbox;
    const second = setup({ storage, key: "owner-b" }).inbox;

    await first.add("Private idea");
    await second.ready;
    assert.deepEqual(second.notes, []);
    rememberInboxAccount(storage, { id: "owner-a", role: "owner" });
    assert.equal(readInboxAccount(storage)!.id, "owner-a");
    rememberInboxAccount(storage, { id: "guest", role: "guest" });
    assert.equal(readInboxAccount(storage), null);
    rememberInboxAccount(storage, { id: "owner-b", role: "owner" });
    assert.equal(readInboxAccount(storage)!.id, "owner-b");
    forgetInboxAccount(storage);
    assert.equal(readInboxAccount(storage), null);
    assert.equal(first.notes[0]!.text, "Private idea");
});
