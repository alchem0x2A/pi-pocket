// Memory: the notes (once called lessons) the agent can find across sessions, for this session's project and everywhere.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, navigate, notify, store } from "../store.js";
import { html, Icon, Markdown, plainText, Sheet, timeAgo } from "../ui.js";

/** Memory needs its extension, and a conversation to say which project: `id`, or the one open. */
export const memoryAvailable = (id) =>
    (id ?? store.state.conversationId) !== null &&
    store.state.server?.extensions?.includes("pocket-memory") === true;

const path = (id, rest = "", pendingOnly = false) =>
    `c/${id}/memory${rest}${pendingOnly ? "?pending=all" : ""}`;

/** The lessons last fetched, keyed by person, conversation, and view: the menu can show its hint while asking again. */
let last = null;
/**
 * The fetch under way for each conversation, `{ rev, promise }`: the sheet, the menu, and each memory call ask once
 * together, Pia's calls and the open session's too.
 */
const asking = new Map();

function fetchLessons(id, rev, key, pendingOnly) {
    const fetching = asking.get(key);

    if (fetching?.rev === rev) {
        return fetching.promise;
    }

    const asked = { rev, promise: api(path(id, "", pendingOnly)) };

    asking.set(key, asked);
    // A fetch that failed is not kept: the next one asks again.
    asked.promise.catch(() => {
        if (asking.get(key) === asked) {
            asking.delete(key);
        }
    });

    return asked.promise;
}

/**
 * The lessons that apply in conversation `id` (the one open when absent), fetched when it shows and again whenever
 * they change on the server.
 */
