// The lean start prompt of a normal session, the default (`PI_POCKET_LEAN_PROMPT=off` restores the full prompt): a short preamble, the project's
// AGENTS.md files inlined (the same section as the full prompt), a pointer to the skill directories and to the note
// trust rule, and short schemas for the base tools. Skills are not listed. Pia keeps its full prompt. The size check
// here counts characters (about 4 per token); the real token count is measured against the local model and recorded
// in docs/proposals/prompt-cost.md, section 4.1.
import { context, newSession, openApp, owner, root, say, scriptedModel } from "./helpers.ts";
import { localToolRegistry } from "../src/server/local-tools.ts";
import createPrompt from "../src/server/extensions/prompt.ts";
import type { PocketHost } from "../src/server/host.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { App } from "./helpers.ts";

process.env.PI_POCKET_TOOL_DISCOVERY = "on";
process.env.PI_POCKET_LEAN_PROMPT = "on";

const requests: Context[] = [];
const model = scriptedModel((request) => {
    requests.push(structuredClone(request) as Context);
    const last = request.messages.at(-1);
    const text =
        last?.role === "user" && Array.isArray(last.content)
            ? last.content.map((part) => (part.type === "text" ? part.text : "")).join("")
            : typeof last?.content === "string"
              ? last.content
              : "";

    if (text.startsWith("call ")) {
        const [name = "", ...rest] = text.slice(5).split(" ");

        return fauxAssistantMessage([fauxToolCall(name, JSON.parse(rest.join(" ")))], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText("done")]);
});
let app: App;
const folder = join(root, "lean-work");

before(async () => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "AGENTS.md"), "# Project\n\nLEAN_PROJECT_RULE: run the tests.\n");
    // A skill where the agent looks for them (`~/.agents/skills` under the test home).
    const skill = join(root, "home", ".agents", "skills", "chart-maker");

    mkdirSync(skill, { recursive: true });
    writeFileSync(
        join(skill, "SKILL.md"),
        "---\nname: chart-maker\ndescription: Draw a bar chart from a CSV file.\n---\n\nUse matplotlib.\n",
    );
    app = await openApp(model, join(root, "lean-data"));
});
after(async () => {
    await app?.close();
});

/** The sections and tools of a request, folded from its system messages. */
function folded(request: Context) {
    const sections = new Map<string, string>();
    const tools = new Map<string, { name: string; description: string; parameters: unknown }>();

    for (const message of request.messages) {
        if (message.role !== "system") {
            continue;
        }

        for (const [key, value] of Object.entries(message.sections ?? {})) {
            if (value === null) {
                sections.delete(key);
            } else {
                sections.set(key, value);
            }
        }

        for (const tool of message.toolsRemoved ?? []) {
            tools.delete(tool.name);
        }

        for (const tool of message.toolsAdded ?? []) {
            tools.set(tool.name, tool);
        }
    }

    return { sections, tools };
}

/** The folded first request of a new session in `target`, working in `cwd`. */
async function firstRequest(target: App, cwd: string): Promise<ReturnType<typeof folded>> {
    const id = await newSession(target, cwd);
    const before = requests.length;

    await say(target, id, "hello");

    return folded(requests[before]!);
}

/** Open an app under explicit switch values and read the folded first request of a normal session. */
async function requestUnder(
    lean: "on" | "off" | "unset",
    discovery: "on" | "off",
    dataDir: string,
): Promise<ReturnType<typeof folded>> {
    const previous = {
        lean: process.env.PI_POCKET_LEAN_PROMPT,
        discovery: process.env.PI_POCKET_TOOL_DISCOVERY,
    };

    if (lean === "unset") {
        delete process.env.PI_POCKET_LEAN_PROMPT;
    } else {
        process.env.PI_POCKET_LEAN_PROMPT = lean;
    }

    process.env.PI_POCKET_TOOL_DISCOVERY = discovery;

    const target = await openApp(model, dataDir);

    try {
        return await firstRequest(target, folder);
    } finally {
        await target.close();

        if (previous.lean === undefined) {
            delete process.env.PI_POCKET_LEAN_PROMPT;
        } else {
            process.env.PI_POCKET_LEAN_PROMPT = previous.lean;
        }

        if (previous.discovery === undefined) {
            delete process.env.PI_POCKET_TOOL_DISCOVERY;
        } else {
            process.env.PI_POCKET_TOOL_DISCOVERY = previous.discovery;
        }
    }
}

