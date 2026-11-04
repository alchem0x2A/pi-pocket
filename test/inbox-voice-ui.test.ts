// Real Chromium and isolated app data. Mocked Web Speech does not test a physical microphone,
// browser/provider permission prompts, audio capture, or a speech provider's transcription service.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const field = ".quick-notes-form textarea";
const mic = '.quick-notes-capture-actions .quick-notes-mic[aria-label="Dictate"]';
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let route = 0;
let modelCalls = 0;
let sessionsBefore = 0;

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const see = (condition: string, state: string) =>
    until(() => inPage<boolean>(`return JSON.stringify(Boolean(${condition}))`), state, 15_000);
const click = (selector: string) =>
    page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const sessionCount = async () =>
    Object.keys((await app.harness.snapshot(SessionsDoc, context))?.items ?? {}).length;
const draftIs = (value: string) =>
    see(
        `document.querySelector(${JSON.stringify(field)})?.value === ${JSON.stringify(value)}`,
        "expected draft state",
    );
const localCount = () =>
    inPage<number>(`
        const { store } = await import('/store.js');
        return JSON.stringify(JSON.parse(localStorage.getItem('pocket.quick-notes.v2.' + store.state.me.id) || '[]').length);
    `);

/** Install after load, before opening the panel: voice.js must look up availability at runtime. */
async function instrument(): Promise<void> {
    await page.evaluate(`
        window.voiceTest = { recognitions: [], calls: [], offline: false };
        window.SpeechRecognition = class {
            onresult = null;
            onerror = null;
            onend = null;
            starts = 0;
            stops = 0;
            aborts = 0;
            active = false;
            constructor() { window.voiceTest.recognitions.push(this); }
            start() { this.starts++; this.active = true; }
            stop() { this.stops++; this.active = false; }
            abort() { this.aborts++; this.active = false; }
            emit(phrases) {
                this.onresult?.({ results: phrases.map(([transcript, isFinal]) => ({
                    0: { transcript }, isFinal, length: 1,
                })) });
            }
            fail(error) { this.onerror?.({ error }); }
            end() { this.active = false; this.onend?.(); }
        };
        window.webkitSpeechRecognition = undefined;
        const original = window.fetch.bind(window);
        window.fetch = (input, init = {}) => {
            const url = new URL(typeof input === 'string' ? input : input.url, location.href);
            const method = (init.method || input.method || 'GET').toUpperCase();
            const account = new Headers(init.headers).get('X-Pocket-Account');
            let stored = false;
            if (url.pathname === '/api/inbox' && method === 'POST') {
                const note = JSON.parse(init.body);
                stored = JSON.parse(localStorage.getItem('pocket.quick-notes.v2.' + account) || '[]')
                    .some((item) => item.id === note.id && item.text === note.text && item.state === 'local');
            }
            window.voiceTest.calls.push({ path: url.pathname, method, stored });
            if (window.voiceTest.offline && url.pathname.startsWith('/api/inbox')) {
                return Promise.reject(new TypeError('test offline'));
            }
            return original(input, init);
        };
    `);
}

