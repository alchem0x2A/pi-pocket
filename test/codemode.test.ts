// Native codemode integration: real Durable tasks, hooks, stores, and isolated environments.
import {
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CodemodeStoreDoc } from "../src/server/docs.ts";
import { LiveDoc } from "@earendil-works/pi-durable";
import { CodemodeStoreDoc as NativeStoreDoc } from "@earendil-works/pi-durable/codemode";

const data = join(root, "codemode-native");
const fixture = `/** Native codemode fixture, never installed in live data. */
import { Type } from "typebox";
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";
export default () => defineExtension({ name: "script-fixtures", tools: [
    defineTool({ name: "script_shell", description: "Streams text", parameters: Type.Object({command:Type.String()}),
        async execute(args, api) { api.output("ran " + args.command); api.output(new TextEncoder().encode(" ✓")); return {}; } }),
    defineTool({ name: "script_structured", description: "Returns structured failure", parameters: Type.Object({}),
        structuredOutputSchema: Type.Object({ok:Type.Boolean()}),
        async execute() { return { structuredOutput:{ok:false}, isError:true, diagnostics:[{severity:"error",message:"fixture failed"}] }; } }),
    defineTool({ name: "script_wait", description: "Waits for isolated fixture release", parameters: Type.Object({marker:Type.String(),release:Type.String()}), replay:"safe",
        async execute(args, api, context) {
            const { existsSync, appendFileSync } = await import("node:fs");
            const { setTimeout } = await import("node:timers/promises");
            await api.memo("started", true, context);
            appendFileSync(args.marker,"start\\n");
            try { while (!existsSync(args.release)) { await setTimeout(20, undefined, {signal:context.abortSignal}); } }
            finally { appendFileSync(args.marker,"end\\n"); }
            return {output:[{type:"text",text:"released"}]};
        } }),
    defineTool({ name: "script_history", description: "Checks hook history reads", parameters: Type.Object({}),
        async execute() { return {output:[{type:"text",text:"history checked"}]}; } }),
], hooks:[hook(ToolTask, { async beforeTool(call, api, context) {
    if (call.name === "script_shell") {
        if (call.arguments.command === "deny") return {block:"fixture denied"};
        if (call.arguments.command === "boom") throw new Error("hook failed");
        if (call.arguments.command === "short") return {arguments:{command:"rewritten"}};
    }
    if (call.name === "script_history") {
        const page = await api.entries({}, 10, undefined, context);
        if (page.items.length === 0 || !(await api.entry(page.items[0].id, context))) throw new Error("history absent");
    }
} })] });`;
const model = scriptedModel((request) => {
    const last = lastText(request);

    return last.role === "user" && last.text.startsWith("script ")
        ? fauxAssistantMessage([fauxToolCall("codemode", { code: last.text.slice(7) })], {
              stopReason: "toolUse",
          })
        : fauxAssistantMessage([fauxText("done")]);
});
let app: App;

before(async () => {
    mkdirSync(join(data, "extensions"), { recursive: true });
    writeFileSync(join(data, "extensions", "script-fixtures.ts"), fixture);
    app = await openApp(model, data, undefined, undefined, false);
    await app.setExtensionEnabled(owner(app), "script-fixtures.ts", true);
});
after(async () => app?.close());

async function run(id: Parameters<typeof say>[1], code: string) {
    await say(app, id, `script ${code}`);
    const view = await (await app.conversation(id)).context(context);
    const result = view.messages.findLast(
        (m) => m.role === "toolResult" && m.toolName === "codemode",
    );

    assert.ok(result && result.role === "toolResult");

    return {
        ...result,
        text: result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n"),
    };
}

test("native calls stream text, reject blocks and invalid args, and receive structured errors", async () => {
    const id = await newSession(app);
    const result = await run(
        id,
        `
        const values = await Promise.allSettled([
            tools.script_shell({command:"deny"}), tools.script_shell({command:"boom"}),
            tools.script_shell({command:"short"}), tools.script_shell({}),
        ]);
        text(values.map(v => v.status === "fulfilled" ? v.value : "ERR " + v.reason.message));
        text(await tools.script_structured({})); text(await tools.script_history({}));
    `,
    );

    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /fixture denied/);
    assert.match(result.text, /hook failed/);
    assert.match(result.text, /ran rewritten ✓/);
    assert.match(result.text, /ERR.*(string|command)/);
    assert.match(result.text, /"ok":false/);
    assert.match(result.text, /history checked/);
});

test("legacy store copies once, mode changes share one store, failure writes nothing, and sessions stay separate", async () => {
    const id = await newSession(app);

    await app.harness.commit(async (tx) => {
        (await tx.doc(CodemodeStoreDoc, id)).values = { count: 4, oldOnly: "kept" };
        (await tx.doc(NativeStoreDoc, id)).values = { count: 8 };
    }, context);
    assert.match(
        (await run(id, 'text([load("count"),load("oldOnly")]); store("count",9);')).text,
        /\[8,"kept"\]/,
    );
    assert.equal((await app.harness.snapshot(CodemodeStoreDoc, id, context))?.values.count, 4);
    app.setExtensionSettings(owner(app), "codemode", { mode: "only" });
    const failure = await run(
        id,
        'text(load("count"));store("count",999);throw new Error("intentional");',
    );

    assert.equal(failure.isError, true);
    assert.match(failure.text, /intentional/);
    assert.equal((await app.harness.snapshot(NativeStoreDoc, id, context))?.values.count, 9);
    app.setExtensionSettings(owner(app), "codemode", { mode: "on" });
    assert.match((await run(id, 'text(load("count"));')).text, /\b9\b/);
    const other = await newSession(app);

    assert.match((await run(other, 'text(load("count") ?? "empty");')).text, /empty/);
    await app.close();
    app = await openApp(model, data, undefined, undefined, false);
    assert.match((await run(id, 'text([load("count"),load("oldOnly")]);')).text, /\[9,"kept"\]/);
});

