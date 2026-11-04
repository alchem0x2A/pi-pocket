// Device-side quick-note persistence and delivery retries (`web/quick-notes.js`).
import assert from "node:assert/strict";
import { test } from "node:test";

type Note = {
    id: string;
    text: string;
    createdAt: number;
    state: "cached" | "delivered";
    deliveredAt?: number;
};
type Storage = {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
};
type Inbox = {
    notes: Note[];
    add(text: string): Note;
    flush(): Promise<number>;
};
type QuickNotesApi = {
    createQuickNotes(options: {
        storage: Storage;
        key: string;
        send(note: Note): Promise<unknown>;
        makeId(): string;
        now(): number;
    }): Inbox;
};

const { createQuickNotes } = (await import(
    new URL("../web/quick-notes.js", import.meta.url).href
)) as QuickNotesApi;

class MemoryStorage implements Storage {
    values = new Map<string, string>();

    getItem(key: string) {
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string) {
        this.values.set(key, value);
    }
}

function inbox(storage: Storage, send: (note: Note) => Promise<unknown> = async () => {}) {
    let nextId = 0;

    return createQuickNotes({
        storage,
        key: "owner-notes",
        send,
        makeId: () => `note-${++nextId}`,
        now: () => 1234,
    });
}

test("new notes are cached before delivery and survive an inbox reload", () => {
    const storage = new MemoryStorage();
    const first = inbox(storage, async () => {
        throw new Error("offline");
    });
    const note = first.add("  Check the build later  ");

    assert.equal(note.state, "cached");
    assert.equal(JSON.parse(storage.getItem("owner-notes")!)[0].text, "Check the build later");

    const restored = inbox(storage);

    assert.deepEqual(restored.notes, [note]);
});

test("flush marks a note delivered only after the server accepts it, then sends in order", async () => {
    const storage = new MemoryStorage();
    let accept!: () => void;
    const gate = new Promise<void>((resolve) => {
        accept = resolve;
    });
    const sent: Note[] = [];
    const queue = inbox(storage, async (note) => {
        sent.push(note);

        if (sent.length === 1) {
            await gate;
        }
    });

    queue.add("First note");
    queue.add("Second note");
    const flushing = queue.flush();

    await Promise.resolve();
    assert.deepEqual(
        queue.notes.map((note) => note.state),
        ["cached", "cached"],
    );
    assert.deepEqual(
        sent.map((note) => note.text),
        ["First note"],
    );

    accept();
    assert.equal(await flushing, 2);
    assert.deepEqual(
        sent.map((note) => note.text),
        ["First note", "Second note"],
    );
    assert.deepEqual(
        queue.notes.map((note) => note.state),
        ["delivered", "delivered"],
    );
    assert.ok(queue.notes.every((note) => note.deliveredAt === 1234));
});

test("a failed flush keeps its request id and retries the cached queue", async () => {
    const storage = new MemoryStorage();
    const sent: string[] = [];
    let offline = true;
    const queue = inbox(storage, async (note) => {
        sent.push(note.id);

        if (offline) {
            throw new Error("server unreachable");
        }
    });

    queue.add("First note");
    queue.add("Second note");
    assert.equal(await queue.flush(), 0);
    assert.deepEqual(
        queue.notes.map((note) => note.state),
        ["cached", "cached"],
    );

    offline = false;
    assert.equal(await queue.flush(), 2);
    assert.deepEqual(sent, ["note-1", "note-1", "note-2"]);
    assert.deepEqual(
        queue.notes.map((note) => note.state),
        ["delivered", "delivered"],
    );
});

test("concurrent flush calls share one delivery pass", async () => {
    const storage = new MemoryStorage();
    let accept!: () => void;
    const gate = new Promise<void>((resolve) => {
        accept = resolve;
    });
    const sent: string[] = [];
    const queue = inbox(storage, async (note) => {
        sent.push(note.id);
        await gate;
    });

    queue.add("One note");
    const first = queue.flush();
    const second = queue.flush();

    assert.equal(first, second);
    assert.deepEqual(sent, ["note-1"]);
    accept();
    assert.equal(await first, 1);
    assert.deepEqual(
        queue.notes.map((note) => note.state),
        ["delivered"],
    );
});
