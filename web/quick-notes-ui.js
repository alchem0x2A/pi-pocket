// The owner's compact idea inbox. Capture and reconnection synchronize data, never chat messages.
import { useBack } from "./back.js";
import { drafts, navigate, notify, store } from "./store.js";
import { accountGeneration, inboxFor, revalidating } from "./inbox-sync.js";
import { MAX_NOTE_LENGTH, readInboxAccount } from "./quick-notes.js";
import { html, Icon, railState } from "./ui.js";
import { MicButton, useDictation } from "./voice.js";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

const statusLabel = (note) =>
    note.state === "archived"
        ? "Archived"
        : note.state === "local"
          ? "Saved locally"
          : "Synced to inbox";

function QuickNotes({ account, inbox }) {
    const [notes, setNotes] = useState(inbox.notes);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState("");
    const [syncStatus, setSyncStatus] = useState(inbox.syncStatus);
    const [selected, setSelected] = useState(null);
    const [working, setWorking] = useState(false);
    const input = useRef(null);
    const button = useRef(null);
    const saving = useRef(false);
    const draftVersion = useRef(0);
    const draftRef = useRef("");
    const dictation = useDictation(input, (value, caret) => {
        if (value.length > MAX_NOTE_LENGTH) {
            // Do not cut off existing text when speech arrives before it in a full draft.
            dictation.stop(true);

            if (input.current) {
                input.current.value = draftRef.current;
                const at = Math.min(caret, draftRef.current.length);

                input.current.setSelectionRange(at, at);
            }

            notify(
                "error",
                `A note can contain at most ${MAX_NOTE_LENGTH} characters. Dictation stopped; your draft is unchanged.`,
            );

            return;
        }

        draftVersion.current++;
        draftRef.current = value;
        setDraft(value);
    });
    const [panelStyle, setPanelStyle] = useState(null);
    const pending = notes.filter((note) => note.state !== "archived").length;
    const local = notes.filter((note) => note.pendingSync || note.state === "local").length;
    const syncProblem = local > 0 || syncStatus.error !== null;

    useBack(open, () => setOpen(false));

    useEffect(() => {
        const generation = accountGeneration;
        const unsubscribe = inbox.subscribe((updated, status) => {
            if (
                !revalidating &&
                generation === accountGeneration &&
                store.state.me?.id === account &&
                store.state.me?.role === "owner" &&
                readInboxAccount(localStorage)?.id === account
            ) {
                setNotes(updated);
                setSyncStatus(status);
            }
        });

        return unsubscribe;
    }, [account, inbox]);

    useEffect(() => {
        let conversation = store.state.conversationId;

        return store.subscribe((state) => {
            if (state.conversationId !== conversation) {
                conversation = state.conversationId;
                dictation.stop(true);
                setOpen(false);
            }
        });
    }, []);

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

            const width = Math.max(0, Math.min(360, innerWidth - 16));
            const height = Math.min(520, innerHeight - 16);
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
        } else {
            dictation.stop(true);
        }
    }, [open]);

    const submit = async (event) => {
        event.preventDefault();

        if (saving.current) {
            return;
        }

        dictation.stop(true);
        saving.current = true;
        const value = input.current?.value.slice(0, MAX_NOTE_LENGTH) ?? draft;
        const version = draftVersion.current;
        const generation = accountGeneration;

        try {
            if (
                revalidating ||
                store.state.me?.id !== account ||
                store.state.me?.role !== "owner" ||
                readInboxAccount(localStorage)?.id !== account
            ) {
                throw new Error("Confirm your account before saving a note.");
            }

            await inbox.add(value);

            if (
                generation !== accountGeneration ||
                store.state.me?.id !== account ||
                store.state.me?.role !== "owner" ||
                readInboxAccount(localStorage)?.id !== account
            ) {
                return;
            }

            if (draftVersion.current === version) {
                draftRef.current = "";
                setDraft("");
            }

            void inbox.flush();
        } catch (error) {
            notify("error", error.message ?? String(error));
        } finally {
            saving.current = false;
        }
    };

    const continueNote = async (note) => {
        const generation = accountGeneration;

        setWorking(true);

        try {
            if (
                revalidating ||
                store.state.me?.id !== account ||
                store.state.me?.role !== "owner" ||
                readInboxAccount(localStorage)?.id !== account
            ) {
                throw new Error("Confirm your account before changing a note.");
            }

            const result = await inbox.continueNote(note.id);

            if (
                generation !== accountGeneration ||
                store.state.me?.id !== account ||
                readInboxAccount(localStorage)?.id !== account
            ) {
                return;
            }

            // The new conversation starts with a draft, not an automatic agent request.
            if (!drafts.get(result.conversationId)) {
                drafts.set(result.conversationId, result.note.text);
            }

            setOpen(false);
            navigate(result.conversationId);
            setSelected(null);
        } catch (error) {
            notify("error", error.message ?? String(error));
        } finally {
            setWorking(false);
        }
    };

    const recent = notes
        .filter((note) => note.state !== "archived")
        .sort((a, b) => b.createdAt - a.createdAt);

    return html`<div class="quick-notes" data-part="quick-notes">
        ${
            open &&
            html`<section class="quick-notes-panel" style=${panelStyle} aria-label="Quick note inbox">
            <header class="quick-notes-head">
                <strong>Quick notes</strong>
                <span class="quick-notes-count">${pending} pending</span>
                <button class="icon-button" type="button" aria-label="Close quick notes" onClick=${() => setOpen(false)}>
                    <${Icon} name="close" size=${16} />
                </button>
            </header>
            <form class="quick-notes-form" onSubmit=${submit}>
                <textarea
                    ref=${input}
                    rows="2"
                    maxLength=${MAX_NOTE_LENGTH}
                    value=${draft}
                    placeholder=${dictation.listening ? "Listening…" : "Capture an idea…"}
                    aria-label="Quick note"
                    onInput=${(event) => {
                        draftVersion.current++;
                        draftRef.current = event.currentTarget.value;
                        setDraft(event.currentTarget.value);
                    }}
                    onKeyDown=${(event) => {
                        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                            event.preventDefault();
                            submit(event);
                        }
                    }}
                ></textarea>
                <div class="quick-notes-capture-actions">
                    <${MicButton} dictation=${dictation} class="quick-notes-mic" size=${17} />
                    <button class="button small primary quick-notes-send" type="submit" disabled=${!draft.trim()}>
                        Save note
                    </button>
                </div>
            </form>
            ${
                syncProblem &&
                html`<div class="quick-notes-sync" role="status" aria-live="polite">
                <div class="quick-notes-sync-status">${
                    local > 0
                        ? `${local} note${local === 1 ? "" : "s"} on this device — not synced yet`
                        : "Inbox sync unavailable"
                }</div>
                ${syncStatus.error && html`<small class="quick-notes-sync-detail">Last failure: ${syncStatus.error}</small>`}
            </div>`
            }
            <ol class="quick-notes-list">
                ${
                    recent.length === 0
                        ? html`<li class="quick-notes-empty">No pending notes.</li>`
                        : recent.map(
                              (note) => html`<li class="quick-note" key=${note.id}>
                        <button
                            class="quick-note-select"
                            type="button"
                            aria-expanded=${selected === note.id}
                            onClick=${() => setSelected(selected === note.id ? null : note.id)}
                        >
                            <span class="quick-note-text">${note.text}</span>
                            <span class=${`quick-note-state ${note.state}`}>${statusLabel(note)}</span>
                        </button>
                        ${
                            selected === note.id &&
                            html`<div class="quick-note-actions">
                            <button
                                class="button small ghost"
                                type="button"
                                disabled=${working}
                                onClick=${() => continueNote(note)}
                            >Continue in conversation</button>
                        </div>`
                        }
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
            aria-label=${`Quick notes${pending > 0 ? `, ${pending} pending` : ""}`}
            aria-expanded=${open}
            title="Quick notes"
            onClick=${() => setOpen(!open)}
        >
            <${Icon} name="file" size=${19} />
            ${pending > 0 && html`<span class="rail-count">${pending > 9 ? "9+" : pending}</span>`}
        </button>
    </div>`;
}

/** The inbox is independent of Pia chat and remains available when the helper is disabled. */
export function QuickNotesButton() {
    const { me } = store.state;

    if (revalidating || me?.role !== "owner") {
        return null;
    }

    try {
        if (readInboxAccount(localStorage)?.id !== me.id) {
            return null;
        }

        const inbox = inboxFor(me.id);

        return html`<${QuickNotes} key=${`${me.id}:${accountGeneration}`} account=${me.id} inbox=${inbox} />`;
    } catch {
        return html`<button
            class="rail-button"
            type="button"
            aria-label="Quick notes unavailable"
            onClick=${() => notify("error", "Local notes could not be read. Check this browser's storage. No notes were removed.")}
        ><${Icon} name="file" size=${19} /></button>`;
    }
}
