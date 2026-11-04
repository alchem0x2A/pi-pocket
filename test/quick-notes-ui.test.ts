// Real browser and throwaway servers: capturing an idea must never start agent work.
import { type App, cleanUp, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
let app: App;
let other: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let handler: ReturnType<typeof createHandler>;
let guestToken = "";
let modelCalls = 0;

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const see = (condition: string, what: string) =>
    until(() => inPage<boolean>(`return JSON.stringify(Boolean(${condition}))`), what, 15_000);
const click = (selector: string) =>
    page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const button = (label: string) =>
    page.evaluate(`
    [...document.querySelectorAll('.quick-notes-panel button')]
        .find((button) => button.textContent.trim() === ${JSON.stringify(label)}).click();
`);
const notes = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll('.quick-note-text')].map((node) => node.textContent))`,
    );
const calls = () =>
    inPage<{ url: string; method: string; stored: boolean; account: string | null }[]>(
        `return JSON.stringify(window.noteTestCalls)`,
    );

async function instrument(): Promise<void> {
    await page.evaluate(`
        window.noteTestCalls = [];
        window.noteTestOffline = false;
        window.noteTestInbox404 = false;
        window.noteTestList404 = false;
        window.noteTestFailedLists = 0;
        const original = window.fetch.bind(window);
        window.fetch = (input, init = {}) => {
            const url = typeof input === 'string' ? input : input.url;
            const method = init.method || 'GET';
            const headers = new Headers(init.headers);
            const account = headers.get('X-Pocket-Account');
            let stored = false;
            if (url === '/api/inbox' && method === 'POST') {
                const note = JSON.parse(init.body);
                stored = JSON.parse(localStorage.getItem('pocket.quick-notes.v2.' + account) || '[]')
                    .some((item) => item.id === note.id && item.text === note.text);
            }
            window.noteTestCalls.push({ url, method, stored, account });
            if (window.noteTestOffline && url.startsWith('/api/inbox')) {
                return Promise.reject(new TypeError('test offline'));
            }
            if (url.startsWith('/api/inbox') && (window.noteTestInbox404 || (window.noteTestList404 && method === 'GET'))) {
                if (window.noteTestList404 && method === 'GET') window.noteTestFailedLists++;
                return Promise.resolve(new Response('Not Found', { status: 404 }));
            }
            return original(input, init);
        };
    `);
}

async function login(token: string, role: string): Promise<void> {
    await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);

    if (
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('form[action="/login"]') !== null)`,
        )
    ) {
        await click('form[action="/login"] button');
        await see(
            `document.querySelector('form[action="/login"]') === null`,
            "account switch completed",
        );
    }

    await see(
        `(await import('/store.js')).store.state.me?.role === ${JSON.stringify(role)} && (await import('/store.js')).store.state.connection === 'open'`,
        `${role} connected`,
    );
    await instrument();
    await new Promise((resolve) => setTimeout(resolve, 500));
}

async function open(): Promise<void> {
    await see(`document.querySelector('.quick-notes-button') !== null`, "quick notes button");
    await click(".quick-notes-button");
    await see(`document.querySelector('.quick-notes-panel') !== null`, "quick notes panel");
}

