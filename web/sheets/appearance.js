// Appearance: light or dark, and how the app looks and moves.
import { useEffect, useState } from "preact/hooks";
import { closeSheet, openSheet } from "../store.js";
import {
    chooseMode,
    modeNow,
    prefs,
    setPrefs,
    textSizeOf,
    MAX_TEXT,
    MIN_TEXT,
    STEP_TEXT,
} from "../theme.js";
import { arranged, move, resetSlot, setShown, SLOTS } from "../slots.js";
import { html, Icon, Sheet, Switch } from "../ui.js";

// Key hints are for people with a keyboard: a touch screen has none.
const touch = matchMedia("(pointer: coarse)").matches;

/**
 * The conversation's text size: a few usual sizes, and a field for any other, MIN_TEXT to MAX_TEXT in half pixels. The
 * field takes a size once it is one (14 on the way to 145 shows at once); Enter or leaving it keeps it in range.
 */
function TextSize({ size }) {
    const [draft, setDraft] = useState(null);

    // A size set another way (a button, another tab) shows at once, over what was being typed; what is being typed
    // stays while it means this size.
    useEffect(() => {
        if (draft !== null && textSizeOf(draft) !== size) {
            setDraft(null);
        }
    }, [size]);

    const commit = (value) => {
        setDraft(null);
        setPrefs({ text: textSizeOf(value) });
    };

    return html`<div class="text-size" role="group" aria-label="Text size">
        <div class="segmented">
            ${[13, 15, 17, 20].map(
                (each) => html`<button
                    class=${size === each ? "on" : ""}
                    aria-pressed=${size === each}
                    onClick=${() => commit(each)}
                >
                    ${each}
                </button>`,
            )}
        </div>
        <label class="text-size-field">
            <input
                type="number"
                inputmode="decimal"
                min=${MIN_TEXT}
                max=${MAX_TEXT}
                step=${STEP_TEXT}
                aria-label="Text size in pixels"
                value=${draft ?? size}
                onInput=${(event) => {
                    const value = event.currentTarget.value;
                    const number = Number(value);

                    setDraft(value);

                    if (value !== "" && number >= MIN_TEXT && number <= MAX_TEXT) {
                        setPrefs({ text: textSizeOf(number) });
                    }
                }}
                onChange=${(event) =>
                    commit(event.currentTarget.value === "" ? size : event.currentTarget.value)}
                onBlur=${() => setDraft(null)}
                onKeyDown=${(event) => event.key === "Enter" && event.currentTarget.blur()}
            />
            <span>px</span>
        </label>
    </div>`;
}

/** A new density, with the choice tapped kept where it was: the rows above it grow or shrink with the change. */
function chooseDensity(density, event) {
    const button = event.currentTarget;
    const before = button.getBoundingClientRect().top;

    setPrefs({ density });
    requestAnimationFrame(() => {
        const body = button.closest(".sheet-body");

        if (body) {
            body.scrollTop += button.getBoundingClientRect().top - before;
        }
    });
}

function SettingRow({ title, detail, children }) {
    return html`<div class="setting-row">
        <div class="setting-text">
            <span>${title}</span>
            ${detail && html`<span>${detail}</span>`}
        </div>
        ${children}
    </div>`;
}

/**
 * One slot's items, as Layout lists them: each with a switch to show or hide it and arrows to move it, the app's own and
 * extensions' alike. Fixed ones (the menu, Lancet Guard) always show, in their place. Saved in this browser.
 */
