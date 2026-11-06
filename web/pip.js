// Pia, the owner's assistant, in a small window over whatever is open. It stays out of the way until
// called: Alt+A, the rail's Pia button, the places, the launcher, or `/pia`; and a small mark in the corner shows only
// while Pia works, or has something new. The panel watches Pia's conversation through a view of its own (`piaview`
// events), so the session behind it stays as it was.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { followUpText } from "./artifact-bridge.js";
import { useBack } from "./back.js";
import { boxKey, keyBox } from "./box-keys.js";
import { useDragToClose } from "./gestures.js";
import { createPiaDraft } from "./pip-attachments.js";
import { usePiaResize } from "./pip-window.js";
import { api, attempt, isRow, navigate, notify, openSheet, store, uid } from "./store.js";
import { spendTap } from "./taps.js";
import { memoryAvailable, useMemory } from "./sheets/memory.js";
import { itemsOf, says, summarize } from "./turns.js";
import {
    contextLevel,
    entryImageUrl,
    fileUrl,
    formatBytes,
    formatTokens,
    html,
    Icon,
    Markdown,
    modelLabel,
    railState,
    readable,
    Spinner,
    splitAttachments,
    Thumb,
    usePresence,
} from "./ui.js";
import { MicButton, useDictation } from "./voice.js";

const OPEN_KEY = "pocket.pia";
const SEEN_KEY = "pocket.pia.seen";
const DRAFT_KEY = "pocket.pia.draft";
const LEGACY_SEEN_KEY = "pocket.pip.seen";
const LEGACY_DRAFT_KEY = "pocket.pip.draft";
// Image previews and in-flight work outlive the panel, but never their Pia/account scope.
const composerDraft = createPiaDraft({
    loadText: () => localStorage.getItem(DRAFT_KEY) ?? localStorage.getItem(LEGACY_DRAFT_KEY) ?? "",
    saveText: (text) => {
        if (text === "") {
            localStorage.removeItem(DRAFT_KEY);
            localStorage.removeItem(LEGACY_DRAFT_KEY);
        } else {
            localStorage.setItem(DRAFT_KEY, text);
            localStorage.removeItem(LEGACY_DRAFT_KEY);
        }
    },
    upload: (id, file) => api(`c/${id}/upload?name=${encodeURIComponent(file.name)}`, file),
    onError: (message) => notify("error", message.replaceAll("Pia", assistantName())),
});
const syncDraftScope = (state) =>
    composerDraft.scope(
        // Before the first hello, a signed-out/unknown bootstrap is not this tab logging out.
        state.me === undefined || (state.me === null && !state.server)
            ? undefined
            : (state.me?.id ?? null),
        state.pia?.id,
    );

syncDraftScope(store.state);
/** How many of Pia's newest rows the panel shows: it is for the moment, and the full conversation is a tap away. */
const ROWS = 80;
/** Below this width the panel is a sheet from the bottom edge; above it, a window in the corner. */
const NARROW = matchMedia("(max-width: 699px)");
const REPORT = "[report] ";
/**
 * What came from outside, as Pia gets it: a post to one of the person's webhooks (`hooks.ts`), or what happened on a
 * repository they watch (`repo-watches.ts`). Which one, then the instructions and what came.
 */
const WEBHOOK = /^\[via webhook ([^\]\n]{1,300})\] /;
const REPO_WATCH = /^\[via watch ([^\]\n]{1,300})\] /;

/**
 * A webhook's post or a watch's news for reading: the person's instructions, and what came as plain text (never
 * Markdown: it is anyone's), without the note to Pia about it.
 */
function post(text) {
    const body = text.replace(
        /\n?What came between <(?:webhook-payload|github-event)> tags[^\n]*$/,
        "",
    );
    const data = /<(webhook-payload|github-event)[^>]*>\n?([\s\S]*?)\n?<\/\1>/.exec(body);

    return data
        ? { text: body.slice(0, data.index).trim(), data: readable(data[2]) }
        : { text: body, data: null };
}

const SCHEDULED = "[scheduled] ";

const INTRO =
    "I keep an eye on your sessions and repositories: ask what’s going on, start new work, have me check back later, or watch a repository and act when something happens.";

/** Things to ask Pia on its first open: sent at once, or (ending in "…") put in the box to finish. */
const SUGGESTIONS = [
    "What needs me?",
    "What happened today?",
    "Start a session to …",
    "Every weekday at 9:00, tell me what changed overnight",
    "When CI fails on main in …",
];

/** The server lets this person have a Pia: the owner, while its extension is on. */
export const piaAvailable = () => store.state.server?.pia === true;

/** The configurable name of the assistant. */
export const assistantName = () => store.state.server?.assistant?.name || "Pia";

let seq = 0;
/** The connection the panel's last "open" went to: a new one (a reconnect) is told again. */
let toldConnection = null;
/** The server's answer to the last "open": Pia's state, with its conversation's id. */
let opening = null;

