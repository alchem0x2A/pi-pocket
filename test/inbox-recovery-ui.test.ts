// A real service worker must recover a locally captured idea without starting agent work.
// Keep this origin separate from the live app, including its host (cookies ignore ports).
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
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { ChatDoc, OwnerInboxDoc, SessionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const host = "127.0.0.2";
const port = 18799;
const base = `http://${host}:${port}`;
const dataDir = join(root, "inbox-recovery-data");
const noteText = "Offline recovery proof: keep this idea, never send it to Pia.";

after(cleanUp);

async function counts(app: App) {
    return app.harness.commit(async (tx) => {
        const conversations = (await tx.scanConversations({}, 1000)).items;
        const sessions = (await tx.doc(SessionsDoc)).items;
        let piaMessages = 0;
        let messages = 0;
        let chatMessages = 0;

        for (const conversation of conversations) {
            const entries = (await tx.scanEntries({ conversationId: conversation.id }, 1000)).items;
            const sent = entries.filter(
                (entry) => entry.kind === "user" || entry.kind === "assistant",
            ).length;

            messages += sent;
            chatMessages += (await tx.doc(ChatDoc, conversation.id)).messages.length;

            if (sessions[String(conversation.id)]?.pia !== undefined) {
                piaMessages += sent;
            }
        }

        return {
            conversations: conversations.length,
            sessions: Object.keys(sessions).length,
            piaMessages,
            messages,
            chatMessages,
            tasks: (await tx.scanTasks({}, 1000)).items.length,
        };
    }, context);
}

async function stop(server: Server | undefined): Promise<void> {
    if (!server?.listening) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Event streams otherwise keep server.close() waiting. This is only our test server.
        server.closeAllConnections();
    });
}

