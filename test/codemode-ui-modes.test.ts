// UI-read exposure is per conversation. These are isolated registry fixtures, not live Browser or Ink Board services.
import { context, lastText, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    createRegistry,
    defineExtension,
    defineTool,
    Harness,
    type Conversation,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Type } from "typebox";
import createCodemode from "../src/server/extensions/codemode.ts";
import type { ExtensionWeb, PocketHost } from "../src/server/host.ts";

test("Browser and ink_read keep On script access; Only keeps direct UI paths and Pia can stay On", async () => {
    let mode = "on";
    let piaOnly = false;
    const pia = new Set<number>();
    const executed = { browser: 0, ink_read: 0 };
    const disposers: (() => unknown)[] = [];
    const registry = createRegistry();
    const models = await ModelRuntime.create();
    const provider = scriptedModel((request) => {
        const last = lastText(request);

        if (last.role === "user") {
            const name =
                last.text === "direct"
                    ? "browser"
                    : last.text === "proxy"
                      ? "proxy_ui"
                      : "codemode";
            const args: Parameters<typeof fauxToolCall>[1] =
                name === "codemode"
                    ? {
                          code: `
                text("SEARCH " + (await searchTools("browser", {limit:10})).some(t=>t.name==="browser"));
                for (const name of ["browser", "ink_read"]) {
                    try { text(await tools[name]({})); } catch(e) { text("ERROR " + name + ":" + e.message); }
                }
            `,
                      }
                    : {};

            return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
        }

        return fauxAssistantMessage([fauxText("done")]);
    });

    models.registerNativeProvider(provider.provider);
    let harness: Harness;
    const extension = createCodemode(
        {
            history: (id: Conversation["id"]) => ({
                agent: async (scope: typeof context) =>
                    (await harness.conversation(id, scope))!.agent(scope),
                context: async (scope: typeof context) =>
                    (await harness.conversation(id, scope))!.context(scope),
            }),
            pia: { ownerOf: (id: number) => (pia.has(id) ? "owner" : undefined) },
        } as unknown as PocketHost,
        {
            settings: () => {},
            setting: (name: string) => (name === "mode" ? mode : piaOnly),
            onDispose: (dispose: () => unknown) => disposers.push(dispose),
        } as unknown as ExtensionWeb,
    );

    registry.install(extension);
    registry.install(
        defineExtension({
            name: "ui-fixtures",
            tools: [
                ...(["browser", "ink_read"] as const).map((name) =>
                    defineTool({
                        name,
                        description: name,
                        parameters: Type.Object({}),
                        async execute() {
                            executed[name]++;

                            return { output: [{ type: "text", text: name + " fixture" }] };
                        },
                    }),
                ),
                defineTool({
                    name: "proxy_ui",
                    description: "An explicit model-only UI caller",
                    parameters: Type.Object({}),
                    callers: ["model"],
                    async execute(_args, api, scope) {
                        const result = await api.executeTool("browser", {}, scope);

                        return {
                            isError: result.isError,
                            output: [
                                {
                                    type: "text",
                                    text: result.diagnostics.map((d) => d.message).join("\n"),
                                },
                            ],
                        };
                    },
                }),
            ],
        }),
    );
    harness = await Harness.open(new MemoryStorage(), { registry, models }, context);
    const conversation = await harness.createConversation(
        {
            ownership: { kind: "ownerless" },
            agent: { model: { provider: "faux", modelId: "faux-1" } },
        },
        context,
    );

    const ask = async (target: Conversation, message: string) => {
        await (await target.submit({ type: "input", content: message }, context)).wait(context);
        const view = await target.context(context);
        const result = view.messages.findLast((m) => m.role === "toolResult");

        assert.ok(result && result.role === "toolResult");

        return result;
    };

    try {
        const on = await ask(conversation, "scripts");

        assert.equal(on.isError, false, JSON.stringify(on));
        assert.match(JSON.stringify(on.content), /SEARCH true/);
        assert.deepEqual(executed, { browser: 1, ink_read: 1 });
        mode = "only";
        const only = await ask(conversation, "scripts");

        assert.equal(only.isError, false, JSON.stringify(only));
        assert.match(JSON.stringify(only.content), /SEARCH false/);
        assert.match(JSON.stringify(only.content), /ERROR browser:tools.browser does not exist/);
        assert.match(JSON.stringify(only.content), /ERROR ink_read:tools.ink_read does not exist/);
        assert.deepEqual(executed, { browser: 1, ink_read: 1 });
        assert.equal((await ask(conversation, "direct")).isError, false);
        assert.deepEqual(executed, { browser: 2, ink_read: 1 });
        const proxy = await ask(conversation, "proxy");

        assert.equal(proxy.isError, true);
        assert.match(
            JSON.stringify(proxy.content),
            /Only mode requires this UI read tool to be called directly/,
        );
        assert.deepEqual(executed, { browser: 2, ink_read: 1 });
        const personal = await harness.createConversation(
            {
                ownership: { kind: "ownerless" },
                agent: { model: { provider: "faux", modelId: "faux-1" } },
            },
            context,
        );

        pia.add(Number(personal.id));
        await ask(personal, "scripts");
        assert.deepEqual(
            executed,
            { browser: 3, ink_read: 2 },
            "Pia stays On while ordinary sessions use Only",
        );
        piaOnly = true;
        await ask(personal, "scripts");
        assert.deepEqual(executed, { browser: 3, ink_read: 2 }, "Pia Only is a separate choice");
        mode = "on";
        await ask(conversation, "scripts");
        assert.deepEqual(
            executed,
            { browser: 4, ink_read: 3 },
            "switching back restores script access",
        );
    } finally {
        await harness.close(context);

        for (const dispose of disposers) {
            await dispose();
        }
    }
});
