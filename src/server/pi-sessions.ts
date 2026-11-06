/**
 * the agent's sessions from the terminal, to continue in Pia. The agent keeps each in a JSONL file in its sessions folder
 * (`~/.pi/agent/sessions/`, a folder per project; or the one folder `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` in
 * the agent's settings names), and finds them all with `SessionManager.listAll`, as `pi -r` lists every folder's. Their files
 * are only read, never written: the agent's own loader mends a file whose last line is cut off, and a `pi` still running may be
 * writing that line.
 *
 * A session continues here as a copy of where the agent left it, its current branch. People get every message of it to read,
 * and the agent gets the context the agent itself builds from the file (`buildSessionProjection`): a compaction becomes Pi Durable's,
 * keeping the same messages, and a context edit edits the same message. The agent's system prompt, its extensions' state, and
 * its model changes stay behind; Pia's prompt and tools apply. Nothing the agent did runs again: a tool call that never
 * finished gets a result saying so (the agent's says "No result provided"). Where the agent would send a tool result whose call is
 * not there (a stray one, or one whose call a context edit took out), Pi Durable leaves it out, as providers refuse it.
 */
import { readFile, stat } from "node:fs/promises";
import type { Message } from "@earendil-works/pi-ai";
import {
    buildSessionProjection,
    convertToLlm,
    CURRENT_SESSION_VERSION,
    migrateSessionEntries,
    parseSessionEntries,
    type SessionEntry,
    sessionEntryToContextMessages,
    type SessionInfo,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
    AssistantEntry,
    CompactionEntry,
    type ContextEdit,
    type ConversationId,
    type EntryId,
    ToolResultEntry,
    type Tx,
    UserEntry,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { FROM_PI_ENTRY, type FromPiData } from "./entry-format.ts";
import { HttpError } from "./errors.ts";

/** the agent's variable for its sessions folder (`ENV_SESSION_DIR` in its config, which the package does not export). */
const SESSION_DIR_VARIABLE = "PI_CODING_AGENT_SESSION_DIR";
/** The largest session file read: images make big ones. */
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
/** How long a list of the agent's sessions answers "is this one of them?" for a preview or a continue after it. */
const FOUND_FOR_MS = 5_000;
/** How many sessions a list holds, newest first: a search looks through them all first. */
const MAX_LISTED = 300;
/** How many of its last messages a session's preview shows. */
const PREVIEW_MESSAGES = 6;
const PREVIEW_TEXT = 600;
const TITLE_LENGTH = 80;
/** What a tool call that never finished in the agent gets as its result. */
const NOT_RUN = "Not run: the agent session ended before this call finished.";

/** A message of the copy, in order: what it is, and the entry of the agent's it comes from (none for a result made here). */
export type PiEntry =
    | { kind: "user" | "assistant" | "toolResult"; from?: string; message: Message }
    /** `head`: the first entry of the agent's the compaction keeps, or null when it keeps none. */
    | { kind: "compaction"; from: string; head: string | null; message: Message };

/** an agent session as it continues here. */
export type PiSession = {
    id: string;
    cwd: string;
    title: string;
    /** Message entries in the file, as `pi -r` counts them: more later means the agent went on in the terminal. */
    count: number;
    model: { provider: string; modelId: string } | null;
    thinkingLevel: string;
    entries: PiEntry[];
    /** the agent's context edits on the current branch: the entry of the agent's they change, and its messages for the agent (none: left out). */
    edits: { target: string; messages: Message[] }[];
};

/** One of the agent's sessions as listed: what the agent says of it, and what a search looks through (lower case). */
type Listed = { info: SessionInfo; words: string };

/** A session file Pia cannot continue, and why, in words for people. */
export class PiSessionError extends Error {}

/**
 * The entries from the first to `leafId`, along `parentId`. A file whose entries lead back to one already passed is
 * damaged: the agent's own walk along them, which comes next, would never end.
 */
function branchTo(entries: readonly SessionEntry[], leafId: string): SessionEntry[] {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const path: SessionEntry[] = [];
    const seen = new Set<string>();

    for (
        let entry = byId.get(leafId);
        entry !== undefined;
        entry = entry.parentId === null ? undefined : byId.get(entry.parentId)
    ) {
        if (seen.has(entry.id)) {
            throw new PiSessionError(
                "This the agent session file is damaged: its entries lead in a circle.",
            );
        }

        seen.add(entry.id);
        path.push(entry);
    }

    return path.reverse();
}

/** The first of `sorted` (ascending) at or after `from`, or undefined. */
function firstFrom(sorted: readonly number[], from: number): number | undefined {
    let low = 0;
    let high = sorted.length;

    while (low < high) {
        const middle = (low + high) >> 1;

        if (sorted[middle]! < from) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return sorted[low];
}

/** What an entry of the agent's gives the model, as the agent sends it; the agent's system messages stay behind for Pia's own. */
function forModel(messages: Parameters<typeof convertToLlm>[0]): Message[] {
    return convertToLlm(messages).filter((message) => message.role !== "system");
}

/** The text of a message's text parts; none for a message without content, which old or edited files can have. */
function textOf(message: Message): string {
    if (typeof message.content === "string") {
        return message.content;
    }

    if (!Array.isArray(message.content)) {
        return "";
    }

    return message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim();
}

/** an agent session's file, read: the conversation on its current branch, and what the agent's context of it is. */
export function readPiSession(text: string): PiSession {
    const file = parseSessionEntries(text);
    const header = file[0];

    if (header?.type !== "session" || typeof header.id !== "string") {
        throw new PiSessionError("This is not an agent session file.");
    }

    if ((header.version ?? 1) > CURRENT_SESSION_VERSION) {
        throw new PiSessionError(
            "A newer the agent wrote this session. Update Pia to continue it.",
        );
    }

    // In memory only: older files get the current format, as the agent gives them when it opens one.
    migrateSessionEntries(file);
    const all = file.slice(1) as SessionEntry[];
    const leaf = all.at(-1);
    const path = leaf === undefined ? [] : branchTo(all, leaf.id);
    const projection = buildSessionProjection(all, leaf?.id);
    const entries: PiEntry[] = [];
    // Where each entry is on the branch, and where those that became messages here are (in order): a compaction finds
    // the first it keeps without a scan, so a file with many compactions reads in time that grows with its length.
    const at = new Map(path.map((entry, index) => [entry.id, index]));
    const copied: number[] = [];
    // Tool calls of the last assistant message without a result yet.
    const open = new Map<string, { name: string; timestamp: number }>();

    const closeOpen = () => {
        for (const [toolCallId, call] of open) {
            entries.push({
                kind: "toolResult",
                message: {
                    role: "toolResult",
                    toolCallId,
                    toolName: call.name,
                    content: [{ type: "text", text: NOT_RUN }],
                    isError: true,
                    timestamp: call.timestamp,
                },
            });
        }

        open.clear();
    };

    for (const [index, entry] of path.entries()) {
        if (entry.type === "compaction") {
            const summary = forModel(sessionEntryToContextMessages(entry))[0];
            const start = at.get(entry.firstKeptEntryId) ?? -1;
            // The first of the kept entries that is a message here, as the agent keeps them up to the compaction.
            const first = start === -1 || start > index ? undefined : firstFrom(copied, start);
            const kept = first === undefined || first >= index ? undefined : path[first];

            if (summary !== undefined) {
                entries.push({
                    kind: "compaction",
                    from: entry.id,
                    head: kept?.id ?? null,
                    message: summary,
                });
            }

            continue;
        }

        if (
            entry.type !== "message" &&
            entry.type !== "custom_message" &&
            entry.type !== "branch_summary"
        ) {
            continue;
        }

        for (const message of forModel(sessionEntryToContextMessages(entry))) {
            if (copied.at(-1) !== index) {
                copied.push(index);
            }

            if (message.role === "toolResult") {
                open.delete(message.toolCallId);
                entries.push({ kind: "toolResult", from: entry.id, message });
                continue;
            }

            closeOpen();

            if (message.role === "assistant") {
                for (const part of message.content) {
                    if (part.type === "toolCall") {
                        open.set(part.id, { name: part.name, timestamp: message.timestamp });
                    }
                }

                entries.push({ kind: "assistant", from: entry.id, message });
            } else if (message.role === "user") {
                entries.push({ kind: "user", from: entry.id, message });
            }
        }
    }

    closeOpen();

    // Where the agent's context of an entry differs from the entry, a context edit changed it: the copy edits it the same way.
    const edits = projection.entries.flatMap(({ sourceEntry, messages }) => {
        if (sourceEntry.type === "compaction") {
            return [];
        }

        const own = forModel(sessionEntryToContextMessages(sourceEntry));
        const seen = forModel(messages);

        return own.length === 0 || JSON.stringify(own) === JSON.stringify(seen)
            ? []
            : [{ target: sourceEntry.id, messages: seen }];
    });
    // As `pi -r` names it: its latest name, or what it was first asked.
    const named = all.findLast((entry) => entry.type === "session_info");
    const firstAsked = path.find(
        (entry) => entry.type === "message" && entry.message.role === "user",
    );
    const firstText =
        firstAsked?.type === "message" ? textOf(firstAsked.message as Message).split("\n")[0]! : "";
    const title =
        (named?.type === "session_info" ? named.name?.trim() : undefined) ||
        firstText.slice(0, TITLE_LENGTH).trim() ||
        "the agent session";

    return {
        id: header.id,
        cwd: header.cwd,
        title,
        count: all.filter((entry) => entry.type === "message").length,
        model: projection.model,
        thinkingLevel: projection.thinkingLevel,
        entries,
        edits,
    };
}

/** Write an agent session's copy into a new conversation, from its `init`: its messages, then where it came from. */
export async function writePiSession(
    tx: Tx,
    id: ConversationId,
    session: PiSession,
    data: FromPiData,
): Promise<void> {
    const made = new Map<string, EntryId>();

    for (const entry of session.entries) {
        const written =
            entry.kind === "compaction"
                ? await tx.appendEntry(CompactionEntry, id, {
                      model: [entry.message],
                      // A kept entry is written before its compaction, as the agent keeps them.
                      head: entry.head === null ? "self" : made.get(entry.head)!,
                      data: { reason: "threshold" },
                  })
                : entry.kind === "toolResult"
                  ? await tx.appendEntry(ToolResultEntry, id, {
                        model: [entry.message],
                        data: { diagnostics: [] },
                    })
                  : await tx.appendEntry(entry.kind === "user" ? UserEntry : AssistantEntry, id, {
                        model: [entry.message],
                    });

        if (entry.from !== undefined && !made.has(entry.from)) {
            made.set(entry.from, written.id);
        }
    }

    const edits: ContextEdit[] = session.edits.flatMap(({ target, messages }) => {
        const entry = made.get(target);

        if (entry === undefined) {
            return [];
        }

        return [
            messages.length === 0
                ? { target: entry, action: "omit" as const }
                : { target: entry, action: "replace" as const, messages },
        ];
    });

    // Last, after every entry it edits; it adds nothing for the agent itself.
    await tx.appendEntry(id, {
        kind: FROM_PI_ENTRY,
        data,
        ...(edits.length === 0 ? {} : { edits }),
    });
}

/** an agent session as the list shows it. */
export type PiSessionSummary = {
    path: string;
    title: string;
    cwd: string;
    modified: number;
    messages: number;
    /** The newest session here that continues it, and whether the agent went on in the terminal since. */
    pocket?: { id: number; behind: boolean };
};

/** Finding the agent's sessions, and reading one, for the owner. */
export class PiSessions {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /**
     * The last list, for a few seconds: reading every session's file again for each look, or each letter of a search,
     * is slow with many. It holds the words of every session, so it is let go when its time is up.
     */
    #found: { at: number; list: Promise<Listed[]> } | undefined;

    /**
     * the agent's sessions, newest first, as `pi -r` lists them all, each with what a search looks through, in lower case:
     * made once per list, not for every letter typed. `fresh` reads them again.
     */
    #find(fresh = true): Promise<Listed[]> {
        if (!fresh && this.#found !== undefined && Date.now() - this.#found.at < FOUND_FOR_MS) {
            return this.#found.list;
        }

        let configured: string | undefined;

        try {
            configured = this.#app.settings.getSessionDir();
        } catch {
            // Unreadable settings: the agent's own folder.
        }

        const folder = process.env[SESSION_DIR_VARIABLE] || configured;
        const list = (folder ? SessionManager.listAll(folder) : SessionManager.listAll()).then(
            (infos) =>
                infos.map((info) => {
                    const words = [
                        info.name ?? "",
                        info.cwd,
                        info.firstMessage,
                        info.allMessagesText,
                    ]
                        .join("\n")
                        .toLowerCase();

                    // Kept once, as the search's words: a session's whole text is the bulk of the list.
                    info.allMessagesText = "";

                    return { info, words };
                }),
        );
        const found = { at: Date.now(), list };

        this.#found = found;
        setTimeout(() => {
            if (this.#found === found) {
                this.#found = undefined;
            }
        }, FOUND_FOR_MS).unref();
        // A list that failed is not kept.
        list.catch(() => {
            if (this.#found === found) {
                this.#found = undefined;
            }
        });

        return list;
    }

    /** The newest session here that continues each of the agent's, by its id. */
    #continued(): Map<string, { id: number; count: number }> {
        const found = new Map<string, { id: number; count: number }>();

        // Newest first: the first one seen of each is the one to open.
        for (const session of this.#app.sessions()) {
            const from = this.#app.sessionMeta(session.id as unknown as ConversationId)?.fromPi;

            if (from !== undefined && !found.has(from.session)) {
                found.set(from.session, { id: session.id, count: from.count });
            }
        }

        return found;
    }

    #requireOwner(user: User): void {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can continue the agent's sessions here.");
        }
    }

    /** the agent's sessions on this machine, newest first; with `query`, those whose title, folder, or words have it. */
    async list(user: User, query = ""): Promise<{ sessions: PiSessionSummary[] }> {
        this.#requireOwner(user);
        const continued = this.#continued();
        const needle = query.trim().toLowerCase();
        // Opening the list reads it again; a search narrows the one just read.
        const found = (await this.#find(needle === ""))
            .filter((each) => needle === "" || each.words.includes(needle))
            .map((each) => each.info);

        return {
            sessions: found.slice(0, MAX_LISTED).map((info) => {
                const pocket = continued.get(info.id);
                const first = info.firstMessage.split("\n")[0]!.slice(0, TITLE_LENGTH).trim();

                return {
                    path: info.path,
                    title: info.name ?? (first || "the agent session"),
                    cwd: info.cwd,
                    modified: info.modified.getTime(),
                    messages: info.messageCount,
                    ...(pocket === undefined
                        ? {}
                        : { pocket: { id: pocket.id, behind: info.messageCount > pocket.count } }),
                };
            }),
        };
    }

    /** One of the agent's sessions, read: only a file the agent lists, so nothing else can be read through this. */
    async read(user: User, path: string): Promise<PiSession> {
        this.#requireOwner(user);

        const listed = async (fresh: boolean) =>
            (await this.#find(fresh)).some((each) => each.info.path === path);

        // The list the sheet just showed, or, for a session new since, the list as it is now.
        if (!(await listed(false)) && !(await listed(true))) {
            throw new HttpError(404, "the agent has no such session. It may have been deleted.");
        }

        // Gone since the list was read (it is kept a few seconds), or unreadable: as the agent not having it.
        const missing = (error: unknown) => {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
                throw new HttpError(
                    404,
                    "the agent has no such session. It may have been deleted.",
                );
            }

            throw error;
        };

        if ((await stat(path).catch(missing)).size > MAX_SESSION_BYTES) {
            throw new HttpError(413, "This the agent session is too large to continue here.");
        }

        const text = await readFile(path, "utf8").catch(missing);

        try {
            return readPiSession(text);
        } catch (error) {
            if (error instanceof PiSessionError) {
                throw new HttpError(400, error.message);
            }

            throw error;
        }
    }

    /** One of the agent's sessions, to decide whether to continue it: where it worked, and its last messages. */
    async preview(user: User, path: string) {
        const session = await this.read(user, path);
        const pocket = this.#continued().get(session.id);
        let cwdExists = true;

        try {
            this.#app.workspace.checkDirectory(session.cwd);
        } catch {
            cwdExists = false;
        }

        const last = session.entries
            .flatMap((entry) => {
                if (entry.kind !== "user" && entry.kind !== "assistant") {
                    return [];
                }

                const text = textOf(entry.message);

                return text === "" ? [] : [{ role: entry.kind, text: text.slice(0, PREVIEW_TEXT) }];
            })
            .slice(-PREVIEW_MESSAGES);

        const { model } = session;
        const modelHere =
            model !== null &&
            this.#app.models
                .getAvailableSnapshot()
                .some((each) => each.provider === model.provider && each.id === model.modelId);

        return {
            path,
            title: session.title,
            cwd: session.cwd,
            cwdExists,
            messages: session.count,
            model: model === null ? null : `${model.provider}/${model.modelId}`,
            modelHere,
            last,
            ...(pocket === undefined
                ? {}
                : { pocket: { id: pocket.id, behind: session.count > pocket.count } }),
        };
    }
}
