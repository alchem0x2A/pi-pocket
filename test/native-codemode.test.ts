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
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ConfigStore } from "../src/server/config.ts";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

process.env.PI_POCKET_TOOL_DISCOVERY = "on";

const executions = join(root, "native-executions.txt");
const fixture = `/** A test tool that returns a known string. */
import { appendFileSync } from "node:fs";
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";
import { Type } from "typebox";
export default () => defineExtension({ name: "fixture-native", tools: [defineTool({
    name: "fixture_native", description: "A unique frobnicator test tool", parameters: Type.Object({ word: Type.String() }),
    async execute(args) { appendFileSync(${JSON.stringify(executions)}, "fixture_native\\n"); return { output: [{ type: "text", text: "fixture:" + args.word }] }; }
}), defineTool({
    name: "model_only_fixture", description: "For the model only", parameters: Type.Object({}), callers: ["model"],
    async execute() { appendFileSync(${JSON.stringify(executions)}, "model_only_fixture\\n"); return { output: [{ type: "text", text: "model-only-secret" }] }; }
}), defineTool({
    name: "blocked_fixture", description: "Blocked by a real hook", parameters: Type.Object({}),
    async execute() { appendFileSync(${JSON.stringify(executions)}, "blocked_fixture\\n"); return { output: [{ type: "text", text: "blocked-secret" }] }; }
})], hooks: [hook(ToolTask, { beforeTool(call) {
    if (call.name === "blocked_fixture") return { block: "fixture denied" };
} })] });`;