/** Tell the server whether this tab's panel shows: while it does, the server sends Pia's conversation. */
function tellServer(on) {
    const connection = store.state.streamId;

    if (!connection) {
        return Promise.resolve(null);
    }

    toldConnection = on ? connection : null;
    const asked = api("pip", { connection, on, seq: ++seq }).then(
        (answer) => {
            const state = answer.pia ?? answer.pip ?? null;

            if (state) {
                store.set({ pia: state });
            }

            return state;
        },
        (error) => {
            if (on) {
                closePia();
                notify("error", error.message ?? String(error));
            }

            return null;
        },
    );

    if (on) {
        opening = asked;
    }

    return asked;
}

// A reconnect (or the first connection, with the panel kept open across a reload) gets the panel's view again; Pia
// turned off in Extensions closes the panel.
store.subscribe((state) => {
    syncDraftScope(state);

    if (!state.piaOpen) {
        return;
    }

    if (state.server && !piaAvailable()) {
        closePia();
    } else if (state.streamId && state.streamId !== toldConnection) {
        tellServer(true);
    }
});

// A Pia notification tapped while a window is open: the worker asks that window for the panel (`sw.js`).
navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.type === "pocket.pia" || event.data?.type === "pocket.pip") {
        openPia();
    }
});

/** Pia's answers seen up to now: what the panel last showed, by the server's clock. */
function markSeen() {
    const ended = store.state.pia?.endedAt;

    if (
        ended !== undefined &&
        ended > Number(localStorage.getItem(SEEN_KEY) ?? localStorage.getItem(LEGACY_SEEN_KEY) ?? 0)
    ) {
        localStorage.setItem(SEEN_KEY, String(ended));
    }
}

/** Pia answered since this browser last looked, and is not at work. */
export function piaUnread(state = store.state) {
    const pia = state.pia;

    return Boolean(
        pia &&
        !state.piaOpen &&
        !pia.busy &&
        pia.endedAt !== undefined &&
        pia.endedAt >
            Number(localStorage.getItem(SEEN_KEY) ?? localStorage.getItem(LEGACY_SEEN_KEY) ?? 0),
    );
}

/** Open the panel; with `text`, put it in Pia's message box. */
export function openPia(text) {
    if (!piaAvailable()) {
        return;
    }

    if (text) {
        store.set({ piaDraft: { text, n: (store.state.piaDraft?.n ?? 0) + 1 } });
    }

    if (store.state.piaOpen) {
        focusComposer();

        return;
    }

    sessionStorage.setItem(OPEN_KEY, "1");
    // The subscriber above tells the server, from inside this `set`: once, not twice.
    store.set({ piaOpen: true, launcher: false, drawer: false });
}

export function closePia() {
    if (!store.state.piaOpen) {
        return;
    }

    sessionStorage.removeItem(OPEN_KEY);
    markSeen();
    store.set({ piaOpen: false });
    tellServer(false);
}

export const togglePia = () => (store.state.piaOpen ? closePia() : openPia());

/** Get Pia's conversation id without showing its panel; the server creates it the first time if needed. */
export async function ensurePiaId() {
    if (!piaAvailable()) {
        return null;
    }

    if (store.state.pia?.id !== undefined) {
        return store.state.pia.id;
    }

    const connection = store.state.streamId;

    if (!connection) {
        return null;
    }

    const opened = await api("pip", { connection, on: true, seq: ++seq });

    if (opened.pia) {
        store.set({ pia: opened.pia });
    }

    // This brief server-side view makes the existing Pia API return its id, but does not open the local panel.
    if (!store.state.piaOpen) {
        try {
            const closed = await api("pip", { connection, on: false, seq: ++seq });

            if (closed.pia) {
                store.set({ pia: closed.pia });
            }
        } catch {
            // A disconnect removes the server-side view; the accepted id still lets the inbox retry safely.
        }
    }

    return store.state.pia?.id ?? opened.pia?.id ?? null;
}

/** Put `text` in Pia's box, after what is there, and open the panel. */
function draftPia(text) {
    const draft = localStorage.getItem(DRAFT_KEY)?.trim();

    openPia(draft ? `${draft}\n\n${text}` : text);
}

/** Send Pia a message from anywhere (`/pia …`), and open the panel to show what it says; true when it went. */
export async function askPia(text) {
    if (!piaAvailable()) {
        notify("error", `${assistantName()} is not on here.`);

        return false;
    }

    const account = store.state.me?.id;

    openPia();
    const pia = store.state.pia ?? (await opening);

    if (account !== store.state.me?.id) {
        return false;
    }

    if (!pia) {
        notify("error", `${assistantName()} is not ready yet: your message waits in its box.`);
    }

    // Not sent: the words wait in Pia's box rather than be lost (`send` said why), after what was there already.
    if (pia && (await send(pia.id, text, false))) {
        return true;
    }

    if (account === store.state.me?.id && (!pia || store.state.pia?.id === pia.id)) {
        draftPia(text);
    }

    return false;
}

const piaUnavailable = () => `${assistantName()} is not available`;

/**
 * What `pocket.pia.ask` does for the browser module `source` names: put its text in Pia's box for the person to read,
 * edit, and send; or, with `send` and only just after a tap or a key press, send it as the person's own message. The
 * text starts with where it came from, as an artifact's follow-up does, so it never reads as a command. The answer says
 * why nothing happened, or whether the message went (`sent` is false when it waits in the box).
 */
