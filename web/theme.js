// Appearance: one palette (after Rosé Pine, in style.css), light or dark by the system's setting or by choice, tiled
// windows, motion, text size, density, and the sidebar's shape. Saved per browser. index.html applies the last look
// before the first paint from `pocket.themeCache`, so a reload never flashes the other mode.
import { store } from "./store.js";

const KEY = "pocket.appearance";
const CACHE = "pocket.themeCache";
const PINNED = "pocket.pinned";

/** The conversation's text size in pixels: anything from MIN_TEXT to MAX_TEXT, in steps of STEP_TEXT. */
export const MIN_TEXT = 10;
export const MAX_TEXT = 32;
export const STEP_TEXT = 0.5;

/** A text size someone typed or saved, kept in range and on a step; the default for one that is not a number. */
export function textSizeOf(value) {
    const size = Number(value);

    if (value === null || value === "" || !Number.isFinite(size)) {
        return 15;
    }

    return Math.min(MAX_TEXT, Math.max(MIN_TEXT, Math.round(size / STEP_TEXT) * STEP_TEXT));
}

const DEFAULTS = {
    /** Light or dark: "auto" follows the system's setting; "light" or "dark" keeps one. */
    mode: "auto",
    /** Wide screens: the sidebar and the conversation as Hyprland windows, with gaps and borders. */
    tiling: true,
    /**
     * "auto" follows the system's reduced-motion setting; "full" is the app's usual motion, "reduced" none, and "fluid"
     * the most: springs, staggered entrances, and layout changes that morph (`motionLevel`).
     */
    motion: "auto",
    /** The conversation's text in pixels, MIN_TEXT to MAX_TEXT; the rest of the app keeps its own sizes. */
    text: 15,
    /** How much room the spacing takes: "comfortable", "compact", or "tight". Font sizes stay. */
    density: "comfortable",
    /**
     * How wide the conversation and the message box are on a wide screen: "comfortable" (the theme's width, which grows
     * with the pane), "wide" (most of the pane), or "full" (all of it).
     */
    width: "comfortable",
    /** The sidebar on wide screens: "open", or "rail" (icons and numbered sessions only). */
    sidebar: "open",
    /** The open sidebar's width, its borders, the rail, and the list's: a 254px list. */
    sidebarWidth: 312,
    /** How the session list groups: "recent" (by day) or "folder". */
    group: "recent",
    /** Other sessions' live work as peek tiles beside the session (a strip on narrow screens). Off until turned on. */
    peeks: false,
    /** How fast the last answer came, in the status line under the message box. Off until turned on. */
    speed: false,
    /** Pi's current thought above the live line, and its finished thoughts open. Off until turned on. */
    showThinking: false,
    /**
     * Pi's thinking and tool calls stay folded into their one line until opened, also while they run and in the newest
     * turn; off, the newest turn's groups open as they come. A group opened or closed by hand keeps that choice, and a
     * thought alone in its group still follows Show thinking. Off until turned on.
     */
    foldActivity: false,
    /** This browser's own layout of each slot (`slots.js`): `{ [slot]: { order: [ids], hidden: { [id]: boolean } } }`. */
    layout: {},
};

function readJson(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key) ?? "null");

        return value ?? fallback;
    } catch {
        return fallback;
    }
}

const reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");
/** The system's light or dark, which Auto follows. */
const lightQuery = matchMedia("(prefers-color-scheme: light)");

/** Set once this browser's saved look has the sidebar's width for the rail beside the list. */
const RAIL_KEY = "pocket.railBeside";
/** Set once this browser's saved look has the soft tiles' text size and sidebar. */
const SOFT_KEY = "pocket.softTiles";

/**
 * What this browser saved. The sidebar's usual width was 300 before the rail went beside the list, then 324, and is
 * 312 with soft tiles. The text size was the whole app's, 12 to 16; it is now the conversation's, a step larger.
 */
function savedPrefs() {
    const saved = readJson(KEY, {});

    if (localStorage.getItem(SOFT_KEY) !== null) {
        return saved;
    }

    // Either usual width, the one from before the rail went beside the list too.
    const usual =
        saved.sidebarWidth === 324 ||
        (saved.sidebarWidth === 300 && !localStorage.getItem(RAIL_KEY));
    const next = {
        ...saved,
        ...(usual && { sidebarWidth: DEFAULTS.sidebarWidth }),
        ...(typeof saved.text === "number" && { text: saved.text + 1 }),
    };

    localStorage.setItem(RAIL_KEY, "1");
    localStorage.setItem(SOFT_KEY, "1");
    localStorage.setItem(KEY, JSON.stringify(next));

    return next;
}

