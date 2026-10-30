// This suite uses the real local discovery policy; older scripted-model fixtures use eager exposure.
import {
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    work,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    AgentDoc,
    type ConversationId,
    createRegistry,
    defineExtension,
    defineTool,
    section,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { hasRipgrep, localToolRegistry } from "../src/server/local-tools.ts";

process.env.PI_POCKET_TOOL_DISCOVERY = "on";

const requests: string[][] = [];
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const model = scriptedModel((request) => {
    const offered = new Set<string>();

    for (const message of request.messages) {
        if (message.role === "system") {
            for (const tool of message.toolsAdded ?? []) {
                offered.add(tool.name);
            }

            for (const tool of message.toolsRemoved ?? []) {
                offered.delete(tool.name);
            }
        }
    }

    requests.push([...offered]);
    const { role, text } = lastText(request);

    if (role === "user" && text === "parallel loading") {
        return fauxAssistantMessage(
            [
                fauxToolCall("tool_load", { names: ["browser"] }),
                fauxToolCall("tool_load", { names: ["edit"] }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (role === "user" && text.startsWith("call ")) {
        const [name = "", ...rest] = text.slice(5).split(" ");

        return tool(name, JSON.parse(rest.join(" ")));
    }

    return fauxAssistantMessage([fauxText("done")]);
});
const data = join(root, "local-tools-data");
let app: App;

before(async () => {
    app = await openApp(model, data);
});
after(async () => {
    await app?.close();
});

const agent = async (id: ConversationId) => (await app.conversation(id)).agent(context);
const names = async (id: ConversationId) => (await agent(id)).tools.map((tool) => tool.name);

const renderSection = async (id: ConversationId, key: string) => {
    const current = await agent(id);
    const guide = current.sections.find((section) => section.key === key)!;

    return guide.render(
        {
            conversationId: id,
            agent: current,
            env: undefined,
            shown: {},
            read: {
                snapshot: (...args: Parameters<App["harness"]["snapshot"]>) =>
                    app.harness.snapshot(...args),
            } as never,
        },
        context,
    );
};

const results = async (id: ConversationId) => {
    const view = await (await app.conversation(id)).context(context);

    return view.messages.filter((message) => message.role === "toolResult");
};

test("sessions offer only the small set; PiP's explicit extension selection is unchanged", async () => {
    const id = await newSession(app);
    const offered = await names(id);

    assert.deepEqual(offered.filter((name) => name !== "rg").sort(), [
        "bash",
        "ls",
        "read",
        "tool_load",
        "tool_search",
        "write",
    ]);
    assert.ok((await agent(id)).deferred.some((tool) => tool.name === "browser"));
    assert.ok((await agent(id)).deferred.some((tool) => tool.name === "edit"));
    assert.ok((await agent(id)).deferred.some((tool) => tool.name === "subagent"));

    const pip = await app.pip.ensure(owner(app));

    assert.ok((await names(pip)).includes("sessions"));
    assert.ok(!(await names(pip)).includes("tool_search"));
    assert.ok(!(await names(pip)).includes("bash"));
});

test("catalog lists all eligible tools with compact summaries and stays stable when loading", async (t) => {
    const id = await newSession(app);
    const catalog = (await renderSection(id, "available_tools")) as string;
    const current = await agent(id);
    const expected = [...current.tools, ...current.deferred].map((tool) => tool.name).sort();
    const listed = catalog.split("\n").map((line) => /^- `([^`]+)`: (.+)$/.exec(line)!);

    assert.deepEqual(listed.map((match) => match[1]).sort(), expected);
    assert.ok(listed.every((match) => match[2]!.split(/\s+/).length <= 5));
    assert.ok(listed.every((match) => match[2]!.length <= 80));
    assert.match(catalog, /`browser`: Browse and inspect websites/);
    assert.match(catalog, /`request_restart`: Request Pi Pocket server restart/);
    assert.ok(!catalog.includes("`team`:"));
    assert.ok(!(await names(id)).includes("browser"));
    await say(app, id, 'call tool_load {"names":["browser"]}');
    assert.equal(
        await renderSection(id, "available_tools"),
        catalog,
        "loading does not churn the catalog prefix",
    );
    t.diagnostic(`Catalog: ${listed.length} tools, ${Buffer.byteLength(catalog)} bytes.`);
});

test("catalog reflects extension toggles and conversation exclusions on the next request", async () => {
    const id = await newSession(app);

    assert.match((await renderSection(id, "available_tools")) as string, /`background`:/);
    await app.setExtensionEnabled(owner(app), "background.ts", false);
    assert.ok(!(await renderSection(id, "available_tools"))!.includes("`background`:"));
    await app.setExtensionEnabled(owner(app), "background.ts", true);
    assert.match((await renderSection(id, "available_tools")) as string, /`background`:/);
    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentDoc, id)).tools = { remove: ["browser"] };
    }, context);
    assert.ok(!(await renderSection(id, "available_tools"))!.includes("`browser`:"));
});

test("hot-loaded tools can supply local shortDescription metadata with a safe fallback", async () => {
    const path = join(data, "extensions", "catalog-example.ts");

    writeFileSync(
        path,
        `/** Test catalog metadata. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
export const pocketApi = 2;
const make = (name, shortDescription, callers = ["model", "tools"]) => Object.assign(defineTool({
    name, description: "A complete description for discovery, not the short catalog entry.",
    parameters: Type.Object({}), callers, execute: async () => ({ output: [] }),
}), { shortDescription });
export default () => defineExtension({ name: "catalog-example", tools: [
    make("catalog_custom", "  Inspect\\nlocal    test objects  "),
    make("catalog_unknown", undefined),
    make("catalog_long", "This summary has more than five words"),
    make("catalog_blank", "   "),
    make("catalog_huge", "x".repeat(81)),
    make("catalog_nested", "Only callable by other tools", ["tools"]),
] });
`,
    );
    const id = await newSession(app);

    assert.ok(!(await renderSection(id, "available_tools"))!.includes("`catalog_custom`:"));
    await app.setExtensionEnabled(owner(app), "catalog-example.ts", true);
    const catalog = (await renderSection(id, "available_tools")) as string;

    assert.match(catalog, /`catalog_custom`: Inspect local test objects/);

    for (const name of ["catalog_unknown", "catalog_long", "catalog_blank", "catalog_huge"]) {
        assert.ok(catalog.includes(`- \`${name}\`: Search for tool details`));
    }

    assert.ok(!catalog.includes("`catalog_nested`:"));
    assert.ok(!(await names(id)).includes("catalog_custom"));
    writeFileSync(
        path,
        readFileSync(path, "utf8")
            .replace("test objects", "project records")
            .replace('"catalog_unknown"', '"catalog_added"'),
    );
    await app.loader.reload("catalog-example.ts");
    const refreshed = (await renderSection(id, "available_tools")) as string;

    assert.match(refreshed, /`catalog_custom`: Inspect local project records/);
    assert.ok(refreshed.includes("`catalog_added`:"));
    assert.ok(!refreshed.includes("`catalog_unknown`:"));
    await say(app, id, "catalog refresh");
    const view = await (await app.conversation(id)).context(context);
    const shown = view.messages
        .filter((message) => message.role === "system")
        .map((message) => message.sections?.available_tools)
        .filter((section) => typeof section === "string")
        .at(-1);

    assert.match(shown!, /`catalog_custom`: Inspect local project records/);
    assert.ok(!(await names(id)).includes("catalog_custom"));
    await app.setExtensionEnabled(owner(app), "catalog-example.ts", false);
    assert.ok(!(await renderSection(id, "available_tools"))!.includes("`catalog_custom`:"));
});

test("search changes no exposure; explicit loading adds only selected schemas on the next request", async () => {
    const id = await newSession(app);
    const other = await newSession(app);

    const initial = await names(id);

    await say(app, id, 'call tool_search {"query":"browser","limit":1}');
    assert.deepEqual(await names(id), initial);
    assert.equal((await app.agentState(id))?.modelTools, undefined);
    assert.ok(!requests.at(-1)!.includes("browser"));
    assert.match(JSON.stringify((await results(id)).at(-1)?.details), /browser/);
    await say(app, id, 'call tool_load {"names":["browser"]}');
    assert.ok((await names(id)).includes("browser"), JSON.stringify(await results(id)));
    assert.ok(!(await names(id)).includes("subagent"));
    assert.ok(!(await names(other)).includes("browser"));
    assert.ok(
        requests.at(-1)!.includes("browser"),
        "the model receives the loaded schema on its next request",
    );
    assert.deepEqual((await app.agentState(id))?.modelTools, { add: ["browser"] });

    writeFileSync(join(work, "discovery-edit.txt"), "before");
    await say(app, id, 'call tool_load {"names":["edit"]}');
    await say(
        app,
        id,
        'call edit {"path":"discovery-edit.txt","oldText":"before","newText":"after"}',
    );
    assert.ok((await names(id)).includes("edit"));
    assert.equal(readFileSync(join(work, "discovery-edit.txt"), "utf8"), "after");
    assert.equal((await results(id)).at(-1)?.isError, false);
});

test("optional guides disappear before loading, lessons and policy sections remain", async () => {
    const id = await newSession(app);
    const before = await agent(id);

    const render = async (key: string) => {
        const current = await agent(id);
        const guide = current.sections.find((section) => section.key === key)!;

        return guide.render(
            {
                conversationId: id,
                agent: current,
                env: undefined,
                shown: {},
                read: {
                    snapshot: (...args: Parameters<App["harness"]["snapshot"]>) =>
                        app.harness.snapshot(...args),
                } as never,
            },
            context,
        );
    };

    assert.ok(before.sections.some((section) => section.key === "memory"));
    assert.equal(await render("browser"), undefined);
    assert.equal(await render("subagents"), undefined);
    assert.equal(await render("codemode"), undefined);
    assert.ok(await render("tool_discovery"));

    await say(app, id, 'call tool_search {"query":"browser","limit":1}');
    assert.equal(await render("browser"), undefined);
    await say(app, id, 'call tool_load {"names":["browser"]}');
    assert.ok(await render("browser"));
    assert.equal(await render("subagents"), undefined);
});

test("search rejects invalid input and handles no matches without loading", async () => {
    for (const args of [
        { query: "" },
        { query: "browser", limit: 0 },
        { query: "browser", limit: 11 },
        { query: "browser", limit: 1.5 },
        { query: "zzzzqxjnonexistent" },
    ]) {
        const id = await newSession(app);

        await say(app, id, `call tool_search ${JSON.stringify(args)}`);
        assert.ok(!(await names(id)).includes("browser"));
        assert.ok(!(await names(id)).includes("subagent"));
    }
});

test("disabled extensions and explicitly excluded tools are not discoverable", async () => {
    const id = await newSession(app);

    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentDoc, id)).tools = { remove: ["browser"] };
    }, context);
    await say(app, id, 'call tool_search {"query":"browser","limit":1}');
    assert.ok(!(await names(id)).includes("browser"));
    assert.ok(!(await agent(id)).deferred.some((tool) => tool.name === "browser"));
    await app.setExtensionEnabled(owner(app), "background.ts", false);
    await say(app, id, 'call tool_search {"query":"background","limit":1}');
    assert.ok(!(await names(id)).includes("background"));
    await say(app, id, 'call tool_load {"names":["background"]}');
    assert.equal((await results(id)).at(-1)?.isError, true);
    await say(app, id, 'call tool_load {"names":["browser"]}');
    assert.equal((await results(id)).at(-1)?.isError, true);
    await app.setExtensionEnabled(owner(app), "background.ts", true);
    await say(app, id, 'call tool_load {"names":["background"]}');
    assert.ok((await names(id)).includes("background"));
    await app.setExtensionEnabled(owner(app), "background.ts", false);
    assert.ok(!(await names(id)).includes("background"));
    await app.setExtensionEnabled(owner(app), "background.ts", true);
    assert.ok(
        (await names(id)).includes("background"),
        "a registered tool retains its loaded choice",
    );
    assert.ok(
        !(await agent(id)).deferred.some((tool) => tool.name === "team"),
        "off-by-default extensions stay off",
    );
});

test("loading persists across restart and compaction, but new sessions stay small", async () => {
    const id = await newSession(app);

    await say(app, id, 'call tool_load {"names":["browser"]}');
    await app.commands.compact(id, owner(app), undefined);
    assert.ok((await names(id)).includes("browser"));
    await app.close();
    app = await openApp(model, data);
    assert.ok((await names(id)).includes("browser"));
    assert.ok(!(await names(await newSession(app))).includes("browser"));
});

test("ls uses the session cwd, includes hidden entries, bounds output, and reports errors", async () => {
    const cwd = join(work, "listing");

    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, ".hidden"), "hidden");
    writeFileSync(join(cwd, "normal"), "normal");
    const id = await newSession(app, cwd);

    await say(app, id, "call ls {}");
    const listing = JSON.stringify((await results(id)).at(-1));

    assert.match(listing, /\.hidden/);
    assert.match(listing, /normal/);
    await say(app, id, 'call ls {"limit":1}');
    assert.match(JSON.stringify((await results(id)).at(-1)), /truncated/);
    await say(app, id, 'call ls {"path":"missing"}');
    assert.equal((await results(id)).at(-1)?.isError, true);
});

test("repeated and concurrent explicit loads do not duplicate or lose loaded tools", async () => {
    const id = await newSession(app);

    await say(app, id, "parallel loading");
    assert.ok((await names(id)).includes("browser"));
    assert.ok((await names(id)).includes("edit"));
    const before = await names(id);

    await say(app, id, 'call tool_load {"names":["browser","browser"]}');
    assert.deepEqual(await names(id), before);
    assert.match(JSON.stringify((await results(id)).at(-1)), /already available/);
});

test("task queries return short candidates, not schemas, and never load matches", async () => {
    const id = await newSession(app);

    const before = await names(id);

    await say(app, id, 'call tool_search {"query":"start a long command in the background"}');
    assert.deepEqual(await names(id), before);
    const found = (await results(id)).at(-1)!.details as {
        matches: { name: string; description: string }[];
    };

    assert.ok(found.matches.some((match) => match.name === "background"));
    assert.ok(found.matches.length <= 3);
    assert.ok(found.matches.every((match) => match.description.length <= 160));
    assert.ok(!JSON.stringify(found).includes('"parameters"'));

    await say(app, id, 'call tool_search {"query":"zzzzqxjnonexistent"}');
    assert.deepEqual(await names(id), before);
    assert.match(JSON.stringify((await results(id)).at(-1)), /No matching tools/);
});

test("web search can suggest irrelevant candidates without loading them", async () => {
    const id = await newSession(app);
    const before = await names(id);

    await say(app, id, 'call tool_search {"query":"search the web"}');
    const found = (await results(id)).at(-1)!.details as { matches: { name: string }[] };

    assert.ok(found.matches.some((match) => match.name === "browser"));
    assert.deepEqual(await names(id), before);
    assert.equal((await app.agentState(id))?.modelTools, undefined);
    await say(app, id, 'call tool_load {"names":["browser"]}');
    assert.ok((await names(id)).includes("browser"));
    assert.ok(!(await names(id)).includes("request_restart"));
});

test("loads reject invalid and mixed unknown batches atomically", async () => {
    for (const namesToLoad of [
        [],
        [""],
        ["   "],
        ["browser", "not_a_tool"],
        Array(11).fill("browser"),
    ]) {
        const id = await newSession(app);
        const before = await names(id);

        await say(app, id, `call tool_load ${JSON.stringify({ names: namesToLoad })}`);
        assert.equal((await results(id)).at(-1)?.isError, true);
        assert.deepEqual(await names(id), before);
        assert.equal((await app.agentState(id))?.modelTools, undefined);
    }
});

test("loading rechecks availability after discovery, with no partial batch load", async () => {
    const id = await newSession(app);

    await say(app, id, 'call tool_search {"query":"browser"}');
    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentDoc, id)).tools = { remove: ["browser"] };
    }, context);
    await say(app, id, 'call tool_load {"names":["browser","edit"]}');
    assert.equal((await results(id)).at(-1)?.isError, true);
    assert.ok(!(await names(id)).includes("browser"));
    assert.ok(!(await names(id)).includes("edit"));
    assert.equal((await app.agentState(id))?.modelTools, undefined);
});

test("forks inherit only the tools loaded at the fork point", async () => {
    const id = await newSession(app);

    await say(app, id, "before discovery");
    const old = (await (await app.conversation(id)).entries({}, 20, undefined, context)).items.find(
        (entry) => entry.kind === "pi.assistant",
    )!;

    await say(app, id, 'call tool_load {"names":["browser"]}');
    const latest = (
        await (await app.conversation(id)).entries({}, 20, undefined, context)
    ).items.find((entry) => entry.kind === "pi.assistant")!;
    const early = await app.commands.fork(id, owner(app), { entryId: Number(old.id) });
    const late = await app.commands.fork(id, owner(app), { entryId: Number(latest.id) });

    assert.ok(!(await names(early.id)).includes("browser"));
    assert.ok((await names(late.id)).includes("browser"));
});

test("plan mode permits discovery and ls, but a loaded edit tool still meets the plan hook", async () => {
    const id = await newSession(app);

    await app.commands.setPlan(id, owner(app), true);
    await say(app, id, 'call tool_search {"query":"edit","limit":1}');
    assert.ok(!(await names(id)).includes("edit"));
    await say(app, id, 'call tool_load {"names":["edit"]}');
    assert.ok((await names(id)).includes("edit"));
    await say(app, id, "call ls {}");
    assert.equal((await results(id)).at(-1)?.isError, false);
    await say(
        app,
        id,
        'call edit {"path":"discovery-edit.txt","oldText":"after","newText":"blocked"}',
    );
    assert.equal((await results(id)).at(-1)?.isError, true);
    assert.equal(readFileSync(join(work, "discovery-edit.txt"), "utf8"), "after");
});

test("initial schema payload is substantially smaller than eager exposure", async (t) => {
    const small = await newSession(app);
    const eager = await newSession(app);

    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentDoc, eager)).extensions = { remove: ["pocket-local-tools"] };
    }, context);

    const size = async (id: ConversationId) => {
        const tools = (await agent(id)).tools;

        return {
            count: tools.length,
            bytes: Buffer.byteLength(
                JSON.stringify(
                    tools.map(({ name, description, parameters }) => ({
                        name,
                        description,
                        parameters,
                    })),
                ),
            ),
        };
    };

    const a = await size(small);
    const b = await size(eager);

    assert.ok(a.bytes < b.bytes / 2, JSON.stringify({ small: a, eager: b }));
    t.diagnostic(
        `Schema payload: small ${a.count} tools / ${a.bytes} bytes; eager ${b.count} tools / ${b.bytes} bytes.`,
    );
});

test("ripgrep availability requires an executable file on PATH", async () => {
    const previous = process.env.PATH;
    const folder = join(root, "fake-rg-bin");

    mkdirSync(folder);
    process.env.PATH = folder;

    try {
        assert.equal(await hasRipgrep(), false);
        writeFileSync(join(folder, "rg"), "#!/bin/sh\nexit 0\n", { mode: 0o600 });
        assert.equal(await hasRipgrep(), false);
        chmodSync(join(folder, "rg"), 0o700);
        assert.equal(await hasRipgrep(), true);
    } finally {
        if (previous === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = previous;
        }
    }
});

test("rg uses argument arrays, preserves the environment, and handles no matches", async () => {
    const registry = createRegistry();
    const tool = localToolRegistry(registry, true)
        .snapshot()
        .tools()
        .find(({ tool }) => tool.name === "rg")!.tool;
    const calls: unknown[][] = [];
    const fake = {
        env: {
            exec: async (...args: unknown[]) => {
                calls.push(args);

                return { ok: true, value: { exitCode: 1 } };
            },
        },
        output: () => {},
    };
    const result = await tool.execute(
        { pattern: "$(touch nope)", path: "-file", glob: "*.ts", ignoreCase: true },
        fake as never,
        context,
    );

    assert.equal(result.isError, false);
    assert.match(JSON.stringify(result.output), /No matches/);
    assert.deepEqual((calls[0]![0] as string[]).slice(-3), ["--", "$(touch nope)", "-file"]);
    assert.ok((calls[0]![0] as string[]).includes("--ignore-case"));
});

test("registry view tracks new and removed extensions without mutating the upstream registry", () => {
    const registry = createRegistry();
    const view = localToolRegistry(registry, false);
    const initial = view.snapshot();
    const example = defineExtension({
        name: "example",
        tools: [
            defineTool({
                name: "custom",
                description: "Custom tool",
                parameters: Type.Object({}),
                execute: async () => ({ output: [] }),
            }),
        ],
        sections: [section("custom_guide", () => "Guide")],
    });

    registry.install(example);
    assert.notEqual(view.snapshot(), initial);
    assert.equal(view.snapshot(), view.snapshot(), "snapshot views are cached");
    assert.ok(
        view
            .snapshot()
            .extension("pocket-local-tools")
            ?.wraps?.some((wrap) => "tool" in wrap && wrap.tool === "custom"),
    );
    assert.equal(registry.snapshot().extension("example")?.tools?.[0]?.deferred, undefined);
    assert.ok(
        !view
            .snapshot()
            .extension("pocket-local-tools")
            ?.wraps?.some((wrap) => "section" in wrap && wrap.section === "custom_guide"),
        "unknown extension sections can contain standing rules and remain visible",
    );
    registry.uninstall(example);
    assert.ok(
        !view
            .snapshot()
            .tools()
            .some(({ tool }) => tool.name === "custom"),
    );
    assert.ok(
        !view
            .snapshot()
            .tools()
            .some(({ tool }) => tool.name === "rg"),
    );
    assert.ok(
        localToolRegistry(registry, true)
            .snapshot()
            .tools()
            .some(({ tool }) => tool.name === "rg"),
    );
});