export async function askPiaFrom(source, text, send) {
    if (!piaAvailable()) {
        return { ok: false, reason: piaUnavailable() };
    }

    const words = followUpText(text.trim(), undefined, source);

    if (!send) {
        draftPia(words);

        return { ok: true, sent: false };
    }

    if (!spendTap()) {
        return { ok: false, reason: "Sending needs a click or a key press just before" };
    }

    return { ok: true, sent: await askPia(words) };
}

/** Send Pia a message; false when it did not go (a notice says why). Pia made just now is waited for. */
async function send(id, text, busy, attachments = []) {
    const account = store.state.me?.id;
    const target = id ?? store.state.pia?.id ?? (await opening)?.id;

    if (account !== store.state.me?.id || (id !== undefined && store.state.pia?.id !== id)) {
        return false;
    }

    if (target === undefined) {
        notify("error", `${assistantName()} is not ready yet. Try again in a moment.`);

        return false;
    }

    const sent = await attempt(() =>
        api(`c/${target}/submit`, {
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
            requestId: uid(),
            // Words for Pia while it works change what it does now, rather than wait for it.
            ...(busy ? { mode: "steer" } : {}),
        }),
    );

    return sent !== undefined;
}

/** Request ordinary session compaction for Pia's conversation. */
function compactPia(id, focus, model) {
    return attempt(() =>
        api(`c/${id}/compact`, {
            ...(focus ? { instructions: focus } : {}),
            ...(model === undefined ? {} : { model }),
        }),
    );
}

/** `/compact`, or `/compact --model provider/modelId [what to keep]`, typed in Pia's box. */
const COMPACT = /^\/compact(?:\s+([\s\S]*))?$/;
const COMPACT_MODEL = /^--model\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+([\s\S]*))?$/i;

/** How full Pia's context window is. */
function PiaContext({ stats, window }) {
    if (!window || stats?.contextTokens === undefined) {
        return null;
    }

    const used = stats.contextTokens;
    const percent = Math.min(100, Math.round((used / window) * 100));
    const about = stats.contextEstimated ? "~" : "";
    const title = `${about}${formatTokens(used)} of ${formatTokens(window)} tokens in ${assistantName()}'s context window.`;

    return html`<span
        class="pia-context"
        role="img"
        aria-label=${`Context ${about}${percent}% full`}
        title=${title}
    >
        <span class=${`meter ${contextLevel(percent)}`}><span style=${`width:${percent}%`}></span></span>
        ${about}${percent}%
    </span>`;
}

function focusComposer() {
    requestAnimationFrame(() => document.querySelector(".pia-composer textarea")?.focus());
}

/** A message in Pia's conversation without the "[from: Name]" a server with several people puts first. */
const written = (text) => text.replace(/^\[from: [^\]\n]{1,60}\] /, "");

/**
 * Pia's words with bare session addresses (`/s/12`, as reports and tool results write them) made links named after
 * their sessions. Links already written stay as they are.
 */
function linkSessions(text) {
    // What sessions said comes fenced for Pia (`pip.ts`); people read it as it is.
    text = text.replace(/\n?<\/?session-output>\n?/g, "\n");
    // `“Title” (/s/12)`, as reports name a session: one link.
    const named = text.replace(/“([^”\n[\]]{1,120})” \(\/s\/(\d+)\)/g, "[$1](/s/$2)");

    return named.replace(/(?<!\]\()(?<![\w/.])\/s\/(\d+)\b(?![\w/])/g, (_, id) => {
        const title = store.state.sessions.find((session) => session.id === Number(id))?.title;
        const label = (title ?? `/s/${id}`).replace(/[[\]]/g, "");

        return `[${label}](/s/${id})`;
    });
}

/** The session a link in Pia's words opens: `/s/12`, written whole or as an address of this app. */
function sessionOf(anchor) {
    const href = anchor.getAttribute("href") ?? "";
    const match = /^(?:https?:\/\/[^/]+)?\/s\/(\d+)\/?$/.exec(href);

    return match && (!/^https?:/.test(href) || new URL(href).origin === location.origin)
        ? Number(match[1])
        : null;
}

// ─── The panel ──────────────────────────────────────────────────────────────

/** A report from a session Pia follows, or a webhook's post (with what came as `data`): folded until opened. */
function Report({ text, label = "Report", data = null, conversationId }) {
    const [open, setOpen] = useState(false);

    return html`<div class=${`pia-report ${open ? "open" : ""}`}>
        <button
            type="button"
            class="pia-report-head"
            aria-expanded=${open}
            onClick=${() => setOpen(!open)}
        >
            <${Icon} name="pulse" size=${13} />
            <span>${label}</span>
            <${Icon} name="down" size=${13} class="pia-report-fold" />
        </button>
        <${Markdown}
            text=${linkSessions(text)}
            class="pia-report-text"
            conversationId=${conversationId}
        />
        ${data !== null && html`<pre class="pia-report-data">${data}</pre>`}
    </div>`;
}