async function login(): Promise<void> {
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);

    if (
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('form[action="/login"]') !== null)`,
        )
    ) {
        await click('form[action="/login"] button');
    }

    await see(
        `(await import('/store.js')).store.state.me?.id === ${JSON.stringify(owner(app).id)} && (await import('/store.js')).store.state.connection === 'open'`,
        "owner connected",
    );
    await page.evaluate(`
        const { store } = await import('/store.js');
        await (await import('/inbox-sync.js')).inboxFor(store.state.me.id).ready;
    `);
    await instrument();
}

async function open(): Promise<void> {
    await see(`document.querySelector('.quick-notes-button') !== null`, "capture available");

    if (
        !(await inPage<boolean>(
            `return JSON.stringify(document.querySelector('.quick-notes-panel') !== null)`,
        ))
    ) {
        await click(".quick-notes-button");
    }

    await see(`document.querySelector(${JSON.stringify(field)}) !== null`, "capture open");
}

async function start(): Promise<void> {
    await see(`document.querySelector(${JSON.stringify(mic)}) !== null`, "shared mic visible");
    await click(mic);
    await see(
        `window.voiceTest.recognitions.at(-1)?.active && document.querySelector(${JSON.stringify(mic)})?.getAttribute('aria-pressed') === 'true'`,
        "recognition active",
    );
}

async function hear(...phrases: [string, boolean][]): Promise<void> {
    await page.evaluate(`window.voiceTest.recognitions.at(-1).emit(${JSON.stringify(phrases)})`);
}

/** Deliver a queued browser result after cancellation, without keeping a detached handler alive. */
async function late(): Promise<void> {
    await page.evaluate(`
        window.voiceTest.recognitions.at(-1).emit([['late cancelled words', true]]);
        window.voiceTest.recognitions.at(-1).end();
    `);
}

async function stopped(): Promise<void> {
    await see(
        `!window.voiceTest.recognitions.at(-1).active && (window.voiceTest.recognitions.at(-1).stops + window.voiceTest.recognitions.at(-1).aborts) > 0`,
        "recognition stopped",
    );
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(
        scriptedModel(() => {
            modelCalls++;

            throw new Error("unexpected model run");
        }),
        join(root, "inbox-voice-app"),
    );
    // One idle route fixture, created before the no-session-creation baselines.
    route = await newSession(app);
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "inbox-voice-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.desktop);
});

beforeEach(async () => {
    if (real.skip) {
        return;
    }

    await login();
    sessionsBefore = await sessionCount();
});

afterEach(async () => {
    if (real.skip || !page) {
        return;
    }

    // Let queued callbacks run. Report only counts and states, not note text or account identifiers.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const forbidden = await inPage<number>(`
        return JSON.stringify(window.voiceTest.calls.filter(({ path, method }) =>
            path.startsWith('/api/') && method !== 'GET' && path !== '/api/inbox'
        ).length);
    `);

    assert.equal(forbidden, 0, "no conversation, PiP/Pia, Continue, or submission mutations");
    assert.equal(
        await sessionCount(),
        sessionsBefore,
        "no sessions created, including private helpers",
    );
    assert.equal(modelCalls, 0, "no model work");
    assert.equal(
        page.logs().filter((entry) => entry.level === "error").length,
        0,
        "no browser errors",
    );
});

after(async () => {
    try {
        await browsers?.closeAll({ final: true });
        server?.closeAllConnections();

        if (server?.listening) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }

        await app?.close();
    } finally {
        cleanUp();
    }
});

test("final dictation changes only the capture draft until explicit Save", real, async () => {
    const localBefore = await localCount();
    const remoteBefore = (await app.inbox.list(owner(app), true)).length;

    await open();
    await start();
    await hear(["a spoken ide", false]);
    await draftIs("A spoken ide");
    await hear(["a spoken idea", true]);
    await draftIs("A spoken idea");
    await click(mic);
    await stopped();
    await page.evaluate(`window.voiceTest.recognitions.at(-1).end()`);
    await draftIs("A spoken idea");
    assert.equal(await localCount(), localBefore, "no automatic local capture");
    assert.equal(
        (await app.inbox.list(owner(app), true)).length,
        remoteBefore,
        "no automatic durable capture",
    );
    assert.equal(
        await inPage<number>(
            `return JSON.stringify(window.voiceTest.calls.filter((call) => call.path === '/api/inbox' && call.method === 'POST').length)`,
        ),
        0,
        "no automatic inbox POST",
    );
    await see(`!document.querySelector('.quick-notes-send').disabled`, "explicit Save enabled");
});

test(
    "offline Save persists locally, then reconnect automatically syncs the same ID",
    real,
    async () => {
        const remoteBefore = (await app.inbox.list(owner(app), true)).length;

        await open();
        await start();
        await hear(["offline spoken idea", true]);
        await draftIs("Offline spoken idea");
        await page.evaluate(`window.voiceTest.offline = true`);
        await click(".quick-notes-send");
        await draftIs("");
        await see(
            `[...document.querySelectorAll('.quick-note')].some((row) => row.querySelector('.quick-note-text')?.textContent === 'Offline spoken idea' && row.querySelector('.quick-note-state')?.textContent === 'Saved locally')`,
            "local capture visible",
        );
        await see(
            `document.querySelector('.quick-notes-sync-status') !== null`,
            "unsynced status visible",
        );
        const local = await inPage<{ id: string; state: string }>(`
        const { store } = await import('/store.js');
        const note = JSON.parse(localStorage.getItem('pocket.quick-notes.v2.' + store.state.me.id))
            .find((item) => item.text === 'Offline spoken idea');
        window.voiceTest.savedId = note.id;
        return JSON.stringify({ id: note.id, state: note.state });
    `);

        assert.equal(local.state, "local");
        assert.equal(
            (await app.inbox.list(owner(app), true)).length,
            remoteBefore,
            "failed API saved no remote note",
        );
        await page.evaluate(`window.voiceTest.offline = false; dispatchEvent(new Event('online'))`);
        await see(
            `[...document.querySelectorAll('.quick-note')].some((row) => row.querySelector('.quick-note-text')?.textContent === 'Offline spoken idea' && row.querySelector('.quick-note-state')?.textContent === 'Synced to inbox')`,
            "automatic synced state",
        );
        await until(async () => {
            const notes = await app.inbox.list(owner(app), true);

            return (
                notes.length === remoteBefore + 1 &&
                notes.some(
                    (note) =>
                        note.id === local.id &&
                        note.text === "Offline spoken idea" &&
                        note.state === "synced",
                )
            );
        }, "same ID in durable inbox");
        await see(
            `window.voiceTest.calls.filter((call) => call.path === '/api/inbox' && call.method === 'POST').length >= 2 && window.voiceTest.calls.filter((call) => call.path === '/api/inbox' && call.method === 'POST').every((call) => call.stored)`,
            "local persistence precedes every capture request",
        );
        await see(
            `JSON.parse(localStorage.getItem('pocket.quick-notes.v2.' + (await import('/store.js')).store.state.me.id)).filter((note) => note.id === window.voiceTest.savedId && note.state === 'synced').length === 1`,
            "same single local ID acknowledged",
        );
        await see(
            `document.querySelector('.quick-notes-sync-status') === null`,
            "failure status cleared",
        );
    },
);

test(
    "closing capture stops recognition and ignores late results after reopening",
    real,
    async () => {
        const count = await localCount();

        await open();
        await start();
        await click('[aria-label="Close quick notes"]');
        await see(`document.querySelector('.quick-notes-panel') === null`, "capture closed");
        await stopped();
        await late();
        await open();
        await draftIs("");
        await late();
        await draftIs("");
        assert.equal(await localCount(), count, "cancellation captured no note");
        await see(
            `document.querySelector(${JSON.stringify(mic)})?.getAttribute('aria-pressed') === 'false'`,
            "mic idle after reopening",
        );
    },
);

test("moving to an existing route stops capture and ignores late results", real, async () => {
    const count = await localCount();

    await open();
    await start();
    await page.evaluate(`(await import('/store.js')).navigate(${route})`);
    await see(
        `(await import('/store.js')).store.state.conversationId === ${route} && document.querySelector('.composer textarea') !== null`,
        "existing idle conversation open",
    );
    await stopped();
    await late();
    await open();
    await draftIs("");
    await late();
    await draftIs("");
    await see(
        `document.querySelector('.composer textarea')?.value === ''`,
        "no leaked conversation draft",
    );
    assert.equal(await localCount(), count, "route change captured no note");
});

test(
    "typing beside interim dictation survives the final transcript without capture",
    real,
    async () => {
        const count = await localCount();

        await open();
        await page.type({ selector: field }, "Typed prefix.");
        await start();
        await hear(["please fix the lo", false]);
        await draftIs("Typed prefix. Please fix the lo");
        await page.press("End");
        await page.type(undefined, "!", { append: true });
        await hear(["please fix the login bug", true]);
        await draftIs("Typed prefix. Please fix the login bug!");
        await click(mic);
        await stopped();
        assert.equal(await localCount(), count, "mixed input remains a draft");
    },
);

test(
    "dictation near the start of a full draft aborts without truncating existing text",
    real,
    async () => {
        const prior = "prefix " + "x".repeat(1984) + " tail-end";
        const notice =
            "A note can contain at most 2000 characters. Dictation stopped; your draft is unchanged.";
        const count = await localCount();
        const remoteBefore = (await app.inbox.list(owner(app), true)).length;

        assert.equal(prior.length, 2000, "synthetic draft fills the limit");
        await open();
        await page.type({ selector: field }, prior);
        await draftIs(prior);
        await page.evaluate(`
        const input = document.querySelector(${JSON.stringify(field)});
        input.focus();
        input.setSelectionRange(7, 7);
    `);
        await start();
        await hear(["additional spoken words", true]);
        await see(
            `!window.voiceTest.recognitions.at(-1).active && window.voiceTest.recognitions.at(-1).aborts === 1`,
            "overflow aborts recognition",
        );
        await draftIs(prior);
        await see(
            `document.querySelector(${JSON.stringify(mic)})?.getAttribute('aria-pressed') === 'false'`,
            "overflow mic idle",
        );
        await see(
            `(await import('/store.js')).store.state.notices.some((item) => item.level === 'error' && item.message === ${JSON.stringify(notice)}) && [...document.querySelectorAll('.notices .notice.error .notice-text')].some((node) => node.textContent === ${JSON.stringify(notice)})`,
            "shared overflow error notification shown",
        );
        await late();
        await click('[aria-label="Close quick notes"]');
        await see(`document.querySelector('.quick-notes-panel') === null`, "capture closed");
        await open();
        await draftIs(prior);
        assert.equal(await localCount(), count, "overflow saved no local note");
        assert.equal(
            (await app.inbox.list(owner(app), true)).length,
            remoteBefore,
            "overflow saved no durable note",
        );
        assert.equal(
            await inPage<number>(
                `return JSON.stringify(window.voiceTest.calls.filter((call) => call.path === '/api/inbox' && call.method === 'POST').length)`,
            ),
            0,
            "overflow made no capture request",
        );
    },
);

test("unsupported Web Speech hides the mic but keeps manual capture available", real, async () => {
    await page.evaluate(
        `window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined`,
    );
    await open();
    assert.equal(
        await inPage<number>(
            `return JSON.stringify(document.querySelectorAll('.quick-notes-panel .mic-button, .quick-notes-panel [aria-label="Dictate"]').length)`,
        ),
        0,
        "unsupported mic hidden",
    );
    await page.type({ selector: field }, "Manual draft without speech");
    await draftIs("Manual draft without speech");
    await see(`!document.querySelector('.quick-notes-send').disabled`, "manual Save enabled");
    assert.equal(
        await inPage<number>(`return JSON.stringify(window.voiceTest.recognitions.length)`),
        0,
        "no recognizer created",
    );
});

test(
    "blocked recognition uses the shared notification and permits a fresh attempt",
    real,
    async () => {
        await open();
        await start();
        await page.evaluate(`window.voiceTest.recognitions.at(-1).fail('not-allowed')`);
        await stopped();
        await see(
            `document.querySelector(${JSON.stringify(mic)})?.getAttribute('aria-pressed') === 'false'`,
            "blocked mic idle",
        );
        await see(
            `(await import('/store.js')).store.state.notices.some((notice) => notice.level === 'error' && notice.message === "The microphone is blocked. Allow it for this site in the browser's settings.") && [...document.querySelectorAll('.notices .notice.error .notice-text')].some((node) => node.textContent === "The microphone is blocked. Allow it for this site in the browser's settings.")`,
            "existing error notification shown",
        );
        await see(
            `document.querySelector('.quick-notes-panel [role="alert"]') === null`,
            "no custom panel alert",
        );
        await draftIs("");
        await start();
        assert.equal(
            await inPage<number>(`return JSON.stringify(window.voiceTest.recognitions.length)`),
            2,
            "fresh recognizer after rejection",
        );
        await page.evaluate(`window.voiceTest.recognitions[0].end()`);
        await see(`window.voiceTest.recognitions[1].active`, "old end cannot stop fresh attempt");
    },
);

test(
    "an account change without reload stops recognition and rejects late draft writes",
    real,
    async () => {
        const replacement = app.config.addUser("Voice test owner", "owner");

        await open();
        await start();
        await page.evaluate(`
        await fetch('/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: ${JSON.stringify(replacement.token)} }),
        });
        await (await import('/store.js')).revalidateAccount();
    `);
        await see(
            `(await import('/store.js')).store.state.me?.id === ${JSON.stringify(replacement.user.id)} && (await import('/store.js')).store.state.connection === 'open'`,
            "replacement account confirmed",
        );
        await stopped();
        await late();
        await open();
        await draftIs("");
        await late();
        await draftIs("");
        assert.equal(await localCount(), 0, "replacement account has no captured notes");
        assert.equal(
            (await app.inbox.list(replacement.user, true)).length,
            0,
            "replacement durable inbox empty",
        );
    },
);