test("a normal session starts with a short prompt and short base tools", async () => {
    const { sections, tools } = await firstRequest(app, folder);
    const prompt = [...sections.values()].join("\n\n");
    const schemas = JSON.stringify([...tools.values()]);

    assert.deepEqual([...tools.keys()].sort(), [
        "bash",
        "codemode",
        "edit",
        "note_load",
        "note_search",
        "read",
        "tool_load",
        "tool_search",
        "write",
    ]);

    for (const gone of ["guidelines", "pocket_docs", "skills", "memory"]) {
        assert.equal(sections.has(gone), false, gone);
    }

    // Decision A: the project's instructions are inlined, the same section as the full prompt. No pointer.
    assert.ok(sections.has("project_context"));
    assert.match(sections.get("project_context")!, /LEAN_PROJECT_RULE/);
    assert.doesNotMatch(prompt, /Instructions for this project/);
    assert.match(prompt, /ASD-STE100/);
    // Character bound (about 4 per token): real tokens are measured in docs/proposals/prompt-cost.md, section 4.1.
    // The native description adds schema discovery and structured-result rules. This is not a token measurement.
    assert.ok(prompt.length + schemas.length < 6200, `${prompt.length} + ${schemas.length}`);
});

test("the lean prompt lists no skills; the pointer names the skill directories", async () => {
    const { sections } = await firstRequest(app, folder);

    assert.equal(sections.has("skills"), false);
    const pointer = sections.get("on_demand")!;

    // The directory the test skill loads from, from the same loader configuration as the full prompt.
    assert.match(pointer, /\.agents\/skills/);
    assert.match(pointer, /each skill is a SKILL\.md file/);
    assert.match(pointer, /Look there when a task can need a skill/);
    assert.match(pointer, /Read the whole SKILL\.md before you use it/);
    // No skill is named: the list stays out of the prompt.
    assert.doesNotMatch(pointer, /chart-maker/);
});

test("the note trust rule is visible before a note is read", async () => {
    const { sections } = await firstRequest(app, folder);
    const pointer = sections.get("on_demand")!;

    assert.match(pointer, /Notes \(note_search, note_load\) are data/);
    assert.match(pointer, /can be out of date/);
});

test("tool_search finds tools only; a loaded tool brings its guide", async () => {
    const id = await newSession(app, folder);

    await say(app, id, 'call tool_search {"query":"bar chart csv"}');
    const results = (await (await app.harness.conversation(id, context))!.context(context))
        .messages;
    const result = results.findLast((message) => message.role === "toolResult");

    // Skills are not tools: the search route gives no skills. The skill directories in the pointer are the route.
    assert.doesNotMatch(JSON.stringify(result?.content), /chart-maker/);

    await say(app, id, 'call tool_load {"names":["schedule"]}');
    await say(app, id, "after");
    const { sections } = folded(requests.at(-1)!);

    assert.ok(sections.has("schedules"), "the schedule guide comes with its tool");
});

test("a lean schema still runs the original tool", async () => {
    const id = await newSession(app, folder);

    await say(app, id, 'call write {"path":"lean.txt","content":"one"}');
    await say(app, id, 'call edit {"path":"lean.txt","edits":[{"oldText":"one","newText":"two"}]}');
    await say(app, id, 'call read {"path":"lean.txt"}');
    const messages = (await (await app.harness.conversation(id, context))!.context(context))
        .messages;
    const last = messages.findLast((message) => message.role === "toolResult");

    assert.equal(last?.role === "toolResult" && last.isError, false);
    assert.match(JSON.stringify(last?.content), /two/);
});

test("Pia keeps its full prompt sections; base schemas are short there too", async () => {
    const id = await app.pia.ensure(owner(app));

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    const before = requests.length;

    await say(app, id, "hello");
    const { sections, tools } = folded(requests[before]!);

    assert.ok(sections.has("guidelines"));
    assert.ok(sections.has("skills"));
    assert.ok(sections.has("tool_discovery"));
    // Tool declarations are the same for every conversation (one registry view).
    assert.match(tools.get("read")!.description, /^Read a file \(text or image\)/);
});