/**
 * A message's list of attached files (`splitAttachments`). Uploaded names can contain commas or parentheses: find the
 * name repeated at the end of its saved path.
 */
function attachedFiles(block) {
    if (block === undefined) {
        return [];
    }

    return block.split("\n").flatMap((line) => {
        const suffix = /^- (.*), ([^,]*), (\d+) bytes\)$/.exec(line);

        if (!suffix) {
            return [];
        }

        const candidates = [...suffix[1].matchAll(/ \(/g)].map((separator) => ({
            path: suffix[1].slice(0, separator.index),
            name: suffix[1].slice(separator.index + 2),
            mime: suffix[2],
        }));
        const file = candidates.find((candidate) => candidate.path.endsWith(candidate.name));

        return file ? [file] : [];
    });
}

/** One of the panel's rows: a message, a report, a group of Pia's calls, or its words. */
function Item({ item, last, busy, conversationId }) {
    if (item.type === "row") {
        const entry = item.entry;

        if (entry.kind === "user") {
            // Reports, posts, and scheduled messages whole: what came from outside may hold anything, an attachment
            // heading too, and is read only as the plain data it is.
            const body = written(entry.text);

            if (body.startsWith(REPORT)) {
                return html`<${Report}
                    text=${body.slice(REPORT.length)}
                    conversationId=${conversationId}
                />`;
            }

            const hook = WEBHOOK.exec(body);
            const watched = hook ? null : REPO_WATCH.exec(body);
            const outside = hook ?? watched;

            if (outside) {
                const posted = post(body.slice(outside[0].length));

                return html`<${Report}
                    label=${`${watched ? "GitHub" : "Webhook"}: ${outside[1]}`}
                    text=${posted.text}
                    data=${posted.data}
                    conversationId=${conversationId}
                />`;
            }

            if (body.startsWith(SCHEDULED)) {
                return html`<div class="pia-event">
                    <${Icon} name="pulse" size=${13} />
                    <span>${body.slice(SCHEDULED.length)}</span>
                </div>`;
            }

            const [text, block] = splitAttachments(body);
            // Uploaded pictures also remain readable when the chosen model cannot take inline images.
            const files = attachedFiles(block);
            const pictures = files.filter((file) => file.mime.startsWith("image/"));
            const others = files.filter((file) => !pictures.includes(file));

            return html`<div class="pia-you">
                ${text && html`<div>${text}</div>`}
                ${
                    others.length > 0 &&
                    html`<div class="attachments">
                        ${others.map((file) => html`<span class="chip">📎 ${file.name}</span>`)}
                    </div>`
                }
                ${
                    (pictures.length > 0 || entry.images > 0) &&
                    html`<div class="thumbs">
                        ${
                            pictures.length > 0
                                ? pictures.map(
                                      (picture) => html`<${Thumb}
                                          src=${fileUrl(picture.path, conversationId)}
                                          alt=${picture.name}
                                      />`,
                                  )
                                : Array.from(
                                      { length: entry.images },
                                      (_, index) => html`<${Thumb}
                                          src=${entryImageUrl(entry.id, index, conversationId)}
                                          alt=${`Image ${index + 1}`}
                                      />`,
                                  )
                        }
                    </div>`
                }
            </div>`;
        }

        const line =
            entry.kind === "reset"
                ? "Fresh start"
                : entry.kind === "compaction"
                  ? "Earlier messages summarized"
                  : entry.kind === "note"
                    ? `${entry.name} ${entry.text}`
                    : null;

        return line && html`<div class="pia-event"><span>${line}</span></div>`;
    }

    // A page it showed in a reply (`artifact_inline`): in this panel, a line like its other work.
    if (item.type === "inline") {
        return html`<div class="pia-steps">
            <span class="pia-tick"><${Icon} name="check" size=${10} /></span>
            <span>${summarize([item.step], false)}</span>
        </div>`;
    }

    if (item.type === "activity") {
        const thinking =
            item.steps.at(-1)?.streaming && item.steps.at(-1).block.type === "thinking";
        const working = busy && last;

        return html`<div class=${`pia-steps ${working ? "working" : ""}`}>
            ${working ? html`<${Spinner} hidden=${true} />` : html`<span class="pia-tick"><${Icon} name="check" size=${10} /></span>`}
            <span>${summarize(item.steps, thinking)}</span>
        </div>`;
    }

    if (item.type === "reply") {
        const text = item.blocks.map((each) => each.block.text).join("\n\n");
        const growing = item.blocks.some((each) => each.growing);
        const entry = item.entry;

        return html`<div class="pia-reply">
            ${
                text.trim() !== "" &&
                html`<${Markdown}
                    text=${linkSessions(text)}
                    cache=${!growing}
                    conversationId=${conversationId}
                />`
            }
            ${entry?.stopReason === "aborted" && html`<div class="pia-event"><span>Stopped</span></div>`}
            ${
                entry?.stopReason === "error" &&
                html`<div class="pia-error">${entry.error ?? "The model request failed."}</div>`
            }
        </div>`;
    }

    return null;
}

