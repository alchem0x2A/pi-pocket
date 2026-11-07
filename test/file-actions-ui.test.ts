// All local-file preview entry points share the same actions, at desktop and phone sizes.
import {
    type App,
    cleanUp,
    lastText,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium" : false };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base: string;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const waitFor = (selector: string) =>
    until(
        async () =>
            inPage<boolean>(
                `return JSON.stringify(!!document.querySelector(${JSON.stringify(selector)}));`,
            ),
        selector,
    );

async function screenshot(name: string) {
    const directory = process.env.PIA_FILE_ACTION_SHOTS;

    if (directory) {
        await page.evaluate(
            '(await import("/store.js")).store.set({notices: []}); await new Promise(resolve => setTimeout(resolve, 1300));',
        );
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            join(directory, `${name}.jpg`),
            Buffer.from((await page.screenshot()).data, "base64"),
        );
    }
}

const overflow = () =>
    inPage<
        string[]
    >(`return JSON.stringify([...document.querySelectorAll(".file-tools > *, .lightbox-bar > *")]
        .filter((element) => element.getClientRects().length > 0)
        .filter((element) => { const box = element.getBoundingClientRect(); return box.left < -0.5 || box.right > innerWidth + 0.5; })
        .map((element) => element.getAttribute("aria-label") || element.className));`);

const tap = async (selector: string) => {
    await waitFor(selector);
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
};

