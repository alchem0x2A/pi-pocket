// App-lifetime inbox retries use isolated apps, browser profiles, and random ports. Never inspect the live inbox.
import { type App, cleanUp, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const host = "127.0.0.2";
const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
    timeout: 60_000,
} as const;
const captureText = "Synthetic pending idea for the inbox synchronization regression.";
const inactiveText = "Synthetic inactive account idea.";

after(cleanUp);

type Post = {
    connection: string;
    expectedAccount: boolean;
    persisted: boolean;
    cache: string | null;
    timeout: number | null;
    confirmed: boolean;
};

async function fixture(t: TestContext) {
    let app: App | undefined;
    let server: Server | undefined;
    let browsers: Browsers | undefined;
    let blockStreams = false;
    let modelCalls = 0;
    const streams = new Set<ServerResponse>();

    t.after(async () => {
        await browsers?.closeAll({ final: true });

        if (server?.listening) {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
                server!.close((error) => (error ? reject(error) : resolve()));
            });
        }

        await app?.close();
    });

    app = await openApp(
        scriptedModel(() => {
            modelCalls++;

            throw new Error("Inbox synchronization must not run a model");
        }),
        mkdtempSync(join(root, "inbox-sync-app-")),
    );
    const current = app;
    const inactive = current.config.addUser("Synthetic inactive owner", "owner").user;
    const handler = createHandler({
        app: current,
        listen: { host, port: 0 },
        restart: () => {
            throw new Error("No server restart is permitted in this test");
        },
    });

    server = createServer((request, response) => {
        const path = new URL(request.url ?? "/", `http://${host}`).pathname;
        const transport = path === "/api/events" || path === "/api/poll";

        if (transport && blockStreams) {
            response.writeHead(503);
            response.end();

            return;
        }

        if (transport) {
            streams.add(response);
            response.on("close", () => streams.delete(response));
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, host, resolve);
    });
    const port = (server.address() as { port: number }).port;

    assert.ok(port !== 18787 && port !== 18799, "the test uses neither protected port");
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "inbox-sync-browser-")),
        load: async () => undefined,
        save() {},
    });
    const page = await browsers.open(1);
    const inPage = async <T>(script: string): Promise<T> =>
        JSON.parse(await page.evaluate(script)) as T;
    const see = (condition: string, label: string, timeout = 15_000) =>
        until(
            () => inPage<boolean>(`return JSON.stringify(Boolean(${condition}))`),
            label,
            timeout,
        );
    const click = (selector: string) =>
        page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(
        `http://${host}:${port}/login?token=${encodeURIComponent(current.config.ownerToken)}`,
    );
    await see(
        `(await import('/store.js')).store.state.me?.role === 'owner' && (await import('/store.js')).store.state.connection === 'open'`,
        "the isolated owner connects",
    );
    await page.evaluate(`
        const { store } = await import('/store.js');
        const { ACCOUNT_KEY, NOTES_PREFIX } = await import('/quick-notes.js');
        window.syncTestAccount = store.state.me.id;
        window.syncTestKey = NOTES_PREFIX + store.state.me.id;
        window.syncTestAccountKey = ACCOUNT_KEY;
        window.syncTestPosts = [];
        window.syncTestConfirmations = [];
        window.syncTestBlockInbox = false;
        window.syncTestHoldConfirmation = false;
        window.syncTestConfirmed = false;
        window.syncTestForbiddenPosts = 0;
        const deadlines = new WeakMap();
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        AbortSignal.timeout = (milliseconds) => {
            const signal = timeout(milliseconds);
            deadlines.set(signal, milliseconds);
            return signal;
        };
        const original = window.fetch.bind(window);
        window.fetch = async (input, init = {}) => {
            const url = typeof input === 'string' ? input : input.url;
            const method = init.method || 'GET';
            if (method === 'POST' && /\\/(submit|chat|continue)$/.test(url)) {
                window.syncTestForbiddenPosts++;
            }
            if (url === '/api/inbox' && method === 'POST') {
                const body = JSON.parse(init.body);
                const saved = JSON.parse(localStorage.getItem(window.syncTestKey) || '[]');
                window.syncTestPosts.push({
                    connection: store.state.connection,
                    expectedAccount: new Headers(init.headers).get('X-Pocket-Account') === window.syncTestAccount,
                    persisted: saved.some((note) => note.id === body.id && note.text === body.text),
                    cache: init.cache || null,
                    timeout: deadlines.get(init.signal) || null,
                    confirmed: window.syncTestConfirmed,
                });
            }
            if (url.startsWith('/api/inbox') && window.syncTestBlockInbox) {
                return new Response('Not Found', { status: 404 });
            }
            if (url === '/api/me') {
                const confirmation = {
                    cache: init.cache || null,
                    timeout: deadlines.get(init.signal) || null,
                    aborted: false,
                    timeoutError: false,
                    forwarded: false,
                    sameAccount: false,
                };
                window.syncTestConfirmations.push(confirmation);
                if (window.syncTestHoldConfirmation) {
                    await new Promise((resolve, reject) => {
                        const aborted = () => {
                            confirmation.aborted = true;
                            confirmation.timeoutError = init.signal.reason?.name === 'TimeoutError';
                            reject(init.signal.reason);
                        };
                        window.syncTestReleaseConfirmation = () => {
                            init.signal?.removeEventListener('abort', aborted);
                            resolve();
                        };
                        if (init.signal?.aborted) {
                            aborted();
                        } else {
                            init.signal?.addEventListener('abort', aborted, { once: true });
                        }
                    });
                }
                confirmation.forwarded = true;
                const response = await original(input, init);
                const data = await response.clone().json();
                confirmation.sameAccount = response.ok && data.user?.id === window.syncTestAccount;
                window.syncTestConfirmed ||= confirmation.sameAccount;
                return response;
            }
            return original(input, init);
        };
    `);

    const save = async () => {
        await see(
            `document.querySelector('.quick-notes-button') !== null`,
            "the capture button mounts",
        );
        await click(".quick-notes-button");
        await see(
            `document.querySelector('.quick-notes-form textarea') !== null`,
            "the capture form opens",
        );
        await page.evaluate(`
            const input = document.querySelector('.quick-notes-form textarea');
            input.value = ${JSON.stringify(captureText)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        `);
        await see(
            `!document.querySelector('.quick-notes-send').disabled`,
            "the capture is enabled",
        );
        await click(".quick-notes-send");
        await see(
            `JSON.parse(localStorage.getItem(window.syncTestKey) || '[]').some((note) => note.text === ${JSON.stringify(captureText)})`,
            "the capture persists locally",
        );
    };

    const quiet = async () => {
        assert.equal(modelCalls, 0, "no model runs");
        assert.equal(
            await inPage<number>(`return JSON.stringify(window.syncTestForbiddenPosts)`),
            0,
            "no chat, agent submission, or Continue request occurs",
        );
        assert.equal(
            page
                .logs()
                .filter(
                    (entry) =>
                        entry.level === "error" &&
                        !/Failed to load resource|ERR_CONNECTION/.test(entry.text),
                ).length,
            0,
            "the isolated page has no unexpected console errors",
        );
    };

    return {
        app: current,
        inactive,
        page,
        inPage,
        see,
        save,
        quiet,
        closeStream() {
            blockStreams = true;

            for (const response of streams) {
                response.destroy();
            }
        },
    };
}