function Welcome({ id, name, hasModel }) {
    const first = (name ?? "").split(/\s+/)[0];

    return html`<div class="pia-welcome">
        <p class="pia-hello">Hi${first ? ` ${first}` : ""}. I’m ${assistantName()}.</p>
        <p class="pia-intro">${INTRO}</p>
        ${
            !hasModel &&
            html`<p class="pia-intro">
                <button
                    type="button"
                    class="button small"
                    onClick=${() => openSheet({ type: "model", piaId: id })}
                >
                    Choose a model to use these suggestions
                </button>
            </p>`
        }
        <div class="pia-chips">
            ${SUGGESTIONS.map(
                (suggestion) => html`<button
                    type="button"
                    class="pia-chip"
                    key=${suggestion}
                    disabled=${!hasModel && !suggestion.endsWith("…")}
                    onClick=${() =>
                        suggestion.endsWith("…")
                            ? openPia(suggestion.slice(0, -1))
                            : send(id, suggestion, false)}
                >
                    ${suggestion}
                </button>`,
            )}
        </div>
    </div>`;
}

function Composer({ id, busy }) {
    const [saved, setSaved] = useState(() => {
        composerDraft.syncText();

        return composerDraft.state;
    });
    const { text, files, pending } = saved;
    const ref = useRef(null);
    const picker = useRef(null);
    const draft = store.state.piaDraft;
    const change = composerDraft.changeText;
    const uploading = files.some((file) => file.state === "uploading");
    const hasMessage = text.trim() !== "" || files.length > 0;
    const sendDisabled =
        !hasMessage || (uploading && !COMPACT.test(text.trim())) || Boolean(pending);

    useLayoutEffect(() => {
        const unsubscribe = composerDraft.subscribe(setSaved);

        setSaved(composerDraft.state);

        return unsubscribe;
    }, []);

    const fit = () => {
        const box = ref.current;

        if (box) {
            box.style.height = "auto";
            box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
        }
    };

    // Pia's box takes Alt+V while it shows, over the session's.
    const dictation = useDictation(ref, change, { top: true });

    useLayoutEffect(fit, [text]);
    // A phone's keyboard would cover the panel as it opens: there, the box waits for a tap. Elsewhere it takes the focus
    // as it mounts, in the same task as the key that opened it, so the next keys land here.
    useLayoutEffect(() => {
        if (!NARROW.matches) {
            ref.current?.focus({ preventScroll: true });
        }
    }, []);
    useEffect(() => {
        if (draft) {
            change(draft.text);
            ref.current?.focus();
            // Used: opened again later, the box keeps what was typed since.
            store.set({ piaDraft: null });
        }
    }, [draft?.n]);

    const submit = async (event) => {
        event?.preventDefault();
        // Read the durable-in-this-tab draft, not a render's text or an old panel's queue.
        const message = composerDraft.state.text.trim();
        const compact = COMPACT.exec(message);

        if (message === "" && composerDraft.state.files.length === 0) {
            return;
        }

        if (compact && id === undefined) {
            notify("error", `${assistantName()} is not ready yet. Try again in a moment.`);

            return;
        }

        const compactArgs = compact?.[1]?.trim() ?? "";
        const compactModel = COMPACT_MODEL.exec(compactArgs);
        const compactSpec = compactModel?.[1] ?? compactModel?.[2] ?? compactModel?.[3];
        const compactFocus = compactModel ? compactModel[4]?.trim() : compactArgs;
        const token = composerDraft.begin(Boolean(compact));

        if (!token) {
            return;
        }

        // What shows is what goes: words still coming would land in the emptied box.
        dictation.stop(true);
        let success = false;

        try {
            // Compact never sends or removes the attachments waiting in the box.
            success = compact
                ? (await compactPia(id, compactFocus || undefined, compactSpec)) !== undefined
                : await send(
                      id,
                      message,
                      busy,
                      token.files.map((file) => file.attachment),
                  );
        } finally {
            composerDraft.finish(token, success);
        }
    };

    const onPaste = (event) => {
        const pasted = [...(event.clipboardData?.files ?? [])];

        if (pasted.length === 0) {
            return; // Normal text paste retains the browser's caret/selection behavior.
        }

        event.preventDefault();
        composerDraft.addFiles(pasted);
        const words = event.clipboardData?.getData("text/plain") ?? "";
        const box = event.currentTarget;

        if (words) {
            const at = box.selectionStart;
            const end = box.selectionEnd;
            const current = composerDraft.state.text;

            change(`${current.slice(0, at)}${words}${current.slice(end)}`);
            requestAnimationFrame(() =>
                box.setSelectionRange(at + words.length, at + words.length),
            );
        }
    };

    return html`<div
        class="pia-composer-wrap"
        onDragOver=${(event) => {
            if ([...(event.dataTransfer?.types ?? [])].includes("Files")) {
                event.preventDefault();
            }
        }}
        onDrop=${(event) => {
            const dropped = [...(event.dataTransfer?.files ?? [])];

            if (dropped.length > 0) {
                event.preventDefault();
                composerDraft.addFiles(dropped);
            }
        }}
    >
        ${
            files.length > 0 &&
            html`<div class="pia-attachments" aria-label=${`Files attached to ${assistantName()}`}>
                ${files.map(
                    (file) => html`<div class="pia-attachment" key=${file.key}>
                        ${file.preview && html`<${Thumb} src=${file.preview} alt=${file.name} />`}
                        <span class="pia-attachment-name">${file.name}</span>
                        <span class="muted">${formatBytes(file.size)}</span>
                        ${
                            file.state === "uploading" &&
                            html`<${Spinner} label=${`Uploading ${file.name}`} />`
                        }
                        <button
                            type="button"
                            class="icon-button pia-attachment-remove"
                            aria-label=${`Remove ${file.name}`}
                            onClick=${() => composerDraft.removeFile(file.key)}
                        >
                            <${Icon} name="close" size=${14} />
                        </button>
                    </div>`,
                )}
            </div>`
        }
        <form class="pia-composer" onSubmit=${submit}>
            <input
                class="pia-file-picker"
                ref=${picker}
                type="file"
                multiple
                hidden
                disabled=${id === undefined}
                onChange=${(event) => {
                    composerDraft.addFiles([...(event.currentTarget.files ?? [])]);
                    event.currentTarget.value = "";
                }}
            />
            <button
                type="button"
                class="icon-button pia-attach"
                aria-label=${`Attach files to ${assistantName()}`}
                title="Attach files. Images need an image-capable model to be read inline."
                disabled=${id === undefined}
                onClick=${() => picker.current?.click()}
            >
                <${Icon} name="clip" size=${18} />
            </button>
            <textarea
                ref=${ref}
                rows="1"
                value=${text}
                placeholder=${dictation.listening ? "Listening…" : busy ? `Tell ${assistantName()} more…` : `Ask ${assistantName()}…`}
                aria-label=${`Message to ${assistantName()}`}
                enterkeyhint="send"
                onInput=${(event) => change(event.currentTarget.value)}
                onPaste=${onPaste}
                onKeyDown=${(event) => {
                    // A module's key (`pocket.composerKey`) comes first, as in the session's box.
                    const keyed = keyBox(event.currentTarget, "pia", (value, start, end) => {
                        change(value);
                        requestAnimationFrame(() => ref.current?.setSelectionRange(start, end));
                    });

                    if (boxKey(event, keyed)) {
                        event.preventDefault();

                        return;
                    }

                    if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.isComposing &&
                        event.keyCode !== 229
                    ) {
                        submit(event);
                    }
                }}
            ></textarea>
            <${MicButton} dictation=${dictation} class="pia-mic" size=${18} />
            ${
                busy && !hasMessage && !pending
                    ? html`<button
                          type="button"
                          class="icon-button pia-send"
                          aria-label=${`Stop ${assistantName()}`}
                          title="Stop"
                          onClick=${() => attempt(() => api(`c/${id}/abort`, {}))}
                      >
                          <${Icon} name="stop" size=${18} />
                      </button>`
                    : html`<button
                          type="submit"
                          class="icon-button pia-send"
                          aria-label=${`Send to ${assistantName()}`}
                          disabled=${sendDisabled}
                      >
                          <${Icon} name="send" size=${18} />
                      </button>`
            }
        </form>
    </div>`;
}

