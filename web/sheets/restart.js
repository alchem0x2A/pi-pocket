// Restart server: whether the server's code changed since it started, Pi's requests, the restart command, and the
// restart itself, now or once no tool call runs (`src/server/restart.ts`). The owner's alone.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, navigate, notify, store } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

/** This server's restart status, as `hello` and `restart` events carry it; undefined for others, or an older server. */
export const restartStatus = () => store.state.server?.restart;

/** What the menu item says beside its name. */
export function restartHint() {
    const status = restartStatus();

    if (status === undefined) {
        return "running work resumes";
    }

    if (status.waiting) {
        return "waiting for tool calls";
    }

    if (status.requests.length > 0) {
        return "Pi asks for one";
    }

    return status.needed
        ? `needed · ${status.changedCount} ${status.changedCount === 1 ? "file" : "files"} changed`
        : "not needed";
}

/** Whether the menu item shows: a launcher runs the server, or the owner set a command. */
export function restartAvailable() {
    const { me, server } = store.state;

    return me?.role === "owner" && (server?.restart?.available ?? server?.supervised === true);
}

/** Whether the item gets a dot: Pi asks, or the code changed. */
export function restartWanted() {
    const status = restartStatus();

    return status !== undefined && (status.needed || status.requests.length > 0);
}

function ago(at) {
    const minutes = Math.round((Date.now() - at) / 60_000);

    if (minutes < 1) {
        return "just now";
    }

    if (minutes < 60) {
        return `${minutes} min ago`;
    }

    const hours = Math.round(minutes / 60);

    return hours < 48 ? `${hours} h ago` : new Date(at).toLocaleDateString();
}

/** Set the status the server answered with, until its next event. */
function keep(status) {
    if (status && typeof status === "object" && "method" in status) {
        store.set((state) => ({ server: { ...state.server, restart: status } }));
    }
}

export function RestartSheet() {
    const live = restartStatus();
    const [loaded, setLoaded] = useState(live !== undefined);
    const [command, setCommand] = useState(live?.command ?? "");
    const [busy, setBusy] = useState(false);

    // The changes now, not as of the last event.
    useEffect(() => {
        api("restart").then(
            (status) => {
                keep(status);
                setCommand(status.command ?? "");
                setLoaded(true);
            },
            (error) => {
                setLoaded(true);

                // An older server has no status to give: the sheet offers its plain restart.
                if (error.status !== 404) {
                    notify("error", error.message);
                }
            },
        );
    }, []);

    const status = restartStatus();

    if (!loaded && status === undefined) {
        return html`<${Sheet} title="Restart server" onClose=${closeSheet}>
            <${Loader} label="Looking" />
        <//>`;
    }

    // An older server: only its plain restart.
    if (status === undefined) {
        return html`<${Sheet} title="Restart server" onClose=${closeSheet}>
            <p class="muted small">Running work continues after the restart.</p>
            <div class="sheet-actions">
                <button class="button" onClick=${closeSheet}>Cancel</button>
                <button
                    class="button primary"
                    onClick=${() =>
                        attempt(async () => {
                            await api("restart", {});
                            closeSheet();
                            notify("info", "Restarting. Running work continues after the restart.");
                        })}
                >
                    Restart now
                </button>
            </div>
        <//>`;
    }

    const restart = (when, force = false) =>
        attempt(async () => {
            setBusy(true);

            try {
                keep(await api("restart", { when, force }));
            } finally {
                setBusy(false);
            }

            if (when === "now") {
                closeSheet();
                notify("info", "Restarting. Running work continues after the restart.");
            }
        });
    const saveCommand = () => attempt(async () => keep(await api("restart/command", { command })));
    const cancel = () => attempt(async () => keep(await api("restart/cancel", {})));
    const dismiss = (id) => attempt(async () => keep(await api("restart/dismiss", { id })));
    const commandChanged = command.trim() !== (status.command ?? "");
    const commit =
        status.commitAtStart && status.commitNow && status.commitAtStart !== status.commitNow
            ? `${status.commitAtStart} → ${status.commitNow}`
            : status.commitAtStart;

    return html`<${Sheet} title="Restart server" onClose=${closeSheet}>
        <p class=${`restart-state ${status.needed ? "needed" : ""}`}>
            ${
                status.needed
                    ? `A restart is needed: ${status.changedCount} server ${status.changedCount === 1 ? "file has" : "files have"} changed since the server started ${ago(status.startedAt)}.`
                    : `No restart is needed: the server code is the same as when it started ${ago(status.startedAt)}.`
            }
            ${commit && html` <span class="muted">Commit ${commit}.</span>`}
        </p>
        ${
            status.changed.length > 0 &&
            html`<details class="restart-files">
                <summary>Changed files</summary>
                <pre class="output">${status.changed.join("\n")}${status.changedCount > status.changed.length ? "\n…" : ""}</pre>
            </details>`
        }
        ${
            status.launcherChanged &&
            html`<p class="muted small">
                The launcher changed too. This restart does not load the launcher. Restart its service, or run
                pi-pocket again, to load it.
            </p>`
        }
        ${status.requests.map(
            (request) => html`<div class="restart-request" key=${request.id}>
                <div class="grow">
                    <div>Pi asks for a restart${request.reason ? `: ${request.reason}` : "."}</div>
                    <button
                        class="link small"
                        onClick=${() => {
                            closeSheet();
                            navigate(request.conversationId);
                        }}
                    >
                        Open its session · ${ago(request.at)}
                    </button>
                </div>
                <button class="button" onClick=${() => dismiss(request.id)}>Dismiss</button>
            </div>`,
        )}
        ${status.lastError && html`<div class="error-box">${status.lastError}</div>`}
        ${
            status.waiting &&
            html`<div class="restart-request">
                <div class="grow">
                    Waiting for ${status.waiting.tools || "the"} tool
                    ${status.waiting.tools === 1 ? "call" : "calls"} to end, then restarting. It
                    restarts after 10 minutes at most.
                </div>
                <button class="button" onClick=${cancel}>Cancel</button>
            </div>`
        }
        <div class="field">
            <div class="label">Restart command</div>
            <input
                aria-label="Restart command"
                value=${command}
                placeholder="Empty: the launcher restarts the server"
                spellcheck="false"
                autocapitalize="off"
                onInput=${(event) => setCommand(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && commandChanged && saveCommand()}
            />
        </div>
        <p class="muted small">A shell command that restarts the server. It runs on this machine as the server's user.</p>
        <pre class="cmd"><code>systemctl --user reload pi-pocket-office.service</code></pre>
        ${
            commandChanged &&
            html`<div class="sheet-actions">
                <button class="button" onClick=${() => setCommand(status.command ?? "")}>
                    Undo
                </button>
                <button class="button primary" onClick=${saveCommand}>Save command</button>
            </div>`
        }
        <p class="muted small">
            Before it restarts, the server checks that the new code loads. If it does not load, the server keeps running.
            Running work continues after the restart.
        </p>
        <div class="sheet-actions restart-actions">
            ${
                status.lastError?.startsWith("The new code") &&
                html`<button class="button" disabled=${busy} onClick=${() => restart("now", true)}>
                    Restart anyway
                </button>`
            }
            <button
                class="button"
                disabled=${busy || Boolean(status.waiting)}
                onClick=${() => restart("idle")}
            >
                When tools finish
            </button>
            <button
                class="button primary"
                disabled=${busy || commandChanged}
                onClick=${() => restart("now")}
            >
                ${busy ? "Checking…" : "Restart now"}
            </button>
        </div>
    <//>`;
}