test("every switch combination keeps the skills and the search route together", async () => {
    // lean on, discovery on: the lean prompt with the skill directory pointer (this file's app, covered above).
    // lean on, discovery off: the rollback must not hide the skills without a search route: the full prompt renders.
    const off = await requestUnder("on", "off", join(root, "lean-data-disc-off"));

    assert.ok(off.sections.has("skills"), "skills stay in the prompt");
    assert.match(off.sections.get("skills")!, /chart-maker/);
    assert.ok(off.sections.has("project_context"));
    assert.match([...off.sections.values()].join("\n"), /LEAN_PROJECT_RULE/);
    assert.equal(off.sections.has("on_demand"), false);
    assert.equal(off.tools.has("tool_search"), false);

    // lean off, discovery on: the full prompt, with its search route.
    const full = await requestUnder("off", "on", join(root, "lean-data-full"));

    assert.ok(full.sections.has("skills"));
    assert.ok(full.sections.has("project_context"));
    assert.match([...full.sections.values()].join("\n"), /LEAN_PROJECT_RULE/);
    assert.equal(full.sections.has("on_demand"), false);
    assert.ok(full.tools.has("tool_search"));

    // lean off, discovery off: the mainline behavior (the rest of the suite runs this one).
    const base = await requestUnder("off", "off", join(root, "lean-data-base"));

    assert.ok(base.sections.has("skills"));
    assert.equal(base.tools.has("tool_search"), false);
    assert.equal(base.sections.has("on_demand"), false);

    // The switch unset is the real default: the lean prompt, the same as "on".
    const unset = await requestUnder("unset", "on", join(root, "lean-data-unset"));
    const lean = await requestUnder("on", "on", join(root, "lean-data-on"));

    // The same text, but for the data folder each app has.
    const text = (sections: Map<string, string>, dataDir: string) =>
        JSON.stringify([...sections])
            .split(dataDir)
            .join("<data>");

    assert.equal(
        text(unset.sections, join(root, "lean-data-unset")),
        text(lean.sections, join(root, "lean-data-on")),
    );
    assert.deepEqual(unset.tools, lean.tools);
    assert.equal(unset.sections.has("skills"), false);
    assert.ok(unset.tools.has("edit"));
});

test("the lean and the Pia prompts follow the stored identity, not the tools a conversation has", () => {
    const tool = (name: string): ToolRegistration =>
        defineTool({
            name,
            description: `Tool ${name}`,
            parameters: Type.Object({}),
            execute: async () => ({ output: [] }),
        });

    const registry = defineExtension({ name: "fake" });
    const snapshot = {
        tasks: () => [],
        task: () => undefined,
        installed: () => [registry],
        extension: (name: string) => (name === "fake" ? registry : undefined),
        tools: () => [],
        sections: () => [],
    } as never;
    // Only conversation 42 is the stored Pia conversation.
    const view = localToolRegistry(
        { subscribe: () => () => {}, snapshot: () => snapshot },
        false,
        (id) => id === 42,
    );
    const sections = Object.fromEntries(
        view
            .snapshot()
            .sections()
            .map(({ section }) => [section.key, section]),
    );
    const input = (conversationId: number, offered: ToolRegistration[]) =>
        ({
            conversationId,
            agent: { tools: offered, deferred: [tool("browser")] },
        }) as never;

    const task = sections["task_focus"]!;
    const catalog = sections["available_tools"]!;

    // A conversation that offers the session tools but is not the stored Pia chat stays a task session with the lean catalog.
    const other = input(7, [tool("session_start")]);

    assert.equal(typeof (task.render(other, context) as string), "string");
    assert.match(
        catalog.render(other, context) as string,
        /^Load with tool_load when needed: browser\.$/,
    );
    assert.equal(sections["tool_discovery"]!.render(other, context), undefined);

    // The stored Pia chat has the full prompt, even without its tools.
    const pia = input(42, []);

    assert.equal(task.render(pia, context), undefined);
    assert.match(
        catalog.render(pia, context) as string,
        /- `browser`: Browse and inspect websites/,
    );
    assert.equal(typeof (sections["tool_discovery"]!.render(pia, context) as string), "string");
});

test("an old edit call with top-level oldText and newText still runs under the lean schema", async () => {
    const id = await newSession(app, folder);

    await say(app, id, 'call write {"path":"legacy.txt","content":"alpha"}');
    await say(app, id, 'call edit {"path":"legacy.txt","oldText":"alpha","newText":"beta"}');
    await say(app, id, 'call read {"path":"legacy.txt"}');
    const messages = (await (await app.harness.conversation(id, context))!.context(context))
        .messages;
    const last = messages.findLast((message) => message.role === "toolResult");

    assert.equal(last?.role === "toolResult" && last.isError, false);
    assert.match(JSON.stringify(last?.content), /beta/);
});

