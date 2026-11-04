// The owner's instruction-file list and editor: Pi's global and project context paths, disk writes, and access checks.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type App, cleanUp, newSession, openApp, root, scriptedModel } from "./helpers.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: ReturnType<typeof createServer>;
let base: string;
const project = join(root, "instruction-project");
const nested = join(project, "nested");
const globalFile = join(process.env.PI_CODING_AGENT_DIR!, "AGENTS.md");
const projectFile = join(project, "AGENTS.md");
const nestedFile = join(nested, "AGENTS.md");
const linkedFile = join(nested, "AGENTS.override.md");
const outsideFile = join(root, "outside.txt");

before(async () => {
    mkdirSync(nested, { recursive: true });
    writeFileSync(globalFile, "Global rules.\n");
    writeFileSync(projectFile, "Project rules.\n");
    writeFileSync(nestedFile, "Nested rules.\n");
    writeFileSync(outsideFile, "Keep this file.\n");
    symlinkSync(outsideFile, linkedFile);
    app = await openApp(scriptedModel());
    await newSession(app, nested);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function call(path: string, token: string, method = "GET", body?: unknown) {
    return fetch(`${base}/api/${path}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-pocket": "1",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

test("lists global and folder context files with paths, and reports Memory storage", async () => {
    const response = await call("instruction-files", app.config.ownerToken);

    assert.equal(response.status, 200);
    const data = (await response.json()) as {
        memoryPath: string;
        files: { path: string; content: string; exists: boolean }[];
    };
    const paths = data.files.map((file) => file.path);

    assert.equal(data.memoryPath, join(app.dataDir, "pocket.sqlite"));
    assert.ok(paths.includes(globalFile));
    assert.ok(paths.includes(projectFile));
    assert.ok(paths.includes(nestedFile));
    assert.ok(paths.includes(linkedFile));
    assert.equal(data.files.find((file) => file.path === linkedFile)?.exists, true);
    assert.equal(data.files.find((file) => file.path === nestedFile)?.content, "Nested rules.\n");
});

test("saves a listed context file to disk and refuses other paths and non-owners", async () => {
    const ownerToken = app.config.ownerToken;
    const text = "Updated instructions.\n";

    assert.equal(
        (await call("instruction-files", ownerToken, "PUT", { path: nestedFile, content: text }))
            .status,
        200,
    );
    assert.equal(readFileSync(nestedFile, "utf8"), text);
    assert.equal(
        (
            await call("instruction-files", ownerToken, "PUT", {
                path: outsideFile,
                content: "No.",
            })
        ).status,
        404,
    );
    assert.equal(
        (
            await call("instruction-files", ownerToken, "PUT", {
                path: linkedFile,
                content: "Do not follow this link.",
            })
        ).status,
        409,
    );
    assert.equal(readFileSync(outsideFile, "utf8"), "Keep this file.\n");

    const guest = app.config.addUser("Guest", "guest").token;

    assert.equal((await call("instruction-files", guest)).status, 403);
    assert.equal(
        (await call("instruction-files", guest, "PUT", { path: nestedFile, content: "No." }))
            .status,
        403,
    );
});