/**
 * Appearance's Width, past Comfortable: the column's width and the message box's, set inline so they win over a theme's.
 * Each grows with the pane (a percentage of it) and has a floor of today's column, so phones and narrow windows stay as
 * they are.
 */
const WIDTHS = {
    wide: {
        "--transcript-width": "clamp(720px, 92%, 1600px)",
        "--composer-width": "calc(clamp(720px, 92%, 1600px) + 48px)",
    },
    full: { "--transcript-width": "100%", "--composer-width": "100%" },
};

/** The open sidebar's width as it shows: the rail and its borders, and a list 204–464px wide. */
const sidebarWidth = (p) => `${Math.min(524, Math.max(264, p.sidebarWidth))}px`;

/**
 * This browser's own choices: what it saved, over the defaults. Choices from before the one palette (a theme folder,
 * colors, the desktop's wallpaper) go.
 */
const { theme: _colors, look: _look, wallpaper: _wallpaper, ...saved } = savedPrefs();
let own = { ...DEFAULTS, ...saved };

if (_colors !== undefined || _look !== undefined || _wallpaper !== undefined) {
    localStorage.setItem(KEY, JSON.stringify(own));
}

for (const key of ["pocket.themeChosen", "pocket.themeDefault", "pocket.desktopTheme"]) {
    localStorage.removeItem(key);
}

store.set({
    appearance: own,
    pinned: readJson(PINNED, []),
});

export const prefs = () => store.state.appearance;

/** The settings that move the windows: with Fluid motion, changing one morphs the layout (`morph`). */
const MORPHS = new Set(["sidebar", "width", "tiling"]);
let morphing = false;
let morphs = 0;

/**
 * Make `change` a view transition in which the windows slide and resize into their new places (style.css,
 * `layout-vt`), and say whether it did: only with Fluid motion, in a browser that has view transitions, on a page in
 * view, with nothing over the windows. The change itself comes a frame later, once the old layout is captured.
 */