before(async () => {
    if (real.skip) {
        return;
    }

    execFileSync("git", ["init", "-q", work]);
    writeFileSync(join(work, "notes with spaces.txt"), "hello\n");
    writeFileSync(join(work, "notes.txt"), "linked text\n");
    writeFileSync(join(work, "font.woff2"), Buffer.alloc(1_153_434, 0));
    writeFileSync(
        join(work, "drawing.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="pink"/></svg>',
    );
    app = await openApp(
        scriptedModel((request) => {
            const { role, text } = lastText(request as never);

            return role === "user" && text.includes("make a tool file")
                ? fauxAssistantMessage(
                      [
                          fauxToolCall("write", {
                              path: join(work, "tool-created.txt"),
                              content: "A tool-created file.\n",
                          }),
                      ],
                      { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
        }),
    );
    const id = await newSession(app);

    await say(app, id, "[a linked file](notes.txt) and `./font.woff2`\n\n![drawing](drawing.svg)");
    await say(app, id, 'make a tool file and see @"notes with spaces.txt"');
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "file-actions-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await waitFor(".session-row");
    await page.navigate(`${base}/s/${id}`);
    await waitFor(".md a[data-path]");
    await page.evaluate(`
        globalThis.fileActionRequests = [];
        const original = fetch;
        globalThis.fetch = (...args) => {
            globalThis.fileActionRequests.push(String(args[0]));
            return original(...args);
        };
    `);
});

after(async () => {
    if (real.skip) {
        return;
    }

    await browsers.closeAll();
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

test(
    "an agent Markdown file link opens shared actions; Download has a busy state and errors",
    real,
    async () => {
        await tap(".md a[data-path]");
        await waitFor(".file-view");
        await waitFor('[aria-label="Download original file"]');
        await waitFor('[aria-label="Open in Emacs"]');
        await screenshot("desktop-linked-text");
        // The GNU Emacs glyph from Simple Icons is a filled path in Emacs purple, at a thumb-sized target.
        const glyph = await inPage<{
            fill: string;
            stroke: string;
            box: number[];
            size: number[];
            d: string;
        }>(`
            const button = document.querySelector('[aria-label="Open in Emacs"]');
            const svg = button.querySelector('svg.emacs-glyph');
            // Layout sizes, not transformed boxes: a sheet scales a little while it opens.
            const box = { width: button.offsetWidth, height: button.offsetHeight };
            const size = { width: svg.width.baseVal.value, height: svg.height.baseVal.value };
            return JSON.stringify({ fill: getComputedStyle(svg.querySelector('path')).fill,
                stroke: getComputedStyle(svg.querySelector('path')).stroke,
                box: [box.width, box.height], size: [size.width, size.height],
                d: svg.querySelector('path').getAttribute('d') });
        `);

        assert.equal(glyph.fill, "rgb(127, 90, 182)");
        assert.equal(glyph.stroke, "none");
        assert.deepEqual(glyph.box, [40, 40]);
        assert.deepEqual(glyph.size, [20, 20]);
        assert.equal(glyph.d.length, 1299);
        assert.ok(glyph.d.startsWith("M12,24C5.448,24,0.118,18.617,0.118,12S5.448,0,12,0"));
        assert.ok(glyph.d.endsWith("C11.448,19.438,8.047,20.193,8.03,20.197z"));
        assert.equal(
            await inPage<number>(
                "return JSON.stringify(fileActionRequests.filter(url => /download|emacs/.test(url)).length);",
            ),
            0,
            "preview loads cause no action",
        );
        assert.equal(
            await inPage<boolean>(
                'return JSON.stringify(!![...document.querySelectorAll(".file-tools button")].find(b => b.textContent.includes("Mention")));',
            ),
            true,
        );
        assert.equal(
            await inPage<boolean>(
                'return JSON.stringify(!!document.querySelector(".file-tools [aria-label=\\"Show in the file manager\\"]"));',
            ),
            false,
        );

        // Intercept only this click, to observe loading and a clear error without changing any server service.
        await page.evaluate(`
        globalThis.savedFetch = fetch;
        globalThis.fetch = (...args) => String(args[0]).includes('/download?')
            ? new Promise(resolve => { globalThis.completeDownload = () => resolve(new Response(JSON.stringify({error: "The test file is unavailable"}), {status: 404})); })
            : savedFetch(...args);
    `);
        await tap('[aria-label="Download original file"]');
        assert.equal(
            await inPage<boolean>(
                'return JSON.stringify(document.querySelector("[aria-label=\\"Download original file\\"]").disabled);',
            ),
            true,
        );
        await page.evaluate("completeDownload(); globalThis.fetch = savedFetch;");
        await waitFor(".file-action-error");
        assert.match(
            await inPage<string>(
                'return JSON.stringify(document.querySelector(".file-action-error").textContent);',
            ),
            /test file is unavailable/,
        );
        await tap('[aria-label="Download original file"]');
        await until(
            async () =>
                inPage<boolean>(
                    'return JSON.stringify(!document.querySelector("[aria-label=\\"Download original file\\"]").disabled);',
                ),
            "download finished",
        );
    },
);

test(
    "session Files exposes binary downloads and explicit unsupported Emacs errors on mobile",
    real,
    async () => {
        await page.setViewport(VIEWPORTS.mobile);
        await page.evaluate(
            '(await import("/store.js")).closeSheet(); (await import("/files-panel.js")).setFilesOpen(true);',
        );
        await waitFor('.ft-row[data-path$="/font.woff2"]');
        await tap('.ft-row[data-path$="/font.woff2"]');
        await waitFor('.ft-view .file-tools [aria-label="Download original file"]');
        await until(
            async () =>
                inPage<boolean>(
                    'return JSON.stringify(document.querySelector(".ft-view")?.textContent.includes("binary file"));',
                ),
            "binary preview",
        );
        await until(
            async () =>
                inPage<boolean>(
                    'return JSON.stringify(document.querySelector(".ft-view [aria-label=\\"Open in Emacs\\"]").getBoundingClientRect().right <= 390);',
                ),
            "file slide finished",
        );
        const sizes = await inPage<{ width: number; height: number; right: number }[]>(
            'return JSON.stringify([...document.querySelectorAll(".ft-view .file-transfer")].map(b => {const r=b.getBoundingClientRect();return {width:r.width,height:r.height,right:r.right};}));',
        );

        assert.equal(sizes.length, 2);
        assert.ok(
            sizes.every((r) => r.width >= 40 && r.height >= 40 && r.right <= 390),
            JSON.stringify(sizes),
        );
        assert.deepEqual(await overflow(), [], "mobile-binary stays inside the screen");
        await screenshot("mobile-binary");
        await tap('.ft-view [aria-label="Download original file"]');
        await until(
            async () =>
                inPage<boolean>(
                    'return JSON.stringify(!document.querySelector(".ft-view [aria-label=\\"Download original file\\"]").disabled);',
                ),
            "binary downloaded",
        );
        await page.evaluate(
            "globalThis.window.open = () => ({opener: null, close() {}, location: {replace() {}}});",
        );
        await tap('.ft-view [aria-label="Open in Emacs"]');
        await waitFor(".file-action-error");
        assert.match(
            await inPage<string>(
                'return JSON.stringify(document.querySelector(".file-action-error").textContent);',
            ),
            /Download/,
        );
    },
);

test(
    "a failed preview still downloads; a local-image lightbox preserves its own session scope",
    real,
    async () => {
        await page.evaluate(`
            globalThis.previewFetch = fetch;
            globalThis.fetch = (...args) => String(args[0]).includes('/view?')
                ? Promise.resolve(new Response(JSON.stringify({error: 'Preview unavailable'}), {status: 409}))
                : previewFetch(...args);
            globalThis.originalCreateObjectURL = URL.createObjectURL;
            URL.createObjectURL = blob => { globalThis.savedBlob = blob; return originalCreateObjectURL(blob); };
            globalThis.originalAnchorClick = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function() {
                if (this.hasAttribute('download')) { globalThis.savedDownload = {url: this.href, name: this.download}; }
                else { originalAnchorClick.call(this); }
            };
            (await import('/files-panel.js')).setFilesOpen(false);
            (await import('/ui.js')).openFile('notes.txt');
        `);
        await until(
            async () =>
                inPage<boolean>(
                    'return JSON.stringify(document.querySelector(".file-viewer")?.textContent.includes("Preview unavailable"));',
                ),
            "failed preview",
        );
        await tap('[aria-label="Download original file"]');
        await until(
            async () => inPage<boolean>("return JSON.stringify(!!globalThis.savedDownload);"),
            "download without a preview",
        );
        const downloaded = await inPage<{ name: string; text: string }>(
            "return JSON.stringify({name: savedDownload.name, text: await savedBlob.text()});",
        );

        assert.deepEqual(downloaded, { name: "notes.txt", text: "linked text\n" });
        await page.evaluate(
            "globalThis.fetch = previewFetch; URL.createObjectURL = originalCreateObjectURL; HTMLAnchorElement.prototype.click = originalAnchorClick;",
        );
        await page.evaluate('(await import("/store.js")).closeSheet();');
        await tap(".md img");
        await waitFor('.lightbox [aria-label="Download original file"]');
        await tap('.lightbox [aria-label="Download original file"]');
        await until(
            async () =>
                inPage<boolean>(
                    'return JSON.stringify(!document.querySelector(".lightbox [aria-label=\\"Download original file\\"]").disabled);',
                ),
            "SVG downloaded",
        );
        const result = await inPage<{ conversationId: string; path: string }>(
            `const {localImageFile} = await import('/file-actions.js'); return JSON.stringify(localImageFile(location.origin + '/api/c/999/file?path=%2Fimage%20name.svg'));`,
        );

        assert.deepEqual(result, { conversationId: "999", path: "/image name.svg" });
        assert.deepEqual(await overflow(), [], "mobile-image-actions stays inside the screen");
        await screenshot("mobile-image-actions");
        assert.equal(
            await inPage<null>(
                `return JSON.stringify((await import('/file-actions.js')).localImageFile('https://outside.invalid/api/c/999/file?path=x'));`,
            ),
            null,
        );
    },
);

test(
    "inline code, file mentions, tool cards, and Changes use the same file actions",
    real,
    async () => {
        await page.evaluate('(await import("/store.js")).closeSheet();');
        await tap('.md code[data-path="./font.woff2"]');
        await waitFor('.file-viewer [aria-label="Download original file"]');
        await page.evaluate('(await import("/store.js")).closeSheet();');
        await tap(".file-mention");
        await waitFor('.file-viewer [aria-label="Download original file"]');
        await waitFor('.file-viewer [aria-label="Open in Emacs"]');
        await page.evaluate('(await import("/store.js")).closeSheet();');
        await page.evaluate(`
        if (!document.querySelector('.step-head')) { document.querySelector('.activity-head')?.click(); }
    `);
        await waitFor(".step-head");
        await page.evaluate(
            `if (!document.querySelector('.tool-open')) { document.querySelector('.step-head').click(); }`,
        );
        await tap(".tool-open");
        await waitFor('.file-viewer [aria-label="Download original file"]');
        await page.evaluate(
            '(await import("/store.js")).closeSheet(); (await import("/files-panel.js")).setFilesOpen(true, "changes");',
        );
        await tap('.dr-file [aria-label="Open the file"]');
        await waitFor('.ft-view .file-viewer [aria-label="Download original file"]');
        await waitFor('.ft-view .file-viewer [aria-label="Open in Emacs"]');
    },
);

test(
    "unavailable Emacs offers its terminal link; success uses the existing frame without opening a new terminal",
    real,
    async () => {
        await page.evaluate(
            '(await import("/files-panel.js")).setFilesOpen(false); (await import("/ui.js")).openFile("notes.txt");',
        );
        await page.evaluate("await new Promise(resolve => setTimeout(resolve, 700));");
        await waitFor(".sheet .file-view");
        await page.evaluate(`
        globalThis.editorFetch = fetch;
        globalThis.editorOpens = 0;
        globalThis.window.open = () => { globalThis.editorOpens++; return null; };
        globalThis.fetch = (...args) => String(args[0]).endsWith('/emacs')
            ? Promise.resolve(new Response(JSON.stringify({opened: false, url: 'https://editor.example.ts.net:9449/', error: 'Emacs could not open the file. Open the Emacs terminal, then try again.'})))
            : editorFetch(...args);
    `);
        await tap('.file-viewer [aria-label="Open in Emacs"]');
        await waitFor(".file-action-error a");
        assert.equal(await inPage<number>("return JSON.stringify(editorOpens);"), 0);
        assert.equal(
            await inPage<string>(
                'return JSON.stringify(document.querySelector(".file-action-error a").href);',
            ),
            "https://editor.example.ts.net:9449/",
        );
        assert.deepEqual(await overflow(), [], "mobile-emacs-unavailable stays inside the screen");
        await screenshot("mobile-emacs-unavailable");
        await waitFor(".file-action-error a");
        await page.evaluate(`
        globalThis.fetch = (...args) => String(args[0]).endsWith('/emacs')
            ? Promise.resolve(new Response(JSON.stringify({opened: true, url: 'https://editor.example.ts.net:9449/'})))
            : editorFetch(...args);
    `);
        await tap('.file-viewer [aria-label="Open in Emacs"]');
        await until(
            async () =>
                inPage<boolean>(
                    'return JSON.stringify((await import("/store.js")).store.state.notices.some(notice => notice.message.includes("existing Emacs terminal")));',
                ),
            "the existing terminal success notice",
        );
        assert.equal(await inPage<number>("return JSON.stringify(editorOpens);"), 0);
        await page.evaluate("globalThis.fetch = editorFetch;");
    },
);
