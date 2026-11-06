// The menu: what can be done in this session and in the app.
import { useLayoutEffect, useRef } from "preact/hooks";
import { browserAvailable, setBrowserOpen } from "../browser.js";
import { schedulesAvailable, triggersOn } from "../commands.js";
import { extensionMenuItems, safeMode } from "../extension-ui.js";
import { useChanges } from "../diff.js";
import { filesAvailable, setFilesOpen } from "../files-panel.js";
import { modelRefreshAvailable, refreshModels } from "../model-refresh.js";
import { assistantName } from "../pip.js";
import { setArchived } from "../sessions.js";
import { openSubagent } from "../subagents.js";
import { api, canSteer, closeSheet, collab, openSheet, scoped, signOut, store } from "../store.js";
import { defineItem, slotItems } from "../slots.js";
import { modeLabel } from "../theme.js";
import { currentTrust, trustAvailable } from "../trust.js";
import { branchAvailable } from "./branch.js";
import { memoryAvailable, memoryHint, useMemory } from "./memory.js";
import { restartAvailable, restartHint, restartWanted } from "./restart.js";
import { defaultLabel, defaultsKept } from "./model.js";
import { html, Icon, item, PlaceTile, Sheet, shortPath } from "../ui.js";

// Key hints are for people with a keyboard: a touch screen has none.
const touch = matchMedia("(pointer: coarse)").matches;

/** The Extensions row's hint: that this tab loads none of their browser parts (safe mode), and Lancet Guard. */
function extensionsHint() {
    const { guard } = store.state;

    return [
        safeMode() && "browser parts off here",
        guard?.enabled ? "Lancet Guard on" : guard?.available ? "Lancet Guard off" : "",
    ]
        .filter(Boolean)
        .join(" · ");
}

/**
 * The core places are Files, Changes, Browser, Find, and Branch. Extension panels have their own topbar buttons.
 */
function Places() {
    if (!store.state.view.conversation) {
        return null;
    }

    return filesAvailable() ? html`<${PlacesWithChanges} />` : html`<${PlacesGrid} />`;
}

/** Only people who can open Files request its shared changes data, just as the top bar does. */
function PlacesWithChanges() {
    const { changes } = useChanges();

    return html`<${PlacesGrid} changes=${changes} />`;
}

/**
 * The app's own places, items of the `places` slot (`slots.js`), which extensions may arrange and a person can hide or
 * reorder in Appearance. Each gets `{ changes }`: the folder's changes, for the count on Changes.
 */
const PLACES = [
    {
        id: "core:files",
        label: "Files",
        place: () =>
            filesAvailable() && {
                icon: "folder",
                on: store.state.filesOpen && store.state.filesTab === "files",
                run: () => setFilesOpen(true, "files"),
            },
    },
    {
        id: "core:changes",
        label: "Changes",
        place({ changes }) {
            // Match the top bar: uncommitted files in a repository, the agent's edits elsewhere, plus any unlisted files.
            const count = changes
                ? changes.files.length +
                  (changes.repo ? 0 : changes.piOnly.length) +
                  (changes.more ?? 0)
                : 0;

            return (
                filesAvailable() && {
                    icon: "diff",
                    count,
                    counted: count === 1 ? "changed file" : "changed files",
                    on: store.state.filesOpen && store.state.filesTab === "changes",
                    run: () => setFilesOpen(true, "changes"),
                }
            );
        },
    },
    {
        id: "core:browser",
        label: "Browser",
        place() {
            const { browser, browserOpen } = store.state;

            return (
                browserAvailable() && {
                    icon: "globe",
                    on: browserOpen,
                    dot: browser?.open && browser.url !== "" && browser.url !== "about:blank",
                    run: () => {
                        setBrowserOpen(true);
                        closeSheet();
                    },
                }
            );
        },
    },
    {
        id: "core:find",
        label: "Find",
        place: () => ({ icon: "search", run: () => openSheet({ type: "find" }) }),
    },
    {
        id: "core:branch",
        label: "Branch",
        place: () =>
            branchAvailable() && { icon: "fork", run: () => openSheet({ type: "branch" }) },
    },
];

PLACES.forEach((entry, index) =>
    defineItem("places", {
        id: entry.id,
        get label() {
            return entry.label;
        },
        order: (index + 1) * 100,
        render(context) {
            const shown = entry.place(context);

            // As before slots: `data-place="files"`, which tests and themes may select.
            return (
                shown &&
                html`<${PlaceTile}
                    place=${{ id: entry.id.replace(/^core:/, ""), label: entry.label, ...shown }}
                />`
            );
        },
    }),
);

/** Extension panels have topbar buttons, so this compact grid shows core places only. */
function PlacesGrid({ changes = null }) {
    const places = slotItems("places", { changes }).filter(({ id }) => id.startsWith("core:"));

    return html`<nav class="places" aria-label="Places">
        ${places.map(({ node }) => node)}
    </nav>`;
}

/**
 * The places alone, in a short sheet that stays near the bottom edge: what the button beside the message box and a
 * swipe up from it open on a phone, a thumb's reach away. A compact icon opens the session menu below them.
 */
