// Updates' browser module, for the owner: a menu row and a launcher action that open the Update Pi Pocket sheet (the running
// version, the newest release and its notes, and a button to start its migration session), a notice once for each new
// version, and one for how an earlier update ended. Nothing starts by itself. It uses only `pocket`.
export const pocketApi = 1;

/** Lucide's refresh-cw icon. */
const ICON =
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 M8 16H3v5";
const TOLD = "x.updates.told";
const ENDED = "x.updates.outcome";
/** An outcome older than this is not told: it is from an update before this browser looked. */
const RECENT_MS = 60 * 60 * 1000;

const remembered = (key) => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

const remember = (key, value) => {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Private mode: told again next time.
    }
};

/** "5 minutes ago", "3 hours ago", "2 days ago". */
function ago(at) {
    const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));

    if (minutes < 1) {
        return "just now";
    }

    if (minutes < 60) {
        return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    }

    const hours = Math.round(minutes / 60);

    if (hours < 48) {
        return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    }

    return `${Math.round(hours / 24)} days ago`;
}

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    let status = null;
    let failure = null;
    const listeners = new Set();

    const menu = pocket.menu({ id: "updates", label: "Update Pi Pocket", sheet: "updates" });
    const launcher = pocket.launcher({
        id: "updates",
        label: "Update Pi Pocket",
        detail: "Check for a new version of Pi Pocket",
        iconPath: ICON,
        keywords: ["update", "upgrade", "version", "release"],
        sheet: "updates",
    });

    /** After contact is lost, the status is read again until the server answers. */
    let poll = null;
    let gone = false;

    const later = () => {
        if (poll === null && !gone) {
            poll = setTimeout(() => {
                poll = null;
                pocket.api("status").then(publish, later);
            }, 2000);
        }
    };

    pocket.onDispose(() => {
        gone = true;
        clearTimeout(poll);
    });

    const publish = (next) => {
        if (gone) {
            return;
        }

        status = next;
        failure = null;

        const hint =
            next.step ??
            (next.available && next.latest ? `${next.latest.version} is out` : undefined);

        menu.update({ hint });
        launcher.update(
            next.available && next.latest
                ? {
                      label: `Pi Pocket ${next.latest.version} is available`,
                      detail: "See what is new, and start a migration session",
                  }
                : { label: "Update Pi Pocket", detail: "Check for a new version of Pi Pocket" },
        );

        // Once for each version: a short line. Nothing is fetched or started until the owner asks in the sheet.
        if (next.available && next.latest && remembered(TOLD) !== next.latest.version) {
            remember(TOLD, next.latest.version);
            pocket.notify(
                "info",
                `Pi Pocket ${next.latest.version} is available: Menu → Update Pi Pocket.`,
            );
        }

        const last = next.last;

        if (last && last.id !== remembered(ENDED) && Date.now() - last.at < RECENT_MS) {
            remember(ENDED, last.id);
            pocket.notify(last.ok ? "info" : "warning", last.message);
        }

        for (const listener of listeners) {
            listener();
        }
    };

    const fail = (error) => {
        if (gone) {
            return;
        }

        failure = error.message;

        for (const listener of listeners) {
            listener();
        }
    };

    const refresh = () => pocket.api("status").then(publish, fail);

    pocket.on("status", publish);
    refresh();

    const useStatus = () => {
        const [, redraw] = useState(0);

        useEffect(() => {
            const listener = () => redraw((count) => count + 1);

            listeners.add(listener);
            refresh();

            return () => listeners.delete(listener);
        }, []);

        return status;
    };

    function List({ items, tone }) {
        return html`<ul class=${`updates-list ${tone}`}>
            ${items.map((item) => html`<li key=${item}><${pocket.Markdown} text=${item} /></li>`)}
        </ul>`;
    }

    function Updates() {
        const current = useStatus();
        const [working, setWorking] = useState(null);
        const [error, setError] = useState(null);

        // Contact lost, then a status came: the server answers again, so the words about it go.
        useEffect(() => setError((shown) => (shown?.lost ? null : shown)), [current]);

        const run = async (label, work) => {
            setWorking(label);
            setError(null);

            try {
                const next = await work();

                if (next) {
                    publish(next);
                }
            } catch (failed) {
                // No status: the request got no answer (the phone slept, or the server restarted).
                setError(
                    failed.status === undefined
                        ? {
                              text: "Lost contact with the server. This sheet reads the status again when it answers.",
                              lost: true,
                          }
                        : { text: failed.message, lost: false },
                );
                later();
            } finally {
                setWorking(null);
            }
        };

        const check = () => run("Checking", () => pocket.api("check", {}));

        const migrate = () => run("Starting a migration session", () => pocket.api("migrate", {}));

        const [synced, setSynced] = useState(null);

        const sync = () =>
            run("Syncing", async () => {
                setSynced(null);
                const answer = await pocket.api("sync", {});

                setSynced(answer);
                pocket.notify(answer.restart ? "warning" : "info", answer.message);

                return pocket.api("status");
            });

        if (current === null) {
            return failure
                ? html`<div class="error-box">${failure}</div>`
                : html`<${pocket.Loader} label="Reading the version" />`;
        }

        const latest = current.latest;
        // Notes that warn, or notes Pi Pocket could not read: open, so the owner reads them.
        const careful = latest !== undefined && (latest.warning || latest.unread === true);
        const migration =
            current.available && current.migration?.version === latest?.version
                ? current.migration
                : undefined;
        const step = current.step ?? working;
        // While an update moves the checkout, the server does not read it: no commit then is no word on it.
        const where = current.commit
            ? `${current.branch ?? "detached"} · ${current.commit.slice(0, 7)}`
            : current.step === undefined
              ? "not a git checkout"
              : null;

        return html`<div class="updates-sheet">
            <div class="updates-card">
                <div class="updates-row">
                    <div>
                        <div class="updates-title">Pi Pocket ${current.version}</div>
                        ${where && html`<div class="muted small mono">${where}</div>`}
                    </div>
                    <button
                        class="button"
                        disabled=${step !== null && step !== undefined}
                        onClick=${check}
                    >
                        Check now
                    </button>
                </div>
                ${
                    step === "Checking" && !current.available
                        ? html`<div class="updates-step">
                              <${pocket.Spinner} label="Checking" />
                              <span>Checking…</span>
                          </div>`
                        : html`<div class="muted small">
                              ${
                                  current.error
                                      ? "Could not check."
                                      : current.available
                                        ? `${latest.version} is out.`
                                        : latest
                                          ? "This is the newest version."
                                          : current.checkedAt
                                            ? "No release found."
                                            : "Not checked since the server started."
                              }
                              ${current.checkedAt ? ` Last look ${ago(current.checkedAt)}.` : ""}
                          </div>`
                }
                ${current.error && html`<div class="error-box">${current.error}</div>`}
                ${
                    failure &&
                    html`<div class="error-box">Could not read the status again: ${failure}</div>`
                }
            </div>
            ${
                current.last &&
                html`<div class=${`updates-card ${current.last.ok ? "" : "updates-warn"}`}>
                    <div class="updates-label">Last update · ${ago(current.last.at)}</div>
                    <div>${current.last.message}</div>
                </div>`
            }
            ${
                current.available &&
                html`<div class="updates-card updates-new">
                    <div class="updates-row">
                        <div class="updates-title">${latest.name}</div>
                        ${
                            latest.url &&
                            html`<a
                                class="small updates-link"
                                href=${latest.url}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                On GitHub
                            </a>`
                        }
                    </div>
                    ${
                        latest.publishedAt &&
                        !Number.isNaN(Date.parse(latest.publishedAt)) &&
                        html`<div class="muted small">
                            Released ${ago(Date.parse(latest.publishedAt))}
                        </div>`
                    }
                    ${
                        latest.notes &&
                        html`<details class="updates-notes" open=${careful}>
                            <summary>Release notes</summary>
                            <div class="updates-notes-body">
                                <${pocket.Markdown} text=${latest.notes} />
                            </div>
                        </details>`
                    }
                    <div class="updates-label">Migration</div>
                    ${
                        migration?.conversationId !== undefined
                            ? html`<div>
                                      Pi Pocket fetched upstream and started a session where Pi
                                      reads what ${latest.version} changes and reports. Pi changes
                                      nothing: you do the merge.
                                  </div>
                                  <button
                                      class="button primary updates-go"
                                      onClick=${() => {
                                          pocket.closeSheet();
                                          pocket.openConversation(migration.conversationId);
                                      }}
                                  >
                                      Open “${migration.title}”
                                  </button>`
                            : html`<div class="muted small">
                                  Nothing is fetched or merged by itself. Start a migration session
                                  to fetch upstream and have Pi report what changed. You do the
                                  merge.
                              </div>`
                    }
                    ${migration?.error && html`<div class="error-box">${migration.error}</div>`}
                    ${error && html`<div class="error-box">${error.text}</div>`}
                    ${
                        step
                            ? html`<div class="updates-step">
                                  <${pocket.Spinner} label=${step} />
                                  <span>${step}…</span>
                              </div>`
                            : html`<button
                                  class=${`button updates-go ${migration?.conversationId === undefined ? "primary" : ""}`}
                                  onClick=${migrate}
                              >
                                  ${
                                      migration?.conversationId === undefined
                                          ? "Start a migration session"
                                          : "Start another migration session"
                                  }
                              </button>`
                    }
                </div>`
            }
            ${!current.available && error && html`<div class="error-box">${error.text}</div>`}
            ${
                current.commit &&
                html`<div class="updates-card">
                    <div class="updates-row">
                        <div>
                            <div class="updates-title">Sync to main</div>
                            <div class="muted small">
                                Fetch upstream, and move your main forward to upstream's main.
                                Fast-forward only: it never merges, and never pushes.
                            </div>
                        </div>
                        <button
                            class="button"
                            disabled=${step !== null && step !== undefined}
                            onClick=${sync}
                        >
                            Sync
                        </button>
                    </div>
                    ${synced && html`<div class="small">${synced.message}</div>`}
                </div>`
            }
            <p class="muted small">
                To stop looking for new versions, open Menu → Extensions → Installed → Pi Pocket
                updates.
            </p>
        </div>`;
    }

    pocket.sheet({ id: "updates", title: "Update Pi Pocket", component: Updates });
    pocket.style("style.css");
}
