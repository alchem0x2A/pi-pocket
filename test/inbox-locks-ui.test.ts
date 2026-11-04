// Browser-native cross-tab locks protect local idea capture, including the IndexedDB fallback.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser" : false };

test(
    "independent browser writers wait for Web Locks and IndexedDB before changing local storage",
    real,
    async () => {
        const folder = mkdtempSync(join(tmpdir(), "pocket-inbox-locks-"));
        const model = readFileSync(new URL("../web/quick-notes.js", import.meta.url));
        const server = createServer((request, response) => {
            if (request.url === "/quick-notes.js") {
                response.writeHead(200, { "content-type": "text/javascript" });
                response.end(model);
            } else {
                response.writeHead(200, { "content-type": "text/html" });
                response.end("<!doctype html><title>Inbox lock test</title>");
            }
        });
        const browsers = new Browsers({ dataDir: folder, load: async () => undefined, save() {} });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

        try {
            const page = await browsers.open(1);
            const address = server.address() as { port: number };

            await page.navigate(`http://127.0.0.1:${address.port}/`);
            const result = JSON.parse(
                await page.evaluate(`
            const frames = await Promise.all([0, 1].map(() => new Promise((resolve) => {
                const frame = document.createElement('iframe');
                frame.src = '/';
                frame.onload = () => resolve(frame.contentWindow);
                document.body.append(frame);
            })));
            const results = [];
            for (const fallback of [false, true]) {
                const key = 'lock-test-' + fallback;
                let release;
                let entered;
                const started = new Promise((resolve) => { entered = resolve; });
                let held;
                if (!fallback) {
                    held = navigator.locks.request('pocket.inbox:' + key, async () => {
                        entered();
                        await new Promise((resolve) => { release = resolve; });
                    });
                } else {
                    for (const frame of frames) {
                        Object.defineProperty(frame.navigator, 'locks', { value: undefined });
                    }
                    const database = await new Promise((resolve, reject) => {
                        const request = indexedDB.open('pocket-inbox-locks', 1);
                        request.onupgradeneeded = () => request.result.createObjectStore('locks');
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => reject(request.error);
                    });
                    held = new Promise((resolve, reject) => {
                        const transaction = database.transaction('locks', 'readwrite');
                        const store = transaction.objectStore('locks');
                        let holding = true;
                        release = () => { holding = false; };
                        const keep = () => {
                            const request = store.get(key);
                            request.onsuccess = () => {
                                entered();
                                if (holding) { keep(); }
                            };
                        };
                        transaction.oncomplete = () => { database.close(); resolve(); };
                        transaction.onabort = () => reject(transaction.error);
                        keep();
                    });
                }
                await started;
                const writers = await Promise.all(frames.map(async (frame, index) => {
                    const module = await frame.eval("import('/quick-notes.js')");
                    return module.createQuickNotes({
                        storage: frame.localStorage,
                        key,
                        makeId: () => 'writer-' + index,
                    });
                }));
                const captures = writers.map((writer, index) => writer.add('Idea ' + index));
                await new Promise((resolve) => setTimeout(resolve, 100));
                const beforeRelease = localStorage.getItem(key);
                release();
                await held;
                await Promise.all(captures);
                results.push({
                    fallback,
                    beforeRelease,
                    notes: JSON.parse(localStorage.getItem(key)),
                });
            }
            return JSON.stringify(results);
        `),
            ) as {
                fallback: boolean;
                beforeRelease: string | null;
                notes: { id: string; text: string }[];
            }[];

            for (const entry of result) {
                assert.equal(
                    entry.beforeRelease,
                    null,
                    `writer waited for ${entry.fallback ? "IndexedDB" : "Web Locks"}`,
                );
                assert.deepEqual(entry.notes.map((note) => note.id).sort(), [
                    "writer-0",
                    "writer-1",
                ]);
                assert.deepEqual(entry.notes.map((note) => note.text).sort(), ["Idea 0", "Idea 1"]);
            }
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    },
);
