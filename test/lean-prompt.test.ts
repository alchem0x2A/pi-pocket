// The lean start prompt of a normal session: a short preamble and pointers, short schemas for the base tools, every
// guide and skill on demand. Pia keeps its full prompt. Counted with characters: about 4 per token.
import { context, newSession, openApp, owner, root, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { App } from "./helpers.ts";
import { matchSkills } from "../src/server/local-tools.ts";

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

async function firstRequest(cwd: string): Promise<ReturnType<typeof folded>> {
    const id = await newSession(app, cwd);
    const before = requests.length;

    await say(app, id, "hello");

    return folded(requests[before]!);
}

test("a normal session starts with a short prompt and short base tools", async () => {
    const { sections, tools } = await firstRequest(folder);
    const prompt = [...sections.values()].join("\n\n");
    const schemas = JSON.stringify([...tools.values()]);

    assert.deepEqual([...tools.keys()].sort(), [
        "bash",
        "edit",
        "note_load",
        "note_search",
        "read",
        "tool_load",
        "tool_search",
        "write",
    ]);

    for (const gone of ["guidelines", "pocket_docs", "project_context", "skills", "memory"]) {
        assert.equal(sections.has(gone), false, gone);
    }

    // The project's instructions are a pointer, not their text.
    assert.match(prompt, new RegExp(`read before you change files: ${join(folder, "AGENTS.md")}`));
    assert.doesNotMatch(prompt, /LEAN_PROJECT_RULE/);
    assert.doesNotMatch(prompt, /chart-maker/);
    assert.match(prompt, /ASD-STE100/);
    // About 4 characters per token: under 1500 tokens with room for a chat template.
    assert.ok(prompt.length + schemas.length < 5000, `${prompt.length} + ${schemas.length}`);
});

test("tool_search finds skills, and a loaded tool brings its guide", async () => {
    const id = await newSession(app, folder);

    await say(app, id, 'call tool_search {"query":"bar chart csv"}');
    const results = (await (await app.harness.conversation(id, context))!.context(context))
        .messages;
    const result = results.findLast((message) => message.role === "toolResult");

    assert.match(JSON.stringify(result?.content), /chart-maker: Draw a bar chart from a CSV file/);

    await say(app, id, 'call tool_load {"names":["schedule"]}');
    await say(app, id, "after");
    const { sections } = folded(requests.at(-1)!);

    assert.ok(sections.has("schedules"), "the schedule guide comes with its tool");
});

test("a lean schema still runs the original tool", async () => {
    const id: ConversationId = await newSession(app, folder);

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

test("skill matching ranks name hits first and ignores hidden skills", () => {
    const skill = (name: string, description: string, hidden = false) =>
        ({
            name,
            description,
            filePath: `/s/${name}/SKILL.md`,
            disableModelInvocation: hidden,
        }) as never;
    const found = matchSkills(
        [
            skill("notebook", "Write a marimo notebook"),
            skill("pdf", "Fill a notebook form"),
            skill("secret", "notebook", true),
        ],
        "notebook",
        5,
    );

    assert.deepEqual(
        found.map((entry: { name: string }) => entry.name),
        ["notebook", "pdf"],
    );
});
