import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const worker = await readFile(new URL("../web/sw.js", import.meta.url), "utf8");

test("worker caches only the fixed shell and falls back only for app navigation", async () => {
    const listeners = new Map<string, (event: any) => void>();
    const stores = new Map<string, Map<string, Response>>();
    const caches = {
        async open(name: string) {
            if (!stores.has(name)) {
                stores.set(name, new Map());
            }

            const store = stores.get(name)!;

            return {
                async put(key: string, response: Response) {
                    store.set(key, response);
                },
                async match(key: string) {
                    return store.get(key)?.clone();
                },
            };
        },
        async keys() {
            return [...stores.keys()];
        },
        async delete(name: string) {
            return stores.delete(name);
        },
    };
    let offline = false;
    let status = 200;

    const fetch = async (request: string | { url: string }) => {
        if (offline) {
            throw new TypeError("offline");
        }

        return new Response(typeof request === "string" ? request : request.url, { status });
    };

    const self = {
        location: { origin: "https://pocket.test" },
        clients: { claim: async () => {} },
        skipWaiting: async () => {},
        addEventListener(name: string, callback: (event: any) => void) {
            listeners.set(name, callback);
        },
    };

    vm.runInNewContext(worker, { self, caches, fetch, URL, Response, crypto, File });
    let pending: Promise<unknown> | undefined;

    listeners.get("install")!({
        waitUntil(promise: Promise<unknown>) {
            pending = promise;
        },
    });
    await pending;
    const store = stores.get("pocket-offline-shell-v5")!;

    assert.deepEqual(
        [...store.keys()],
        ["/offline.html", "/offline.js", "/offline.css", "/quick-notes.js"],
    );

    async function request(path: string, mode = "cors") {
        let response: Promise<Response> | undefined;

        listeners.get("fetch")!({
            request: { method: "GET", url: `https://pocket.test${path}`, mode },
            respondWith(promise: Promise<Response>) {
                response = promise;
            },
        });

        return response;
    }

    assert.equal(await request("/api/me"), undefined);
    assert.equal(await request("/api/me", "navigate"), undefined);
    assert.equal(await request("/x/private/module.js"), undefined);
    assert.equal(
        await request("/s/4", "navigate").then((r) => r?.text()),
        "https://pocket.test/s/4",
    );
    assert.equal(
        await request("/quick-notes.js").then((r) => r?.text()),
        "https://pocket.test/quick-notes.js",
    );
    status = 503;
    assert.equal(await request("/s/4", "navigate").then((r) => r?.text()), "/offline.html");
    assert.equal(await request("/quick-notes.js").then((r) => r?.text()), "/quick-notes.js");
    status = 401;
    assert.equal((await request("/s/4", "navigate"))?.status, 401);
    status = 403;
    assert.equal((await request("/s/4", "navigate"))?.status, 403);
    offline = true;
    assert.equal(await request("/s/4", "navigate").then((r) => r?.text()), "/offline.html");
    assert.equal(await request("/offline.js").then((r) => r?.text()), "/offline.js");
    assert.equal(store.size, 4);
});

test("registration does not require push or notification support", async () => {
    const source = await readFile(new URL("../web/notify.js", import.meta.url), "utf8");
    const part = source
        .slice(source.indexOf("const supported"), source.indexOf("/** The count on the icon"))
        .replace("export function registerWorker", "function registerWorker");
    let registered = "";
    const context = {
        navigator: {
            serviceWorker: {
                register: async (path: string) => {
                    registered = path;

                    return {};
                },
            },
        },
        isSecureContext: true,
        globalThis: {},
    };

    await vm.runInNewContext(`${part}\nregisterWorker()`, context);
    assert.equal(registered, "/sw.js");
});

test("unlock reports a local model failure without revealing the inbox", async () => {
    const source = (await readFile(new URL("../web/offline.js", import.meta.url), "utf8")).replace(
        /^import\s*\{[\s\S]*?\}\s*from\s*"\/quick-notes\.js";\s*/,
        "",
    );
    const elements = new Map<string, any>();
    const document = {
        addEventListener() {},
        getElementById(id: string) {
            if (!elements.has(id)) {
                elements.set(id, {
                    hidden: false,
                    textContent: "",
                    value: "",
                    addEventListener(_name: string, handler: unknown) {
                        this.handler = handler;
                    },
                    replaceChildren() {},
                    append() {},
                });
            }

            return elements.get(id);
        },
    };
    const context = {
        document,
        window: { addEventListener() {} },
        localStorage: {},
        ACCOUNT_KEY: "account",
        NOTES_PREFIX: "notes.",
        readInboxAccount: () => ({ id: "owner" }),
        forgetInboxAccount() {},
        createQuickNotes() {
            throw new Error("storage failed");
        },
        fetch: async () => new Response(JSON.stringify({ user: { id: "owner", role: "owner" } })),
        AbortSignal,
        crypto,
        TypeError,
        setInterval() {},
    };

    vm.runInNewContext(source, context);
    await elements.get("unlock").handler();
    assert.match(elements.get("status").textContent, /Could not open the local inbox/);
    assert.equal(elements.get("inbox").hidden, true);
    assert.equal(elements.get("locked").hidden, false);
});
test("reconnection returns only the confirmed owner, and retains an unfinished draft on mismatch", async () => {
    const source = (await readFile(new URL("../web/offline.js", import.meta.url), "utf8")).replace(
        /^import\s*\{[\s\S]*?\}\s*from\s*"\/quick-notes\.js";\s*/,
        "",
    );

    for (const mode of ["same", "different", "draft"]) {
        const elements = new Map<string, any>();
        const events = new Map<string, () => void>();
        const document = {
            visibilityState: "visible",
            addEventListener() {},
            getElementById(id: string) {
                if (!elements.has(id)) {
                    elements.set(id, {
                        hidden: false,
                        value: "",
                        textContent: "",
                        addEventListener(_name: string, handler: unknown) {
                            this.handler = handler;
                        },
                        replaceChildren() {},
                        append() {},
                    });
                }

                return elements.get(id);
            },
            createElement() {
                return { textContent: "" };
            },
        };
        let account: { id: string } | null = { id: "owner" };
        let responseId = "owner";
        let navigated = "";
        const context = {
            document,
            window: {
                addEventListener(name: string, callback: () => void) {
                    events.set(name, callback);
                },
            },
            localStorage: {},
            ACCOUNT_KEY: "account",
            NOTES_PREFIX: "notes.",
            readInboxAccount: () => account,
            forgetInboxAccount() {
                account = null;
            },
            createQuickNotes: () => ({ notes: [] }),
            fetch: async () =>
                new Response(JSON.stringify({ user: { id: responseId, role: "owner" } })),
            location: {
                assign(path: string) {
                    navigated = path;
                },
            },
            AbortSignal,
            crypto,
            TypeError,
            setInterval() {},
        };

        vm.runInNewContext(source, context);
        await elements.get("unlock").handler();

        if (mode !== "same") {
            elements.get("note").value = "unfinished";
        }

        if (mode === "different") {
            responseId = "other";
        }

        events.get("online")!();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(navigated, mode === "same" ? "/" : "");

        if (mode === "different") {
            assert.equal(elements.get("inbox").hidden, true);
            assert.match(elements.get("status").textContent, /unfinished text stays/);
            account = { id: "owner" };
            responseId = "owner";
            await elements.get("unlock").handler();
            assert.equal(elements.get("note").value, "unfinished");
        }

        if (mode === "draft") {
            assert.equal(elements.get("note").value, "unfinished");
        }
    }
});