export function PlacesSheet() {
    const conversation = store.state.view.conversation;

    return html`<${Sheet}
        title=${conversation?.pia ? assistantName() : (conversation?.title ?? "Open")}
        onClose=${closeSheet}
        className="places-sheet"
    >
        <${Places} />
        <div class="places-session-action">
            <button
                class="icon-button"
                aria-label="Session menu"
                title="Session menu"
                onClick=${() => openSheet({ type: "menu", fromPlaces: true })}
            >
                <${Icon} name="more" size=${16} />
            </button>
        </div>
    <//>`;
}

/** Keep Sheet's Esc, drag, and focus handling; the sheet trail already owns its back-stack layer. */
function MenuFrame({ title, children }) {
    const host = useRef(null);

    useLayoutEffect(() => {
        const element = host.current;
        const button = document.querySelector('.topbar [aria-label="Menu"]');
        const active = document.activeElement;
        const opener = active === document.body ? button : active;

        const place = () => {
            const rect = button?.getBoundingClientRect();
            const top = (rect?.bottom ?? 58) + 6;
            const bottom =
                (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight);
            const left = Math.max(
                8,
                Math.min((rect?.right ?? innerWidth - 8) - 360, innerWidth - 368),
            );

            element.style.setProperty("--menu-left", `${left}px`);
            element.style.setProperty("--menu-top", `${top}px`);
            element.style.setProperty("--menu-height", `${Math.max(100, bottom - top - 8)}px`);
        };

        const body = element.querySelector(".sheet-body");

        if (menuScroll !== null) {
            body.scrollTop = menuScroll;
            menuScroll = null;
        }

        place();
        addEventListener("resize", place);
        visualViewport?.addEventListener("resize", place);

        return () => {
            removeEventListener("resize", place);
            visualViewport?.removeEventListener("resize", place);

            // Another sheet open now: the menu is going back under it, not closing.
            if (store.state.sheet) {
                menuScroll = body.scrollTop;
            }

            const focused = document.activeElement;
            const back = opener?.isConnected ? opener : button;
            // As sheets.js does: not behind a sheet the menu opened, and not into a text field on a touch screen,
            // where its keyboard would pop up.
            const field =
                matchMedia("(pointer: coarse)").matches &&
                back?.matches("input, textarea, [contenteditable]");

            if (
                !store.state.sheet &&
                !field &&
                (focused === document.body || element.contains(focused)) &&
                back?.isConnected
            ) {
                back.focus({ preventScroll: true });
            }
        };
    }, []);

    const onKey = (event) => {
        if (
            event.defaultPrevented ||
            event.isComposing ||
            event.keyCode === 229 ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
        ) {
            return;
        }

        const items = [...host.current.querySelectorAll(".place, .list-item")];
        const active = document.activeElement;
        const index = items.indexOf(active);
        let target;

        if (event.key === "Tab") {
            // Close stays reachable with Tab, but is not part of the menu's item navigation.
            const controls = [...items, ...host.current.querySelectorAll(".sheet-head button")];
            const at = controls.indexOf(active);
            const next =
                at < 0
                    ? event.shiftKey
                        ? controls.length - 1
                        : 0
                    : (at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;

            target = controls[next];
        } else if (event.key === "Home") {
            target = items[0];
        } else if (event.key === "End") {
            target = items.at(-1);
        } else if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) {
            const down = event.key === "ArrowDown" || event.key === "ArrowRight";
            const vertical = event.key === "ArrowDown" || event.key === "ArrowUp";
            const tiles = host.current.querySelectorAll(".place").length;
            const step = vertical && index >= 0 && index < tiles ? 3 : 1;
            let next = index < 0 ? (down ? 0 : items.length - 1) : index + (down ? step : -step);

            // Down from the grid's last row enters the first text row; Up from its first row wraps to the last item.
            if (vertical && index >= 0 && index < tiles) {
                next = next < 0 ? items.length - 1 : Math.min(next, tiles);
            }

            target = items[(next + items.length) % items.length];
        }

        if (target) {
            event.preventDefault();
            target.focus();
        }
    };

    return html`<div class="nav-menu-host" data-part="menu" ref=${host} onKeyDown=${onKey}>
        <${Sheet} title=${title} onClose=${closeSheet} className="nav-menu">
            ${children}
        <//>
    </div>`;
}

/** The menu's scroll, kept while a sheet it opened shows, so back finds the menu where it was left. */
let menuScroll = null;

store.subscribe(({ sheet }) => {
    if (!sheet) {
        menuScroll = null;
    }
});

/** The project's trust in a word, once the server said. */
function trustHint() {
    const info = currentTrust();

    if (!info) {
        return "";
    }

    if (info.ask) {
        return "not decided";
    }

    // No decision, and nothing waiting for one: there is nothing to say.
    if (info.saved === null && info.defaultProjectTrust === "ask") {
        return "";
    }

    return info.trusted ? "trusted" : "not trusted";
}