function morph(change) {
    if (
        morphing ||
        motionLevel() !== "fluid" ||
        typeof document.startViewTransition !== "function" ||
        document.visibilityState !== "visible" ||
        // The windows would draw over a sheet or the launcher while they move: with one open, change at once.
        document.querySelector(".overlay, .launcher-overlay")
    ) {
        return false;
    }

    const root = document.documentElement;
    // A second change while one runs skips the first; only the newest one takes the class off when it ends.
    const mine = ++morphs;

    root.classList.add("layout-vt");
    const run = document.startViewTransition(async () => {
        morphing = true;

        try {
            change();
        } finally {
            morphing = false;
        }

        // The store renders in a microtask; let it finish before the new layout is captured.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    settleTransition(run, () => mine === morphs && root.classList.remove("layout-vt"));

    return true;
}

export function setPrefs(patch) {
    const moved = Object.keys(patch).some((key) => MORPHS.has(key) && patch[key] !== prefs()[key]);

    if (moved && morph(() => setPrefs(patch))) {
        return;
    }

    own = { ...own, ...patch };
    localStorage.setItem(KEY, JSON.stringify(own));
    store.set({ appearance: own });
    apply();
}

// ─── Pinned sessions (this browser) ──────────────────────────────────────────────

/** The pinned ids as a set, made again only when the list changes: rows ask for each session as they draw. */
let pinnedSet = { list: null, set: new Set() };

export function isPinned(id) {
    const list = store.state.pinned;

    if (pinnedSet.list !== list) {
        pinnedSet = { list, set: new Set(list) };
    }

    return pinnedSet.set.has(id);
}

export function togglePin(id) {
    const pinned = isPinned(id)
        ? store.state.pinned.filter((each) => each !== id)
        : [...store.state.pinned, id];

    localStorage.setItem(PINNED, JSON.stringify(pinned));
    store.set({ pinned });
}

/** The mode on the page: the one chosen, or with Auto, the system's. */
export const modeNow = (p = prefs()) =>
    p.mode === "light" || p.mode === "dark" ? p.mode : lightQuery.matches ? "light" : "dark";

/** The mode in words, for the menu's Appearance row and the home screen: "Auto · dark", "Light". */
export const modeLabel = (p = prefs()) =>
    p.mode === "auto" ? `Auto · ${modeNow(p)}` : modeNow(p) === "light" ? "Light" : "Dark";

/** The motion on the page, from Appearance's choice: "reduced", "full", or "fluid" (chosen only, never by Auto). */
export function motionLevel() {
    const motion = prefs().motion;

    if (motion === "reduced" || (motion === "auto" && reduceQuery.matches)) {
        return "reduced";
    }

    return motion === "fluid" ? "fluid" : "full";
}

const reducedMotion = () => motionLevel() === "reduced";

/** Put the current look on the page: the mode, sizes, and the switches style.css reads from data attributes. */
export function apply() {
    const root = document.documentElement;
    const p = prefs();
    // Width other than Comfortable is the person's choice, set inline; Comfortable leaves it to style.css.
    const width = WIDTHS[p.width];
    const inline = {
        "--text-size": `${textSizeOf(p.text)}px`,
        "--sidebar-w": sidebarWidth(p),
        ...(width ?? {}),
    };

    if (!width) {
        root.style.removeProperty("--transcript-width");
        root.style.removeProperty("--composer-width");
    }

    for (const [name, value] of Object.entries(inline)) {
        root.style.setProperty(name, value);
    }

    const mode = modeNow(p);
    const attrs = {
        mode,
        tiling: p.tiling ? "on" : "off",
        motion: motionLevel(),
        rail: p.sidebar === "rail" ? "on" : "off",
        density: p.density,
        width: width ? p.width : "comfortable",
    };

    Object.assign(root.dataset, attrs);
    // The page's ground, as style.css has it for the mode: the browser's bar takes its color.
    const ground = getComputedStyle(root).getPropertyValue("--o-bg").trim();

    if (ground) {
        document.querySelector('meta[name="theme-color"]')?.setAttribute("content", ground);
    }

    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", mode);
    localStorage.setItem(
        CACHE,
        JSON.stringify({ vars: inline, attrs, auto: p.mode === "auto", color: ground }),
    );
}

/**
 * Change the look with a circle that grows from `at` (a click's place) over the old one, as a view transition. Without
 * view transitions, or with reduced motion, it changes at once.
 */
let transitions = 0;

function transition(change, at) {
    const root = document.documentElement;

    if (
        typeof document.startViewTransition !== "function" ||
        reducedMotion() ||
        document.visibilityState !== "visible"
    ) {
        change();

        return;
    }

    const x = at?.x ?? innerWidth / 2;
    const y = at?.y ?? innerHeight / 2;

    root.style.setProperty("--vt-x", `${x}px`);
    root.style.setProperty("--vt-y", `${y}px`);
    root.style.setProperty(
        "--vt-r",
        `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`,
    );
    root.classList.add("theme-vt");
    // A second change while one runs skips the first; only the newest one takes the class off when it ends.
    const mine = ++transitions;
    const run = document.startViewTransition(async () => {
        await change();
        // The store renders in a microtask; let it finish before the new look is captured.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    settleTransition(run, () => mine === transitions && root.classList.remove("theme-vt"));
}

/** A rapid change can skip a transition: handle each promise, and clean up even when it was skipped. */
function settleTransition(run, clean) {
    run.ready.catch(() => {});
    run.updateCallbackDone.catch(() => {});
    run.finished.then(clean, clean);
}

/** Change light or dark ("auto", "light", or "dark"), with the reveal starting from where the person clicked. */
export function chooseMode(mode, event) {
    const at =
        event && "clientX" in event && (event.clientX || event.clientY)
            ? { x: event.clientX, y: event.clientY }
            : undefined;

    if (mode === prefs().mode) {
        return;
    }

    const before = modeNow();
    const change = () => setPrefs({ mode });

    if (modeNow({ ...prefs(), mode }) === before) {
        change();

        return;
    }

    transition(change, at);
}

let started = false;

/** Put the look on the page, and again whenever the system's light or dark or reduced motion changes. */
export function startTheme() {
    apply();

    if (started) {
        return;
    }

    started = true;
    reduceQuery.addEventListener?.("change", apply);
    lightQuery.addEventListener?.("change", apply);
}
