/** The durable owner idea inbox. Capture stores data only; Continue alone creates an idle conversation. */
import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { type InboxNote, OwnerInboxDoc, SessionsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";

const key = (value: string) => createHash("sha256").update(value).digest("hex");
const copy = (note: InboxNote): InboxNote => ({ ...note });

function noteId(value: unknown): string {
    if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
        throw new HttpError(
            400,
            "id must contain 1 to 128 letters, digits, dots, underscores, colons, or hyphens, starting with a letter or digit.",
        );
    }

    return value;
}

export type InboxAction = {
    action: "list" | "archive" | "restore" | "post";
    id?: string;
    archived?: boolean;
    /** list: only notes with this tag (without one: the owner's own, untagged notes). post: the tag. */
    tag?: string;
    /** post: the note's text. */
    text?: string;
};

/** A tag: short, lowercase, so a handful of tags keep agent notes apart from the owner's. */
const TAG = /^[a-z0-9][a-z0-9._-]{0,31}$/;
/** Notes one session may post in an hour. */
const POSTS_PER_HOUR = 20;
const HOUR_MS = 3_600_000;

function tagOf(value: unknown): string {
    if (typeof value !== "string" || !TAG.test(value)) {
        throw new HttpError(
            400,
            "tag must be 1 to 32 lowercase letters, digits, dots, underscores, or hyphens, starting with a letter or digit.",
        );
    }

    return value;
}

function textOf(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || value.length > 20_000) {
        throw new HttpError(400, "text must contain 1 to 20000 characters and cannot be blank.");
    }

    return value;
}

export class OwnerInbox {
    readonly #app: PocketApp;
    /** When each session posted lately, for the hourly limit. */
    readonly #posted = new Map<string, number[]>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Re-resolve the account, including its current role, at each operation and transaction boundary. */
    #owner(user: User): User {
        const current = this.#app.config.userById(user.id);

        if (current?.role !== "owner" || current.sessions !== undefined) {
            throw new HttpError(403, "Only the owner can use the idea inbox.");
        }

