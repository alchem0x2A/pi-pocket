// Links to HTTP services reachable through this machine's local network or tailnet.
import { useEffect, useState } from "preact/hooks";
import { browserAvailable, openInBrowser } from "../browser.js";
import { api, closeSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet } from "../ui.js";

const HIDDEN_LINKS_KEY = "pi-pocket.links.hiddenPorts";

function readHiddenPorts() {
    try {
        const value = JSON.parse(localStorage.getItem(HIDDEN_LINKS_KEY) ?? "[]");

        return Array.isArray(value)
            ? value.filter((port) => Number.isSafeInteger(port) && port > 0)
            : [];
    } catch {
        return [];
    }
}

/** The owner can refresh the HTTP services this machine exposes on its local network or tailnet. */
export function LinksSheet() {
    const [services, setServices] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [refreshCount, setRefreshCount] = useState(0);
    const [hiddenPorts, setHiddenPorts] = useState(readHiddenPorts);
    const [showHidden, setShowHidden] = useState(false);

    useEffect(() => {
        let active = true;

        setLoading(true);
        setError("");
        api("links")
            .then(
                (data) => active && setServices(data.services),
                (reason) => active && setError(reason.message ?? String(reason)),
            )
            .finally(() => active && setLoading(false));

        return () => {
            active = false;
        };
    }, [refreshCount]);

    const refresh = () => setRefreshCount((count) => count + 1);
    const canOpenServerLocal = store.state.conversationId !== null && browserAvailable();
    // Loopback-only services need a session's browser, so without one they are hidden like the owner's own picks.
    const isHidden = (service) =>
        hiddenPorts.includes(service.port) ||
        (!canOpenServerLocal && service.links.every((link) => link.network === "server"));
    const visibleServices = services?.filter((service) => showHidden || !isHidden(service));
    const hiddenCount = services?.filter(isHidden).length ?? 0;

    const saveHidden = (update) => {
        setHiddenPorts((current) => {
            const next = update(current);

            try {
                localStorage.setItem(HIDDEN_LINKS_KEY, JSON.stringify(next));
            } catch {
                // The change still applies to this sheet even when browser storage is unavailable.
            }

            return next;
        });
    };

    const hideService = (port) => saveHidden((current) => [...new Set([...current, port])]);
    const unhideService = (port) =>
        saveHidden((current) => current.filter((each) => each !== port));

    return html`<${Sheet} title="Links" onClose=${closeSheet} wide=${true} className="links-sheet">
        <div class="links-tools">
            <p class="muted">Network links open in a new tab. Loopback-only services open in Pia Browser.</p>
            <button class="button small" disabled=${loading} onClick=${refresh}>
                <${Icon} name="reload" size=${14} />
                Refresh
            </button>
        </div>
        ${loading && html`<${Loader} label="Scanning services" />`}
        ${error && html`<p class="links-error" role="alert">${error}</p>`}
        ${!loading && !error && services?.length === 0 && html`<p class="muted">No reachable HTTP services found.</p>`}
        ${
            !loading &&
            !error &&
            services?.length > 0 &&
            visibleServices?.length === 0 &&
            html`<p class="muted">All service tiles are hidden.</p>`
        }
        ${
            !loading &&
            !error &&
            visibleServices?.length > 0 &&
            html`<div class="links-grid">
                ${visibleServices.map(
                    (service) => html`<article
                        class="links-card ${isHidden(service) ? "hidden-tile" : ""}"
                        key=${service.port}
                    >
                        <div class="links-card-title">${service.title}</div>
                        <div class="links-card-port">Port ${service.port}</div>
                        <div class="links-card-actions">
                            ${service.links.map((link) =>
                                link.network === "server"
                                    ? html`<button
                                          class="button small links-open server"
                                          disabled=${!canOpenServerLocal}
                                          title=${
                                              canOpenServerLocal
                                                  ? "Open in Pia's server-side browser"
                                                  : "Open a session with the Browser enabled first"
                                          }
                                          onClick=${() => {
                                              closeSheet();
                                              openInBrowser(link.url);
                                          }}
                                          key=${`${link.network}:${link.host}`}
                                      >
                                          Pia Browser
                                          <${Icon} name="globe" size=${13} />
                                      </button>`
                                    : html`<a
                                          class="button small links-open ${link.network}"
                                          href=${link.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          title=${link.url}
                                          key=${`${link.network}:${link.host}`}
                                      >
                                          ${
                                              link.network === "tailnet"
                                                  ? link.secure
                                                      ? "Tailnet HTTPS"
                                                      : "Tailnet HTTP"
                                                  : "Local network"
                                          }
                                          <${Icon} name="external" size=${13} />
                                      </a>`,
                            )}
                            ${
                                hiddenPorts.includes(service.port)
                                    ? html`<button
                                          class="button small links-hide"
                                          type="button"
                                          aria-label=${`Unhide ${service.title}`}
                                          onClick=${() => unhideService(service.port)}
                                      >
                                          Unhide
                                      </button>`
                                    : html`<button
                                          class="button small links-hide"
                                          type="button"
                                          title="Hide this service in this browser"
                                          aria-label=${`Hide ${service.title}`}
                                          onClick=${() => hideService(service.port)}
                                      >
                                          Hide
                                      </button>`
                            }
                        </div>
                    </article>`,
                )}
            </div>`
        }
        ${
            hiddenCount > 0 &&
            html`<button
                class="button small links-show-hidden"
                type="button"
                aria-pressed=${showHidden}
                onClick=${() => setShowHidden(!showHidden)}
            >
                ${showHidden ? "Hide hidden" : `Show hidden (${hiddenCount})`}
            </button>`
        }
    <//>`;
}
