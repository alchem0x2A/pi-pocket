import { cleanUp, owner, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { PocketApp } from "../src/server/app.ts";

const app = await PocketApp.open({
    dataDir: join(root, "scope-data"),
    defaultCwd: work,
    supervised: false,
    log: () => {},
    configureModels: (models) => models.registerNativeProvider(scriptedModel().provider),
});

type Choices = Awaited<ReturnType<typeof app.modelList>>;
const scopedIds = (models: Choices) =>
    models.filter((model) => model.scoped).map((model) => model.id);

after(async () => {
    await app.close();
    cleanUp();
});

test("scope is optional picker metadata and uses the agent patterns without applying thinking", async () => {
    app.settings.setEnabledModels(["faux/*2:high", "faux/faux-2"]);
    const choices = (await app.hello(owner(app))).models;

    assert.deepEqual(scopedIds(choices), ["faux-2"]);
    assert.equal(choices.length, 3);
    assert.ok(choices.every((model) => !Object.hasOwn(model, "thinkingLevel")));
    assert.equal(app.config.defaultModel, undefined);
});

test("a sign-in store that cannot be read leaves the scope out rather than failing hello", async () => {
    const auth = join(process.env.PI_CODING_AGENT_DIR!, "auth.json");

    writeFileSync(auth, "{ not json");
    app.settings.setEnabledModels(["faux/faux-2"]);

    try {
        const choices = (await app.hello(owner(app))).models;

        assert.equal(choices.length, 3);
    } finally {
        rmSync(auth);
    }
});

test("hiddenModels leaves matching models out of All, but never a scoped one", async () => {
    const folder = join(work, ".pi");
    const file = join(folder, "settings.json");

    mkdirSync(folder, { recursive: true });
    writeFileSync(file, JSON.stringify({ hiddenModels: ["faux/faux-1", "*-2", 7] }));

    try {
        await app.settings.reload();
        app.settings.setEnabledModels(["faux/faux-2"]);

        const ids = (await app.hello(owner(app))).models.map((model) => model.id);

        assert.ok(!ids.includes("faux-1"), "a hidden model is left out");
        assert.ok(ids.includes("faux-2"), "a scoped model stays though a pattern matches it");
        assert.ok(ids.includes("faux-vision"), "a model no pattern matches stays");
    } finally {
        rmSync(folder, { recursive: true, force: true });
        await app.settings.reload();
    }
});
