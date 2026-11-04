import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { cleanUp, openApp, root, scriptedModel } from "./helpers.ts";
import { createHandler } from "../src/server/http.ts";
import { networkServices } from "../src/server/network-links.ts";

test("network links list only reachable network-bound HTTP services", async () => {
    const hosts = [
        { network: "local" as const, host: "192.0.2.10" },
        { network: "tailnet" as const, host: "100.64.0.10" },
    ];
    const listeners = new Map([
        [5001, new Set(["*"])],
        [5002, new Set(["100.64.0.10"])],
        [5003, new Set(["127.0.0.1"])],
        [5004, new Set(["*"])],
        [8787, new Set(["*"])],
    ]);
    const services = await networkServices([8787], {
        hosts,
        listeners,
        local: [
            { port: 5003, url: "http://localhost:5003/", title: "Emacs (web)" },
            {
                port: 5004,
                url: "http://localhost:5004/",
                title: "400 The plain HTTP request was sent to HTTPS port",
            },
        ],
        served: [
            {
                port: 9445,
                backendPort: 5003,
                title: "Emacs (web)",
                link: {
                    network: "tailnet",
                    host: "pocket.example.ts.net",
                    url: "https://pocket.example.ts.net:9445/",
                    secure: true,
                },
            },
        ],
        probe: async (host, port) => {
            if (port === 5001) {
                return { title: "Inference Engine" };
            }

            if (port === 5002 && host === "100.64.0.10") {
                return { title: "Ink Board" };
            }

            return undefined;
        },
    });

    assert.deepEqual(services, [
        {
            port: 9445,
            title: "Emacs (web)",
            links: [
                {
                    network: "tailnet",
                    host: "pocket.example.ts.net",
                    url: "https://pocket.example.ts.net:9445/",
                    secure: true,
                },
            ],
        },
        {
            port: 5001,
            title: "Inference Engine",
            links: [
                {
                    network: "tailnet",
                    host: "100.64.0.10",
                    url: "http://100.64.0.10:5001/",
                },
                {
                    network: "local",
                    host: "192.0.2.10",
                    url: "http://192.0.2.10:5001/",
                },
            ],
        },
        {
            port: 5002,
            title: "Ink Board",
            links: [
                {
                    network: "tailnet",
                    host: "100.64.0.10",
                    url: "http://100.64.0.10:5002/",
                },
            ],
        },
    ]);
});

test("the links API is owner-only", async () => {
    const app = await openApp(scriptedModel(), `${root}/network-links-api`);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/links`;
    const guest = app.config.addUser("Guest", "guest");

    try {
        const ownerResponse = await fetch(base, {
            headers: { authorization: `Bearer ${app.config.ownerToken}` },
        });
        const ownerBody = (await ownerResponse.json()) as { services?: unknown };

        assert.equal(ownerResponse.status, 200);
        assert.ok(Array.isArray(ownerBody.services));

        const guestResponse = await fetch(base, {
            headers: { authorization: `Bearer ${guest.token}` },
        });

        assert.equal(guestResponse.status, 403);
    } finally {
        server.closeAllConnections();
        server.close();
        await app.close();
        cleanUp();
    }
});