export function useMemory(conversationId, pendingOnly = false, force = false) {
    const id = conversationId ?? store.state.conversationId;
    const { me } = store.state;
    const key = `${me?.id}:${me?.role}:${id}:${pendingOnly ? "pending" : "applying"}`;
    // Followed here, not read from the render: a call's card in the conversation is not drawn again on every change.
    const revision = (state) => `${state.memoryRev ?? 0}:${state.streamId ?? ""}`;
    const [rev, setRev] = useState(() => revision(store.state));

    useEffect(() => store.subscribe((state) => setRev(revision(state))), []);
    const on = (force || memoryAvailable(id)) && (!pendingOnly || me?.role === "owner");
    const [data, setData] = useState(last?.key === key ? last : null);
    // Asked again a few times when a fetch fails (a dropped connection, a restart), rather than loading for ever.
    const [retry, setRetry] = useState(0);

    useEffect(() => {
        let live = true;
        let timer;

        if (!on) {
            return undefined;
        }

        fetchLessons(id, rev, key, pendingOnly).then(
            (fetched) => {
                if (live) {
                    // An older running server ignores the new query: never label its scoped view as an all-project queue.
                    last = {
                        key,
                        data:
                            pendingOnly && fetched.pendingAll !== true
                                ? { restartRequired: true }
                                : fetched,
                    };
                    setData(last);
                }
            },
            () => {
                if (live && retry < 3) {
                    timer = setTimeout(() => setRetry(retry + 1), 2000 * (retry + 1));
                }
            },
        );

        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [key, rev, on, retry]);

    return !on ? null : data?.key === key ? data.data : last?.key === key ? last.data : null;
}

/** Fetch again after a write here, without waiting for the server's word. */
function refresh() {
    store.set((state) => ({ memoryRev: (state.memoryRev ?? 0) + 1 }));
}

/** The menu's hint: how many lessons apply here and everywhere, and for the owner how many wait for approval. */
export function memoryHint(data) {
    if (!data) {
        return "";
    }

    const live = data.lessons.filter((lesson) => !lesson.pending);
    const here = live.filter((lesson) => lesson.scope === "project").length;
    const everywhere = live.length - here;
    const waiting = data.owner
        ? data.lessons.filter((lesson) => lesson.pending || lesson.proposal).length
        : 0;
    const parts = [
        data.project ? `${here} here` : null,
        `${everywhere} everywhere`,
        waiting > 0 ? `${waiting} to approve` : null,
    ];

    return parts.filter(Boolean).join(" · ");
}

/** Save a note by hand: for this project, or everywhere, with an optional title. */
export async function remember(text, scope = "project", conversationId, title = "") {
    const id = conversationId ?? store.state.conversationId;
    const lesson = await api(path(id), { text, scope, ...(title.trim() ? { title } : {}) });

    refresh();

    return lesson;
}

/** What the owner saw waiting, sent with Approve: the server approves only if it still waits. */
function approval(lesson) {
    if (lesson.pending) {
        return { text: lesson.text, title: lesson.title ?? "" };
    }

    if (lesson.proposal?.forget) {
        return { forget: true };
    }

    // A proposal that sets no title keeps the one in force; "" removes it.
    const title = lesson.proposal?.title ?? lesson.title ?? "";

    return { text: lesson.proposal?.text, title };
}

/** A note's title: its own, or its body's first line. */
export const noteTitle = (lesson) =>
    lesson.title ||
    (lesson.text.split("\n").find((line) => line.trim() !== "") ?? "")
        .replace(/^#+\s*/, "")
        .slice(0, 80);

/** Words of a search, lowercased. */
const words = (text) =>
    text
        .toLowerCase()
        .split(/[^\p{L}\p{N}_./:@-]+/u)
        .filter((word) => word !== "");

/** Whether a note has every word of a search, in its title or body (the start of a word is enough). */
function matches(lesson, query) {
    const asked = words(query);

    if (asked.length === 0) {
        return true;
    }

    const own = words(`${noteTitle(lesson)} ${lesson.text} ${lesson.id}`);

    return asked.every((word) => own.some((each) => each.startsWith(word)));
}

/**
 * Title and body fields with their size against the limits: a body or title over its limit shows the error and keeps
 * Save off, so nothing is cut. Returns whether the draft can be saved.
 */
function NoteFields({ title, text, setTitle, setText, limits, autofocus = false, onSubmit }) {
    const over = text.length > limits.text;
    const titleOver = title.length > limits.title;

    return html`<div class="note-fields">
        <input
            class="note-title-input"
            type="text"
            aria-label="Title"
            placeholder="Title (optional): when it helps"
            value=${title}
            onInput=${(event) => setTitle(event.currentTarget.value)}
        />
        ${
            titleOver &&
            html`<div class="note-size over" role="alert">
                The title is ${title.length} characters; ${limits.title} at most.
            </div>`
        }
        <textarea
            rows="6"
            autofocus=${autofocus}
            aria-label="Note"
            placeholder="Markdown is fine: lists, code, links. e.g. Run the tests with npm test; the browser tests need Chromium."
            value=${text}
            onInput=${(event) => setText(event.currentTarget.value)}
            onKeyDown=${(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onSubmit) {
                    event.preventDefault();
                    onSubmit();
                }
            }}
        ></textarea>
        <div class=${`note-size ${over ? "over" : ""}`} role=${over ? "alert" : undefined}>
            ${
                over
                    ? `Too long: ${text.length} of ${limits.text} characters. Shorten it, or split it into two notes.`
                    : `${text.length} / ${limits.text}`
            }
        </div>
    </div>`;
}

const fits = (title, text, limits) =>
    text.trim() !== "" && text.length <= limits.text && title.length <= limits.title;

/** Who saved a lesson, and where it came from, in a line. */
function Source({ lesson }) {
    const { me } = store.state;
    const who = lesson.byPi ? "the agent" : lesson.by === me?.id ? "you" : lesson.byName;

    const open = (event) => {
        event.preventDefault();
        closeSheet();
        navigate(lesson.from.id);
    };

    return html`<div class="muted small lesson-source">
        <span>${who}</span>
        ${lesson.byPi && lesson.by !== me?.id && html`<span> for ${lesson.byName}</span>`}
        ${
            lesson.from &&
            html` · <a href=${`/s/${lesson.from.id}`} onClick=${open}>${lesson.from.title}</a>`
        }
        <span> · ${timeAgo(lesson.updatedAt ?? lesson.createdAt)}</span>
        ${(lesson.pending || lesson.proposal) && html`<span> · for ${reach(lesson)}</span>`}
    </div>`;
}

/** Where a lesson applies, said where it waits: everywhere's reach every session and Pia. */
const assistantName = () => store.state.server?.assistant?.name || "Pia";
const reach = (lesson) =>
    lesson.scope === "everywhere"
        ? `everywhere: every session, and ${assistantName()}`
        : (lesson.projectName ?? "this project");

/** One note: its title, its Markdown, where it came from, and what this person may do with it. */
function Lesson({ lesson, data, conversationId, pendingOnly = false, open: opened = false }) {
    const id = conversationId ?? store.state.conversationId;
    const [draft, setDraft] = useState(null);
    const [forgetting, setForgetting] = useState(false);
    const [open, setOpen] = useState(opened);
    const act = (rest, body = {}, done = "") =>
        attempt(async () => {
            // Fetched again either way: after a refusal (it changed since), the sheet shows what waits now.
            try {
                await api(path(id, `/${encodeURIComponent(lesson.id)}${rest}`, pendingOnly), body);
            } finally {
                refresh();
            }

            setDraft(null);
            setForgetting(false);

            if (done) {
                notify("info", done);
            }
        });
    const approving = data.owner && (lesson.pending || lesson.proposal);
    const withdrawing = !data.owner && lesson.proposal?.mine;

    if (draft !== null) {
        const save = () =>
            fits(draft.title, draft.text, data.limits) &&
            act("", { text: draft.text, title: draft.title });

        return html`<div class="lesson editing" data-note=${lesson.id}>
            <${NoteFields}
                title=${draft.title}
                text=${draft.text}
                setTitle=${(title) => setDraft({ ...draft, title })}
                setText=${(text) => setDraft({ ...draft, text })}
                limits=${data.limits}
                autofocus=${true}
                onSubmit=${save}
            />
            <div class="row lesson-actions">
                <button class="button small ghost" onClick=${() => setDraft(null)}>Cancel</button>
                <button
                    class="button small primary"
                    disabled=${!fits(draft.title, draft.text, data.limits)}
                    onClick=${save}
                >
                    Save
                </button>
            </div>
        </div>`;
    }

    return html`<div
        class=${`lesson ${lesson.pending ? "pending" : ""} ${open ? "open" : ""}`}
        data-note=${lesson.id}
    >
        <button
            class="note-head"
            aria-expanded=${open ? "true" : "false"}
            onClick=${() => setOpen(!open)}
        >
            <span class="note-title">${noteTitle(lesson)}</span>
            ${lesson.purpose && html`<span class="note-tag">model choice</span>`}
            <${Icon} name="chevron" size=${16} class=${`note-chevron ${open ? "open" : ""}`} />
        </button>
        ${
            open
                ? html`<div class="lesson-text note-body">
                      <${Markdown} text=${lesson.text} conversationId=${id} />
                  </div>`
                : html`<div class="lesson-text note-excerpt muted small">
                      ${lesson.title ? plainText(lesson.text).replace(/\s+/g, " ").slice(0, 140) : ""}
                  </div>`
        }
        ${
            lesson.proposal &&
            html`<div class="lesson-proposal">
                <span class="muted small">
                    ${lesson.proposal.byPi ? "the agent" : lesson.proposal.mine ? "You" : lesson.proposal.byName} ${lesson.proposal.forget ? "proposes forgetting it." : "proposes:"}
                </span>
                ${
                    lesson.proposal.title !== undefined &&
                    html`<div class="note-title">${lesson.proposal.title || "(no title)"}</div>`
                }
                ${
                    lesson.proposal.text &&
                    html`<div class="lesson-text note-body">
                        <${Markdown} text=${lesson.proposal.text} conversationId=${id} />
                    </div>`
                }
            </div>`
        }
        ${
            (lesson.pending || lesson.proposal) &&
            !data.owner &&
            html`<div class="muted small">Waits for the owner's approval; until then the agent goes on as before.</div>`
        }
        ${open && data.owner && !pendingOnly && html`<${Purpose} lesson=${lesson} act=${act} />`}
        <div class="lesson-foot">
            <${Source} lesson=${lesson} />
            ${
                (lesson.mine || approving || withdrawing) &&
                html`<div class="row lesson-actions">
                    ${
                        approving &&
                        html`<button
                            class="button small primary"
                            onClick=${() =>
                                act(
                                    "/approve",
                                    approval(lesson),
                                    "Approved: the agent can find it from its next message.",
                                )}
                        >
                            Approve
                        </button>`
                    }
                    ${
                        (approving || withdrawing) &&
                        html`<button class="button small ghost" onClick=${() => act("/discard")}>
                            ${approving ? "Discard" : "Withdraw"}
                        </button>`
                    }
                    ${
                        lesson.mine &&
                        html`<button
                            class="button small ghost"
                            onClick=${() =>
                                setDraft({ title: lesson.title ?? "", text: lesson.text })}
                        >
                            Edit
                        </button>`
                    }
                    ${
                        lesson.mine &&
                        !(approving && lesson.pending) &&
                        html`<button
                            class=${`button small ghost ${forgetting ? "danger" : ""}`}
                            onClick=${() => (forgetting ? act("/remove") : setForgetting(true))}
                            onBlur=${() => setForgetting(false)}
                        >
                            ${forgetting ? "Delete it" : "Delete"}
                        </button>`
                    }
                </div>`
            }
        </div>
    </div>`;
}

/** The owner marks a note for everywhere as the one Pia reads before it picks a model, with an optional thinking rule. */
function Purpose({ lesson, act }) {
    const rule = lesson.modelRule;
    const [models, setModels] = useState(rule ? rule.models.join(", ") : "");
    const [level, setLevel] = useState(rule?.minThinking ?? "xhigh");

    if (lesson.scope !== "everywhere" || lesson.pending) {
        return null;
    }

    const list = models
        .split(",")
        .map((each) => each.trim())
        .filter(Boolean);
    const mark = () =>
        act(
            "/purpose",
            {
                purpose: "model-choice",
                ...(list.length > 0 ? { models: list, minThinking: level } : {}),
            },
            "Pia reads this note before it picks a model.",
        );

    return html`<details class="note-purpose" open=${lesson.purpose ? true : undefined}>
        <summary class="muted small">
            ${lesson.purpose ? "Pia reads this before it picks a model" : "Use for Pia's model choices…"}
        </summary>
        <div class="note-purpose-body">
            <label class="field">
                <span class="label">Models that need a minimum thinking level (words of their ids)</span>
                <input
                    type="text"
                    placeholder="e.g. luna, terra"
                    value=${models}
                    onInput=${(event) => setModels(event.currentTarget.value)}
                />
            </label>
            <label class="field">
                <span class="label">Minimum thinking level</span>
                <select value=${level} onChange=${(event) => setLevel(event.currentTarget.value)}>
                    ${["minimal", "low", "medium", "high", "xhigh", "max"].map(
                        (each) => html`<option value=${each}>${each}</option>`,
                    )}
                </select>
            </label>
            <div class="row lesson-actions">
                ${
                    lesson.purpose &&
                    html`<button
                        class="button small ghost"
                        onClick=${() => act("/purpose", {}, "Pia no longer reads this note first.")}
                    >
                        Stop
                    </button>`
                }
                <button class="button small primary" onClick=${mark}>
                    ${lesson.purpose ? "Save rule" : "Use this note"}
                </button>
            </div>
        </div>
    </details>`;
}

/** A group of lessons with its title, or nothing when it has none. */
function Group({ title, lessons, data, empty, conversationId, pendingOnly = false }) {
    return html`<div class="group">
        <div class="group-title">${title}</div>
        ${lessons.length === 0 && empty && html`<p class="muted small">${empty}</p>`}
        ${
            lessons.length > 0 &&
            html`<div class="sheet-list">
                ${lessons.map(
                    (lesson) => html`<${Lesson}
                        key=${lesson.id}
                        lesson=${lesson}
                        data=${data}
                        conversationId=${conversationId}
                        pendingOnly=${pendingOnly}
                    />`,
                )}
            </div>`
        }
    </div>`;
}

/** The notes the agent can find: what waits for approval, this project's, and everywhere's; a search; and a new one. */
export function MemorySheet({
    draft: initial = "",
    conversationId,
    pendingOnly = false,
    settings = false,
}) {
    const id = conversationId ?? store.state.conversationId;
    const data = useMemory(id, pendingOnly, settings);
    const [text, setText] = useState(initial);
    const [title, setTitle] = useState("");
    const [scope, setScope] = useState("project");
    const [busy, setBusy] = useState(false);
    const [query, setQuery] = useState("");
    const [adding, setAdding] = useState(initial !== "");

    const heading = pendingOnly ? "Pending memories" : "Memory";

    if (pendingOnly && store.state.me?.role !== "owner") {
        return html`<${Sheet} title=${heading} onClose=${closeSheet}>
            <p class="muted">Only the owner can review pending memories.</p>
        <//>`;
    }

    if (!data) {
        return html`<${Sheet} title=${heading} onClose=${closeSheet}>
            <p class="muted">Loading…</p>
        <//>`;
    }

    if (pendingOnly && data.restartRequired) {
        return html`<${Sheet} title=${heading} onClose=${closeSheet}>
            <p class="muted">
                Restart the server from Menu → Restart server to review pending memories across projects.
            </p>
        <//>`;
    }

    // An older server sends no title limit.
    const limits = { title: 120, ...data.limits };
    const project = data.project;
    const chosen = project ? scope : "everywhere";
    const searching = query.trim() !== "";
    const found = data.lessons.filter((lesson) => matches(lesson, query));
    const waiting = data.owner ? found.filter((lesson) => lesson.pending || lesson.proposal) : [];
    const shown = found.filter((lesson) => !waiting.includes(lesson));
    const here = shown.filter((lesson) => lesson.scope === "project");
    const everywhere = shown.filter((lesson) => lesson.scope === "everywhere");

    const add = () => {
        if (busy || !fits(title, text, limits)) {
            return;
        }

        setBusy(true);
        attempt(async () => {
            const lesson = await remember(text, chosen, id, title);

            setText("");
            setTitle("");
            setAdding(false);
            notify(
                "info",
                lesson.pending
                    ? "Saved. The agent can find it once the owner approves it."
                    : "Saved. The agent can find it from its next message.",
            );
        }).finally(() => setBusy(false));
    };

    if (pendingOnly) {
        return html`<${Sheet} title=${heading} onClose=${closeSheet}>
            <p class="muted small">
                Memories waiting for your approval, across every project and everywhere.
                Approve only what you want the agent to find; until then the agent goes on as before.
            </p>
            <${Group}
                title=${`To approve · ${waiting.length}`}
                lessons=${waiting}
                data=${{ ...data, limits }}
                conversationId=${id}
                pendingOnly=${true}
                empty="No memories waiting for approval."
            />
        <//>`;
    }

    const full = { ...data, limits };

    return html`<${Sheet} title=${heading} onClose=${closeSheet}>
        ${
            settings &&
            store.state.server?.extensions?.includes("pocket-memory") !== true &&
            html`<p class="muted small">Memory is off in Extensions. You can still edit its saved notes here.</p>`
        }
        <p class="muted small">
            Notes the agent can search and read across sessions: facts about this machine, how to build and test, conventions, preferences. ${project ? html`Those for <b>${project.name}</b> can be found in every session in it, worktrees too; the rest everywhere.` : `${assistantName()} finds notes for everywhere.`} No note is in the agent's prompt: it searches and reads them, and keeps the ones it read through a compaction. The agent proposes notes, and the owner approves them; yours count at once.
        </p>
        <div class="note-tools">
            <label class="search note-search">
                <${Icon} name="search" size=${16} />
                <input
                    type="search"
                    aria-label="Search notes"
                    placeholder="Search notes"
                    value=${query}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                />
            </label>
            ${
                data.canWrite &&
                !adding &&
                html`<button class="button primary" onClick=${() => setAdding(true)}>
                    New note
                </button>`
            }
        </div>
        ${
            data.canWrite &&
            adding &&
            html`<div class="lesson-add">
                <${NoteFields}
                    title=${title}
                    text=${text}
                    setTitle=${setTitle}
                    setText=${setText}
                    limits=${limits}
                    autofocus=${true}
                    onSubmit=${add}
                />
                <div class="row">
                    ${
                        project &&
                        html`<div class="segmented grow" role="radiogroup" aria-label="For">
                            <button
                                role="radio"
                                aria-checked=${chosen === "project" ? "true" : "false"}
                                class=${chosen === "project" ? "on" : ""}
                                onClick=${() => setScope("project")}
                            >
                                This project
                            </button>
                            <button
                                role="radio"
                                aria-checked=${chosen === "everywhere" ? "true" : "false"}
                                class=${chosen === "everywhere" ? "on" : ""}
                                onClick=${() => setScope("everywhere")}
                            >
                                Everywhere
                            </button>
                        </div>`
                    }
                    <button
                        class="button ghost"
                        onClick=${() => {
                            setAdding(false);
                            setText("");
                            setTitle("");
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        class="button primary"
                        disabled=${busy || !fits(title, text, limits)}
                        onClick=${add}
                    >
                        Save
                    </button>
                </div>
            </div>`
        }
        ${searching && found.length === 0 && html`<p class="muted small">No note matches.</p>`}
        ${
            waiting.length > 0 &&
            html`<${Group}
                title=${`To approve · ${waiting.length}`}
                lessons=${waiting}
                data=${full}
                conversationId=${id}
            />`
        }
        ${
            project &&
            (!searching || here.length > 0) &&
            html`<${Group}
                title=${`This project: ${project.name}`}
                lessons=${here}
                data=${full}
                conversationId=${id}
                empty="Nothing yet."
            />`
        }
        ${
            (!searching || everywhere.length > 0) &&
            html`<${Group}
                title="Everywhere"
                lessons=${everywhere}
                data=${full}
                conversationId=${id}
                empty="Nothing yet."
            />`
        }
    <//>`;
}

/**
 * Under the agent's memory call: what became of the lesson it saved, changed, or forgot, in conversation `conversationId` (the
 * one open when absent). While it waits, the owner reads it and approves or discards it right here, without opening
 * the sheet.
 */
export function LessonCall({ lessonId, conversationId }) {
    const id = conversationId ?? store.state.conversationId;
    const data = useMemory(id);

    if (!data) {
        return null;
    }

    const lesson = data.lessons.find((each) => each.id === lessonId);
    // Fetched again either way: after a refusal (it changed since), the card shows what waits now.
    const act = (rest, body, done) =>
        attempt(async () => {
            try {
                await api(path(id, `/${encodeURIComponent(lessonId)}${rest}`), body);
            } finally {
                refresh();
            }

            notify("info", done);
        });

    // One waiting for the owner is hidden from others: say nothing rather than that it is gone.
    if (!lesson) {
        return data.owner
            ? html`<div class="lesson-call muted small">No longer in memory.</div>`
            : null;
    }

    if (!lesson.pending && !lesson.proposal) {
        return html`<div class="lesson-call muted small">In memory: the agent can find it.</div>`;
    }

    const what = lesson.pending
        ? "A new note"
        : lesson.proposal.forget
          ? "Forgetting this note"
          : "New text for this note";
    const text = lesson.pending || lesson.proposal.forget ? lesson.text : lesson.proposal.text;

    return html`<div class="lesson-call waiting">
        <div class="grow">
            <div>${what}, for ${reach(lesson)}, waits for ${data.owner ? "you" : "the owner"}:</div>
            ${lesson.title && html`<div class="note-title">${lesson.proposal?.title || lesson.title}</div>`}
            <div class="lesson-text note-body">
                <${Markdown} text=${text} conversationId=${id} />
            </div>
        </div>
        ${
            data.owner &&
            html`<button
                    class="button small primary"
                    onClick=${() =>
                        act(
                            "/approve",
                            approval(lesson),
                            "Approved: the agent can find it from its next message.",
                        )}
                >
                    Approve
                </button>
                <button
                    class="button small ghost"
                    onClick=${() => act("/discard", {}, "Discarded.")}
                >
                    Discard
                </button>`
        }
    </div>`;
}