test(
    "a closed chat stream does not block REST inbox capture and synchronization",
    real,
    async (t) => {
        const f = await fixture(t);

        f.closeStream();
        await f.see(
            `(await import('/store.js')).store.state.connection === 'closed'`,
            "the actual chat transport closes",
        );
        await f.save();
        await until(
            async () =>
                (await f.app.inbox.list(owner(f.app), true)).some(
                    (note) => note.text === captureText,
                ),
            "the capture reaches the durable inbox without a chat stream",
        );
        const posts = await f.inPage<Post[]>(`return JSON.stringify(window.syncTestPosts)`);

        assert.ok(posts.length > 0, "the browser sends an inbox POST");
        assert.ok(
            posts.some((post) => post.connection === "closed"),
            "the connection is closed when an inbox POST starts",
        );
        assert.ok(
            posts.every((post) => post.expectedAccount && post.persisted),
            "POST follows account-scoped persistence",
        );
        assert.ok(
            posts.every((post) => post.cache === "no-store" && post.timeout === 10000),
            "REST requests retain their cache and timeout bounds",
        );
        await f.see(
            `document.querySelector('.quick-note-state')?.textContent === 'Synced to inbox'`,
            "the capture receives its server acknowledgement",
        );
        assert.equal(
            (await f.app.inbox.list(f.inactive, true)).length,
            0,
            "the inactive owner receives nothing",
        );
        await f.quiet();
    },
);

