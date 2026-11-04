/** The durable owner idea inbox. Capture stores data only; Continue alone creates an idle conversation. */
import { createHash } from "node:crypto";
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
    action: "list" | "archive" | "restore";
    id?: string;
    archived?: boolean;
};

export class OwnerInbox {
    readonly #app: PocketApp;

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

    async list(user: User, archived = false): Promise<InboxNote[]> {
        this.#owner(user);
        const doc = await this.#app.harness.snapshot(OwnerInboxDoc, BACKGROUND_CONTEXT);

        this.#owner(user);

        return this.#notes(doc?.users[key(user.id)] ?? {}, archived);
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

        // Do not list, sort, copy, or return note text to build a prompt.
        for (const note of Object.values(doc?.users[key(user.id)] ?? {})) {
            if (note.state !== "archived") {
                count++;
            }
        }

        return count;
    }

    #notes(notes: Record<string, InboxNote>, archived: boolean): InboxNote[] {
        return Object.values(notes)
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
                return this.#notes(notes, request.archived === true);
            }

            if (request.action !== "archive" && request.action !== "restore") {
                throw new HttpError(
                    400,
                    "The inbox tool can only list, archive, or restore notes.",
                );
            }

            const note = this.#find(notes, noteId(request.id));

            this.#archive(note, request.action === "archive");

            return [copy(note)];
        }, context);
    }
}