/** The owner's private review queue, not just the memories that apply in the conversation behind Pia. */
function PendingMemories({ id }) {
    const data = useMemory(id, true);
    const count = data?.pendingAll === true ? data.lessons.length : null;
    const hint = data?.restartRequired
        ? "Restart required"
        : count === null
          ? "Loading…"
          : `${count} pending`;

    return html`<div class="pia-memory">
        <button
            type="button"
            class="button small ghost"
            aria-label="Pending memories"
            aria-describedby="pia-memory-count"
            onClick=${() => {
                closePia();
                openSheet({ type: "memory", conversationId: id, pendingOnly: true });
            }}
        >
            <span>Pending memories</span>
            <span
                id="pia-memory-count"
                class=${`pia-memory-count ${count > 0 ? "waiting" : ""}`}
                aria-live="polite"
                aria-atomic="true"
            >
                ${hint}
            </span>
        </button>
    </div>`;
}

/** When Pia takes a message that waits: a steer at its next pause, a queued one when it finishes its work. */
const pendingWhen = (item, busy) =>
    !busy
        ? `Waiting for ${assistantName()}`
        : item.mode === "steer"
          ? `${assistantName()} reads this at its next pause`
          : `${assistantName()} reads this when it finishes`;

/** Who sent a message, as the server writes it at the start when several people use the agent (`FROM_PREFIX`). */
const FROM = /^\[from: [^\]\n]{1,60}\] /;