function SlotLayout({ slot }) {
    const list = arranged(slot);
    const movable = list.filter(({ item }) => !item.fixed).map(({ item }) => item.id);
    const changed = Object.keys(prefs().layout?.[slot] ?? {}).length > 0;

    return html`<div class="label slot-label">
            <span>${SLOTS[slot].label}</span>
            ${
                changed &&
                html`<button class="button ghost small" onClick=${() => resetSlot(slot)}>
                    Reset
                </button>`
            }
        </div>
        <div class="sheet-list slot-layout" data-slot=${slot}>
            ${list.map(({ item, hidden, hiddenBy }) => {
                const at = movable.indexOf(item.id);
                const detail = [
                    item.module && `From ${item.module}`,
                    hiddenBy && `Hidden by ${hiddenBy}`,
                    item.fixed && "Always shown",
                ]
                    .filter(Boolean)
                    .join(" · ");

                return html`<${SettingRow} key=${item.id} title=${item.label} detail=${detail}>
                    ${
                        !item.fixed &&
                        html`<div class="slot-moves">
                            <button
                                class="icon-button"
                                aria-label=${`Move ${item.label} earlier`}
                                disabled=${at <= 0}
                                onClick=${() => move(slot, item.id, -1)}
                            >
                                <${Icon} name="chevron" size=${16} class="slot-earlier" />
                            </button>
                            <button
                                class="icon-button"
                                aria-label=${`Move ${item.label} later`}
                                disabled=${at === movable.length - 1}
                                onClick=${() => move(slot, item.id, 1)}
                            >
                                <${Icon} name="chevron" size=${16} />
                            </button>
                        </div>
                        <${Switch}
                            on=${!hidden}
                            label=${`Show ${item.label}`}
                            onChange=${() => setShown(slot, item.id, hidden)}
                        />`
                    }
                <//>`;
            })}
        </div>`;
}

export function AppearanceSheet() {
    const p = prefs();

    return html`<${Sheet} title="Appearance" onClose=${closeSheet} wide=${true}>
        <div class="label">Light and dark</div>
        <div class="sheet-list">
            <${SettingRow}
                title="Auto dark mode"
                detail="Light or dark as your system is. Off, keep the one you choose"
            >
                <${Switch}
                    on=${p.mode === "auto"}
                    label="Auto dark mode"
                    onChange=${() => chooseMode(p.mode === "auto" ? modeNow() : "auto")}
                />
            <//>
            ${
                p.mode !== "auto" &&
                html`<${SettingRow} title="Mode" detail="Pi Pocket's pink, on light or on dark">
                    <div class="segmented">
                        ${[
                            ["light", "Light"],
                            ["dark", "Dark"],
                        ].map(
                            ([value, label]) =>
                                html`<button
                                    class=${p.mode === value ? "on" : ""}
                                    aria-pressed=${p.mode === value}
                                    onClick=${(event) => chooseMode(value, event)}
                                >
                                    ${label}
                                </button>`,
                        )}
                    </div>
                <//>`
            }
        </div>
        <div class="label">Layout and motion</div>
        <div class="sheet-list">
            <${SettingRow}
                title="Tiled windows"
                detail="Wide screens: the sidebar and the session as Hyprland windows, with gaps and the active border"
            >
                <${Switch}
                    on=${p.tiling}
                    label="Tiled windows"
                    onChange=${() => setPrefs({ tiling: !p.tiling })}
                />
            <//>
            <${SettingRow}
                title="Peek tiles"
                detail=${`Other sessions beside this one, live while on screen: working, waiting for you, done since you looked, and pinned. Also the tiles button in the top bar${touch ? "" : ", or Alt+P"}`}
            >
                <${Switch}
                    on=${p.peeks}
                    label="Peek tiles"
                    onChange=${() => setPrefs({ peeks: !p.peeks })}
                />
            <//>
            <${SettingRow}
                title="Sidebar"
                detail="Folded, it shows numbered sessions like workspaces"
            >
                <div class="segmented">
                    ${[
                        ["open", "Open"],
                        ["rail", "Folded"],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${p.sidebar === value ? "on" : ""}
                                aria-pressed=${p.sidebar === value}
                                onClick=${() => setPrefs({ sidebar: value })}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
            <${SettingRow}
                title="Motion"
                detail="Auto follows your system's reduced-motion setting. Fluid adds springs, staggered entrances, and layout changes that morph"
            >
                <div class="segmented">
                    ${[
                        ["auto", "Auto"],
                        ["full", "Full"],
                        ["fluid", "Fluid"],
                        ["reduced", "Reduced"],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${p.motion === value ? "on" : ""}
                                aria-pressed=${p.motion === value}
                                onClick=${() => setPrefs({ motion: value })}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
            <${SettingRow}
                title="Text size"
                detail=${`The conversation's, in pixels: any from ${MIN_TEXT} to ${MAX_TEXT}`}
            >
                <${TextSize} size=${textSizeOf(p.text)} />
            <//>
            <${SettingRow}
                title="Width"
                detail="Wide screens: how much of the window the conversation and the message box take. Comfortable grows with the window"
            >
                <div class="segmented">
                    ${[
                        ["comfortable", "Comfortable"],
                        ["wide", "Wide"],
                        ["full", "Full"],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${(p.width ?? "comfortable") === value ? "on" : ""}
                                aria-pressed=${(p.width ?? "comfortable") === value}
                                onClick=${() => setPrefs({ width: value })}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
            <${SettingRow}
                title="Density"
                detail="Less room around messages, rows, and the message box, to fit more on a screen"
            >
                <div class="segmented">
                    ${[
                        ["comfortable", "Comfortable"],
                        ["compact", "Compact"],
                        ["tight", "Tight"],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${p.density === value ? "on" : ""}
                                aria-pressed=${p.density === value}
                                onClick=${(event) => chooseDensity(value, event)}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
        </div>
        <div class="label">Conversation</div>
        <div class="sheet-list">
            <${SettingRow}
                title="Show thinking"
                detail=${`Shows Pi's current thought above the live line as it comes, and its finished thoughts. The chevron before the line folds the live one${touch ? "" : ". Also Alt+T"}`}
            >
                <${Switch}
                    on=${p.showThinking}
                    label="Show thinking"
                    onChange=${() => setPrefs({ showThinking: !p.showThinking })}
                />
            <//>
            <${SettingRow}
                title="Keep activity folded"
                detail="Pi's thinking and tool calls stay on their one line until you open them, also while it works and in the newest turn"
            >
                <${Switch}
                    on=${p.foldActivity}
                    label="Keep activity folded"
                    onChange=${() => setPrefs({ foldActivity: !p.foldActivity })}
                />
            <//>
        </div>
        <div class="label">Status line</div>
        <div class="sheet-list">
            <${SettingRow}
                title="Reply speed"
                detail="Under the message box: how fast the last answer came, in tokens a second, and how long its first token took"
            >
                <${Switch}
                    on=${p.speed}
                    label="Reply speed"
                    onChange=${() => setPrefs({ speed: !p.speed })}
                />
            <//>
        </div>
        ${Object.keys(SLOTS).map((slot) => html`<${SlotLayout} key=${slot} slot=${slot} />`)}
        ${
            !touch &&
            html`<button
                class="button ghost wide sheet-footer"
                onClick=${() => openSheet({ type: "shortcuts" })}
            >
                <${Icon} name="keyboard" size=${16} /> Keyboard shortcuts
            </button>`
        }
    <//>`;
}