for (const mode of ["missing", "mismatched"] as const) {
    test(
        `${mode} local account hint requires bounded fresh confirmation before inbox sync resumes`,
        real,
        async (t) => {
            const f = await fixture(t);
            const inactiveKey = `pocket.quick-notes.v2.${f.inactive.id}`;

            await f.page.evaluate(`window.syncTestBlockInbox = true`);
            await f.save();
            await f.see(
                `/404/.test(document.querySelector('.quick-notes-sync-detail')?.textContent || '')`,
                "the queued capture reports its failed attempt",
            );
            await f.page.evaluate(`
            await (await import('/inbox-sync.js')).inboxFor(window.syncTestAccount).flush();
            window.syncTestCapturedId = JSON.parse(localStorage.getItem(window.syncTestKey))[0].id;
            window.syncTestInactiveKey = ${JSON.stringify(inactiveKey)};
            window.syncTestInactiveCache = JSON.stringify([{
                id: 'synthetic-inactive-note',
                text: ${JSON.stringify(inactiveText)},
                createdAt: 1,
                state: 'local',
                pendingSync: true,
            }]);
            localStorage.setItem(window.syncTestInactiveKey, window.syncTestInactiveCache);
            window.syncTestPostsBeforeConfirmation = window.syncTestPosts.length;
            window.syncTestBlockInbox = false;
            window.syncTestHoldConfirmation = true;
            ${
                mode === "missing"
                    ? "localStorage.removeItem(window.syncTestAccountKey);"
                    : `localStorage.setItem(window.syncTestAccountKey, JSON.stringify({ id: ${JSON.stringify(f.inactive.id)}, name: 'Synthetic inactive owner' }));`
            }
            dispatchEvent(new StorageEvent('storage', { key: window.syncTestAccountKey }));
        `);
            await f.see(
                `window.syncTestConfirmations.length === 1 && (await import('/inbox-sync.js')).revalidating`,
                "a fresh account confirmation starts",
            );
            await f.page.evaluate(`
            dispatchEvent(new Event('online'));
            dispatchEvent(new Event('focus'));
            dispatchEvent(new Event('pageshow'));
            document.dispatchEvent(new Event('visibilitychange'));
        `);
            // Let the retry event burst run while the account response remains held.
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(
                await f.inPage<boolean>(`return JSON.stringify(
            window.syncTestConfirmations.length === 1 &&
            window.syncTestConfirmations[0].cache === 'no-store' &&
            window.syncTestConfirmations[0].timeout === 10000 &&
            !window.syncTestConfirmations[0].forwarded &&
            window.syncTestPosts.length === window.syncTestPostsBeforeConfirmation
        )`),
                true,
                "one bounded fresh request blocks inbox POSTs until confirmation",
            );
            assert.equal(
                await f.inPage<boolean>(`return JSON.stringify(
            document.querySelector('.quick-notes-panel') === null &&
            document.querySelector('.quick-note-text') === null &&
            !document.body.textContent.includes(${JSON.stringify(captureText)}) &&
            (await import('/store.js')).store.state.me === undefined &&
            JSON.parse(localStorage.getItem(window.syncTestKey)).some((note) =>
                note.id === window.syncTestCapturedId && note.state === 'local' && note.pendingSync) &&
            localStorage.getItem(window.syncTestInactiveKey) === window.syncTestInactiveCache
        )`),
                true,
                "the old cached view stays hidden and both account caches remain separate",
            );
            assert.equal(
                (await f.app.inbox.list(owner(f.app), true)).length,
                0,
                "the queued capture is not synchronized before confirmation",
            );
            assert.equal(
                (await f.app.inbox.list(f.inactive, true)).length,
                0,
                "the hinted inactive owner receives nothing",
            );

            if (mode === "missing") {
                // Exercise the actual 10-second AbortSignal, not only the configured timeout value.
                await f.see(
                    `window.syncTestConfirmations[0].aborted && window.syncTestConfirmations[0].timeoutError`,
                    "the held confirmation reaches its real timeout",
                    15_000,
                );
                assert.equal(
                    await f.inPage<boolean>(`return JSON.stringify(
                document.querySelector('.quick-note-text') === null &&
                !(await import('/store.js')).store.state.me &&
                window.syncTestPosts.length === window.syncTestPostsBeforeConfirmation
            )`),
                    true,
                    "a timed-out confirmation does not restore the old view or synchronize notes",
                );
            }

            await f.page.evaluate(`
            window.syncTestHoldConfirmation = false;
            window.syncTestReleaseConfirmation();
        `);
            await f.see(
                `window.syncTestConfirmed && !(await import('/inbox-sync.js')).revalidating &&
            (await import('/store.js')).store.state.me?.id === window.syncTestAccount &&
            JSON.parse(localStorage.getItem(window.syncTestAccountKey) || 'null')?.id === window.syncTestAccount`,
                "the real server confirms the original owner",
            );
            await until(
                async () =>
                    (await f.app.inbox.list(owner(f.app), true)).some(
                        (note) => note.text === captureText,
                    ),
                "the pending capture automatically resumes after account confirmation",
            );
            await f.see(
                `JSON.parse(localStorage.getItem(window.syncTestKey)).some((note) => note.id === window.syncTestCapturedId && note.state === 'synced' && !note.pendingSync)`,
                "the original local capture receives its acknowledgement",
            );
            assert.equal(
                await f.inPage<boolean>(`return JSON.stringify(
            window.syncTestPosts.slice(window.syncTestPostsBeforeConfirmation).length > 0 &&
            window.syncTestPosts.slice(window.syncTestPostsBeforeConfirmation).every((post) =>
                post.expectedAccount && post.persisted && post.confirmed) &&
            localStorage.getItem(window.syncTestInactiveKey) === window.syncTestInactiveCache &&
            window.syncTestConfirmations.length === ${mode === "missing" ? 2 : 1}
        )`),
                true,
                "only fresh confirmation permits the original account's pending capture to synchronize",
            );
            assert.equal(
                (await f.app.inbox.list(owner(f.app), true)).length,
                1,
                "the original owner receives one capture",
            );
            assert.equal(
                (await f.app.inbox.list(f.inactive, true)).length,
                0,
                "no capture transfers to the hinted account",
            );
            await f.quiet();
        },
    );
}
