// The owner's left-rail inbox captures notes and retries them against PiP's normal submit route.
import { useBack } from "./back.js";
import { assistantName, ensurePipId, pipAvailable } from "./pip.js";
import { api, notify, store, uid } from "./store.js";
import { createQuickNotes, MAX_NOTE_LENGTH } from "./quick-notes.js";
import { html, Icon, railState } from "./ui.js";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

const KEY = "pocket.quick-notes.";
let activeAccount;
let activeInbox;

/** Get this owner's inbox, kept separate from any other browser sign-in. */
function inboxFor(account) {
    if (activeAccount !== account) {
        activeAccount = account;
        activeInbox = createQuickNotes({
            storage: localStorage,
            key: `${KEY}${account}`,
            makeId: uid,
            send: async (note) => {
                if (
                    store.state.me?.id !== account ||
                    store.state.me?.role !== "owner" ||
                    store.state.connection !== "open" ||
                    globalThis.navigator?.onLine === false
                ) {
                    throw new Error("Pi Pocket is not connected.");
                }

                const id = await ensurePipId();

                if (id === null || store.state.me?.id !== account) {
                    throw new Error("Pia is not ready.");
                }

                return api(`c/${id}/submit`, { text: note.text, requestId: note.id });
            },
        });
    }

    return activeInbox;
}

/** The sidebar capture button and its compact list of cached and delivered notes. */
function QuickNotes({ account }) {
    const inbox = inboxFor(account);
    const [notes, setNotes] = useState(inbox.notes);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState("");
    const input = useRef(null);
    const button = useRef(null);
    const [panelStyle, setPanelStyle] = useState(null);
    const cached = notes.filter((note) => note.state === "cached").length;

    useBack(open, () => setOpen(false));

    useEffect(() => {
        setNotes(inbox.notes);
        const unsubscribe = inbox.subscribe(setNotes);

        const retry = () => {
            if (globalThis.navigator?.onLine !== false) {
                void inbox.flush();
            }
        };

        const onStorage = (event) => {
            if (event.key === `${KEY}${account}` || event.key === null) {
                inbox.refresh();
            }
        };

        let connection = store.state.connection;
        let stream = store.state.streamId;
        const unsubscribeStore = store.subscribe((state) => {
            if (
                state.connection === "open" &&
                (connection !== "open" || stream !== state.streamId)
            ) {
                retry();
            }

            connection = state.connection;
            stream = state.streamId;
        });
        const interval = setInterval(retry, 15000);

        addEventListener("online", retry);
        addEventListener("storage", onStorage);
        document.addEventListener("visibilitychange", retry);
        retry();

        return () => {
            unsubscribe();
            unsubscribeStore();
            clearInterval(interval);
            removeEventListener("online", retry);
            removeEventListener("storage", onStorage);
            document.removeEventListener("visibilitychange", retry);
        };
    }, [account, inbox]);

    useLayoutEffect(() => {
        if (!open) {
            setPanelStyle(null);

            return undefined;
        }

        const place = () => {
            const rect = button.current?.getBoundingClientRect();

            if (!rect) {
                return;
            }

            const width = Math.max(0, Math.min(340, innerWidth - rect.right - 16));
            const height = Math.min(480, innerHeight - 16);
            const left = Math.max(8, Math.min(rect.right + 8, innerWidth - width - 8));
            const top = Math.max(
                8,
                Math.min(rect.top + rect.height / 2 - height / 2, innerHeight - height - 8),
            );

            setPanelStyle(`left:${left}px;top:${top}px;width:${width}px;max-height:${height}px`);
        };

        const rail = button.current?.closest(".rail");

        place();
        rail?.addEventListener("scroll", place);
        addEventListener("resize", place);

        return () => {
            rail?.removeEventListener("scroll", place);
            removeEventListener("resize", place);
        };
    }, [open]);

    useEffect(() => {
        if (open) {
            input.current?.focus({ preventScroll: true });
        }
    }, [open]);

    const submit = (event) => {
        event.preventDefault();

        try {
            inbox.add(draft);
            setDraft("");
            void inbox.flush();
        } catch (error) {
            notify("error", error.message ?? String(error));
        }
    };

    const recent = notes.slice().reverse();

    return html`<div class="quick-notes" data-part="quick-notes">
        ${
            open &&
            html`<section
                class="quick-notes-panel"
                style=${panelStyle}
                aria-label="Quick note inbox"
            >
                <header class="quick-notes-head">
                    <strong>Quick notes</strong>
                    ${cached > 0 && html`<span class="quick-notes-count">${cached} cached</span>`}
                    <button
                        class="icon-button"
                        type="button"
                        aria-label="Close quick notes"
                        onClick=${() => setOpen(false)}
                    >
                        <${Icon} name="close" size=${16} />
                    </button>
                </header>
                <form class="quick-notes-form" onSubmit=${submit}>
                    <textarea
                        ref=${input}
                        rows="2"
                        maxLength=${MAX_NOTE_LENGTH}
                        value=${draft}
                        placeholder=${`Write a note for ${assistantName()}…`}
                        aria-label=${`Note for ${assistantName()}`}
                        onInput=${(event) => setDraft(event.currentTarget.value)}
                        onKeyDown=${(event) => {
                            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                                event.preventDefault();
                                submit(event);
                            }
                        }}
                    ></textarea>
                    <button class="button small primary quick-notes-send" type="submit" disabled=${!draft.trim()}>
                        <${Icon} name="send" size=${14} />
                        <span>Save note</span>
                    </button>
                </form>
                <ol class="quick-notes-list">
                    ${
                        recent.length === 0
                            ? html`<li class="quick-notes-empty">Your notes will appear here.</li>`
                            : recent.map(
                                  (note) => html`<li class="quick-note" key=${note.id}>
                                      <span class="quick-note-text">${note.text}</span>
                                      <span class=${`quick-note-state ${note.state}`}>${note.state}</span>
                                  </li>`,
                              )
                    }
                </ol>
            </section>`
        }
        <button
            ref=${button}
            class=${`rail-button quick-notes-button ${open ? "open" : ""}`}
            data-part="rail-button"
            data-state=${railState(open)}
            type="button"
            aria-label=${`Quick notes${cached > 0 ? `, ${cached} cached` : ""}`}
            aria-expanded=${open}
            title=${`Quick notes${cached > 0 ? `, ${cached} cached` : ""}`}
            onClick=${() => setOpen(!open)}
        >
            <${Icon} name="file" size=${19} />
            ${cached > 0 && html`<span class="rail-count">${cached > 9 ? "9+" : cached}</span>`}
        </button>
    </div>`;
}

/** Show local notes only after this tab confirms the signed-in owner and PiP feature. */
export function QuickNotesButton() {
    const { me } = store.state;

    if (me?.role !== "owner" || !pipAvailable()) {
        return null;
    }

    return html`<${QuickNotes} key=${me.id} account=${me.id} />`;
}