async function save(text: string): Promise<void> {
    await page.evaluate(`
        const input = document.querySelector('.quick-notes-form textarea');
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await see(`!document.querySelector('.quick-notes-send').disabled`, "save enabled");
    await click(".quick-notes-send");
    await see(
        `[...document.querySelectorAll('.quick-note-text')].some((node) => node.textContent === ${JSON.stringify(text)})`,
        "saved note visible",
    );
}

async function select(text: string): Promise<void> {
    await page.evaluate(
        `[...document.querySelectorAll('.quick-note-select')].find((node) => node.textContent.includes(${JSON.stringify(text)})).click()`,
    );
    await see(`document.querySelector('.quick-note-actions') !== null`, "note actions");
}

async function quiet(): Promise<void> {
    const recorded = await calls();

    assert.deepEqual(
        recorded.filter(
            (call) =>
                call.method === "POST" &&
                (/\/submit(?:\?|$)/.test(call.url) || /\/pip(?:\/|\?|$)/.test(call.url)),
        ),
        [],
        "no chat or PiP POST",
    );
    assert.equal(modelCalls, 0, "the model did not run");
}

before(async () => {
    if (real.skip) {
        return;
    }

    const model = () =>
        scriptedModel(() => {
            modelCalls++;

            throw new Error("unexpected model run");
        });

    app = await openApp(model(), join(root, "notes-owner"));
    other = await openApp(model(), join(root, "notes-other"));
    guestToken = app.config.addUser("Guest", "guest").token;
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "notes-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.desktop);
    await login(app.config.ownerToken, "owner");
});

after(async () => {
    try {
        await browsers?.closeAll({ final: true });
        server?.closeAllConnections();
        server?.close();
        await app?.close();
        await other?.close();
    } finally {
        cleanUp();
    }
});

test("capture keeps the synchronized note in the default pending list", real, async () => {
    const before = app.sessions(owner(app)).length;

    await open();
    await save("A pending idea");
    await see(
        `document.querySelector('.quick-note-state')?.textContent === 'Synced to inbox'`,
        "inbox sync",
    );
    assert.ok(
        (await calls()).some(
            (call) => call.url === "/api/inbox" && call.method === "POST" && call.stored,
        ),
        "local storage precedes POST",
    );
    assert.deepEqual(
        await notes(),
        ["A pending idea"],
        "a synchronized pending note remains visible after the server list refresh",
    );
    await select("A pending idea");
    const controls = await inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll('.quick-notes-panel button')].map((button) => button.textContent.trim()))`,
    );

    assert.ok(controls.includes("Continue in conversation"));

    for (const label of ["Archive", "Restore", "Pending", "Archived", "Deliver"]) {
        assert.ok(!controls.includes(label), `${label} control is absent`);
    }

    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('.quick-notes-panel').textContent.includes('Ideas only. Saving starts no agent work.'))`,
        ),
        false,
    );
    assert.equal(app.sessions(owner(app)).length, before);
    await quiet();
});

test("server archived notes remain hidden without archive controls", real, async () => {
    const before = app.sessions(owner(app)).length;

    await save("Archive idea");
    await see(
        `document.querySelector('.quick-note-state')?.textContent === 'Synced to inbox'`,
        "archive candidate synced",
    );
    const note = (await app.inbox.list(owner(app), true)).find(
        (item) => item.text === "Archive idea",
    );

    assert.ok(note);
    await app.inbox.archive(owner(app), note.id, true);
    await page.evaluate(`dispatchEvent(new Event('online'))`);
    await see(
        `![...document.querySelectorAll('.quick-note-text')].some((node) => node.textContent === 'Archive idea')`,
        "archived note hidden from pending",
    );
    assert.equal(
        (await app.inbox.list(owner(app), true)).find((item) => item.id === note.id)?.state,
        "archived",
    );
    assert.equal(app.sessions(owner(app)).length, before);
    await quiet();
});

test("404 keeps a local note visible and retries until inbox sync succeeds", real, async () => {
    const before = app.sessions(owner(app)).length;

    await page.evaluate(`window.noteTestInbox404 = true`);
    await save("Endpoint unavailable idea");
    await see(
        `document.querySelector('.quick-notes-sync-status')?.textContent.trim() === '1 note on this device — not synced yet'`,
        "compact unsynced status",
    );
    await see(
        `/404/.test(document.querySelector('.quick-notes-sync-detail')?.textContent || '') && /endpoint/i.test(document.querySelector('.quick-notes-sync-detail')?.textContent || '') && /restart/i.test(document.querySelector('.quick-notes-sync-detail')?.textContent || '')`,
        "404 endpoint and restart detail",
    );
    assert.ok((await notes()).includes("Endpoint unavailable idea"));
    await page.evaluate(
        `window.noteTestInbox404 = false; window.noteTestList404 = true; dispatchEvent(new Event('online'))`,
    );
    await until(
        async () =>
            (await app.inbox.list(owner(app), true)).some(
                (note) => note.text === "Endpoint unavailable idea",
            ),
        "automatic retry posts the local note",
    );
    await see(`window.noteTestFailedLists > 0`, "inbox list retry failed");
    await see(
        `document.querySelector('.quick-notes-sync-status') !== null`,
        "status remains when the inbox list still fails",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await page.evaluate(`window.noteTestList404 = false; dispatchEvent(new Event('online'))`);
    await see(
        `document.querySelector('.quick-notes-sync-status') === null`,
        "successful inbox sync clears status",
    );
    assert.ok((await notes()).includes("Endpoint unavailable idea"));
    assert.equal(app.sessions(owner(app)).length, before);
    await quiet();
});

test("offline capture persists before reconnect and syncs only to inbox", real, async () => {
    const before = app.sessions(owner(app)).length;

    await page.evaluate(`window.noteTestOffline = true`);
    await save("Offline idea");
    await see(
        `[...document.querySelectorAll('.quick-note')].some((row) => row.textContent.includes('Offline idea') && row.textContent.includes('Saved locally'))`,
        "local state",
    );
    await page.evaluate(`window.noteTestOffline = false; dispatchEvent(new Event('online'))`);
    await see(
        `[...document.querySelectorAll('.quick-note')].some((row) => row.textContent.includes('Offline idea') && row.textContent.includes('Synced to inbox'))`,
        "reconnected inbox sync",
    );
    assert.ok(
        (await calls())
            .filter((call) => call.url === "/api/inbox" && call.method === "POST")
            .every((call) => call.stored),
    );
    await until(
        async () =>
            (await app.inbox.list(owner(app), true)).some((note) => note.text === "Offline idea"),
        "offline idea durably synced",
    );
    assert.equal(app.sessions(owner(app)).length, before);
    await quiet();
});

test(
    "explicit Continue creates one idle conversation with a draft, never a submission",
    real,
    async () => {
        const before = app.sessions(owner(app)).length;

        await select("Offline idea");
        await button("Continue in conversation");
        await see(
            `document.querySelector('.composer textarea')?.value === 'Offline idea'`,
            "conversation draft",
        );
        await until(() => app.sessions(owner(app)).length === before + 1, "one new conversation");
        const id = await inPage<number>(
            `return JSON.stringify((await import('/store.js')).store.state.view.conversation.id)`,
        );

        assert.equal(app.isBusy(id as never), false);
        assert.equal(
            (await app.transcripts.allEntries(id as never, true)).filter(
                (entry) => entry.kind === "user" || entry.kind === "assistant",
            ).length,
            0,
        );
        assert.equal(
            (await calls()).filter(
                (call) => call.url.endsWith("/continue") && call.method === "POST",
            ).length,
            1,
        );
        await quiet();
        await open();
        assert.ok(!(await notes()).includes("Offline idea"));
        assert.equal(
            (await app.inbox.list(owner(app), true)).find((note) => note.text === "Offline idea")
                ?.state,
            "archived",
        );
    },
);

test(
    "guest and another owner cannot see or synchronize the prior owner cache; stale account is rejected",
    real,
    async () => {
        const first = owner(app).id;

        await login(guestToken, "guest");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.quick-notes-button') !== null)`,
            ),
            false,
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.body.textContent.includes('A pending idea'))`,
            ),
            false,
        );
        const guestStatus = await inPage<number>(
            `const response = await fetch('/api/inbox?archived=true', { headers: { 'X-Pocket': '1', 'X-Pocket-Account': ${JSON.stringify(first)} } }); return JSON.stringify(response.status)`,
        );

        assert.ok(guestStatus === 403 || guestStatus === 409, `guest rejected: ${guestStatus}`);
        await quiet();
        handler = createHandler({
            app: other,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        });
        await login(other.config.ownerToken, "owner");
        const staleStatus = await inPage<number>(
            `const response = await fetch('/api/inbox', { method: 'POST', headers: { 'X-Pocket': '1', 'X-Pocket-Account': ${JSON.stringify(first)}, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'stale-request', text: 'stale', createdAt: Date.now() }) }); return JSON.stringify(response.status)`,
        );

        assert.ok(
            staleStatus === 403 || staleStatus === 409,
            `stale owner rejected: ${staleStatus}`,
        );
        await open();
        await see(
            `document.querySelector('.quick-notes-empty') !== null`,
            "other owner has empty inbox",
        );
        assert.deepEqual(await notes(), []);
        await page.evaluate(`dispatchEvent(new Event('online'))`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(
            (await calls()).filter(
                (call) =>
                    call.url === "/api/inbox" &&
                    call.method === "POST" &&
                    call.account === owner(other).id,
            ).length,
            0,
            "prior cache not synchronized to other owner",
        );
        await quiet();
    },
);

test(
    "a stale cookie rejection hides the old inbox before revalidation without a page reload",
    real,
    async () => {
        const prior = owner(other).id;
        const replacement = other.config.addUser("Other owner", "owner");

        await save("Old account private idea");
        await see(
            `[...document.querySelectorAll('.quick-note')].some((row) => row.textContent.includes('Old account private idea') && row.textContent.includes('Synced to inbox'))`,
            "prior account note synced",
        );
        // Hold the cross-tab storage lock while capture waits. New typing must survive the save.
        await page.evaluate(`
            window.testLockAcquired = new Promise((resolve) => { window.testAcquired = resolve; });
            window.testLockReleased = new Promise((resolve) => { window.testReleaseLock = resolve; });
            navigator.locks.request('pocket.inbox:pocket.quick-notes.v2.' + ${JSON.stringify(prior)}, async () => {
                window.testAcquired();
                await window.testLockReleased;
            });
            await window.testLockAcquired;
            const field = document.querySelector('.quick-notes-form textarea');
            field.value = 'Capture while locked';
            field.dispatchEvent(new Event('input', { bubbles: true }));
        `);
        await see(`!document.querySelector('.quick-notes-send').disabled`, "locked save enabled");
        await click(".quick-notes-send");
        await page.evaluate(`
            const field = document.querySelector('.quick-notes-form textarea');
            field.value = 'Newer draft while saving';
            field.dispatchEvent(new Event('input', { bubbles: true }));
            window.testReleaseLock();
        `);
        await see(
            ` [...document.querySelectorAll('.quick-note-text')].some((node) => node.textContent === 'Capture while locked')`,
            "locked capture completed",
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('.quick-notes-form textarea').value)`,
            ),
            "Newer draft while saving",
        );
        await see(
            ` [...document.querySelectorAll('.quick-note')].some((row) => row.textContent.includes('Capture while locked') && row.textContent.includes('Synced to inbox'))`,
            "locked capture synced",
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        await page.evaluate(`
        window.testLateAcquired = new Promise((resolve) => { window.testLateAcquire = resolve; });
        window.testLateReleased = new Promise((resolve) => { window.testLateRelease = resolve; });
        navigator.locks.request('pocket.inbox:pocket.quick-notes.v2.' + ${JSON.stringify(prior)}, async () => {
            window.testLateAcquire();
            await window.testLateReleased;
        });
        await window.testLateAcquired;
        const field = document.querySelector('.quick-notes-form textarea');
        field.value = 'Late locked capture';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        `);
        await click(".quick-notes-send");
        await page.evaluate(`
        const field = document.querySelector('.quick-notes-form textarea');
        field.value = 'Private unfinished draft';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        const testPriorFetch = window.fetch;
        window.testRevalidationRequested = false;
        window.testRevalidationGate = new Promise((resolve) => { window.testReleaseRevalidation = resolve; });
        window.fetch = async (input, init) => {
            const url = typeof input === 'string' ? input : input.url;
            if (url === '/api/me') {
                window.testRevalidationRequested = true;
                await window.testRevalidationGate;
            }
            return testPriorFetch(input, init);
        };
    `);
        await page.evaluate(`
        await fetch('/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: ${JSON.stringify(replacement.token)} }),
        });
    `);
        assert.equal(
            await inPage<string>(
                `return JSON.stringify((await import('/store.js')).store.state.me.id)`,
            ),
            prior,
            "the original tab has not reloaded or received a new identity",
        );
        await page.evaluate(`dispatchEvent(new Event('online'))`);
        await see(
            `window.testRevalidationRequested`,
            "revalidation begins after rejected inbox request",
        );
        await see(`document.querySelector('.quick-notes-panel') === null`, "old panel closed");
        await page.evaluate(`window.testLateRelease()`);
        await see(
            `JSON.parse(localStorage.getItem('pocket.quick-notes.v2.' + ${JSON.stringify(prior)}) || '[]').some((note) => note.text === 'Late locked capture')`,
            "late locked capture completed",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.quick-notes-panel') === null)`,
            ),
            true,
            "late publication cannot reopen the old inbox",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.body.textContent.includes('Old account private idea'))`,
            ),
            false,
        );
        assert.equal(
            await inPage<string | null>(
                `return JSON.stringify(localStorage.getItem('pocket.inbox.account'))`,
            ),
            null,
        );
        await page.evaluate(`window.testReleaseRevalidation()`);
        await see(
            `(await import('/store.js')).store.state.me?.id === ${JSON.stringify(replacement.user.id)} && (await import('/store.js')).store.state.connection === 'open'`,
            "replacement account confirmed",
        );
        await open();
        await see(
            `document.querySelector('.quick-notes-empty') !== null`,
            "replacement account inbox empty",
        );
        assert.deepEqual(await notes(), []);
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('.quick-notes-form textarea').value)`,
            ),
            "",
        );
        await quiet();
    },
);