test(
    "real offline shell automatically recovers and durably syncs only the owner inbox",
    {
        skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
        timeout: 120_000,
    },
    async () => {
        let app: App | undefined;
        let server: Server | undefined;
        let browsers: Browsers | undefined;
        let page: BrowserPage | undefined;
        let modelCalls = 0;
        const requests: { method: string; path: string; status: number }[] = [];
        const model = () =>
            scriptedModel(() => {
                modelCalls++;

                throw new Error("Inbox recovery must not call a model");
            });
        const inPage = async <T>(script: string): Promise<T> =>
            JSON.parse(await page!.evaluate(script)) as T;
        const see = (condition: string, what: string) =>
            until(
                async () => {
                    try {
                        return await inPage<boolean>(
                            `return JSON.stringify(Boolean(${condition}))`,
                        );
                    } catch {
                        // The recovery navigation can replace the execution context during a poll.
                        return false;
                    }
                },
                what,
                20_000,
            );
        const click = (selector: string) =>
            page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

        const listen = async () => {
            const handler = createHandler({
                app: app!,
                listen: { host, port },
                restart: () => {
                    throw new Error("No restart is permitted in this proof");
                },
            });
            const next = createServer((req, res) => {
                const method = req.method ?? "GET";
                const path = new URL(req.url ?? "/", base).pathname;

                res.on("finish", () => requests.push({ method, path, status: res.statusCode }));
                void handler(req, res);
            });

            await new Promise<void>((resolve, reject) => {
                next.once("error", reject);
                next.listen(port, host, resolve);
            });
            assert.deepEqual(next.address(), { address: host, family: "IPv4", port });

            return next;
        };

        try {
            console.log(`Recovery proof address: ${base}; temporary data: ${dataDir}`);
            app = await openApp(model(), dataDir);
            app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
            server = await listen();
            browsers = new Browsers({
                dataDir: mkdtempSync(join(root, "inbox-recovery-browser-")),
                load: async () => undefined,
                save: () => {},
            });
            page = await browsers.open(1);
            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await see(
                `(await import('/store.js')).store.state.me?.role === 'owner' && (await import('/store.js')).store.state.connection === 'open'`,
                "owner authenticated and connected",
            );
            const account = owner(app).id;
            const key = `pocket.quick-notes.v2.${account}`;

            await see(
                `JSON.parse(localStorage.getItem('pocket.inbox.account') || 'null')?.id === ${JSON.stringify(account)}`,
                "confirmed local owner hint",
            );
            const worker = await inPage<{ active: string; cached: string[] }>(`
                const registration = await navigator.serviceWorker.ready;
                const name = (await caches.keys()).find((key) => key.startsWith('pocket-offline-shell-'));
                if (!name) throw new Error('Offline shell cache is missing');
                const cache = await caches.open(name);
                return JSON.stringify({
                    active: registration.active.state,
                    cached: (await cache.keys()).map((request) => new URL(request.url).pathname).sort(),
                });
            `);

            assert.equal(worker.active, "activated");
            assert.deepEqual(worker.cached, [
                "/offline.css",
                "/offline.html",
                "/offline.js",
                "/quick-notes.js",
            ]);
            await see(`navigator.serviceWorker.controller !== null`, "worker controls online app");
            // Let the front-page Pia panel finish its initial, idle setup before measuring capture.
            await see(
                `(await import('/store.js')).store.state.server?.assistant?.name === 'Pia'`,
                "Pia name received",
            );
            await new Promise((resolve) => setTimeout(resolve, 500));
            const before = await counts(app);

            assert.equal(before.piaMessages, 0);
            assert.equal(before.messages, 0);
            assert.equal(before.chatMessages, 0);
            assert.equal(modelCalls, 0);
            const captureStart = requests.length;

            await stop(server);
            assert.equal(server.listening, false);
            await assert.rejects(fetch(`${base}/api/me`), TypeError);
            assert.equal((await page.navigate(`${base}/s/987654`)).error, undefined);
            await see(`document.querySelector('#unlock') !== null`, "worker offline shell loaded");
            assert.equal(
                await inPage<string>(`return JSON.stringify(document.title)`),
                "Pia · Offline inbox",
            );
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('#inbox').hidden)`,
                ),
                true,
                "offline inbox requires explicit unlock",
            );
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(navigator.serviceWorker.controller !== null)`,
                ),
                true,
            );
            await click("#unlock");
            await see(`document.querySelector('#inbox')?.hidden === false`, "local inbox unlocked");
            await page.evaluate(`
                const field = document.querySelector('#note');
                field.value = ${JSON.stringify(noteText)};
                field.dispatchEvent(new Event('input', { bubbles: true }));
            `);
            await click('#form button[type="submit"]');
            await see(
                `document.querySelector('#status')?.textContent === 'Saved locally' && document.querySelector('#note')?.value === ''`,
                "offline capture completed after local persistence",
            );
            const local = await inPage<
                { id: string; text: string; createdAt: number; state: string }[]
            >(
                `return JSON.stringify(JSON.parse(localStorage.getItem(${JSON.stringify(key)}) || '[]'))`,
            );

            assert.equal(local.length, 1);
            assert.equal(local[0]!.text, noteText);
            assert.equal(local[0]!.state, "local");
            assert.deepEqual(await app.inbox.list(owner(app), true), []);
            assert.deepEqual(await counts(app), before, "offline capture starts no durable work");
            assert.equal(modelCalls, 0);
            // No fetch replacement or network emulation: the same HTTP endpoint is listening again.
            server = await listen();
            await page.evaluate(`dispatchEvent(new Event('online'))`);
            await see(
                `document.querySelector('#unlock') === null && document.querySelector('.quick-notes-button') !== null && (await import('/store.js')).store.state.connection === 'open'`,
                "offline probe automatically opens the normal app",
            );
            assert.equal(await inPage<string>(`return JSON.stringify(location.pathname)`), "/");
            await until(
                async () =>
                    (await app!.inbox.list(owner(app!), true)).some(
                        (note) => note.id === local[0]!.id,
                    ),
                "local note committed to durable owner inbox",
            );
            await click(".quick-notes-button");
            await see(
                `[...document.querySelectorAll('.quick-note')].some((row) => row.textContent.includes(${JSON.stringify(noteText)}) && row.textContent.includes('Synced to inbox'))`,
                "normal inbox shows the synchronized note",
            );
            const synced = await app.inbox.list(owner(app), true);
            const expected = {
                id: local[0]!.id,
                text: local[0]!.text,
                createdAt: local[0]!.createdAt,
                state: "synced",
            };

            assert.deepEqual(synced, [expected]);
            assert.deepEqual(
                await counts(app),
                before,
                "capture and sync create no sessions or messages",
            );
            assert.equal(modelCalls, 0);
            const recoveryRequests = requests.slice(captureStart);

            assert.ok(recoveryRequests.some((req) => req.path === "/api/me" && req.status === 200));
            assert.ok(recoveryRequests.some((req) => req.path === "/" && req.status === 200));
            assert.ok(
                recoveryRequests.some(
                    (req) =>
                        req.path === "/api/inbox" && req.method === "POST" && req.status === 200,
                ),
            );
            assert.deepEqual(
                recoveryRequests.filter(
                    (req) => req.method === "POST" && /\/(submit|chat|continue)$/.test(req.path),
                ),
                [],
                "no chat, Pia submission, or Continue request",
            );
            assert.ok(!requests.some((req) => req.path.startsWith("/api/inbox/notes")));
            assert.deepEqual(
                page
                    .logs()
                    .filter(
                        (entry) =>
                            entry.level === "error" &&
                            !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(entry.text),
                    ),
                [],
                "normal recovery has no JavaScript errors",
            );
            await browsers.closeAll({ final: true });
            await stop(server);
            await app.close();
            app = undefined;
            app = await openApp(model(), dataDir);
            const persisted = await app.inbox.list(owner(app), true);
            const doc = await app.harness.snapshot(OwnerInboxDoc, context);

            assert.deepEqual(
                persisted,
                [expected],
                "cold open reads the note from SQLite, not browser storage",
            );
            assert.ok(
                Object.values(doc!.users).some((notes) =>
                    Object.values(notes).some(
                        (note) => note.id === expected.id && note.text === noteText,
                    ),
                ),
            );
            assert.deepEqual(await counts(app), before, "cold open preserves all work counts");
            assert.equal(modelCalls, 0);
            console.log(
                JSON.stringify({
                    address: base,
                    dataDir,
                    durableNotesAfterColdOpen: persisted.length,
                    durableStatesAfterColdOpen: persisted.map((note) => note.state),
                    baseline: before,
                    piaMessages: 0,
                    chatMessages: 0,
                    newSessions: 0,
                    newConversations: 0,
                    modelCalls,
                    inboxPosts: recoveryRequests.filter(
                        (req) => req.path === "/api/inbox" && req.method === "POST",
                    ).length,
                }),
            );
        } catch (error) {
            console.error("Recovery proof failed; note text and identifiers are not logged.");

            throw error;
        } finally {
            await browsers?.closeAll({ final: true });
            await stop(server);
            await app?.close();
        }
    },
);

