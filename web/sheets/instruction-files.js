// The owner's persistent lessons and the agent context files, with their on-disk locations.
import { useEffect, useMemo, useState } from "preact/hooks";
import { api, attempt, closeSheet, openSheet, store } from "../store.js";
import { html, Sheet } from "../ui.js";

/** Show the database path and open the lesson editor for a chosen session. */
export function MemorySettingsSheet() {
    const [memoryPath, setMemoryPath] = useState("");
    const [session, setSession] = useState("");
    const sessions = store.state.sessions;
    const current = store.state.view.conversation;
    const piaId = store.state.pia?.id;
    const assistant = store.state.server?.assistant?.name ?? "Pia";
    const choices = useMemo(() => {
        const list = [...sessions];

        if (current && !list.some((each) => each.id === current.id)) {
            list.unshift({
                id: current.id,
                title: current.pia ? `${assistant} · everywhere` : current.title,
                cwd: current.cwd,
            });
        }

        if (piaId && !list.some((each) => each.id === piaId)) {
            list.unshift({ id: piaId, title: `${assistant} · everywhere`, cwd: "" });
        }

        return list;
    }, [sessions, current, piaId, assistant]);

    useEffect(() => {
        let live = true;

        api("instruction-files").then(
            (data) => {
                if (live) {
                    setMemoryPath(data.memoryPath);
                }
            },
            () => {},
        );

        return () => {
            live = false;
        };
    }, []);

    useEffect(() => {
        if (session === "") {
            const chosen = choices.some((each) => each.id === current?.id)
                ? current?.id
                : choices[0]?.id;

            if (chosen !== undefined) {
                setSession(String(chosen));
            }
        }
    }, [session, choices, current]);

    return html`<${Sheet} title="Memory" onClose=${closeSheet}>
        <p class="muted small">
            Lessons are durable app data, not a text file. They live in this database; edit them with the Memory manager.
        </p>
        <div class="field">
            <div class="label">Storage file</div>
            <code class="instruction-path">${memoryPath || "Loading…"}</code>
        </div>
        <p class="muted small">
            Do not edit the database file directly. The app saves lesson changes to disk.
        </p>
        ${
            choices.length > 0 &&
            html`<div class="field">
                <label class="label" for="memory-session">Project</label>
                <select
                    id="memory-session"
                    value=${session}
                    onChange=${(event) => setSession(event.currentTarget.value)}
                >
                    ${choices.map(
                        (each) => html`<option value=${String(each.id)}>
                            ${each.title || each.cwd || `Session ${each.id}`}
                        </option>`,
                    )}
                </select>
            </div>`
        }
        <div class="sheet-actions">
            <button class="button" onClick=${closeSheet}>Close</button>
            <button
                class="button primary"
                disabled=${session === ""}
                onClick=${() =>
                    openSheet({ type: "memory", conversationId: Number(session), settings: true })}
            >
                Edit lessons
            </button>
        </div>
        ${choices.length === 0 && html`<p class="muted small">Open a session to edit its project lessons.</p>`}
    <//>`;
}

/** List each discovered the agent context file, then edit and save one on disk. */
export function InstructionFilesSheet() {
    const [data, setData] = useState(null);
    const [selected, setSelected] = useState(null);
    const [draft, setDraft] = useState("");
    const [loading, setLoading] = useState(true);
    const file = data?.files.find((each) => each.path === selected);

    useEffect(() => {
        let live = true;

        api("instruction-files").then(
            (next) => {
                if (live) {
                    setData(next);
                    setLoading(false);
                }
            },
            () => {
                if (live) {
                    setLoading(false);
                }
            },
        );

        return () => {
            live = false;
        };
    }, []);

    const save = () =>
        attempt(async () => {
            await api("instruction-files", { path: file.path, content: draft }, { method: "PUT" });
            setData((current) => ({
                ...current,
                files: current.files.map((each) =>
                    each.path === file.path ? { ...each, content: draft, exists: true } : each,
                ),
            }));
        });

    return html`<${Sheet} title="Instructions (AGENTS.md)" onClose=${closeSheet}>
        <p class="muted small">
            The agent loads global instructions and context files from each session folder and its parents. Select a path to edit it.
            The agent reads file changes on its next request, within 30 seconds.
        </p>
        ${loading && html`<p class="muted small">Loading files…</p>`}
        ${
            !loading &&
            data?.files.length === 0 &&
            html`<p class="muted small">No instruction files are available.</p>`
        }
        ${
            file === undefined &&
            data?.files.length > 0 &&
            html`<div class="sheet-list">
                ${data.files.map(
                    (each) => html`<button
                        class="list-item instruction-choice"
                        disabled=${!each.editable}
                        onClick=${() => {
                            setSelected(each.path);
                            setDraft(each.content);
                        }}
                    >
                        <span class="instruction-path">${each.path}</span>
                        <span class="muted small">
                            ${each.exists ? (each.editable ? "Edit" : "Read only") : "Create"}
                        </span>
                    </button>`,
                )}
            </div>`
        }
        ${
            file &&
            html`<div class="field">
                <button class="button small ghost instruction-back" onClick=${() => setSelected(null)}>
                    All instruction files
                </button>
                <div class="label">${file.path}</div>
                ${
                    file.editable
                        ? html`<textarea
                              class="instruction-editor"
                              aria-label=${file.path}
                              value=${draft}
                              onInput=${(event) => setDraft(event.currentTarget.value)}
                          ></textarea>`
                        : html`<p class="muted small">
                              This file is a link or exceeds the 512 KB editing limit.
                          </p>`
                }
                <div class="sheet-actions">
                    <button class="button" onClick=${() => setSelected(null)}>Cancel</button>
                    <button class="button primary" disabled=${!file.editable} onClick=${save}>
                        Save to disk
                    </button>
                </div>
            </div>`
        }
    <//>`;
}
