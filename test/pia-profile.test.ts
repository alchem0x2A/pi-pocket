// Pia is the only built-in assistant behavior, with a configurable name and a shared workspace.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { assistantOwner } from "../src/server/docs.ts";
import { ConfigStore } from "../src/server/config.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { piaAgentsFile, piaWorkspace } from "../src/server/pia.ts";
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    work,
    type App,
} from "./helpers.ts";

const data = join(root, "pia-single-assistant");
const model = scriptedModel(() => fauxAssistantMessage([fauxText("ok")]));
let app: App;

before(async () => {
    app = await openApp(model, data, undefined, undefined, false);
});
after(async () => {
    await app?.close();
    cleanUp();
});

const agent = async (id: ConversationId) => (await app.conversation(id)).agent(context);
const tools = async (id: ConversationId) => (await agent(id)).tools.map((tool) => tool.name);

test("Pia always uses the normal tools, shared workspace, and private assistant conversation", async () => {
    const person = owner(app);
    const id = await app.pia.ensure(person);
    const workspace = piaWorkspace(data);
    const state = await app.agentState(id);

    assert.equal(app.pia.name(), "Pia");
    assert.deepEqual((await app.hello(person)).server.assistant, { name: "Pia" });
    assert.equal(state?.cwd, workspace);
    assert.equal(app.sessionMeta(id)?.cwd, workspace);
    assert.ok(readFileSync(piaAgentsFile(data), "utf8").includes("# Pia"));

    const offered = await tools(id);

    for (const name of ["bash", "write", "edit", "session_start", "session_follow"]) {
        assert.ok(offered.includes(name), `${name} in ${offered.join(", ")}`);
    }

    assert.equal(app.pia.runsCommands(id), true);
    assert.ok(!(await app.sessions(person)).some((session) => session.id === Number(id)));
    assert.ok(app.loader.enabled("pip.ts"));

    const ordinary = await newSession(app);
    const ordinaryTools = await tools(ordinary);

    assert.ok(!ordinaryTools.includes("session_start"));
    assert.equal(app.pia.name(), "Pia");
});

test("the owner can set a display name without changing assistant behavior", async () => {
    const person = owner(app);
    const id = await app.pia.ensure(person);

    await app.setAssistantName(person, "  Nova   Helper ");
    assert.equal(app.pia.name(), "Nova Helper");
    assert.deepEqual((await app.hello(person)).server.assistant, { name: "Nova Helper" });
    assert.equal(await app.pia.ensure(person), id);
    assert.equal((await app.agentState(id))?.cwd, piaWorkspace(data));

    await app.setAssistantName(person, null);
    assert.equal(app.pia.name(), "Pia");
});

test("subagents and background default off, and explicit owner choices win", async () => {
    const person = owner(app);

    assert.equal(app.config.extensionChoice("subagents.ts"), undefined);
    assert.equal(app.config.extensionChoice("background.ts"), undefined);
    assert.equal(app.loader.enabled("subagents.ts"), false);
    assert.equal(app.loader.enabled("background.ts"), false);

    await app.setExtensionEnabled(person, "subagents.ts", true);
    await app.setExtensionEnabled(person, "background.ts", true);
    assert.equal(app.loader.enabled("subagents.ts"), true);
    assert.equal(app.loader.enabled("background.ts"), true);
});

test("an old session marker still identifies its assistant owner", () => {
    assert.equal(
        assistantOwner({ cwd: work, createdAt: 0, updatedAt: 0, pip: "owner-id" }),
        "owner-id",
    );
    assert.equal(
        assistantOwner({ cwd: work, createdAt: 0, updatedAt: 0, pia: "new-id" }),
        "new-id",
    );
});

test("an old config profile loads, is ignored, and drops on the next save", () => {
    const dir = mkdtempSync(join(tmpdir(), "pia-config-migration-"));

    try {
        const file = join(dir, "config.json");

        writeFileSync(
            file,
            `${JSON.stringify({
                version: 1,
                ownerToken: "legacy-token",
                users: [],
                assistantProfile: "classic",
                assistantName: "Nova",
                pipCompactAt: 60000,
            })}\n`,
        );

        const config = new ConfigStore(dir);

        assert.equal(config.assistantName, "Nova");
        config.assistantName = "Nova";

        const saved = JSON.parse(readFileSync(file, "utf8"));

        assert.equal(Object.hasOwn(saved, "assistantProfile"), false);
        assert.equal(Object.hasOwn(saved, "pipCompactAt"), false);
        assert.equal(saved.assistantName, "Nova");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