// The previous server serves the authenticated app but does not have the inbox API yet.
// All requests use real HTTP. Only the retry response is held to inspect persisted failure UI.
test(
    "HTTP 404 survives reload and a server upgrade automatically syncs legacy archives and a local idea",
    {
        skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
        timeout: 120_000,
    },
    async (t) => {
        const folder = join(root, "inbox-upgrade-data");
        let app: App | undefined;
        let server: Server | undefined;
        let browsers: Browsers | undefined;
        let page: BrowserPage | undefined;
        let modelCalls = 0;
        let hold404 = false;
        let heldRequests = 0;
        let activeInboxRequests = 0;
        let lastInboxFinishedAt = 0;
        let releaseHeld: (() => void)[] = [];
        const requests: { method: string; inbox: boolean; status: number; forbidden: boolean }[] =
            [];
        const localText = "Synthetic upgrade pending idea";
        const expectedWork = {
            conversations: 0,
            sessions: 0,
            piaMessages: 0,
            messages: 0,
            chatMessages: 0,
            tasks: 0,
        };
        const model = () =>
            scriptedModel(() => {
                modelCalls++;

                throw new Error("The upgrade proof must not call a model");
            });
        const inPage = async <T>(script: string): Promise<T> =>
            JSON.parse(await page!.evaluate(script)) as T;
        const see = (condition: string, what: string) =>
            until(
                async () => {
                    try {
                        return await inPage<boolean>(
                            `return JSON.stringify(Boolean(${condition}))`,
                        );
                    } catch {
                        return false;
                    }
                },
                what,
                20_000,
            );
        const click = (selector: string) =>
            page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
        const summary = (notes: { state: string }[]) => ({
            archived: notes.filter((note) => note.state === "archived").length,
            synced: notes.filter((note) => note.state === "synced").length,
            local: notes.filter((note) => note.state === "local").length,
            total: notes.length,
        });
        const expectedInbox = { archived: 2, synced: 1, local: 0, total: 3 };

        const listen = async (inbox: boolean) => {
            const handler = createHandler({
                app: app!,
                listen: { host, port },
                restart: () => {
                    throw new Error("Only the throwaway test app can restart");
                },
            });
            const next = createServer((req, res) => {
                const path = new URL(req.url ?? "/", base).pathname;
                const isInbox = path === "/api/inbox" || path.startsWith("/api/inbox/");

                if (isInbox) {
                    activeInboxRequests++;
                    res.once("close", () => {
                        activeInboxRequests--;
                    });
                }

                res.on("finish", () => {
                    if (isInbox) {
                        lastInboxFinishedAt = Date.now();
                    }

                    requests.push({
                        method: req.method ?? "GET",
                        inbox: isInbox,
                        status: res.statusCode,
                        forbidden: /\/(submit|chat|continue)$/.test(path),
                    });
                });

                if (!inbox && isInbox) {
                    const fail = () => {
                        if (!res.destroyed) {
                            res.writeHead(404, { "content-type": "text/plain" });
                            res.end("Not Found");
                        }
                    };

                    req.resume();

                    if (hold404) {
                        heldRequests++;
                        releaseHeld.push(fail);
                    } else {
                        fail();
                    }

                    return;
                }

                void handler(req, res);
            });

            await new Promise<void>((resolve, reject) => {
                next.once("error", reject);
                next.listen(port, host, resolve);
            });
            assert.deepEqual(next.address(), { address: host, family: "IPv4", port });

            return next;
        };

        try {
            app = await openApp(model(), folder);
            // Do not open Pia: even an idle helper conversation would break the zero-work proof.
            server = await listen(false);
            browsers = new Browsers({
                dataDir: mkdtempSync(join(root, "inbox-upgrade-browser-")),
                load: async () => undefined,
                save: () => {},
            });
            page = await browsers.open(2);
            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`${base}/login`);
            const account = owner(app).id;
            const legacyKey = `pocket.quick-notes.${account}`;
            const key = `pocket.quick-notes.v2.${account}`;

            // Seed synthetic old chat-delivered records before the first authenticated app load.
            await page.evaluate(`
                localStorage.setItem(${JSON.stringify(legacyKey)}, JSON.stringify([
                    { id: 'synthetic-legacy-delivered-a', text: 'Synthetic delivered idea A', createdAt: 1, state: 'delivered' },
                    { id: 'synthetic-legacy-delivered-b', text: 'Synthetic delivered idea B', createdAt: 2, state: 'delivered' },
                ]));
            `);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await see(
                `(await import('/store.js')).store.state.me?.role === 'owner' && (await import('/store.js')).store.state.connection === 'open'`,
                "authenticated normal app while inbox returns HTTP 404",
            );
            await see(`document.querySelector('.quick-notes-button') !== null`, "inbox button");
            await click(".quick-notes-button");
            await see(`document.querySelector('.quick-notes-panel') !== null`, "inbox panel");
            await page.evaluate(`
                const field = document.querySelector('.quick-notes-form textarea');
                field.value = ${JSON.stringify(localText)};
                field.dispatchEvent(new Event('input', { bubbles: true }));
            `);
            await see(`!document.querySelector('.quick-notes-send').disabled`, "capture enabled");
            await click(".quick-notes-send");
            await see(
                `document.querySelectorAll('.quick-note').length === 1 && document.querySelector('.quick-note-text')?.textContent === ${JSON.stringify(localText)} && document.querySelector('.quick-note-state')?.textContent === 'Saved locally'`,
                "synthetic local idea visible and delivered legacy ideas hidden",
            );
            await see(
                `document.querySelector('.quick-notes-count')?.textContent === '1 pending' && /not synced yet/.test(document.querySelector('.quick-notes-sync-status')?.textContent || '') && /HTTP 404/.test(document.querySelector('.quick-notes-sync-detail')?.textContent || '') && /restart/i.test(document.querySelector('.quick-notes-sync-detail')?.textContent || '')`,
                "pending count, warning, and actual HTTP 404 restart reason",
            );
            assert.ok(requests.some((request) => request.inbox && request.status === 404));
            const failureReason = await inPage<string>(
                `return JSON.stringify(document.querySelector('.quick-notes-sync-detail').textContent)`,
            );

            assert.deepEqual(await counts(app), expectedWork);
            assert.equal(modelCalls, 0);
            const captured = await inPage<{ id: string; text: string; createdAt: number }>(`
                const notes = JSON.parse(localStorage.getItem(${JSON.stringify(key)}));
                return JSON.stringify(notes.find((note) => note.state === 'local'));
            `);

            assert.ok(captured.text === localText, "capture retains the synthetic note");
            assert.deepEqual(summary(await app.inbox.list(owner(app), true)), {
                archived: 0,
                synced: 0,
                local: 0,
                total: 0,
            });
            console.log(
                JSON.stringify({
                    phase: "before-upgrade",
                    local: 1,
                    archivedLocal: 2,
                    ...expectedWork,
                    modelCalls,
                }),
            );

            // The flush attempts each queued note and the list. Do not let navigation cancel an
            // unfinished first flush and replace its real 404 reason with a new network failure.
            await until(
                () => activeInboxRequests === 0 && Date.now() - lastInboxFinishedAt >= 200,
                "the initial HTTP 404 flush finishes before reload",
            );
            hold404 = true;
            await page.reload();
            await see(
                `document.querySelector('.quick-notes-button') !== null`,
                "reloaded inbox button",
            );
            await click(".quick-notes-button");
            await see(
                `document.querySelector('.quick-notes-count')?.textContent === '1 pending'`,
                "reloaded pending count",
            );
            await see(
                `/not synced yet/.test(document.querySelector('.quick-notes-sync-status')?.textContent || '')`,
                "reloaded unsynced warning remains visible during retry",
            );
            await until(() => heldRequests > 0, "automatic retry held by old HTTP server");
            // A failing subtest reports the missing persistence before the upgrade proof continues.
            // No response is released and no client state is repaired to pass this assertion.
            await t.test(
                "the HTTP 404 reason is present immediately while the reload retry is held",
                async () => {
                    const failureState = await inPage<string>(`
                        const reason = document.querySelector('.quick-notes-sync-detail')?.textContent || '';
                        return JSON.stringify(
                            /HTTP 404/.test(reason) ? 'http404' :
                            /account/i.test(reason) ? 'account' :
                            /connection/i.test(reason) ? 'connection' :
                            /reach/i.test(reason) ? 'network' :
                            reason === '' ? 'missing' : 'other'
                        );
                    `);

                    console.log(JSON.stringify({ phase: "held-reload-retry", failureState }));
                    assert.equal(
                        await inPage<boolean>(
                            `return JSON.stringify(document.querySelector('.quick-notes-sync-detail')?.textContent === ${JSON.stringify(failureReason)})`,
                        ),
                        true,
                        "the persisted HTTP 404 reason must not wait for another failed request",
                    );
                },
            );
            await click(".quick-note-select");
            await see(
                `document.querySelector('.quick-note-actions') !== null`,
                "local idea selected before upgrade",
            );
            await page.evaluate(`
                window.upgradeProofPanel = document.querySelector('.quick-notes-panel');
                window.upgradeProofRow = document.querySelector('.quick-note');
            `);
            // Complete this old-server retry while the old server still exists.
            hold404 = false;

            for (const release of releaseHeld) {
                release();
            }

            releaseHeld = [];
            await see(
                `/HTTP 404/.test(document.querySelector('.quick-notes-sync-detail')?.textContent || '')`,
                "old-server retry reports HTTP 404",
            );
            await stop(server);
            await app.close();
            app = undefined;
            app = await openApp(model(), folder);
            server = await listen(true);
            const automaticStart = requests.length;

            // No navigation, click, online event, refresh, or Retry action after this listener starts.
            // Poll durable state only. Native stream reconnect and the real 15-second timer drive sync.
            await until(
                async () => {
                    const state = summary(await app!.inbox.list(owner(app!), true));

                    return state.archived === 2 && state.synced === 1 && state.total === 3;
                },
                "automatic sync after the throwaway server restart",
                45_000,
            );
            await see(
                `document.querySelector('.quick-notes-panel') === window.upgradeProofPanel && document.querySelector('.quick-note') === window.upgradeProofRow && document.querySelector('.quick-note-text')?.textContent === ${JSON.stringify(localText)} && document.querySelector('.quick-note-state')?.textContent === 'Synced to inbox' && document.querySelector('.quick-notes-sync') === null`,
                "same panel and same note synchronize without user action",
            );
            assert.deepEqual(
                await inPage<string[]>(
                    `return JSON.stringify([...document.querySelectorAll('.quick-note-actions button')].map((button) => button.textContent.trim()))`,
                ),
                ["Continue in conversation"],
                "Continue is the only action on the selected note",
            );
            assert.equal(
                await inPage<number>(
                    `return JSON.stringify(document.querySelectorAll('.quick-note').length)`,
                ),
                1,
            );
            assert.equal(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector('.quick-notes-count').textContent)`,
                ),
                "1 pending",
            );
            const durable = await app.inbox.list(owner(app), true);

            assert.deepEqual(summary(durable), expectedInbox);
            assert.ok(
                durable.some(
                    (note) =>
                        note.id === captured.id &&
                        note.text === captured.text &&
                        note.createdAt === captured.createdAt &&
                        note.state === "synced",
                ),
                "the durable inbox retains the exact captured synthetic note",
            );
            assert.deepEqual(await counts(app), expectedWork);
            assert.equal(modelCalls, 0);
            assert.ok(
                requests
                    .slice(automaticStart)
                    .some(
                        (request) =>
                            request.inbox && request.method === "POST" && request.status === 200,
                    ),
                "automatic inbox POST succeeds",
            );
            assert.equal(
                requests.filter((request) => request.method === "POST" && request.forbidden).length,
                0,
                "no submission, chat, or Continue POST",
            );
            assert.equal(
                page
                    .logs()
                    .filter(
                        (entry) =>
                            entry.level === "error" &&
                            !/Failed to load resource|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_NETWORK_CHANGED/.test(
                                entry.text,
                            ),
                    ).length,
                0,
                "no unexpected JavaScript console errors",
            );
            console.log(
                JSON.stringify({
                    phase: "automatic-upgrade-sync",
                    ...summary(durable),
                    ...(await counts(app)),
                    modelCalls,
                }),
            );
            await browsers.closeAll({ final: true });
            await stop(server);
            await app.close();
            app = undefined;
            app = await openApp(model(), folder);
            const cold = await app.inbox.list(owner(app), true);
            const doc = await app.harness.snapshot(OwnerInboxDoc, context);
            const stored = Object.values(doc!.users).flatMap((notes) => Object.values(notes));

            assert.deepEqual(
                summary(cold),
                expectedInbox,
                "cold SQLite open preserves inbox states",
            );
            assert.deepEqual(
                summary(stored),
                expectedInbox,
                "the SQLite document has all 3 states",
            );
            assert.ok(
                cold.some(
                    (note) =>
                        note.id === captured.id &&
                        note.text === captured.text &&
                        note.createdAt === captured.createdAt,
                ),
                "cold SQLite open preserves the same synthetic note",
            );
            assert.deepEqual(await counts(app), expectedWork);
            assert.equal(modelCalls, 0);
            console.log(
                JSON.stringify({
                    phase: "cold-open",
                    ...summary(cold),
                    ...(await counts(app)),
                    modelCalls,
                }),
            );
        } finally {
            for (const release of releaseHeld) {
                release();
            }

            await browsers?.closeAll({ final: true });
            await stop(server);
            await app?.close();
        }
    },
);

// This top-level test runs serially with the other proofs on the same isolated port.
test(
    "a phone conversation with an unmounted inbox rail automatically syncs after an HTTP 404 upgrade",
    {
        skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
        timeout: 100_000,
    },
    async () => {
        const folder = join(root, "inbox-hidden-rail-data");
        let app: App | undefined;
        let server: Server | undefined;
        let browsers: Browsers | undefined;
        let page: BrowserPage | undefined;
        let modelCalls = 0;
        const requests: { inbox: boolean; post: boolean; status: number; forbidden: boolean }[] =
            [];
        const text = "Synthetic hidden rail pending idea";
        const model = () =>
            scriptedModel(() => {
                modelCalls++;

                throw new Error("Hidden rail synchronization must not call a model");
            });
        const inPage = async <T>(script: string): Promise<T> =>
            JSON.parse(await page!.evaluate(script)) as T;
        const see = (condition: string, what: string) =>
            until(
                async () => {
                    try {
                        return await inPage<boolean>(
                            `return JSON.stringify(Boolean(${condition}))`,
                        );
                    } catch {
                        return false;
                    }
                },
                what,
                20_000,
            );
        const click = (selector: string) =>
            page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

        const listen = async (inbox: boolean) => {
            const handler = createHandler({
                app: app!,
                listen: { host, port },
                restart: () => {
                    throw new Error("No live restart is permitted");
                },
            });
            const next = createServer((req, res) => {
                const path = new URL(req.url ?? "/", base).pathname;
                const isInbox = path === "/api/inbox" || path.startsWith("/api/inbox/");

                res.on("finish", () =>
                    requests.push({
                        inbox: isInbox,
                        post: req.method === "POST",
                        status: res.statusCode,
                        forbidden: /\/(submit|chat|continue)$/.test(path),
                    }),
                );

                if (!inbox && isInbox) {
                    req.resume();
                    res.writeHead(404, { "content-type": "text/plain" });
                    res.end("Not Found");

                    return;
                }

                void handler(req, res);
            });

            await new Promise<void>((resolve, reject) => {
                next.once("error", reject);
                next.listen(port, host, resolve);
            });
            assert.deepEqual(next.address(), { address: host, family: "IPv4", port });

            return next;
        };

        try {
            app = await openApp(model(), folder);
            // This conversation predates measurement. Capture and sync must create no further work.
            const conversation = await newSession(app);
            const baseline = await counts(app);

            assert.deepEqual(baseline, {
                conversations: 1,
                sessions: 1,
                piaMessages: 0,
                messages: 0,
                chatMessages: 0,
                tasks: 0,
            });
            assert.equal(modelCalls, 0);
            server = await listen(false);
            browsers = new Browsers({
                dataDir: mkdtempSync(join(root, "inbox-hidden-rail-browser-")),
                load: async () => undefined,
                save: () => {},
            });
            page = await browsers.open(3);
            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await see(
                `(await import('/store.js')).store.state.me?.role === 'owner' && (await import('/store.js')).store.state.connection === 'open'`,
                "phone owner authenticated",
            );
            await see(
                `document.querySelector('.quick-notes-button') !== null`,
                "home inbox mounted",
            );
            await click(".quick-notes-button");
            await see(`document.querySelector('.quick-notes-panel') !== null`, "home inbox open");
            await page.evaluate(`
                const field = document.querySelector('.quick-notes-form textarea');
                field.value = ${JSON.stringify(text)};
                field.dispatchEvent(new Event('input', { bubbles: true }));
            `);
            await see(`!document.querySelector('.quick-notes-send').disabled`, "capture enabled");
            await click(".quick-notes-send");
            await see(
                `document.querySelector('.quick-notes-count')?.textContent === '1 pending' && document.querySelector('.quick-note-state')?.textContent === 'Saved locally' && /HTTP 404/.test(document.querySelector('.quick-notes-sync-detail')?.textContent || '')`,
                "local note remains pending after actual HTTP 404",
            );
            assert.ok(requests.some((request) => request.inbox && request.status === 404));
            const key = `pocket.quick-notes.v2.${owner(app).id}`;
            const captured = await inPage<{ id: string; text: string; createdAt: number }>(`
                return JSON.stringify(JSON.parse(localStorage.getItem(${JSON.stringify(key)})).find((note) => note.state === 'local'));
            `);

            assert.ok(captured.text === text, "the local synthetic capture is intact");
            await click('.quick-notes-panel button[aria-label="Close quick notes"]');
            await page.evaluate(`(await import('/store.js')).navigate(${Number(conversation)})`);
            await see(
                `(await import('/store.js')).store.state.conversationId === ${Number(conversation)} && document.querySelector('.composer') !== null`,
                "existing idle phone conversation open",
            );
            // Exercise a real drawer mount and unmount before the server upgrade.
            await page.evaluate(`(await import('/store.js')).store.set({ drawer: true })`);
            await see(
                `document.querySelector('.drawer .quick-notes-button') !== null`,
                "drawer inbox mounted",
            );
            await page.evaluate(
                `document.querySelector('.drawer-overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`,
            );
            await see(
                `document.querySelector('.drawer') === null && document.querySelector('.quick-notes-button') === null && document.querySelector('.quick-notes-panel') === null`,
                "closed phone drawer unmounts the inbox component completely",
            );
            assert.deepEqual(await counts(app), baseline);
            assert.equal((await app.inbox.list(owner(app), true)).length, 0);
            assert.equal(modelCalls, 0);
            console.log(
                JSON.stringify({
                    phase: "hidden-rail-before-upgrade",
                    local: 1,
                    synced: 0,
                    archived: 0,
                    newConversations: 0,
                    newSessions: 0,
                    messages: 0,
                    tasks: 0,
                    modelCalls,
                }),
            );
            await stop(server);
            await app.close();
            app = undefined;
            app = await openApp(model(), folder);
            server = await listen(true);
            const automaticStart = requests.length;

            // No client interaction occurs after the new handler starts. Do not mount the rail to help sync.
            await until(
                async () => {
                    const notes = await app!.inbox.list(owner(app!), true);

                    return notes.length === 1 && notes[0]!.state === "synced";
                },
                "automatic sync with the phone inbox rail unmounted",
                45_000,
            );
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.quick-notes-button') === null && document.querySelector('.quick-notes-panel') === null && document.querySelector('.drawer') === null)`,
                ),
                true,
                "the inbox rail stays unmounted throughout automatic recovery",
            );
            const synced = await app.inbox.list(owner(app), true);

            assert.ok(
                synced.some(
                    (note) =>
                        note.id === captured.id &&
                        note.text === captured.text &&
                        note.createdAt === captured.createdAt,
                ),
                "automatic hidden-rail sync preserves the same synthetic note",
            );
            await see(
                `JSON.parse(localStorage.getItem(${JSON.stringify(key)})).some((note) => note.id === ${JSON.stringify(captured.id)} && note.state === 'synced' && !note.pendingSync)`,
                "local queue accepts automatic sync without a mounted rail",
            );
            assert.deepEqual(await counts(app), baseline, "hidden-rail sync creates no new work");
            assert.equal(modelCalls, 0);
            assert.ok(
                requests
                    .slice(automaticStart)
                    .some((request) => request.inbox && request.post && request.status === 200),
                "the hidden-rail service automatically posts to the real inbox API",
            );
            assert.equal(requests.filter((request) => request.post && request.forbidden).length, 0);
            console.log(
                JSON.stringify({
                    phase: "hidden-rail-automatic-sync",
                    local: 0,
                    synced: 1,
                    archived: 0,
                    newConversations: 0,
                    newSessions: 0,
                    messages: 0,
                    tasks: 0,
                    modelCalls,
                }),
            );
            await browsers.closeAll({ final: true });
            await stop(server);
            await app.close();
            app = undefined;
            app = await openApp(model(), folder);
            const cold = await app.inbox.list(owner(app), true);

            assert.equal(cold.length, 1);
            assert.ok(
                cold[0]!.state === "synced" &&
                    cold[0]!.id === captured.id &&
                    cold[0]!.text === captured.text &&
                    cold[0]!.createdAt === captured.createdAt,
                "cold SQLite open preserves the hidden-rail capture",
            );
            assert.deepEqual(await counts(app), baseline);
            assert.equal(modelCalls, 0);
            console.log(
                JSON.stringify({
                    phase: "hidden-rail-cold-open",
                    local: 0,
                    synced: 1,
                    archived: 0,
                    newConversations: 0,
                    newSessions: 0,
                    messages: 0,
                    tasks: 0,
                    modelCalls,
                }),
            );
        } finally {
            await browsers?.closeAll({ final: true });
            await stop(server);
            await app?.close();
        }
    },
);