test("native codemode discovers and calls a deferred extension tool in one script", async () => {
    const data = join(root, "native-codemode");
    const folder = join(data, "extensions");

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "fixture-native.ts"), fixture);
    const requests: string[][] = [];
    const requestTexts: string[] = [];
    const writtenPath = join(root, "native-write.txt");
    const imagePath = join(root, "native-image.png");

    writeFileSync(
        imagePath,
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
            "base64",
        ),
    );
    let readNoteId = "";
    const model = scriptedModel((request) => {
        requests.push(getCurrentTools(request.messages).map((tool) => tool.name));
        requestTexts.push(JSON.stringify(request.messages));
        const last = lastText(request);

        last.text = last.text.replace(/^\[from: [^\]]+\] /, "");

        if (
            last.role === "user" &&
            (last.text === "load browser" || last.text === "load fixture")
        ) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("tool_load", {
                        names: [last.text === "load browser" ? "browser" : "fixture_native"],
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (last.role === "user" && last.text === "direct bash") {
            return fauxAssistantMessage([fauxToolCall("bash", { command: "echo MUST_NOT_RUN" })], {
                stopReason: "toolUse",
            });
        }

        if (
            last.role === "user" &&
            [
                "run the fixture",
                "test boundaries",
                "test disabled",
                "test write",
                "read notes",
                "propose note",
                "guarded call",
                "usage fixture",
                "test file tools",
            ].includes(last.text)
        ) {
            const code =
                last.text === "usage fixture"
                    ? "try { text(await tools.provider_usage({})); } catch (e) { text(e.message); }"
                    : last.text === "test file tools"
                      ? `text(await tools.read({path:${JSON.stringify(writtenPath)}})); text(await tools.edit({path:${JSON.stringify(writtenPath)},edits:[{oldText:"native",newText:"changed"}]})); text(await tools.bash({command:${JSON.stringify(`grep changed ${writtenPath}`)}})); image(await tools.read({path:${JSON.stringify(imagePath)}}));`
                      : last.text === "guarded call"
                        ? 'text(await tools.bash({command:"echo guard-marker"}));'
                        : last.text === "propose note"
                          ? 'text(await tools.memory({action:"add",title:"Nested proposal",text:"nested-pending-unique",scope:"everywhere"}));'
                          : last.text === "read notes"
                            ? `text(await tools.note_load({ids:[${JSON.stringify(readNoteId)}]})); text(await tools.note_search({query:"searchonlyfixture"}));`
                            : last.text === "test write"
                              ? `await tools.write({path:${JSON.stringify(writtenPath)},content:"native"})`
                              : last.text === "test boundaries" || last.text === "test disabled"
                                ? 'for (const name of ["model_only_fixture", "blocked_fixture", "fixture_native"]) { const found = await searchTools(name, {limit:20}); text("SEARCH " + name + ":" + found.some(x => x.name === name)); try { await tools[name]({word:"hello"}); text("UNEXPECTED " + name); } catch (e) { text("ERROR " + name + ":" + e.message); } }'
                                : 'text(await searchTools("fixture_native")); text(await describeTool("fixture_native")); text(await tools.fixture_native({word:"hello"}));';

            return fauxAssistantMessage([fauxToolCall("codemode", { code })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText("done")]);
    });
    const config = new ConfigStore(data);

    for (const file of [
        "agent-teams.ts",
        "artifacts.ts",
        "background.ts",
        "design.ts",
        "gallery.ts",
        "goals.ts",
        "subagents.ts",
        "triggers.ts",
        "updates.ts",
    ]) {
        config.setExtensionEnabled(file, false);
    }

    const app = await openApp(model, data, undefined, undefined, false);

    try {
        await app.setExtensionEnabled(owner(app), "fixture-native.ts", true);
        app.setExtensionSettings(owner(app), "codemode", { mode: "only" });
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
        assert.ok(
            (result.details as { discoveredTools?: string[] }).discoveredTools?.includes(
                "fixture_native",
            ),
        );
        const after = await conversation.agent(context);

        assert.ok(!after.tools.some((tool) => tool.name === "fixture_native"));
        const writer = { userId: owner(app).id, byPi: false, name: "Owner" };
        const readNote = await app.memory.add(id, undefined, writer, {
            title: "Read note",
            text: "Current note text",
            scope: "everywhere",
        });
        const searchedNote = await app.memory.add(id, undefined, writer, {
            title: "searchonlyfixture",
            text: "A search result only",
            scope: "everywhere",
        });

        const beforeRead = (await app.transcripts.allEntries(id, true)).at(-1);

        assert.ok(beforeRead);
        readNoteId = readNote.id;
        await say(app, id, "read notes");
        const noteView = await conversation.context(context);
        const noteResult = noteView.messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "codemode",
        );

        assert.ok(noteResult && noteResult.role === "toolResult");
        assert.equal(noteResult.isError, false, JSON.stringify(noteResult));
        assert.deepEqual((noteResult.details as { readNoteIds?: string[] }).readNoteIds, [
            readNote.id,
        ]);
        const afterRead = (await app.transcripts.allEntries(id, true)).at(-1);

        assert.ok(afterRead);
        const early = await app.commands.fork(id, owner(app), { entryId: beforeRead.id });
        const late = await app.commands.fork(id, owner(app), { entryId: afterRead.id });

        app.settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });

        for (const fork of [early.id, late.id]) {
            await say(app, fork, "filler for branch");
            await app.commands.compact(fork, owner(app), undefined);
            await until(
                async () => (await app.memory.readBeforeCompaction(fork)).summary !== "",
                "branch compaction",
            );
        }

        assert.ok(!(await app.memory.readBeforeCompaction(early.id)).ids.includes(readNote.id));
        assert.ok((await app.memory.readBeforeCompaction(late.id)).ids.includes(readNote.id));
        await app.memory.edit(id, owner(app), readNote.id, {
            title: "Read note",
            text: "Edited approved text",
        });
        await say(app, id, "extra filler");
        await app.commands.compact(id, owner(app), undefined);
        await until(
            async () => (await app.memory.readBeforeCompaction(id)).summary !== "",
            "compaction",
        );
        const retained = await app.memory.readBeforeCompaction(id);

        assert.ok(retained.ids.includes(readNote.id), JSON.stringify(retained));
        assert.ok(!retained.ids.includes(searchedNote.id), JSON.stringify(retained));
        assert.ok(retained.tools.includes("fixture_native"), JSON.stringify(retained));
        const beforeReminder = requestTexts.length;

        await say(app, id, "check retained references");
        const reminder = requestTexts[beforeReminder]!;

        assert.match(reminder, /Edited approved text/);
        assert.doesNotMatch(reminder, /Current note text|searchonlyfixture/);
        assert.match(reminder, /Tools you discovered before this compaction.*fixture_native/);
        assert.ok(requests[0]!.includes("codemode"));
        assert.ok(!requests[0]!.includes("note_load"));
        assert.ok(!requests[0]!.includes("bash"));
        assert.ok(requests[0]!.includes("tool_load"));
        await say(app, id, "load fixture");
        const deniedLoad = (await conversation.context(context)).messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "tool_load",
        );

        assert.ok(deniedLoad && deniedLoad.role === "toolResult");
        assert.equal(deniedLoad.isError, true);
        await say(app, id, "load browser");
        assert.ok(
            (await conversation.agent(context)).tools.some((tool) => tool.name === "browser"),
        );

        await say(app, id, "direct bash");
        const deniedView = await conversation.context(context);
        const denied = deniedView.messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "bash",
        );

        assert.ok(denied && denied.role === "toolResult");
        assert.equal(denied.isError, true);
        assert.doesNotMatch(JSON.stringify(denied.content), /MUST_NOT_RUN\s*\\n/);

        await say(app, id, "test write");
        const writeView = await conversation.context(context);
        const writeResult = writeView.messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "codemode",
        );

        assert.ok(writeResult && writeResult.role === "toolResult");
        assert.equal(writeResult.isError, false, JSON.stringify(writeResult));
        assert.ok(
            (writeResult.details as { calls?: { name: string; path?: string }[] })?.calls?.some(
                (call) => call.name === "write" && call.path === writtenPath,
            ),
            JSON.stringify(writeResult.details),
        );

        await say(app, id, "test file tools");
        const filesView = await conversation.context(context);
        const filesResult = filesView.messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "codemode",
        );

        assert.ok(filesResult && filesResult.role === "toolResult");
        assert.equal(filesResult.isError, false, JSON.stringify(filesResult));
        assert.match(JSON.stringify(filesResult.content), /changed/);
        assert.ok(filesResult.content.some((part) => part.type === "image"));
        assert.equal(readFileSync(writtenPath, "utf8"), "changed");

        const excluded = after.callable.find((tool) => tool.name === "fixture_native");

        assert.ok(excluded);
        await conversation.configure({ tools: { remove: [excluded] } }, context);
        writeFileSync(executions, "");
        await say(app, id, "test boundaries");
        const boundaryView = await conversation.context(context);
        const boundaryResults = boundaryView.messages.filter(
            (message) => message.role === "toolResult" && message.toolName === "codemode",
        );
        const boundary = boundaryResults.at(-1);

        assert.ok(boundary && boundary.role === "toolResult");
        assert.equal(boundary.isError, false, JSON.stringify(boundary));
        const output = JSON.stringify(boundary.content);

        assert.match(output, /SEARCH model_only_fixture:false/);
        assert.match(output, /SEARCH fixture_native:false/);
        assert.match(output, /SEARCH blocked_fixture:true/);
        assert.match(output, /ERROR model_only_fixture:.*does not exist/);
        assert.match(output, /ERROR fixture_native:.*does not exist/);
        assert.match(output, /ERROR blocked_fixture:.*fixture denied/);
        assert.doesNotMatch(output, /UNEXPECTED/);
        assert.equal(readFileSync(executions, "utf8"), "", "no forbidden fixture executes");

        await conversation.configure({ tools: null }, context);
        await app.setExtensionEnabled(owner(app), "fixture-native.ts", false);
        const beforeDisabled = requestTexts.length;

        await say(app, id, "test disabled");
        assert.doesNotMatch(
            requestTexts[beforeDisabled]!,
            /Tools you discovered before this compaction.*fixture_native/,
        );
        const disabledView = await conversation.context(context);
        const disabled = disabledView.messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "codemode",
        );

        assert.ok(disabled && disabled.role === "toolResult");
        const disabledOutput = JSON.stringify(disabled.content);

        for (const name of ["model_only_fixture", "blocked_fixture", "fixture_native"]) {
            assert.match(disabledOutput, new RegExp(`SEARCH ${name}:false`));
            assert.match(disabledOutput, new RegExp(`ERROR ${name}:.*does not exist`));
        }

        assert.doesNotMatch(disabledOutput, /UNEXPECTED/);
        assert.equal(readFileSync(executions, "utf8"), "", "disabled fixtures do not execute");

        await say(app, id, "propose note");
        const queue = await app.memory.view(id, owner(app));
        const proposal = queue.lessons.find((note) => note.title === "Nested proposal");

        assert.ok(proposal && proposal.pending);
        assert.equal(proposal.byPi, true);
        assert.equal(proposal.from?.id, Number(id));
        const approvalPia = await app.pia.ensure(owner(app));
        const pendingQueue = await app.memory.view(approvalPia, owner(app), true);

        assert.ok(pendingQueue.lessons.some((note) => note.id === proposal.id && note.pending));
        assert.equal((await app.memory.read(id, undefined, [proposal.id])).found.length, 0);
        assert.equal((await app.memory.read(early.id, undefined, [proposal.id])).found.length, 0);
        assert.equal(
            (await app.memory.search(id, undefined, "nested-pending-unique")).hits.length,
            0,
        );
        readNoteId = proposal.id;
        await say(app, id, "read notes");
        const priorHead = (await conversation.context(context)).head?.id;

        await say(app, id, "filler before pending check");
        await app.commands.compact(id, owner(app), undefined);
        await until(
            async () => (await conversation.context(context)).head?.id !== priorHead,
            "pending compaction",
        );
        assert.ok(!(await app.memory.readBeforeCompaction(id)).ids.includes(proposal.id));
        const beforePendingCheck = requestTexts.length;

        await say(app, id, "check pending injection");
        assert.doesNotMatch(
            requestTexts[beforePendingCheck]!,
            /Notes you read with note_load before this compaction[^]*nested-pending-unique/,
        );
        await app.memory.edit(id, owner(app), proposal.id, {
            title: "Nested proposal",
            text: "owner-edited-approved",
        });
        const edited = (await app.memory.view(id, owner(app))).lessons.find(
            (note) => note.id === proposal.id,
        )!;

        assert.equal(edited.pending, true, "editing does not approve a proposal");
        assert.equal((await app.memory.read(id, undefined, [proposal.id])).found.length, 0);
        await app.memory.edit(id, owner(app), proposal.id, "approve", {
            title: "Nested proposal",
            text: "owner-edited-approved",
        });

        assert.equal(
            (await app.memory.read(id, undefined, [proposal.id])).found[0]?.text,
            "owner-edited-approved",
        );

        await app.commands.reset(late.id, owner(app), undefined);
        await say(app, late.id, "filler after reset");
        await say(app, late.id, "more filler after reset");
        await app.commands.compact(late.id, owner(app), undefined);
        await until(
            async () => (await app.memory.readBeforeCompaction(late.id)).summary !== "",
            "reset compaction",
        );
        const resetRefs = await app.memory.readBeforeCompaction(late.id);

        assert.ok(!resetRefs.ids.includes(readNote.id), JSON.stringify(resetRefs));
        assert.ok(!resetRefs.tools.includes("fixture_native"), JSON.stringify(resetRefs));

        // Native nested tasks have their own task IDs. The guard presents their approvals on the parent card.
        app.guard.judge = async (name, args) =>
            name === "bash" && args.command === "echo guard-marker"
                ? {
                      subject: "echo guard-marker",
                      decision: {
                          action: "ask",
                          source: "test",
                          reason: "fixture approval",
                          terminate: false,
                      },
                  }
                : undefined;
        await app.setExtensionEnabled(owner(app), "guard.ts", true);
        const running = say(app, id, "guarded call");

        await until(() => app.approvals.forConversation(id).length === 1, "nested approval");
        const approval = app.approvals.forConversation(id)[0]!;
        const live = await app.harness.snapshot(
            (await import("@earendil-works/pi-durable")).LiveDoc,
            id,
            context,
        );
        const parent = live?.tools?.find((slot) => slot.name === "codemode");
        const nested = live?.nestedTools?.find((slot) => slot.name === "bash");

        assert.ok(parent?.taskId && nested);
        assert.equal(approval.taskId, parent.taskId);
        assert.notEqual(approval.taskId, nested.taskId);
        assert.equal(approval.callId, nested.callId);
        assert.equal(await app.answerApproval(approval.id, true, owner(app)), true);
        await running;

        await app.memory.edit(id, owner(app), readNote.id, "remove");
        const beforeRemoved = requestTexts.length;

        await say(app, id, "check removed note");
        assert.doesNotMatch(requestTexts[beforeRemoved]!, /Edited approved text/);

        // The same retained ID cannot bring a project note into a session after its scope changes.
        const project = join(root, "native-scope-project");
        const outside = join(root, "native-scope-outside");

        mkdirSync(project, { recursive: true });
        mkdirSync(outside, { recursive: true });
        execFileSync("git", ["init", "-q", project]);
        const scopedId = await newSession(app, project);
        const scoped = await app.memory.add(scopedId, project, writer, {
            title: "Project only",
            text: "scope-secret-marker",
            scope: "project",
        });

        readNoteId = scoped.id;
        await say(app, scopedId, "read notes");
        await say(app, scopedId, "project filler");
        await app.commands.compact(scopedId, owner(app), undefined);
        await until(
            async () => (await app.memory.readBeforeCompaction(scopedId)).summary !== "",
            "scope compaction",
        );
        assert.ok((await app.memory.readBeforeCompaction(scopedId)).ids.includes(scoped.id));
        await (await app.conversation(scopedId)).configure({ cwd: outside }, context);
        const beforeScope = requestTexts.length;

        await say(app, scopedId, "check scope");
        assert.doesNotMatch(requestTexts[beforeScope]!, /scope-secret-marker/);

        // An old direct call remains in history when declarations change modes.
        app.setExtensionSettings(owner(app), "codemode", { mode: "on" });
        await say(app, id, "direct bash");
        const beforeSwitch = requestTexts.length;

        app.setExtensionSettings(owner(app), "codemode", { mode: "only" });
        await say(app, id, "check old direct history");
        assert.match(requestTexts[beforeSwitch]!, /MUST_NOT_RUN/);
        assert.ok(!requests[beforeSwitch]!.includes("bash"));

        // The owner chooses separately whether Pia chat gets Only mode.
        const pia = await app.pia.ensure(owner(app));
        const beforePia = requests.length;

        await say(app, pia, "check Pia on mode");
        assert.ok(requests[beforePia]!.includes("bash"));
        app.setExtensionSettings(owner(app), "codemode", { piaOnly: true });
        const beforePiaOnly = requests.length;

        await say(app, pia, "check Pia only mode");
        assert.ok(!requests[beforePiaOnly]!.includes("bash"));

        // Exercise the installed usage extension with every account disabled: no credential or network lookup.
        await app.setExtensionEnabled(owner(app), "tt-usage.ts", true);
        app.setExtensionSettings(owner(app), "tt-usage", {
            refreshMinutes: 0,
            ...Object.fromEntries(
                [
                    "openai",
                    "openai-codex",
                    "claude-code-personal",
                    "claude-code",
                    "aleph",
                    "local-inference",
                ].map((name) => [
                    `config_${name.replaceAll("-", "_")}`,
                    JSON.stringify({ enabled: false }),
                ]),
            ),
        });
        await say(app, id, "usage fixture");
        const usageResult = (await conversation.context(context)).messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "codemode",
        );

        assert.ok(usageResult && usageResult.role === "toolResult");
        assert.equal(usageResult.isError, false);
        assert.match(JSON.stringify(usageResult.content), /Times are/);
        assert.match(JSON.stringify(usageResult.content), /\[\]/);
        const guest = app.config.addUser("Usage guest", "guest").user;
        const submitted = await app.commands.submit(id, guest, {
            text: "usage fixture",
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(submitted.submissionId, context))!.wait(context);
        const deniedUsage = (await conversation.context(context)).messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "codemode",
        );

        assert.ok(deniedUsage && deniedUsage.role === "toolResult");
        assert.match(JSON.stringify(deniedUsage.content), /private to the owner/);
    } finally {
        await app.close();
    }
});