test("parallel nested calls ask separately and denial never executes the denied command", async () => {
    await app.setExtensionEnabled(owner(app), "guard.ts", true);
    app.guard.judge = async (tool, args) =>
        tool === "bash"
            ? {
                  subject: String(args.command),
                  decision: { action: "ask", source: "test", reason: "fixture", terminate: false },
              }
            : undefined;
    const id = await newSession(app);
    const running = run(
        id,
        'text((await Promise.allSettled([tools.bash({command:"echo one"}),tools.bash({command:"echo two"})])).map(v=>v.status === "fulfilled" ? v.value : v.reason.message));',
    );

    await until(() => app.approvals.forConversation(id).length === 2, "parallel approvals");
    const asks = app.approvals.forConversation(id);

    assert.notEqual(asks[0]!.id, asks[1]!.id);
    await app.answerApproval(asks.find((a) => a.subject === "echo one")!.id, true, owner(app));
    await app.answerApproval(asks.find((a) => a.subject === "echo two")!.id, false, owner(app));
    const result = await running;

    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /one/);
    assert.match(result.text, /denied/);
});

test("timeout cancels unfinished nested tasks and a close resumes the native journal without repeating a finished call", async () => {
    const id = await newSession(app);
    const marker = join(root, "cancel-marker.txt");
    const release = join(root, "cancel-release");
    const timeout = await run(
        id,
        `// @options: {"timeout_ms":1000}
        text(await describeTool("script_wait"));
        await tools.script_wait({marker:${JSON.stringify(marker)},release:${JSON.stringify(release)}});
    `,
    );

    assert.equal(timeout.isError, true, timeout.text);
    assert.match(timeout.text, /timed out/i);
    await until(() => readFileSync(marker, "utf8").includes("end"), "cancelled nested call");
    assert.ok(
        (timeout.details as { discoveredTools?: string[] }).discoveredTools?.includes(
            "script_wait",
        ),
    );

    const restartMarker = join(root, "restart-marker.txt");
    const restartRelease = join(root, "restart-release");
    // The first nested call completes before close. Its native task key and journal result must be reused.
    const running = say(
        app,
        id,
        `script text(await tools.script_shell({command:"once"})); text(await tools.script_wait({marker:${JSON.stringify(restartMarker)},release:${JSON.stringify(restartRelease)}}));`,
    );
    const settled = running.catch(() => {});

    await until(
        async () =>
            (await app.harness.snapshot(LiveDoc, id, context))?.nestedTools?.some(
                (s) => s.name === "script_wait" && s.status === "running",
            ) === true,
        "running nested wait",
    );
    const before = (await app.harness.snapshot(LiveDoc, id, context))?.nestedTools?.find(
        (s) => s.name === "script_shell",
    )?.taskId;

    assert.ok(before);
    await app.close();
    await settled;
    writeFileSync(restartRelease, "");
    app = await openApp(model, data, undefined, undefined, false);
    await until(() => !app.isBusy(id), "native run after reopen");
    const view = await (await app.conversation(id)).context(context);
    const result = view.messages.findLast(
        (m) => m.role === "toolResult" && m.toolName === "codemode",
    );

    assert.ok(result && result.role === "toolResult");
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(JSON.stringify(result.content), /released/);
    assert.match(JSON.stringify(result.content), /ran once/);
    const terminal = await app.harness.getTask(before, context);

    assert.equal(terminal?.state.status, "terminal");
});

test("Stop preserves already-read note IDs and discovered names without retaining pending text", async () => {
    const id = await newSession(app);
    const note = await app.memory.add(
        id,
        undefined,
        { userId: owner(app).id, byPi: false, name: "Owner" },
        { title: "Stop test", text: "approved stop note", scope: "everywhere" },
    );
    const marker = join(root, "stop-marker");
    const release = join(root, "stop-release");
    const running = say(
        app,
        id,
        `script await tools.note_load({ids:[${JSON.stringify(note.id)}]}); await describeTool("script_wait"); await tools.script_wait({marker:${JSON.stringify(marker)},release:${JSON.stringify(release)}});`,
    );
    const settled = running.catch(() => {});

    await until(
        async () =>
            (await app.harness.snapshot(LiveDoc, id, context))?.nestedTools?.some(
                (s) => s.name === "script_wait" && s.status === "running",
            ) === true,
        "stop fixture running",
    );
    await app.commands.abort(id, owner(app));
    await settled;
    const view = await (await app.conversation(id)).context(context);
    const result = view.messages.findLast(
        (m) => m.role === "toolResult" && m.toolName === "codemode",
    );

    assert.ok(result && result.role === "toolResult");
    assert.equal(result.isError, true);
    assert.ok(
        (result.details as { readNoteIds?: string[] }).readNoteIds?.includes(note.id),
        JSON.stringify(result),
    );
    assert.ok(
        (result.details as { discoveredTools?: string[] }).discoveredTools?.includes("script_wait"),
        JSON.stringify(result),
    );
});
