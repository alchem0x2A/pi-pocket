// Enabling the ordinary Subagents extension must work for the Pia helper, not just expose its schema.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SubagentsDoc } from "../src/server/docs.ts";
import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);

test("Pia can run an explicitly enabled ordinary subagent and receive its report", async () => {
    const model = scriptedModel((request) => {
        const { role, text } = lastText(request as never);

        if (role === "user" && text === "Start the optional helper.") {
            return fauxAssistantMessage(
                [
                    fauxToolCall("subagent", {
                        action: "spawn",
                        name: "optional-helper",
                        message: "Return the words: optional-helper-result.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText("optional-helper-result")]);
    });
    const app = await openApp(model, join(root, "pia-optional-subagent"));

    try {
        const person = owner(app);

        await newSession(app);
        await app.setAssistantProfile(person, "pia");
        assert.equal(app.loader.enabled("subagents.ts"), false);
        await app.setExtensionEnabled(person, "subagents.ts", true);

        const id = await app.pip.ensure(person);

        await say(app, id, "Start the optional helper.");
        await until(async () => {
            const state = await app.harness.snapshot(SubagentsDoc, id, context);

            return state?.agents["optional-helper"]?.answeredAt !== undefined;
        }, "Pia's optional subagent to finish");

        const state = await app.harness.snapshot(SubagentsDoc, id, context);

        assert.ok(state?.agents["optional-helper"]);
        await until(async () => {
            const entries = await app.transcripts.allEntries(id, true);

            return entries.some(
                (entry) => entry.kind === "user" && entry.text.includes("optional-helper-result"),
            );
        }, "Pia to receive the subagent report");
    } finally {
        await app.close();
    }
});
