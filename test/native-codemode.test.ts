// Native codemode is experimental. Use an isolated app and faux model; never use the owner's data.
import {
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

process.env.PI_POCKET_EXPERIMENTAL_NATIVE_CODEMODE = "on";
process.env.PI_POCKET_TOOL_DISCOVERY = "on";

const fixture = `/** A test tool that returns a known string. */
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";
import { Type } from "typebox";
export default () => defineExtension({ name: "fixture-native", tools: [defineTool({
    name: "fixture_native", description: "A unique frobnicator test tool", parameters: Type.Object({ word: Type.String() }),
    async execute(args) { return { output: [{ type: "text", text: "fixture:" + args.word }] }; }
}), defineTool({
    name: "model_only_fixture", description: "For the model only", parameters: Type.Object({}), callers: ["model"],
    async execute() { return { output: [{ type: "text", text: "model-only-secret" }] }; }
}), defineTool({
    name: "blocked_fixture", description: "Blocked by a real hook", parameters: Type.Object({}),
    async execute() { return { output: [{ type: "text", text: "blocked-secret" }] }; }
})], hooks: [hook(ToolTask, { beforeTool(call) {
    if (call.name === "blocked_fixture") return { block: "fixture denied" };
} })] });`;

test("native codemode discovers and calls a deferred extension tool in one script", async () => {
    const data = join(root, "native-codemode");
    const folder = join(data, "extensions");

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "fixture-native.ts"), fixture);
    const model = scriptedModel((request) => {
        const last = lastText(request);

        if (last.role === "user") {
            const code =
                last.text === "test boundaries"
                    ? 'text(ALL_TOOLS); for (const name of ["model_only_fixture", "blocked_fixture", "fixture_native"]) { try { text(await tools[name]({word:"hello"})); } catch (e) { text(name + ":" + e.message); } }'
                    : 'text(await searchTools("fixture_native")); text(await describeTool("fixture_native")); text(await tools.fixture_native({word:"hello"}));';

            return fauxAssistantMessage([fauxToolCall("codemode", { code })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText("done")]);
    });
    const app = await openApp(model, data, undefined, undefined, false);

    try {
        await app.setExtensionEnabled(owner(app), "fixture-native.ts", true);
        const id = await newSession(app);
        const before = await (await app.conversation(id)).agent(context);

        assert.ok(before.deferred.some((tool) => tool.name === "fixture_native"));
        assert.ok(!before.tools.some((tool) => tool.name === "fixture_native"));
        await say(app, id, "run the fixture");
        const conversation = await app.conversation(id);
        const view = await conversation.context(context);
        const result = view.messages.find(
            (message) => message.role === "toolResult" && message.toolName === "codemode",
        );

        assert.ok(result && result.role === "toolResult");
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.match(JSON.stringify(result.content), /fixture:hello/);
        assert.match(JSON.stringify(result.content), /fixture_native/);
        const after = await conversation.agent(context);

        assert.ok(!after.tools.some((tool) => tool.name === "fixture_native"));

        const excluded = after.callable.find((tool) => tool.name === "fixture_native");

        assert.ok(excluded);
        await conversation.configure({ tools: { remove: [excluded] } }, context);
        await say(app, id, "test boundaries");
        const boundaryView = await conversation.context(context);
        const boundaryResults = boundaryView.messages.filter(
            (message) => message.role === "toolResult" && message.toolName === "codemode",
        );
        const boundary = boundaryResults.at(-1);

        assert.ok(boundary && boundary.role === "toolResult");
        assert.equal(boundary.isError, false, JSON.stringify(boundary));
        const output = JSON.stringify(boundary.content);

        assert.match(output, /fixture denied/);
        assert.doesNotMatch(output, /model-only-secret|blocked-secret|fixture:hello/);
    } finally {
        await app.close();
    }
});
