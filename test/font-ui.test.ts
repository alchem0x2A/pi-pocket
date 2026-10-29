// The app's fonts, in a real browser where this machine has Chromium: the default look, with real italics and the Nerd
// Fonts icons, motion, and the text size.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script).catch(() => false)) === true, what);

type Look = {
    prose: string;
    code: string;
    ligatures: string;
    preloads: string[];
    loaded: string[];
    italics: string[];
};

/**
 * Open a sheet, or close it (null), and wait until the app shows it so. Not awaited in the script that asks: a promise a
 * script waits on can be collected before it settles, which fails the call.
 */
async function sheet(type: string | null): Promise<void> {
    await page.evaluate(`
        import("/store.js").then(({ openSheet, closeSheet }) =>
            ${type === null ? "closeSheet()" : `openSheet({ type: ${JSON.stringify(type)} })`},
        );
        "asked";
    `);
    await see(
        `return JSON.stringify(((await import("/store.js")).store.state.sheet?.type ?? null) === ${JSON.stringify(type)})`,
        type === null ? "the sheet closed" : `the ${type} sheet`,
    );
}

/** Open the session afresh, as a reload would, and say which fonts it uses where. */
let opened = 0;

async function open(): Promise<Look> {
    await page.evaluate(`window.fontTestOldPage = true`);
    // A sheet just closed goes back through history a moment later, which cancels a navigation under way.
    await until(
        async () =>
            (await page.navigate(`${base}/s/${session}?open=${++opened}`)).error === undefined,
        "a navigation that is not cancelled",
    );
    await see(
        `return JSON.stringify(window.fontTestOldPage === undefined)`,
        "the page loaded again",
    );
    await see(
        `return JSON.stringify(document.querySelector(".md pre code .hl-com") !== null && document.fonts.status === "loaded")`,
        "the reply's code, and the fonts",
    );

    return inPage<Look>(`
        const first = (element) => getComputedStyle(element).fontFamily.split(",")[0].trim().replace(/"/g, "");
        const faces = [...document.fonts].filter((face) => face.status === "loaded");

        return JSON.stringify({
            prose: first(document.querySelector(".md p")),
            code: first(document.querySelector(".md pre code")),
            ligatures: getComputedStyle(document.querySelector(".md pre code")).fontVariantLigatures,
            preloads: [...document.querySelectorAll('link[rel="preload"][as="font"]')].map((link) =>
                link.getAttribute("href"),
            ),
            loaded: [...new Set(faces.map((face) => face.family))].toSorted(),
            italics: [...new Set(faces.filter((face) => face.style === "italic").map((face) => face.family))],
        });
    `);
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());

    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "font-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    session = await newSession(app);
    // The scripted model echoes it: a reply with words, and code with a comment (italic) and an arrow (a ligature).
    await say(
        app,
        session,
        "Some prose, then code:\n\n```js\n// a comment\nconst f = (x) => x !== 42;\n```",
    );
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    // A guest: the look is each browser's own.
    const { token } = app.config.addUser("Guest", "guest");

    await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "guest")`,
        "signed in as a guest",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the default look keeps its fonts, with JetBrains Mono's own italic for comments",
    real,
    async () => {
        await page.evaluate(`localStorage.clear()`);

        const shown = await open();

        assert.equal(shown.prose, "Pocket Sans");
        assert.equal(shown.code, "Pocket Mono");
        assert.equal(shown.ligatures, "none");
        assert.deepEqual(shown.preloads, ["/fonts/Geist.woff2", "/fonts/JetBrainsMono.woff2"]);
        assert.deepEqual(shown.italics, ["Pocket Mono"], "the comment from its italic file");
    },
);

test(
    "the Nerd Fonts icons come from a file that loads only for them, one cell wide",
    real,
    async () => {
        await page.evaluate(`localStorage.clear()`);

        const plain = await open();

        assert.ok(!plain.loaded.includes("Pocket Nerd Symbols"), "no icons, no icon file");

        const drawn = await inPage<{ width: number; loaded: boolean }>(`
        const icon = document.createElement("code");

        icon.textContent = "\\u{F07C}\\u{E0A0}";
        document.querySelector(".md").append(icon);
        await document.fonts.load("14px " + getComputedStyle(icon).fontFamily, icon.textContent);
        const width = icon.getBoundingClientRect().width;

        icon.textContent = "ab";
        const letters = icon.getBoundingClientRect().width;
        icon.remove();

        return JSON.stringify({
            width: Math.round((width / letters) * 100) / 100,
            loaded: [...document.fonts].some((face) => face.family === "Pocket Nerd Symbols" && face.status === "loaded"),
        });
    `);

        assert.ok(drawn.loaded, "the icons' file loads for an icon");
        assert.equal(drawn.width, 1, "each icon one letter wide, so columns line up");
    },
);

test("message jumps use the app's motion choice instead of the OS query", real, async () => {
    await open();
    const modes = await inPage<string[]>(`
        const { setPrefs } = await import('/theme.js');
        const { jumpToEntry } = await import('/chat.js');
        const id = Number(document.querySelector('[id^="entry-"]').id.slice(6));
        const scroll = Element.prototype.scrollIntoView;
        const query = window.matchMedia;
        const modes = [];
        Element.prototype.scrollIntoView = (options) => modes.push(options.behavior);
        try {
            window.matchMedia = (text) => text === '(prefers-reduced-motion: reduce)' ? { matches: false } : query(text);
            setPrefs({ motion: 'reduced' });
            await jumpToEntry(id);
            window.matchMedia = (text) => text === '(prefers-reduced-motion: reduce)' ? { matches: true } : query(text);
            setPrefs({ motion: 'full' });
            await jumpToEntry(id);
        } finally {
            Element.prototype.scrollIntoView = scroll;
            window.matchMedia = query;
            setPrefs({ motion: 'auto' });
        }
        return JSON.stringify(modes);
    `);

    assert.deepEqual(modes, ["auto", "smooth"]);
});

/** Wait until the sheet stops moving: it rises as it opens, and a click mid-rise misses. */
const settled = () =>
    see(
        `const at = () => document.querySelector(".text-size-field input").getBoundingClientRect().top;
        const before = at();

        await new Promise((resolve) => setTimeout(resolve, 150));

        return JSON.stringify(document.getAnimations().length === 0 && at() === before);`,
        "the sheet at rest",
    );

test("any text size from 10 to 32 px can be typed, and stays", real, async () => {
    await page.evaluate(`localStorage.clear()`);
    await open();
    await sheet("appearance");
    await see(
        `return JSON.stringify(document.querySelector(".text-size-field input") !== null)`,
        "the size field",
    );
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('[role="group"][aria-label="Text size"]')?.contains(document.querySelector('.text-size-field input')))`,
        ),
        true,
    );
    await page.scroll({ selector: ".text-size-field input" });
    await settled();
    await page.type({ selector: ".text-size-field input" }, "27.5", { submit: true });
    await sheet(null);
    await open();

    const size = await inPage<string>(
        `return JSON.stringify(getComputedStyle(document.querySelector(".md p")).fontSize)`,
    );

    assert.equal(size, "27.5px");
    await sheet("appearance");
    await see(
        `return JSON.stringify(document.querySelector(".text-size-field input") !== null)`,
        "the size field",
    );
    await page.scroll({ selector: ".text-size-field input" });
    await settled();
    await page.type({ selector: ".text-size-field input" }, "99", { submit: true });
    await see(
        `return JSON.stringify(document.querySelector(".text-size-field input").value === "32")`,
        "a size past the largest kept to it",
    );
});