/** The menu; `places` is false when it opens from the places sheet, which just showed the tiles. */
export function MenuSheet({ places = true }) {
    const { view, me, server } = store.state;
    const conversation = view.conversation;
    const steer = canSteer();
    const session = conversation?.kind === "session";
    const turns = view.turns;
    // While take turns is on, settings belong to the driver.
    const driving = !turns?.on || turns.driver === me?.id;
    const instructions = view.agent?.instructions;
    const memory = useMemory();

    return html`<${MenuFrame} title=${conversation?.pia ? assistantName() : (conversation?.title ?? "Menu")}>
        ${places && html`<${Places} />`}
        <div class="menu-session">
            ${session && steer && item("Rename", () => openSheet({ type: "rename" }))}
            ${session && extensionMenuItems("session").map((each) => item(each.label, each.run, each.hint))}
            ${conversation && steer && driving && item("Compact context", () => openSheet({ type: "compact" }), "summarize older messages")}
            ${conversation && steer && driving && item("New context", () => openSheet({ type: "reset" }), "the agent starts fresh; history stays")}
            ${conversation && memoryAvailable() && item("Memory", () => openSheet({ type: "memory" }), memoryHint(memory))}
            ${schedulesAvailable() && item("Scheduled messages", () => openSheet({ type: "schedules" }), view.schedules.length === 0 ? "none" : `${view.schedules.length} coming`)}
            ${
                conversation &&
                html`<a class="list-item" href=${`/api/c/${conversation.id}/export`} download>
                    <span>Export as Markdown</span>
                    <span class="muted small">the whole history</span>
                </a>`
            }
            ${
                session &&
                steer &&
                item(conversation.archived ? "Unarchive" : "Archive", () => {
                    closeSheet();
                    setArchived([conversation.id], !conversation.archived);
                })
            }
        </div>
        ${
            view.subagents.length > 0 &&
            html`<div class="group">
                <div class="group-title">Subagents</div>
                ${view.subagents.map((agent) =>
                    item(
                        html`${agent.busy ? html`<span class="pulse"></span> ` : ""}${agent.name}`,
                        () => openSubagent(agent.conversationId),
                        agent.busy ? "working" : "idle",
                    ),
                )}
            </div>`
        }
        ${item("Extensions", () => openSheet({ type: "extensions" }), extensionsHint())}
        <div class="group">
            <div class="group-title">App</div>
            ${item("Appearance", () => openSheet({ type: "appearance" }), modeLabel())}
            ${me?.role === "owner" && item("Memory", () => openSheet({ type: "memory-settings" }), "lesson storage and editor")}
            ${me?.role === "owner" && item("Instructions (AGENTS.md)", () => openSheet({ type: "instruction-files" }), "global and folder files")}
            ${!touch && item("Keyboard shortcuts", () => openSheet({ type: "shortcuts" }), "?")}
            ${
                me?.role === "owner" &&
                defaultsKept() &&
                item(
                    "Default model",
                    () => openSheet({ type: "model", id: "default", forDefault: true }),
                    defaultLabel(server?.defaultModel, store.state.models) ||
                        "project, last picked, then the agent global",
                )
            }
            ${item("Your name", () => openSheet({ type: "name" }), me?.name)}
            ${collab() ? item("People", () => openSheet({ type: "people" }), me?.role === "viewer" ? "you can view" : "") : item("Sign in another device", () => openSheet({ type: "invite" }))}
            ${collab() && item("Notifications", () => openSheet({ type: "notifications" }), "the agent finished, approvals")}
            ${
                conversation &&
                trustAvailable() &&
                item("Project trust", () => openSheet({ type: "trust" }), trustHint())
            }
            ${
                session &&
                steer &&
                driving &&
                item(
                    "Instructions for the agent",
                    () => openSheet({ type: "instructions" }),
                    instructions ? "on" : "none",
                )
            }
            ${
                conversation &&
                steer &&
                driving &&
                !scoped() &&
                !conversation.worktree &&
                item(
                    "Working directory",
                    () => openSheet({ type: "cwd", mode: "change" }),
                    shortPath(view.agent?.cwd, server?.home),
                )
            }
            ${item("Running now", () => openSheet({ type: "running" }), "everything the agent is doing")}
            ${item("Spend", () => openSheet({ type: "spend" }), me?.role === "owner" ? "by person and session, limits" : "yours")}
            ${triggersOn() && me?.role !== "viewer" && item("Webhooks and watches", () => openSheet({ type: "hooks" }), "GitHub, other services")}
            ${me?.role === "owner" && item("Providers", () => openSheet({ type: "providers" }))}
            ${modelRefreshAvailable() && item("Refresh models", refreshModels, store.state.modelRefresh.loading ? "refreshing…" : "models.json and providers")}
            ${extensionMenuItems().map((each) => item(each.label, each.run, each.hint))}
            ${
                restartAvailable() &&
                item(
                    restartWanted()
                        ? html`Restart server <span class="menu-dot" aria-label="needed"></span>`
                        : "Restart server",
                    () => openSheet({ type: "restart" }),
                    restartHint(),
                )
            }
            ${item(html`<span class="menu-signout">Sign out</span>`, signOut)}
        </div>
    <//>`;
}
