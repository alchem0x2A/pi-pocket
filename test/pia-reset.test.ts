// The helper panel keeps its conversation across closes. Start fresh resets context, not stored work.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { FollowsDoc } from "../src/server/docs.ts";
import {
    cleanUp,
    context,
    fakeTab,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    work,
} from "./helpers.ts";

const model = scriptedModel(() => fauxAssistantMessage([fauxText("Acknowledged.")]));

after(cleanUp);

for (const profile of ["classic", "pia"] as const) {
    test(`${profile}: panel close preserves context; Start fresh retains history, files, and sessions`, async () => {
        const app = await openApp(model, join(root, `helper-reset-${profile}`));

        try {
            const person = owner(app);

            await app.setAssistantProfile(person, profile);

            const worker = await newSession(app);
            const id = await app.pip.ensure(person);

            await app.commands.configure(id, person, {
                model: { provider: "faux", modelId: "faux-1" },
                thinkingLevel: "off",
            });
            await say(app, worker, "Keep this independent worker history.");
            await say(app, id, "Before reset: unique-helper-context-marker.");

            const tab = fakeTab(undefined, person);

            app.attach(tab.client);
            await app.setPip(person, tab.client.connection, true);
            await app.setPip(person, tab.client.connection, false);
            await app.setPip(person, tab.client.connection, true);
            assert.equal(app.pip.idOf(person.id), id);
            assert.match((await modelTexts(app, id)).join("\n"), /unique-helper-context-marker/);

            const file = join(work, "helper-reset-keeps-files.txt");
            const sessions = app.sessions().map((session) => session.id);
            const follows = await app.harness.snapshot(FollowsDoc, id, context);

            writeFileSync(file, "Keep workspace files.\n");
            await app.commands.reset(id, person, undefined);
            assert.doesNotMatch(
                (await modelTexts(app, id)).join("\n"),
                /unique-helper-context-marker/,
            );
            assert.match(
                JSON.stringify(await app.transcripts.allEntries(id, true)),
                /unique-helper-context-marker/,
            );
            assert.equal(readFileSync(file, "utf8"), "Keep workspace files.\n");
            assert.deepEqual(
                app.sessions().map((session) => session.id),
                sessions,
            );
            assert.match((await modelTexts(app, worker)).join("\n"), /independent worker history/);
            assert.deepEqual(await app.harness.snapshot(FollowsDoc, id, context), follows);
            assert.equal(await app.pip.ensure(person), id);
            await app.setPip(person, tab.client.connection, false);
        } finally {
            await app.close();
        }
    });
}