        return current;
    }

    /** The owner's notes; the tagged ones (agents') only when `tag` asks for them. */
    async list(user: User, archived = false, tag?: string): Promise<InboxNote[]> {
        this.#owner(user);
        const doc = await this.#app.harness.snapshot(OwnerInboxDoc, BACKGROUND_CONTEXT);

        this.#owner(user);

        return this.#notes(doc?.users[key(user.id)] ?? {}, archived, tag);
    }

    /** Count only for the private Pia prompt. Its first prompt can precede requester attribution. */
    async pendingCountForAssistant(
        source: ConversationId,
        context: Context = BACKGROUND_CONTEXT,
    ): Promise<number | undefined> {
        const app = this.#app;

        if (app.pip.profile().mode !== "pia" || app.rootOf(source) !== source) {
            return undefined;
        }

        const sessions = await app.harness.snapshot(SessionsDoc, context);
        const person = sessions?.items[String(source)]?.pip;

        // Use the durable private-helper mapping, never a default owner or an ordinary session's requester.
        const authorized = () => {
            const user = person === undefined ? undefined : app.config.userById(person);
            const requester = app.attribution.requesterOf(source);

            return user?.role === "owner" &&
                user.sessions === undefined &&
                app.pip.profile().mode === "pia" &&
                app.rootOf(source) === source &&
                app.pip.ownerOf(source) === user.id &&
                app.pip.idOf(user.id) === source &&
                app.pip.available(user) &&
                (requester === undefined || requester === user.id)
                ? user
                : undefined;
        };

        const user = authorized();

        if (user === undefined) {
            return undefined;
        }

        const doc = await app.harness.snapshot(OwnerInboxDoc, context);

        if (authorized()?.id !== user.id) {
            return undefined;
        }

        let count = 0;

        // Do not list, sort, copy, or return note text to build a prompt. Agents' tagged notes are counted apart.
        for (const note of Object.values(doc?.users[key(user.id)] ?? {})) {
            if (note.state !== "archived" && note.tag === undefined) {
                count++;
            }
        }

        return count;
    }

    /** How many notes wait under each tag, for the private Pia prompt: counts only, never text. */
    async taggedCountsForAssistant(
        source: ConversationId,
        context: Context = BACKGROUND_CONTEXT,
    ): Promise<Record<string, number> | undefined> {
        const app = this.#app;
        const sessions = await app.harness.snapshot(SessionsDoc, context);
        const person = sessions?.items[String(source)]?.pip;
        const user = person === undefined ? undefined : app.config.userById(person);

        if (
            user?.role !== "owner" ||
            user.sessions !== undefined ||
            app.pip.profile().mode !== "pia" ||
            app.rootOf(source) !== source ||
            app.pip.ownerOf(source) !== user.id ||
            app.pip.idOf(user.id) !== source
        ) {
            return undefined;
        }

        const counts: Record<string, number> = {};
        const doc = await app.harness.snapshot(OwnerInboxDoc, context);

        for (const note of Object.values(doc?.users[key(user.id)] ?? {})) {
            if (note.state !== "archived" && note.tag !== undefined) {
                counts[note.tag] = (counts[note.tag] ?? 0) + 1;
            }
        }

        return counts;
    }

    /**
     * An agent's note for the owner it works for: data under a tag, never a message, and it starts no work. The writer is
     * any session whose requester is a current owner; a session is held to a few notes an hour.
     */
    async postAsAgent(
        source: ConversationId,
        request: { tag?: unknown; text?: unknown },
        from?: string,
    ): Promise<InboxNote> {
        const app = this.#app;
        const tag = tagOf(request.tag);
        const text = textOf(request.text);
        const requester = app.attribution.requesterOf(source);
        const user = requester === undefined ? undefined : app.config.userById(requester);

        if (user?.role !== "owner" || user.sessions !== undefined) {
            throw new HttpError(403, "Only a session working for the owner can post to the inbox.");
        }

        const slot = String(app.rootOf(source));
        const now = app.now();
        const recent = (this.#posted.get(slot) ?? []).filter((at) => now - at < HOUR_MS);

        if (recent.length >= POSTS_PER_HOUR) {
            throw new HttpError(
                429,
                `At most ${String(POSTS_PER_HOUR)} inbox notes an hour per session.`,
            );
        }

        this.#posted.set(slot, [...recent, now]);
        const title = from ?? app.sessionMeta(app.rootOf(source))?.title ?? "session";
        const note: InboxNote = {
            id: `agent-${randomUUID()}`,
            text,
            createdAt: now,
            state: "synced",
            tag,
            from: title.replace(/\s+/g, " ").trim().slice(0, 80) || "session",
        };

        return app.harness.commit(async (tx) => {
            const doc = await tx.doc(OwnerInboxDoc);
            const person = key(user.id);

            doc.users[person] ??= {};
            doc.users[person]![key(note.id)] = note;

            return copy(note);
        }, BACKGROUND_CONTEXT);
    }

    /** The notes under a tag for the owner a session works for: how an agent reads an answer. */
    async readAsAgent(source: ConversationId, tagName: unknown): Promise<InboxNote[]> {
        const app = this.#app;
        const tag = tagOf(tagName);
        const requester = app.attribution.requesterOf(source);
        const user = requester === undefined ? undefined : app.config.userById(requester);

        if (user?.role !== "owner" || user.sessions !== undefined) {
            throw new HttpError(403, "Only a session working for the owner can read the inbox.");
        }

        const doc = await app.harness.snapshot(OwnerInboxDoc, BACKGROUND_CONTEXT);

        return this.#notes(doc?.users[key(user.id)] ?? {}, false, tag);
    }

    #notes(notes: Record<string, InboxNote>, archived: boolean, tag?: string): InboxNote[] {
        return Object.values(notes)
            .filter((note) => note.tag === tag)
            .filter((note) => archived || note.state !== "archived")
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
            .map(copy);
    }

    /** Create-only sync. Repeated client ids return the stored note, including its archive and Continue receipt. */
    async capture(
        user: User,
        request: { id?: unknown; text?: unknown; createdAt?: unknown },
    ): Promise<InboxNote> {
        this.#owner(user);
        const id = noteId(request.id);

        if (
            typeof request.text !== "string" ||
            !request.text.trim() ||
            request.text.length > 20_000
        ) {
            throw new HttpError(
                400,
                "text must contain 1 to 20000 characters and cannot be blank.",
            );
        }

        if (
            request.createdAt !== undefined &&
            (!Number.isSafeInteger(request.createdAt) || Number(request.createdAt) < 0)
        ) {
            throw new HttpError(400, "createdAt must be a non-negative integer timestamp.");
        }

        const note: InboxNote = {
            id,
            text: request.text,
            createdAt:
                request.createdAt === undefined ? this.#app.now() : Number(request.createdAt),
            state: "synced",
        };

        return this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(OwnerInboxDoc);

            this.#owner(user);
            const person = key(user.id);

            doc.users[person] ??= {};
            // Read the attached draft after assigning a new bucket; the assigned plain object is not a draft.
            const notes = doc.users[person]!;
            const token = key(id);

            notes[token] ??= note;

            return copy(notes[token]!);
        }, BACKGROUND_CONTEXT);
    }

    #find(notes: Record<string, InboxNote>, id: string): InboxNote {
        const note = notes[key(id)];

        if (note === undefined) {
            throw new HttpError(404, "No such inbox note.");
        }

        return note;
    }

    #archive(note: InboxNote, archived: boolean): void {
        if (archived) {
            if (note.state !== "archived") {
                note.state = "archived";
                note.archivedAt = this.#app.now();
            }
        } else {
            note.state = "synced";
            delete note.archivedAt;
        }
    }

    async archive(user: User, id: unknown, archived: unknown): Promise<InboxNote> {
        this.#owner(user);
        const validId = noteId(id);

        if (typeof archived !== "boolean") {
            throw new HttpError(400, "archived must be true or false.");
        }

        return this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(OwnerInboxDoc);

            this.#owner(user);
            const note = this.#find(doc.users[key(user.id)] ?? {}, validId);

            this.#archive(note, archived);

            return copy(note);
        }, BACKGROUND_CONTEXT);
    }

    /**
     * One atomic receipt, catalogue entry, and archive. No submission, chat entry, task, or model call is made.
     * The returned note.text is the durable draft seed. The client must show it in the new conversation's composer.
     */
    async continue(user: User, id: unknown): Promise<{ conversationId: number; note: InboxNote }> {
        this.#owner(user);
        const validId = noteId(id);
        const app = this.#app;

        return app.harness.commit(async (tx) => {
            const doc = await tx.doc(OwnerInboxDoc);

            this.#owner(user);
            const note = this.#find(doc.users[key(user.id)] ?? {}, validId);

            if (note.conversationId !== undefined) {
                return { conversationId: note.conversationId, note: copy(note) };
            }

            // Resolve only the normal app default folder. Note text cannot select a folder or a model.
            const cwd = app.workspace.checkDirectory(app.defaultCwd);
            const initial = app.commands.defaultModel(cwd);
            const sessions = await tx.doc(SessionsDoc);
            const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
            const agent = await tx.doc(AgentDoc, conversation.id);

            this.#owner(user);
            Object.assign(agent, { cwd }, initial);
            const now = app.now();

            sessions.items[String(conversation.id)] = {
                cwd,
                createdAt: now,
                updatedAt: now,
                createdBy: user.id,
            };
            note.conversationId = Number(conversation.id);
            this.#archive(note, true);

            return { conversationId: note.conversationId, note: copy(note) };
        }, BACKGROUND_CONTEXT);
    }

    /** This is an execution check, not merely a tool-selection rule. No ordinary or subagent source can use it. */
    async #assistant(tx: Tx, source: ConversationId): Promise<User> {
        const app = this.#app;
        const sessions = await tx.doc(SessionsDoc);
        const person = sessions.items[String(source)]?.pip;
        const user = person === undefined ? undefined : app.config.userById(person);

        if (
            user === undefined ||
            app.pip.profile().mode !== "pia" ||
            app.rootOf(source) !== source ||
            app.pip.idOf(user.id) !== source ||
            !app.pip.available(user) ||
            app.attribution.requesterOf(source) !== user.id
        ) {
            throw new HttpError(
                403,
                "The inbox tool is only for the owner's private front-page Pia.",
            );
        }

        return this.#owner(user);
    }

    async forAssistant(
        source: ConversationId,
        request: InboxAction,
        context: Context = BACKGROUND_CONTEXT,
    ): Promise<InboxNote[]> {
        return this.#app.harness.commit(async (tx) => {
            const user = await this.#assistant(tx, source);
            const doc = await tx.doc(OwnerInboxDoc);

            await this.#assistant(tx, source);
            const notes = doc.users[key(user.id)] ?? {};

            if (request.action === "list") {
                return this.#notes(
                    notes,
                    request.archived === true,
                    request.tag === undefined ? undefined : tagOf(request.tag),
                );
            }

            // Pia's own note under a tag: an answer an agent reads with inbox_note.
            if (request.action === "post") {
                const note: InboxNote = {
                    id: `agent-${randomUUID()}`,
                    text: textOf(request.text),
                    createdAt: this.#app.now(),
                    state: "synced",
                    tag: tagOf(request.tag),
                    from: "Pia",
                };

                notes[key(note.id)] = note;

                return [copy(note)];
            }

            if (request.action !== "archive" && request.action !== "restore") {
                throw new HttpError(
                    400,
                    "The inbox tool can only list, archive, restore, or post notes.",
                );
            }

            const note = this.#find(notes, noteId(request.id));

            this.#archive(note, request.action === "archive");

            return [copy(note)];
        }, context);
    }
}