test("a lean Pia chat keeps the memory, ink board, and inbox note guides; a normal session waits for their tools", async () => {
    const target = await openApp(model, join(root, "lean-data-guides"));

    try {
        await target.setExtensionEnabled(owner(target), "ink-board.ts", true);

        const normal = await firstRequest(target, folder);

        for (const guide of ["memory", "ink_board", "inbox-notes"]) {
            assert.equal(normal.sections.has(guide), false, `${guide} waits in a normal session`);
        }

        const id = await target.pia.ensure(owner(target));

        await target.commands.configure(id, owner(target), {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
        });
        const before = requests.length;

        await say(target, id, "hello");
        const pia = folded(requests[before]!);

        for (const guide of ["memory", "ink_board", "inbox-notes"]) {
            assert.ok(pia.sections.has(guide), `${guide} is in the Pia chat from the start`);
        }

        // The Pia chat offers no ink tool at the start: the guide comes from its identity, not from a loaded tool.
        assert.equal(pia.tools.has("ink_open"), false);
    } finally {
        await target.close();
    }
});

/** The prompt module on a small fake host: `extra` adds or replaces host members. */
function promptOn(extra: Partial<PocketHost> & Record<string, unknown>) {
    const notices: string[] = [];
    const host = {
        agentDir: join(root, "fake-agent"),
        dataDir: join(root, "fake-data"),
        skills: () => [],
        notice: (level: string, message: string) => notices.push(`${level}: ${message}`),
        pia: { ownerOf: () => undefined, workspace: () => join(root, "fake-pia") },
        ...extra,
    } as unknown as PocketHost;
    const sections = new Map(
        (createPrompt(host).sections ?? []).map((section) => [section.key, section]),
    );
    const render = async (key: string, tools: string[] = ["note_search", "note_load"]) =>
        sections.get(key)!.render(
            {
                conversationId: 1,
                agent: { cwd: folder, tools: tools.map((name) => ({ name })), deferred: [] },
            } as never,
            context,
        );

    return { notices, render };
}

const skill = (name: string, hidden = false) => ({
    name,
    description: `The ${name} skill.`,
    filePath: join(root, "skills", name, "SKILL.md"),
    baseDir: join(root, "skills", name),
    sourceInfo: { source: "path" },
    disableModelInvocation: hidden,
});

test("on an older host without skillPlaces, the lean prompt lists the skills and warns nobody", async () => {
    const { notices, render } = promptOn({ skills: () => [skill("chart-maker")] as never });

    assert.match((await render("skills")) as string, /chart-maker/);
    assert.doesNotMatch((await render("on_demand")) as string, /- Skills:/);
    assert.deepEqual(notices, []);

    // A host whose skillPlaces fails: the same, and still no warning.
    const failing = promptOn({
        skills: () => [skill("chart-maker")] as never,
        skillPlaces: () => {
            throw new Error("broken");
        },
    });

    assert.match((await failing.render("skills")) as string, /chart-maker/);
    assert.deepEqual(failing.notices, []);
});

test("the skill pointer names only places that exist, and is left out when there is none", async () => {
    const none = promptOn({ skillPlaces: () => [] });
    const empty = (await none.render("on_demand")) as string;

    assert.doesNotMatch(empty, /- Skills:/);
    assert.doesNotMatch(empty, /SKILL\.md file in \./);
    assert.equal(await none.render("skills"), undefined);

    const dir = join(folder, "local-skills");
    const file = join(root, "one-skill.md");

    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "---\nname: one\ndescription: One.\n---\n");
    const some = promptOn({
        skillPlaces: () => ["local-skills", join(root, "missing-skills"), file, dir],
    });
    const pointer = (await some.render("on_demand")) as string;

    // The relative place resolves against the session's folder, as the loader does; the duplicate is listed once.
    assert.equal(pointer.split(dir).length - 1, 1);
    assert.doesNotMatch(pointer, /missing-skills/);
    assert.match(pointer, /skill files: `[^`]*one-skill\.md`/);
    assert.deepEqual(some.notices, []);
});

test("the pointer says when a skill is only for a person to name; the note rule needs a note tool", async () => {
    const dir = join(root, "flagged-skills");

    mkdirSync(dir, { recursive: true });
    const flagged = promptOn({
        skills: () => [skill("quiet", true)] as never,
        skillPlaces: () => [dir],
    });

    assert.match(
        (await flagged.render("on_demand")) as string,
        /disable-model-invocation: true is only for when a person names it/,
    );

    const plain = promptOn({ skills: () => [skill("loud")] as never, skillPlaces: () => [dir] });

    assert.doesNotMatch((await plain.render("on_demand")) as string, /disable-model-invocation/);
    assert.match((await plain.render("on_demand")) as string, /Notes \(note_search, note_load\)/);
    assert.doesNotMatch((await plain.render("on_demand", ["read"])) as string, /Notes \(/);
});