function PiaPanel({ leaving, scrim }) {
    const { pia, piaView: view, me } = store.state;
    const ref = useRef(null);
    const body = useRef(null);
    const pinned = useRef(true);
    const id = pia?.id;
    const ready = id !== undefined && view.conversation?.id === id;
    const live = ready ? view.live : { busy: false };
    const rows = ready
        ? view.order
              .map((entryId) => view.entries.get(entryId))
              .filter((entry) => entry && isRow(entry))
              .slice(-ROWS)
        : [];
    // Your messages that wait while Pia works: shown at once, as waiting, until Pia takes them.
    const pending = ready
        ? (view.inbox ?? []).filter(
              (item) => item.by === me?.id && (item.mode === "steer" || item.mode === "followUp"),
          )
        : [];
    const blocks = live.generation?.message?.blocks ?? [];
    const items = itemsOf(rows, blocks.length > 0 ? { kind: "assistant", blocks } : null);
    const speaking = blocks.some(says);
    const busy = live.busy === true;
    const model = modelLabel(view.agent);
    const thinking = view.agent?.thinkingLevel === "off" ? "" : (view.agent?.thinkingLevel ?? "");
    // Calls of Pia's held for approval: the panel cannot answer them, so it says so and leads to where they can be.
    const waiting = ready ? (view.approvals ?? []) : [];
    const compacting = ready && (live.compactions ?? []).length > 0;
    const status =
        waiting.length > 0 ? "needs you" : compacting ? "compacting…" : busy ? "working…" : "";
    // Where the focus was before the panel: read as it first renders, before its box takes the focus.
    const [before] = useState(() => document.activeElement);

    usePiaResize(ref, me?.id);
    useDragToClose(ref, { dir: "down", onClose: closePia, enabled: NARROW.matches, scrim });
    // Focus goes back where it was when the panel closes.
    useEffect(() => {
        const panel = ref.current;

        return () => {
            const active = document.activeElement;

            if (
                before instanceof HTMLElement &&
                before.isConnected &&
                (active === document.body || panel?.contains(active))
            ) {
                before.focus({ preventScroll: true });
            }
        };
    }, []);
    // What shows now counts as seen.
    useEffect(markSeen, [pia?.endedAt]);
    // Stay at the newest words while they come, unless someone scrolled up to read.
    useLayoutEffect(() => {
        const box = body.current;

        if (box && pinned.current) {
            box.scrollTop = box.scrollHeight;
        }
    });

    const openLink = (event) => {
        const anchor = event.target.closest?.("a[href]");
        const session = anchor ? sessionOf(anchor) : null;

        if (session === null) {
            return;
        }

        event.preventDefault();
        navigate(session);

        // On a phone the session is behind the panel: it steps aside.
        if (NARROW.matches) {
            closePia();
        }
    };

    return html`<section
        class=${`pia-panel ${leaving ? "leaving" : ""}`}
        data-part="pia"
        data-state=${leaving ? "closing" : undefined}
        ref=${ref}
        role="dialog"
        aria-modal=${NARROW.matches ? "true" : undefined}
        aria-label=${`${assistantName()}, your assistant`}
    >
        <div class="pia-resize pia-resize-left" data-pia-resize="left" aria-hidden="true"></div>
        <div class="pia-resize pia-resize-top" data-pia-resize="top" aria-hidden="true"></div>
        <div class="pia-resize pia-resize-corner" data-pia-resize="corner" aria-hidden="true"></div>
        <header class="pia-head">
            <div class="grip"></div>
            <span class=${`pia-mark ${busy ? "working" : ""}`} aria-hidden="true">
                <${Icon} name="pia" size=${18} />
            </span>
            <div class="pia-heading">
                <div class="pia-title-line">
                    <h2>${assistantName()}</h2>
                    <span class="pia-status" aria-live="polite">${status}</span>
                </div>
                <button
                    class="model-chip pia-model"
                    disabled=${!ready || busy || compacting}
                    aria-label=${`${assistantName()} model: ${model}${thinking ? ` · ${thinking}` : ""}`}
                    title=${`Change ${assistantName()}'s model and thinking level`}
                    onClick=${() => openSheet({ type: "model", piaId: id })}
                >
                    <span class="model-name">
                        ${model.replace(/^(?:anthropic:\s*)?claude\s+/i, "")}
                    </span>
                    ${thinking && html`<span class="model-level">${thinking}</span>`}
                </button>
            </div>
            ${
                ready &&
                html`<${PiaContext} stats=${view.stats} window=${view.agent?.contextWindow} />`
            }
            <button
                class="icon-button"
                aria-label="Compact"
                title=${`Compact: ${assistantName()} keeps a summary of older messages, and reads less each time`}
                disabled=${!ready || busy || compacting || rows.length === 0}
                onClick=${() => openSheet({ type: "compact", piaId: id })}
            >
                <${Icon} name="compact" size=${18} />
            </button>
            <button
                class="icon-button"
                aria-label="Start fresh"
                title=${`Start fresh: ${assistantName()} forgets this conversation`}
                disabled=${!ready || busy || rows.length === 0}
                onClick=${() =>
                    confirm(
                        `Start fresh? ${assistantName()} forgets this conversation; you can still read it.`,
                    ) && attempt(() => api(`c/${id}/reset`, {}))}
            >
                <${Icon} name="reload" size=${18} />
            </button>
            <button
                class="icon-button"
                aria-label="Open as a conversation"
                title="Open as a conversation, with every step"
                disabled=${!ready}
                onClick=${() => {
                    closePia();
                    navigate(id);
                }}
            >
                <${Icon} name="external" size=${18} />
            </button>
            <button class="icon-button" aria-label=${`Close ${assistantName()}`} title="Close (Esc)" onClick=${closePia}>
                <${Icon} name="close" size=${18} />
            </button>
        </header>
        <div
            class="pia-body"
            ref=${body}
            onClick=${openLink}
            onScroll=${(event) => {
                const box = event.currentTarget;

                pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
            }}
        >
            ${
                !ready
                    ? html`<div class="pia-loading"><${Spinner} label=${`Waking ${assistantName()}`} /></div>`
                    : rows.length === 0 && !busy
                      ? html`<${Welcome}
                            id=${id}
                            name=${me?.name}
                            hasModel=${Boolean(view.agent?.model)}
                        />`
                      : items.map(
                            (item, index) =>
                                html`<${Item}
                                    key=${item.key}
                                    item=${item}
                                    last=${index === items.length - 1}
                                    busy=${busy}
                                    conversationId=${id}
                                />`,
                        )
            }
            ${
                ready &&
                busy &&
                !speaking &&
                items.at(-1)?.type !== "activity" &&
                html`<div class="pia-steps working">
                    <${Spinner} hidden=${true} />
                    <span>Thinking</span>
                </div>`
            }
            ${pending.map(
                (item) => html`<div class="pia-you pending" key=${`pending-${item.id}`}>
                    <div>${(item.text ?? "").replace(FROM, "")}</div>
                    <div class="pia-pending-line">
                        <span>${pendingWhen(item, busy)}</span>
                        <button
                            type="button"
                            class="pia-pending-withdraw"
                            onClick=${() =>
                                attempt(() => api(`c/${id}/withdraw`, { submissionId: item.id }))}
                        >
                            Withdraw
                        </button>
                    </div>
                </div>`,
            )}
        </div>
        ${
            waiting.length > 0 &&
            html`<div class="pia-approval" role="status">
                <${Icon} name="shield" size=${14} />
                <span class="grow">${assistantName()} waits for your approval: ${waiting[0].tool}</span>
                <button
                    type="button"
                    class="button small"
                    onClick=${() => {
                        closePia();
                        navigate(id);
                    }}
                >
                    Review
                </button>
            </div>`
        }
        ${
            ready &&
            me?.role === "owner" &&
            memoryAvailable(id) &&
            html`<${PendingMemories} id=${id} />`
        }
        <${Composer} id=${id} busy=${busy} />
    </section>`;
}

/** The mark in the corner: only while Pia works, or has something new. */
function PiaBubble() {
    const { pia } = store.state;
    const unread = piaUnread();
    const [kept, leaving] = usePresence(
        pia && (pia.busy || unread) ? (pia.busy ? "busy" : "news") : null,
        150,
    );

    if (kept === null) {
        return null;
    }

    return html`<button
        class=${`pia-bubble ${kept} ${leaving ? "leaving" : ""}`}
        aria-label=${
            kept === "busy"
                ? `${assistantName()} is working: open ${assistantName()}`
                : `${assistantName()} has something new: open ${assistantName()}`
        }
        title=${`${assistantName()} (Alt+A)`}
        onClick=${() => openPia()}
    >
        <${Icon} name="pia" size=${22} />
        ${kept === "news" && html`<span class="pia-dot" aria-hidden="true"></span>`}
    </button>`;
}

/** Pia's panel while it is open (kept a moment after, to animate out), or its mark while it is not. */
export function PiaHost() {
    const open = store.state.piaOpen && piaAvailable();
    const [kept, leaving] = usePresence(open || null, 180);
    // What a drag on the sheet dims as it goes: the scrim, not the app behind it.
    const scrim = useRef(null);

    // Back closes it, as it closes a sheet.
    useBack(Boolean(open), closePia);

    if (!piaAvailable()) {
        return null;
    }

    if (!kept) {
        return html`<${PiaBubble} />`;
    }

    // On phones a scrim dims what is behind the sheet, and a tap on it closes it; wide screens have none.
    return html`<div
            class=${`pia-scrim ${leaving ? "leaving" : ""}`}
            ref=${scrim}
            aria-hidden="true"
            onClick=${closePia}
        ></div>
        <${PiaPanel} leaving=${leaving} scrim=${scrim} />`;
}

/** Pia in the rail: the way to it that is always there, marked while it works or has something new. */
export function PiaRailButton() {
    if (!piaAvailable()) {
        return null;
    }

    const { pia, piaOpen } = store.state;
    const unread = piaUnread();

    return html`<button
        class=${`rail-button rail-pia ${pia?.busy ? "lit" : ""} ${piaOpen ? "open" : ""}`}
        data-part="rail-button"
        data-state=${railState(piaOpen, Boolean(pia?.busy))}
        title=${`${assistantName()}, your assistant (Alt+A)`}
        aria-label=${[assistantName(), pia?.busy && "working", unread && "something new"].filter(Boolean).join(", ")}
        aria-pressed=${piaOpen}
        onClick=${togglePia}
    >
        <${Icon} name="pia" size=${18} />
        ${unread && html`<span class="rail-news" aria-hidden="true"></span>`}
    </button>`;
}