test("a legacy pending idea appended after v2 migration is merged once without losing v2 capture", async () => {
    type Note = {
        id: string;
        text: string;
        createdAt: number;
        state: string;
        pendingSync?: boolean;
        archivePending?: boolean;
    };
    const { createQuickNotes } = (await import(
        new URL("../web/quick-notes.js", import.meta.url).href
    )) as {
        createQuickNotes(options: {
            storage: {
                getItem(key: string): string | null;
                setItem(key: string, value: string): void;
            };
            key: string;
            legacyKey: string;
            makeId(): string;
        }): { ready: Promise<void>; notes: Note[]; add(text: string): Promise<Note> };
    };
    const values = new Map<string, string>();
    const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
            values.set(key, value);
        },
    };
    const legacy = [
        {
            id: "synthetic-late-delivered-a",
            text: "Synthetic delivered A",
            createdAt: 1,
            state: "delivered",
        },
        {
            id: "synthetic-late-delivered-b",
            text: "Synthetic delivered B",
            createdAt: 2,
            state: "delivered",
        },
    ];
    const options = {
        storage,
        key: "synthetic-v2-inbox",
        legacyKey: "synthetic-v1-inbox",
        makeId: () => "synthetic-v2-capture",
    };

    storage.setItem(options.legacyKey, JSON.stringify(legacy));
    const first = createQuickNotes(options);

    await first.ready;
    await first.add("Synthetic v2 capture");
    storage.setItem(
        options.legacyKey,
        JSON.stringify([
            ...legacy,
            {
                id: "synthetic-late-pending",
                text: "Synthetic late legacy capture",
                createdAt: 3,
                state: "cached",
            },
        ]),
    );
    const reopened = createQuickNotes(options);

    await reopened.ready;
    const states = {
        archived: reopened.notes.filter((note) => note.state === "archived").length,
        local: reopened.notes.filter((note) => note.state === "local").length,
        total: reopened.notes.length,
    };

    console.log(JSON.stringify({ phase: "late-legacy-merge", ...states }));
    assert.deepEqual(
        states,
        { archived: 2, local: 2, total: 4 },
        "a late legacy capture must merge into the existing v2 queue",
    );
    assert.ok(
        reopened.notes.some((note) => note.id === "synthetic-v2-capture" && note.pendingSync),
        "the v2 pending capture remains intact",
    );
    const again = createQuickNotes(options);

    await again.ready;
    assert.equal(again.notes.length, 4, "repeated migration must not add duplicates");
    assert.equal(
        new Set(again.notes.map((note) => note.id)).size,
        4,
        "each migrated note occurs once",
    );
    assert.equal(
        JSON.parse(storage.getItem(options.legacyKey)!).length,
        3,
        "the legacy cache remains intact",
    );
});
