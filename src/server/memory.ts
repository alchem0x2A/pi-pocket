/**
 * Memory: notes (once called lessons) that people and the agent keep across sessions, each for one project or for
 * everywhere, and linked to the session it came from. A note has an optional title and a Markdown body. A project is a
 * git repository with all its worktrees (they share one git folder), or a folder outside any repository. The agent
 * proposes notes with its memory tool, and searches and reads them with `note_search` and `note_load`: no note is in its
 * system prompt. The notes a session read before a compaction come back with the summary (`extensions/memory.ts`).
 * People see, add, change, search, and remove them in the Memory sheet.
 *
 * A note added or changed for someone who is not the owner waits for the owner's approval before the agent can find it: a
 * guest could otherwise write instructions into every later session.
 */
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    CompactionEntry,
    type ConversationId,
    ResetEntry,
    type Tx,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { addActivity } from "./collab.ts";
import type { User } from "./config.ts";
import { assistantOwner, ChatDoc, type Lesson, MemoryDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { defang, INVISIBLE_CLASS } from "./fence.ts";
import { git } from "./git.ts";
import { snippet } from "./projection.ts";

const context: Context = BACKGROUND_CONTEXT;

/** Memory's extension: the tool and the prompt section. */
export const MEMORY_EXTENSION = "pocket-memory";
/** How long a note's body may be, in characters. Saving a longer one fails: nothing is cut. */
export const MAX_LESSON = 4000;
/** How long a note's title may be. */
export const MAX_TITLE = 120;
/** Notes a project keeps, and notes for everywhere, approved ones: pending ones do not take their room. */
export const MAX_PROJECT_LESSONS = 200;
export const MAX_EVERYWHERE_LESSONS = 200;
/** Results `note_search` gives by default, and at most. */
export const SEARCH_RESULTS = 8;
export const MAX_SEARCH_RESULTS = 20;
/** Lessons waiting for approval that one person (or the agent for them) may have, so nobody fills the owner's list. */
export const MAX_PENDING = 20;
/** How long a folder's project is kept before git is asked again (a folder can become a repository). */
const PROJECT_FOR_MS = 60_000;

export type Project = { key: string; name: string };
export type LessonScope = "project" | "everywhere";

/** Who writes: a person, or the agent working for one (`userId` undefined when nobody is known). */
export type Writer = { userId: string | undefined; byPi: boolean; name: string };

/** The one purpose a note can have: Pia reads it before it chooses a model (`pip.ts`). */
export const MODEL_CHOICE = "model-choice";
/** What the owner allows for the model-choice note: which models need a minimum thinking level. */
export type ModelRule = { models: string[]; minThinking: string };

/** A search hit, as `note_search` and its callers see it. */
export type NoteHit = {
    id: string;
    title: string;
    revision: number;
    scope: LessonScope;
    byPi: boolean;
    size: number;
    excerpt: string;
};

/** A lesson as a person's Memory sheet shows it. */
export type LessonView = {
    id: string;
    text: string;
    /** The title a person gave it; absent for one without (the sheet shows the body's first line). */
    title?: string;
    revision: number;
    /** Set when Pia reads it before it picks a model, with the owner's thinking rule. */
    purpose?: typeof MODEL_CHOICE;
    modelRule?: ModelRule;
    scope: LessonScope;
    /** The lesson's project label in the owner's all-project pending queue. */
    projectName?: string;
    byPi: boolean;
    by: string;
    byName: string;
    createdAt: number;
    updatedAt?: number;
    pending: boolean;
    /** The session it came from, when this person may see it. */
    from?: { id: number; title: string };
    /** Whether this person may change or remove it. */
    mine: boolean;
    /** A change that waits for the owner, for the owner and whoever proposed it to see. */
    proposal?: {
        text?: string;
        title?: string;
        forget?: boolean;
        byPi: boolean;
        byName: string;
        mine: boolean;
    };
};

export type MemoryView = {
    /** Present only for the all-project pending queue, so an older server's scoped view is not mistaken for it. */
    pendingAll?: true;
    /** This session's project; null for Pia or the all-project pending queue. */
    project: { name: string } | null;
    lessons: LessonView[];
    owner: boolean;
    canWrite: boolean;
    limits: { project: number; everywhere: number; text: number; title: number };
};

/** A plain copy of a lesson out of a commit's document. */
const copy = (lesson: Lesson): Lesson => JSON.parse(JSON.stringify(lesson)) as Lesson;
/**
 * Characters nobody sees: controls, format characters (zero-width, bidi, tags), lone surrogates, private use,
 * unassigned, the variation selectors, and the blank letters (Hangul fillers, the braille blank). The owner approves the
 * text they see, so the agent must read no other.
 */
const INVISIBLE = new RegExp("[" + INVISIBLE_CLASS + "]", "gu");

/** Text on one line with nothing hidden: whitespace first, so a newline becomes a space before controls go. */
export const flat = (text: string) =>
    text.replace(/\s+/g, " ").replace(INVISIBLE, "").replace(/ {2,}/g, " ").trim();
/**
 * A note's Markdown body with nothing hidden: its lines kept (line breaks made `\n`, tabs four spaces), each line without
 * invisible characters or trailing space. A one-line lesson saved before notes comes out as it was.
 */
export const clean = (text: string) =>
    text
        .replace(/\r\n?|[\u2028\u2029\v\f]/g, "\n")
        .replace(/\t/g, "    ")
        .split("\n")
        .map((line) => line.replace(INVISIBLE, "").trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\n+/, "")
        .trimEnd();
/** The title a note shows: its own, or its body's first line, cut to 80 characters. */
export const titleOf = (lesson: Pick<Lesson, "title" | "text">) =>
    lesson.title ??
    cutTo(
        flat(
            lesson.text
                .split("\n")
                .find((line) => line.trim() !== "")
                ?.replace(/^#+\s*/, "") ?? "",
        ),
        80,
    );

const cutTo = (text: string, max: number) => {
    const points = Array.from(text);

    return points.length > max ? `${points.slice(0, max - 1).join("")}…` : text;
};

/** Words of a query or a note, lowercased: letters, digits, and the characters of paths and names. */
const words = (text: string) =>
    text
        .toLowerCase()
        .split(/[^\p{L}\p{N}_./:@-]+/u)
        .map((word) => word.replace(/^[./:@-]+|[./:@-]+$/g, ""))
        .filter((word) => word !== "");

/** Thinking levels, lowest first, as the model-choice rule compares them. */
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A note's body on one line around the first word asked, about 240 characters. */
function excerptOf(text: string, asked: string[]): string {
    const line = flat(text);
    const lower = line.toLowerCase();
    const at = asked
        .map((word) => lower.search(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(word)}`, "u")))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0];
    const start = at === undefined || at < 80 ? 0 : at - 60;
    const cut = line.slice(start, start + 240);

    return `${start > 0 ? "…" : ""}${cut}${start + 240 < line.length ? "…" : ""}`;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A note's text for a prompt or a tool's result: no closing tag can end what holds it. */
export const safeBody = (text: string) => defang(text);
/** A folder's name as the agent's prompt and the sheet show it. */
// Cut by code points, so an emoji at the 80th is kept whole, not halved into a lone surrogate.
const cut = (text: string) => Array.from(text).slice(0, 80).join("");
const named = (name: string, key: string) => cut(flat(name)) || cut(flat(key));

/** Set a note's title: a string sets it, "" removes it, undefined leaves it. */
function setTitle(lesson: Lesson, title: string | undefined): void {
    if (title === undefined) {
        return;
    }

    if (title === "") {
        delete lesson.title;
    } else {
        lesson.title = title;
    }
}

const ordered = (lessons: Lesson[]) =>
    lessons.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

/** The project a folder belongs to: its repository's shared git folder, or the folder itself. */
async function projectOf(cwd: string): Promise<Project> {
    const folder = await realpath(cwd).catch(() => resolve(cwd));
    const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .catch(() => git(folder, ["rev-parse", "--git-common-dir"]))
        .then(
            (out) => out.trim(),
            () => "",
        );

    if (common === "") {
        return { key: folder, name: named(basename(folder), folder) };
    }

    const key = await realpath(resolve(folder, common)).catch(() => resolve(folder, common));
    // `repo/.git` is named for `repo`; a bare repository (`repo.git`) for itself.
    const name =
        basename(key) === ".git" ? basename(dirname(key)) : basename(key).replace(/\.git$/, "");

    return { key, name: named(name, key) };
}

export class Memory {
    readonly #app: PocketApp;
    readonly #projects = new Map<string, { at: number; project: Promise<Project> }>();
    #timer: NodeJS.Timeout | undefined;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The project of a conversation working in `cwd`; undefined for Pia, which has lessons for everywhere only. */
    async project(
        conversationId: ConversationId,
        cwd: string | undefined,
    ): Promise<Project | undefined> {
        const app = this.#app;

        if (assistantOwner(app.sessionMeta(app.rootOf(conversationId))) !== undefined) {
            return undefined;
        }

        const folder = cwd ?? app.cwdOf(conversationId);

        const now = this.#app.now();
        let cached = this.#projects.get(folder);

        if (cached === undefined || now - cached.at > PROJECT_FOR_MS) {
            cached = { at: now, project: projectOf(folder) };
            this.#projects.set(folder, cached);
        }

        return cached.project;
    }

    async #all(): Promise<Lesson[]> {
        const doc = await this.#app.harness.snapshot(MemoryDoc, context);

        return Object.values(doc?.items ?? {});
    }

    /** The lessons that apply in a project (and everywhere's), oldest first, pending ones included. */
    async applying(project: Project | undefined): Promise<Lesson[]> {
        return ordered(
            (await this.#all()).filter(
                (lesson) => lesson.project === undefined || lesson.project === project?.key,
            ),
        );
    }

    /** What the agent's prompt has: the lessons in force for a conversation working in `cwd`, and its project. */
    async inForce(
        conversationId: ConversationId,
        cwd: string | undefined,
    ): Promise<{ project: Project | undefined; lessons: Lesson[] }> {
        const project = await this.project(conversationId, cwd);
        const lessons = (await this.applying(project)).filter((lesson) => lesson.pending !== true);

        return { project, lessons };
    }

    #isOwner(userId: string | undefined): boolean {
        return userId !== undefined && this.#app.config.userById(userId)?.role === "owner";
    }

    /**
     * Whether a write waits for the owner: every one of the agent's, and every one of someone who is not the owner. What the agent
     * read (a web page, a post, a comment, a file) can talk it into "a lesson", and a lesson reaches every later session:
     * the agent proposes, the owner approves.
     */
    #held(writer: Writer): boolean {
        return writer.byPi || !this.#isOwner(writer.userId);
    }

    /** A 409 when a project's (or everywhere's) approved lessons are full. */
    #roomFor(
        doc: { items: Record<string, Lesson> },
        lesson: Pick<Lesson, "project" | "projectName">,
    ) {
        const max = lesson.project === undefined ? MAX_EVERYWHERE_LESSONS : MAX_PROJECT_LESSONS;
        const kept = Object.values(doc.items).filter(
            (item) => item.project === lesson.project && item.pending !== true,
        ).length;

        if (kept >= max) {
            throw new HttpError(
                409,
                `${lesson.project === undefined ? "Lessons for everywhere" : `${lesson.projectName ?? "This project"}'s lessons`} are full (${String(max)}): forget one first, or fold two into one.`,
            );
        }
    }

    #mayChange(lesson: Lesson, userId: string | undefined): boolean {
        return this.#isOwner(userId) || (userId !== undefined && lesson.by === userId);
    }

    /** Cross-project review is for the human owner in their private Pia, before reading any lesson or writing activity. */
    #requirePendingOwner(writer: Writer, conversationId: ConversationId): void {
        if (writer.byPi || !this.#isOwner(writer.userId)) {
            throw new HttpError(403, "Only the owner can review all pending lessons.");
        }

        if (
            assistantOwner(this.#app.sessionMeta(this.#app.rootOf(conversationId))) !==
            writer.userId
        ) {
            throw new HttpError(403, "Review all pending lessons from your private Pia.");
        }
    }

    /** A lesson that applies here (or anywhere for an authorized pending review), or a 404. */
    #find(
        doc: { items: Record<string, Lesson> },
        project: Project | undefined,
        id: string,
        allProjects = false,
    ): Lesson {
        const key = id.trim().replace(/^\[|\]$/g, "");
        // Own keys only: `constructor` or `__proto__` is no lesson.
        const lesson = Object.hasOwn(doc.items, key) ? doc.items[key] : undefined;

        if (
            lesson === undefined ||
            (!allProjects && lesson.project !== undefined && lesson.project !== project?.key)
        ) {
            throw new HttpError(404, `There is no lesson ${id} here.`);
        }

        return lesson;
    }

    /** A line in the session's chat, as people see the rest of what changes. */
    async #activity(tx: Tx, conversationId: ConversationId, writer: Writer, text: string) {
        const root = this.#app.rootOf(conversationId);

        addActivity(
            await tx.doc(ChatDoc, root),
            writer.byPi
                ? { id: "pi", name: "the agent" }
                : { id: writer.userId ?? "someone", name: writer.name },
            text,
        );
    }

    #text(text: unknown): string {
        if (typeof text !== "string" || flat(text) === "") {
            throw new HttpError(400, "Say what to remember.");
        }

        const lesson = clean(text);

        if (lesson.length > MAX_LESSON) {
            throw new HttpError(
                413,
                `A note is ${String(MAX_LESSON)} characters at most (this one is ${String(lesson.length)}): make it shorter, or split it into two notes.`,
            );
        }

        return lesson;
    }

    /** A title on one line, or undefined for none; too long is an error, not a cut. */
    #title(title: unknown): string | undefined {
        if (title === undefined || title === null) {
            return undefined;
        }

        if (typeof title !== "string") {
            throw new HttpError(400, "A title is text.");
        }

        const line = flat(title);

        if (line.length > MAX_TITLE) {
            throw new HttpError(
                413,
                `A title is ${String(MAX_TITLE)} characters at most (this one is ${String(line.length)}).`,
            );
        }

        return line === "" ? undefined : line;
    }

    /**
     * Save a lesson. The same `key` saves it once: a tool call run again finds the one it made. Throws an HttpError a
     * person (or the agent) can act on when it will not do.
     */
    async add(
        conversationId: ConversationId,
        cwd: string | undefined,
        writer: Writer,
        request: { text: unknown; title?: unknown; scope: LessonScope; key?: string },
    ): Promise<Lesson> {
        const app = this.#app;
        const text = this.#text(request.text);
        const title = this.#title(request.title);
        const project =
            request.scope === "project" ? await this.project(conversationId, cwd) : undefined;
        const root = app.rootOf(conversationId);
        const meta = app.sessionMeta(root);
        const by = writer.userId ?? meta?.createdBy ?? "";
        const pending = this.#held(writer);

        return app.harness.commit(async (tx) => {
            const doc = await tx.doc(MemoryDoc);
            const items = Object.values(doc.items);
            const same =
                request.key === undefined
                    ? undefined
                    : items.find((item) => item.key === request.key);

            if (same !== undefined) {
                return copy(same);
            }

            if (
                pending &&
                items.filter((item) => item.pending === true && item.by === by).length >=
                    MAX_PENDING
            ) {
                throw new HttpError(
                    409,
                    `${String(MAX_PENDING)} lessons wait for the owner's approval already: wait for them first.`,
                );
            }

            if (!pending) {
                this.#roomFor(doc, {
                    ...(project === undefined
                        ? {}
                        : { project: project.key, projectName: project.name }),
                });
            }

            let id = randomUUID().slice(0, 5);

            while (Object.hasOwn(doc.items, id)) {
                id = randomUUID().slice(0, 5);
            }

            const lesson: Lesson = {
                id,
                text,
                ...(title === undefined ? {} : { title }),
                ...(project === undefined
                    ? {}
                    : { project: project.key, projectName: project.name }),
                ...(meta === undefined
                    ? {}
                    : { from: { conversationId: Number(root), title: meta.title ?? "Untitled" } }),
                by,
                byPi: writer.byPi,
                createdAt: this.#app.now(),
                ...(pending ? { pending: true } : {}),
                ...(request.key === undefined ? {} : { key: request.key }),
            };

            doc.items[id] = lesson;
            await this.#activity(
                tx,
                conversationId,
                writer,
                `saved a note for ${project === undefined ? "everywhere" : project.name}: “${snippet(title ?? text, 80)}”${pending ? ", for the owner to approve" : ""}`,
            );

            return copy(lesson);
        }, context);
    }

    /**
     * Change a lesson's text or forget it; approve or discard what waits. Only the owner, or whoever saved a lesson,
     * changes or forgets it; only the owner approves. A change from the agent or a guest to a lesson in force is a proposal:
     * the lesson stays as it is until the owner approves it. One that waits anyway changes as it is.
     *
     * An approval says what the owner saw (`expected`): what waits can change between their look and their tap, so
     * approving holds only when it would make true what they saw. `pendingOnly` is a cross-project review mode for the
     * human owner in their private Pia, limited to approving or discarding lessons that still wait; the agent tool never sets it.
     */
    async change(
        conversationId: ConversationId,
        cwd: string | undefined,
        writer: Writer,
        id: string,
        change: { text: unknown; title?: unknown } | "remove" | "approve" | "discard",
        expected?: { text?: string; title?: string; forget?: boolean },
        pendingOnly = false,
    ): Promise<Lesson> {
        const app = this.#app;

        // Never let the agent, a guest, or a shared-session review use the cross-project lookup.
        if (pendingOnly) {
            this.#requirePendingOwner(writer, conversationId);

            if (change !== "approve" && change !== "discard") {
                throw new HttpError(400, "The pending queue only approves or discards lessons.");
            }
        }

        const text = typeof change === "object" ? this.#text(change.text) : undefined;
        // A title left out stays as it is; an empty one goes.
        const titled = typeof change === "object" && change.title !== undefined;
        const newTitle = titled ? this.#title(change.title) : undefined;
        const project = pendingOnly ? undefined : await this.project(conversationId, cwd);
        const said = (tx: Tx, line: string) => this.#activity(tx, conversationId, writer, line);

        return app.harness.commit(async (tx) => {
            const doc = await tx.doc(MemoryDoc);

            if (pendingOnly) {
                // Recheck after waiting for the transaction: a person's role may have changed meanwhile.
                this.#requirePendingOwner(writer, conversationId);
            }

            const lesson = this.#find(doc, project, id, pendingOnly);

            if (pendingOnly && lesson.pending !== true && lesson.proposal === undefined) {
                throw new HttpError(409, "This lesson changed since you looked: check it again.");
            }

            const before = copy(lesson);
            const quoted = `“${snippet(lesson.text, 80)}”`;
            const owner = !writer.byPi && this.#isOwner(writer.userId);

            if (change === "approve") {
                if (!owner) {
                    throw new HttpError(403, "Only the owner approves lessons.");
                }

                // What approving makes true; with nothing waiting, the text in force, so a second tap does nothing.
                const proposed = lesson.pending !== true ? lesson.proposal : undefined;
                const waiting =
                    proposed?.forget === true
                        ? { forget: true }
                        : {
                              text: proposed?.text ?? lesson.text,
                              title:
                                  proposed?.title === undefined
                                      ? lesson.title
                                      : proposed.title || undefined,
                          };

                if (
                    expected === undefined ||
                    (expected.forget === true) !== (waiting.forget === true) ||
                    (waiting.forget !== true &&
                        (expected.text !== waiting.text ||
                            // An older tab sends no title: it saw none only when none waits.
                            (expected.title || undefined) !== waiting.title))
                ) {
                    throw new HttpError(
                        409,
                        "This lesson changed since you looked: check it again.",
                    );
                }

                if (lesson.pending === true) {
                    this.#roomFor(doc, lesson);
                    delete lesson.pending;
                    await said(tx, `approved the lesson ${quoted}`);
                } else if (lesson.proposal?.forget === true) {
                    delete doc.items[lesson.id];
                    await said(tx, `approved forgetting the lesson ${quoted}`);

                    return before;
                } else if (lesson.proposal?.text !== undefined) {
                    lesson.text = lesson.proposal.text;
                    setTitle(lesson, lesson.proposal.title);
                    lesson.revision = (lesson.revision ?? 1) + 1;
                    lesson.updatedAt = app.now();
                    delete lesson.proposal;
                    await said(tx, `approved a note's new text: “${snippet(titleOf(lesson), 80)}”`);
                }

                return copy(lesson);
            }

            if (change === "discard") {
                const proposer = lesson.proposal?.by;
                const own = (by: string | undefined) =>
                    !writer.byPi && by !== undefined && by === writer.userId;

                if (lesson.pending === true && (owner || own(lesson.by))) {
                    delete doc.items[lesson.id];
                    await said(tx, `discarded the lesson ${quoted}`);

                    return before;
                }

                if (lesson.proposal !== undefined && (owner || own(proposer))) {
                    delete lesson.proposal;
                    await said(tx, `kept the lesson ${quoted} as it was`);

                    return copy(lesson);
                }

                throw new HttpError(403, "Only the owner, or whoever asked, can discard this.");
            }

            if (!this.#mayChange(lesson, writer.userId)) {
                throw new HttpError(
                    403,
                    "Only the owner, or whoever saved it, can change or forget this lesson.",
                );
            }

            const held = this.#held(writer);
            const inForce = lesson.pending !== true;

            if (change === "remove") {
                // Forgetting one's own (or one nobody uses yet) goes at once; the agent's forgetting one in force is a proposal.
                if (inForce && writer.byPi) {
                    if (lesson.proposal?.forget !== true) {
                        lesson.proposal = {
                            forget: true,
                            by: writer.userId ?? lesson.by,
                            byPi: true,
                            at: app.now(),
                        };
                        await said(
                            tx,
                            `proposed forgetting the lesson ${quoted}, for the owner to approve`,
                        );
                    }

                    return copy(lesson);
                }

                delete doc.items[lesson.id];
                await said(tx, `forgot the lesson ${quoted}`);

                return before;
            }

            const nextTitle = titled ? newTitle : lesson.title;
            const same = text === lesson.text && nextTitle === lesson.title;

            if (inForce && held) {
                // Back to the text in force: nothing to propose. The writer's own proposal goes (it changed its mind);
                // someone else's stays for the owner.
                if (same) {
                    const proposal = lesson.proposal;

                    if (
                        proposal !== undefined &&
                        proposal.by === (writer.userId ?? lesson.by) &&
                        proposal.byPi === writer.byPi
                    ) {
                        delete lesson.proposal;
                        await said(tx, `withdrew the proposal for the lesson ${quoted}`);
                    }

                    return copy(lesson);
                }

                const proposedTitle = nextTitle === lesson.title ? undefined : (nextTitle ?? "");

                if (lesson.proposal?.text !== text || lesson.proposal?.title !== proposedTitle) {
                    lesson.proposal = {
                        text: text!,
                        ...(proposedTitle === undefined ? {} : { title: proposedTitle }),
                        by: writer.userId ?? lesson.by,
                        byPi: writer.byPi,
                        at: app.now(),
                    };
                    await said(
                        tx,
                        `proposed new text for the lesson ${quoted}: “${snippet(text!, 80)}”, for the owner to approve`,
                    );
                }

                return copy(lesson);
            }

            if (same && (held || inForce)) {
                return before;
            }

            // The owner's own edit is in force at once: of a lesson waiting, it approves it too.
            if (!held && !inForce) {
                this.#roomFor(doc, lesson);
                delete lesson.pending;
            }

            if (inForce && !same) {
                lesson.revision = (lesson.revision ?? 1) + 1;
            }

            lesson.text = text!;
            setTitle(lesson, nextTitle ?? "");
            lesson.updatedAt = app.now();
            delete lesson.proposal;
            await said(
                tx,
                `changed a note to “${snippet(titleOf(lesson), 80)}”${lesson.pending === true ? ", for the owner to approve" : ""}`,
            );

            return copy(lesson);
        }, context);
    }

    // ─── Search and read ──────────────────────────────────────────────

    /** The approved notes a conversation may find: its project's and everywhere's (Pia: everywhere's). */
    async findable(conversationId: ConversationId, cwd: string | undefined): Promise<Lesson[]> {
        return (await this.inForce(conversationId, cwd)).lessons;
    }

    /**
     * Search the notes a conversation may find. Every word of the query must be in the title or the body (a word of the
     * note that starts with it counts); when no note has them all, the notes with the most of them come, marked
     * partial. An empty query lists the newest. Title words count three times, an exact id or title ten.
     */
    async search(
        conversationId: ConversationId,
        cwd: string | undefined,
        query: string,
        limit = SEARCH_RESULTS,
    ): Promise<{ hits: NoteHit[]; partial: boolean; total: number }> {
        const notes = await this.findable(conversationId, cwd);
        const asked = [...new Set(words(query))];
        const max = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(limit)));
        const hit = (lesson: Lesson, excerpt: string): NoteHit => ({
            id: lesson.id,
            title: titleOf(lesson),
            revision: lesson.revision ?? 1,
            scope: lesson.project === undefined ? "everywhere" : "project",
            byPi: lesson.byPi,
            size: lesson.text.length,
            excerpt,
        });

        if (asked.length === 0) {
            const newest = [...notes].sort(
                (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
            );

            return {
                hits: newest.slice(0, max).map((lesson) => hit(lesson, excerptOf(lesson.text, []))),
                partial: false,
                total: notes.length,
            };
        }

        const phrase = query.trim().toLowerCase();
        const scored = notes.map((lesson) => {
            const title = words(titleOf(lesson));
            const body = words(lesson.text);
            let score = 0;
            let matched = 0;

            for (const word of asked) {
                const inTitle = title.filter((each) => each.startsWith(word)).length;
                const inBody = body.filter((each) => each.startsWith(word)).length;

                if (inTitle + inBody > 0) {
                    matched++;
                    score += 3 * Math.min(inTitle, 3) + Math.min(inBody, 5);
                }
            }

            if (lesson.id === phrase.replace(/^\[|\]$/g, "")) {
                score += 10;
                matched = asked.length;
            }

            if (titleOf(lesson).toLowerCase() === phrase) {
                score += 10;
            }

            if (asked.length > 1 && lesson.text.toLowerCase().includes(phrase)) {
                score += 5;
            }

            return { lesson, score, matched };
        });
        const all = scored.filter((each) => each.matched === asked.length);
        const partial = all.length === 0;
        const found = (partial ? scored.filter((each) => each.matched > 0) : all).sort(
            (a, b) =>
                b.matched - a.matched ||
                b.score - a.score ||
                (b.lesson.updatedAt ?? b.lesson.createdAt) -
                    (a.lesson.updatedAt ?? a.lesson.createdAt),
        );

        return {
            hits: found
                .slice(0, max)
                .map(({ lesson }) => hit(lesson, excerptOf(lesson.text, asked))),
            partial,
            total: found.length,
        };
    }

    /** Notes a conversation may find, by id; an id it may not find is "missing", whatever the reason. */
    async read(
        conversationId: ConversationId,
        cwd: string | undefined,
        ids: string[],
    ): Promise<{ found: Lesson[]; missing: string[] }> {
        const notes = new Map((await this.findable(conversationId, cwd)).map((n) => [n.id, n]));
        const found: Lesson[] = [];
        const missing: string[] = [];

        for (const asked of ids) {
            const id = asked.trim().replace(/^\[|\]$/g, "");
            const note = notes.get(id);

            if (note === undefined) {
                missing.push(asked);
            } else if (!found.includes(note)) {
                found.push(note);
            }
        }

        return { found, missing };
    }

    /**
     * The notes a conversation read with `note_load` before its context's latest compaction, by id, oldest read first: from
     * the tool results that the summary replaced, back to the start of the context (a reset). `summary` is the summary
     * message's text; both are empty when the context starts with no compaction.
     */
    async readBeforeCompaction(
        conversationId: ConversationId,
    ): Promise<{ summary: string; ids: string[] }> {
        const conversation = await this.#app.conversation(conversationId);
        const head = (await conversation.context(context)).head;

        if (head?.kind !== CompactionEntry.kind || head.head === undefined) {
            return { summary: "", ids: [] };
        }

        const summary = (head.model ?? [])
            .flatMap((message) =>
                message.role === "user" && typeof message.content !== "string"
                    ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
                    : message.role === "user"
                      ? [message.content]
                      : [],
            )
            .join("");
        const newestFirst: string[] = [];
        let cursor: Parameters<typeof conversation.entries>[2];

        scan: do {
            const page = await conversation.entries(
                { maxEntryId: (head.head - 1) as typeof head.head, order: "descending" },
                200,
                cursor,
                context,
            );

            for (const entry of page.items) {
                if (entry.kind === ResetEntry.kind) {
                    break scan;
                }

                for (const message of entry.model ?? []) {
                    if (message.role !== "toolResult" || message.toolName !== "note_load") {
                        continue;
                    }

                    const text = message.content
                        .flatMap((part) => (part.type === "text" ? [part.text] : []))
                        .join("\n");

                    for (const found of [...text.matchAll(/<note id="([^"]+)"/g)].reverse()) {
                        newestFirst.push(found[1]!);
                    }
                }
            }

            cursor = page.next;
        } while (cursor !== undefined);

        return { summary, ids: [...new Set(newestFirst)].reverse() };
    }

    // ─── Model choice ──────────────────────────────────────────────────────

    /** The approved note Pia reads before it picks a model, if the owner marked one. */
    async modelGuidance(): Promise<Lesson | undefined> {
        const note = (await this.#all()).find(
            (lesson) =>
                lesson.purpose === MODEL_CHOICE &&
                lesson.pending !== true &&
                lesson.project === undefined,
        );

        return note === undefined ? undefined : copy(note);
    }

    /**
     * The owner marks a note as the one Pia reads before it picks a model, with an optional thinking rule, or unmarks it.
     * Only for a note for everywhere that is in force; marking one unmarks any other.
     */
    async setPurpose(
        id: ConversationId,
        user: User,
        lessonId: string,
        request: { purpose?: unknown; models?: unknown; minThinking?: unknown },
    ): Promise<Lesson> {
        const app = this.#app;

        app.requireSee(user, id);

        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner chooses the note for model choices.");
        }

        const on = request.purpose === MODEL_CHOICE;
        const models = Array.isArray(request.models)
            ? request.models
                  .filter((each): each is string => typeof each === "string")
                  .map((each) => flat(each).toLowerCase())
                  .filter((each) => each !== "")
            : [];
        const minThinking =
            typeof request.minThinking === "string" && LEVELS.includes(request.minThinking)
                ? request.minThinking
                : undefined;

        if (on && models.length > 0 && minThinking === undefined) {
            throw new HttpError(400, `Name a thinking level: one of ${LEVELS.join(", ")}.`);
        }

        const project = await this.project(id, app.cwdOf(id));

        return app.harness.commit(async (tx) => {
            const doc = await tx.doc(MemoryDoc);
            const lesson = this.#find(doc, project, lessonId);

            if (on && (lesson.project !== undefined || lesson.pending === true)) {
                throw new HttpError(
                    409,
                    "Only a note for everywhere that is in force can guide Pia's model choices.",
                );
            }

            for (const other of Object.values(doc.items)) {
                if (other.purpose !== undefined && (other.id !== lesson.id || !on)) {
                    delete other.purpose;
                    delete other.modelRule;
                }
            }

            if (on) {
                lesson.purpose = MODEL_CHOICE;

                if (models.length > 0 && minThinking !== undefined) {
                    lesson.modelRule = { models, minThinking };
                } else {
                    delete lesson.modelRule;
                }
            }

            await this.#activity(
                tx,
                id,
                this.#person(user),
                on
                    ? `made “${snippet(titleOf(lesson), 80)}” the note Pia reads before it picks a model${lesson.modelRule === undefined ? "" : ` (${lesson.modelRule.models.join(", ")}: thinking ${lesson.modelRule.minThinking} or higher)`}`
                    : `stopped Pia reading “${snippet(titleOf(lesson), 80)}” before it picks a model`,
            );

            return copy(lesson);
        }, context);
    }

    // ─── People ────────────────────────────────────────────────────────────

    #person(user: User): Writer {
        return { userId: user.id, byPi: false, name: user.name };
    }

    /** The session's lessons, or the human owner's pending lessons across all projects and everywhere in their private Pia. */
    async view(id: ConversationId, user: User, pendingOnly = false): Promise<MemoryView> {
        const app = this.#app;

        if (pendingOnly) {
            this.#requirePendingOwner(this.#person(user), id);
        }

        app.requireSee(user, id);
        const owner = user.role === "owner";
        const project = pendingOnly ? undefined : await this.project(id, app.cwdOf(id));
        const applying = pendingOnly
            ? ordered(
                  (await this.#all()).filter(
                      (lesson) => lesson.pending === true || lesson.proposal !== undefined,
                  ),
              )
            : await this.applying(project);
        const lessons = applying
            .filter((lesson) => lesson.pending !== true || owner || lesson.by === user.id)
            .map((lesson): LessonView => {
                const from = lesson.from;
                const source =
                    from === undefined
                        ? undefined
                        : (from.conversationId as unknown as ConversationId);
                const seen = source !== undefined && app.sessionMeta(source) !== undefined;

                return {
                    id: lesson.id,
                    text: lesson.text,
                    ...(lesson.title === undefined ? {} : { title: lesson.title }),
                    revision: lesson.revision ?? 1,
                    ...(lesson.purpose === undefined ? {} : { purpose: lesson.purpose }),
                    ...(lesson.modelRule === undefined
                        ? {}
                        : { modelRule: structuredClone(lesson.modelRule) }),
                    scope: lesson.project === undefined ? "everywhere" : "project",
                    ...(pendingOnly && lesson.projectName !== undefined
                        ? { projectName: lesson.projectName }
                        : {}),
                    byPi: lesson.byPi,
                    by: lesson.by,
                    byName: app.config.userById(lesson.by)?.name ?? "someone",
                    createdAt: lesson.createdAt,
                    ...(lesson.updatedAt === undefined ? {} : { updatedAt: lesson.updatedAt }),
                    pending: lesson.pending === true,
                    ...(seen && app.canSee(user, source)
                        ? {
                              from: {
                                  id: from!.conversationId,
                                  title: app.sessionMeta(source)?.title ?? from!.title,
                              },
                          }
                        : {}),
                    mine:
                        !pendingOnly && user.role !== "viewer" && this.#mayChange(lesson, user.id),
                    ...(lesson.proposal !== undefined && (owner || lesson.proposal.by === user.id)
                        ? {
                              proposal: {
                                  ...(lesson.proposal.text === undefined
                                      ? {}
                                      : { text: lesson.proposal.text }),
                                  ...(lesson.proposal.title === undefined
                                      ? {}
                                      : { title: lesson.proposal.title }),
                                  ...(lesson.proposal.forget === true ? { forget: true } : {}),
                                  byPi: lesson.proposal.byPi,
                                  byName:
                                      app.config.userById(lesson.proposal.by)?.name ?? "someone",
                                  mine: !pendingOnly && lesson.proposal.by === user.id,
                              },
                          }
                        : {}),
                };
            });

        return {
            ...(pendingOnly ? { pendingAll: true as const } : {}),
            project: project === undefined ? null : { name: project.name },
            lessons,
            owner,
            canWrite: !pendingOnly && user.role !== "viewer",
            limits: {
                project: MAX_PROJECT_LESSONS,
                everywhere: MAX_EVERYWHERE_LESSONS,
                text: MAX_LESSON,
                title: MAX_TITLE,
            },
        };
    }

    /** A person saves a lesson by hand. */
    async remember(
        id: ConversationId,
        user: User,
        request: { text?: unknown; title?: unknown; scope?: unknown },
    ): Promise<Lesson> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);

        return this.add(id, app.cwdOf(id), this.#person(user), {
            text: request.text,
            ...(request.title === undefined ? {} : { title: request.title }),
            scope: request.scope === "everywhere" ? "everywhere" : "project",
        });
    }

    /** A person changes, forgets, or approves a lesson; an approval says what they saw (see `change`). */
    async edit(
        id: ConversationId,
        user: User,
        lessonId: string,
        change: { text: unknown; title?: unknown } | "remove" | "approve" | "discard",
        expected?: { text?: string; title?: string; forget?: boolean },
        pendingOnly = false,
    ): Promise<Lesson> {
        const app = this.#app;

        if (pendingOnly) {
            this.#requirePendingOwner(this.#person(user), id);
        }

        app.requireSee(user, id);
        app.requireSteer(user);

        return this.change(
            id,
            app.cwdOf(id),
            this.#person(user),
            lessonId,
            change,
            expected,
            pendingOnly,
        );
    }

    // ─── Tabs ──────────────────────────────────────────────────────────────

    /** Lessons changed: tabs showing them fetch them again. */
    committed(): void {
        if (this.#timer !== undefined) {
            return;
        }

        this.#timer = setTimeout(() => {
            this.#timer = undefined;

            for (const client of this.#app.clients) {
                client.send("memory", {});
            }
        }, 200);
        this.#timer.unref();
    }
}
