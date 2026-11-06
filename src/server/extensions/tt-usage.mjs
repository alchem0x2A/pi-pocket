// Provider usage peek: one bottom sheet (4 accounts, one line each), opened from a menu row, a status-line item, and
// the launcher. All numbers come from `tt-usage.ts` routes, which are owner only. No token ever reaches this file.

export const pocketApi = 1;

const GAUGE = "M4 18a8 8 0 1116 0M12 18l4-6";
const RANK = { blocked: 3, "near-limit": 2, unknown: 1, ok: 0 };
const NAMES = {
    openai: "OpenAI (personal)",
    "openai-codex": "Codex (org)",
    "claude-code-personal": "Claude (personal)",
    "claude-code": "Claude (org)",
};

const left = (window) => (window ? Math.max(0, Math.round(100 - window.percent)) : null);

/** The shortest remaining percent of an account's windows. */
const least = (report) => {
    const values = [left(report.session), left(report.weekly)].filter((value) => value !== null);

    return values.length ? Math.min(...values) : null;
};

const clock = (window) => (window && window.resetsAtLocal ? window.resetsAtLocal : "");

export default function setup(pocket) {
    const { html, useEffect, useState, Loader } = pocket;
    let latest = null;
    const listeners = new Set();
    const open = () => pocket.openSheet("peek-sheet");
    const item =
        typeof pocket.status === "function"
            ? pocket.status({
                  id: "usage",
                  text: "usage",
                  short: "usage",
                  title: "Open usage",
                  run: open,
              })
            : undefined;

    function publish(data) {
        latest = data;

        for (const listener of listeners) {
            listener(data);
        }
    }

    /** Reads the data, refreshes it, and holds errors: the data, a refresh, and errors. */
    function useUsage() {
        const [data, setData] = useState(latest);
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);

        const load = async (force) => {
            setBusy(true);

            try {
                publish(await (force ? pocket.api("refresh", {}) : pocket.api("usage")));
                setError(null);
            } catch (failure) {
                setError(failure.message);
            } finally {
                setBusy(false);
            }
        };

        useEffect(() => {
            listeners.add(setData);
            void load(false);

            return () => listeners.delete(setData);
        }, []);

        return { data, error, busy, load };
    }

    /** The tag after the name, by state. The words come from the server (`WORDS`), never the technical cause. */
    const TAG = {
        "not-checked": "",
        ok: "ok",
        near: "near limit",
        "at-limit": "at limit",
        blocked: "blocked",
        failed: "",
        "sign-in": "",
    };
    const stateClass = (state) =>
        state === "blocked" || state === "at-limit" || state === "sign-in"
            ? "error"
            : state === "near"
              ? "warn"
              : "muted";

    /** The sheet: one line per account. */
    function Peek() {
        const { data, error, busy, load } = useUsage();

        if (error && !data) {
            return html`<div class="error-box">Could not check. Try again.</div>
                <button class="button" onClick=${() => load(false)}>Try again</button>`;
        }

        if (!data) {
            return html`<${Loader} label="Reading usage" />`;
        }

        return html`<div class="tt-usage-peek" style="padding:8px">
            ${data.reports.map((report) => {
                const remaining = least(report);

                return html`<div class="setting" style="display:block">
                    <div>
                        <strong>${NAMES[report.provider] ?? report.label}</strong>
                        <span class=${stateClass(report.state)}> ${TAG[report.state] ?? ""}</span>
                    </div>
                    ${
                        remaining === null
                            ? html`<div class="small">
                                  ${report.reason}
                                  ${
                                      report.state === "not-checked"
                                          ? ""
                                          : html`<span class="muted">
                                                · ${new Date(report.at).toLocaleTimeString()}</span
                                            >`
                                  }
                              </div>`
                            : html`<div class="small mono">
                                      ${remaining}%
                                      left${report.session ? ` · 5h ${left(report.session)}%` : ""}${report.weekly ? ` · wk ${left(report.weekly)}%` : ""}
                                  </div>
                                  <div class="small muted">
                                      resets ${clock(report.session) || clock(report.weekly)}
                                  </div>`
                    }
                    ${
                        report.gate
                            ? html`<div class="small error">held until ${report.gate.until}</div>`
                            : ""
                    }
                </div>`;
            })}
            ${error ? html`<div class="small error">Could not check. Try again.</div>` : ""}
            <p class="muted small">${data.zone}</p>
            <button class="button" disabled=${busy} onClick=${() => load(true)}>Refresh</button>
        </div>`;
    }

    pocket.sheet({ id: "peek-sheet", title: "Usage", component: Peek });
    pocket.api("usage").then(publish, () => {});
    pocket.on("usage", publish);
}
