// A file of a session's folder as a download: for whom the file viewer lets read it, never past a link or the folder.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";

let app: App;
let server: Server;
let port = 0;
let id: ConversationId;

before(async () => {
    app = await openApp(scriptedModel());

    const { createHandler } = await import("../src/server/http.ts");

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    id = await newSession(app);
    mkdirSync(join(work, "exports"), { recursive: true });
    writeFileSync(join(work, "exports", "deck-v2.pptx"), Buffer.from([0x50, 0x4b, 3, 4, 0, 255]));
    writeFileSync(join(work, "exports", 'odd "name"\n.png'), "png");
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

function download(path: string, token = app.config.ownerToken) {
    return fetch(`http://127.0.0.1:${port}/api/c/${id}/download?path=${encodeURIComponent(path)}`, {
        headers: { authorization: `Bearer ${token}` },
    });
}

test("a session file downloads as it is, as an attachment that no browser runs", async () => {
    const response = await download("exports/deck-v2.pptx");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(
        response.headers.get("content-disposition")!,
        /^attachment; filename="deck-v2.pptx"/,
    );
    assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        Buffer.from([0x50, 0x4b, 3, 4, 0, 255]),
    );

    // No quote or line break of a name gets into the header.
    const odd = await download('exports/odd "name"\n.png');

    assert.equal(odd.status, 200);
    assert.doesNotMatch(odd.headers.get("content-disposition")!, /\n|"name"/);
});

test("downloads preserve text, image, SVG, binary, and large file bytes and Unicode names", async () => {
    for (const [name, bytes] of [
        ["notes with spaces.txt", Buffer.from("text\\r\\n雪\\n")],
        [
            "drawing.svg",
            Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>雪</text></svg>'),
        ],
        ["雪's (image).png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])],
        ["NerdFontsSymbolsMono.woff2", Buffer.alloc(1_100_000, 255)],
    ] as const) {
        writeFileSync(join(work, name), bytes);
        const response = await download(name);

        assert.equal(response.status, 200, name);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, name);
        const disposition = response.headers.get("content-disposition")!;

        assert.ok(disposition.startsWith("attachment;"));
        assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!), name);
        assert.doesNotMatch(disposition.split("filename*=UTF-8''")[1]!, /['()*]/);
    }
});

test("a download needs a sign-in, a file, and, for a viewer, a file in the session's folder", async () => {
    const anonymous = await fetch(
        `http://127.0.0.1:${port}/api/c/${id}/download?path=exports/deck-v2.pptx`,
    );

    assert.equal(anonymous.status, 401);
    assert.equal((await download("exports/missing.pptx")).status, 404);
    assert.equal((await download("exports")).status, 404);
    assert.equal((await download("")).status, 400);

    const outside = join(work, "..", "outside-download.txt");

    writeFileSync(outside, "secret");
    symlinkSync(outside, join(work, "exports", "link.txt"));

    // A link at the file is not followed, for anyone.
    assert.equal((await download("exports/link.txt")).status, 404);

    const viewer = app.config.addUser("Viewer", "viewer").token;

    assert.equal((await download("exports/deck-v2.pptx", viewer)).status, 200);
    assert.equal((await download(outside, viewer)).status, 404);

    const scoped = app.config.addUser("Session guest", "guest", [String(id)]).token;
    const elsewhere = await newSession(app, join(work, "exports"));

    assert.equal((await download(outside, scoped)).status, 404);
    assert.equal((await download("exports/deck-v2.pptx", scoped)).status, 200);
    assert.equal(
        (
            await fetch(`http://127.0.0.1:${port}/api/c/${elsewhere}/download?path=deck-v2.pptx`, {
                headers: { authorization: `Bearer ${scoped}` },
            })
        ).status,
        404,
    );

    const secret = join(process.env.PI_CODING_AGENT_DIR!, "secret.txt");
    const dataSecret = join(root, "data", "private.txt");
    const guest = app.config.addUser("Global guest", "guest").token;

    writeFileSync(secret, "sign-in data");
    writeFileSync(dataSecret, "private data");
    assert.equal((await download(secret, guest)).status, 404);
    assert.equal((await download(dataSecret, guest)).status, 404);
    assert.equal((await download(secret)).status, 200);

    if (process.platform === "linux") {
        const fifo = join(work, "pipe");

        execFileSync("mkfifo", [fifo]);
        assert.equal((await download(fifo)).status, 404, "a pipe must not block the server");
    }
});

test("the Emacs route checks authentication, owner access, input, regular files, and binary support before calling a client", async () => {
    const guest = app.config.addUser("Editor guest", "guest", [String(id)]).token;
    const call = (body: unknown, token?: string, pocket = true) =>
        fetch(`http://127.0.0.1:${port}/api/c/${id}/emacs`, {
            method: "POST",
            headers: {
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(pocket ? { "x-pocket": "1" } : {}),
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });

    assert.equal((await call({ path: "." })).status, 401);
    assert.equal((await call({ path: "." }, guest)).status, 403);
    assert.equal((await call({ path: "." }, app.config.ownerToken, false)).status, 403);
    assert.equal((await call({ path: "" }, app.config.ownerToken)).status, 400);
    assert.equal((await call({ path: "missing.txt" }, app.config.ownerToken)).status, 404);
    assert.equal((await call({ path: "exports" }, app.config.ownerToken)).status, 404);
    const binary = await call({ path: "exports/deck-v2.pptx" }, app.config.ownerToken);

    assert.equal(binary.status, 409);
    assert.match(await binary.text(), /Download/);
});
