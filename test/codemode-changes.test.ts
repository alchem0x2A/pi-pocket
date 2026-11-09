// Changes must use durable validated write facts, not live slots or truncated argument previews.
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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const data = join(root, "native-changes-data");
const repo = join(root, "native-changes-repo");
const gap = join(root, "native-changes-gap");
// Longer than native codemode's 200-character argument preview. Attribution must keep the complete path.
const rewritten = `nested/${"r".repeat(210)}.txt`;
const fixture = `/** Changes fixture: rewrite a path and make the parent's live-slot reader unavailable. */
import { writeFileSync } from "node:fs";
import { defineExtension, hook, ToolTask, wrapTool, LiveDoc } from "@earendil-works/pi-durable";
export default () => defineExtension({name:"changes-fixture", hooks:[hook(ToolTask,{
    beforeTool(call) {
        if (call.name === "write" && call.arguments.path === "requested.txt") {
            return { arguments:{...call.arguments,path:${JSON.stringify(rewritten)}} };
        }
        if (call.name === "write" && call.arguments.path === "blocked.txt") return {block:"fixture denied"};
    }
})],wraps:[wrapTool({name:"codemode"}, tool=>({...tool, execute: async(args,api,context)=>tool.execute(args,{
    ...api,
    snapshot:(doc,...rest)=>{
        if(doc===LiveDoc) throw new Error("Fixture: live slots cannot be read");
        return api.snapshot(doc,...rest);
    },
    executeTool:async(name,input,scope,options)=>{
        const result=await api.executeTool(name,input,scope,options);
        if(name==="write" && ["near-stop.txt","near-timeout.txt"].includes(input.path)) {
            writeFileSync(${JSON.stringify(gap)},"child result committed; parent has not received it");
            await new Promise((_,reject)=>{
                const abort=()=>reject(new Error("Fixture parent stopped before result delivery"));
                if(scope.abortSignal?.aborted) {abort();}
                else {scope.abortSignal?.addEventListener("abort",abort,{once:true});}
            });
        }
        return result;
    },
},context)})), wrapTool({name:"write"},tool=>({...tool,execute:(args,api,context)=>tool.execute(args,
    args.path === "unconfirmed.txt" ? {...api,commit:async()=>{throw new Error("fixture attribution commit failed");}} : api,
    context),
}))]});`;
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
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "base.txt"), "original\n");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync(
        "git",
        [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "fixture",
        ],
        { cwd: repo },
    );
    mkdirSync(join(data, "extensions"), { recursive: true });
    writeFileSync(join(data, "extensions/changes-fixture.ts"), fixture);
    app = await openApp(model, data, undefined, undefined, false);
    await app.setExtensionEnabled(owner(app), "changes-fixture.ts", true);
});
after(async () => app?.close());

for (const mode of ["on", "only"] as const) {
    test(`Changes attributes native writes and rewritten paths in ${mode}, without live-slot inspection`, async () => {
        app.setExtensionSettings(owner(app), "codemode", { mode });
        const id = await newSession(app, repo);
        const filename = `native-${mode}.txt`;

        await say(
            app,
            id,
            `script await tools.write({path:${JSON.stringify(filename)},content:"native\\n"}); await tools.write({path:"requested.txt",content:"rewritten\\n"}); await tools.edit({path:"base.txt",edits:[{oldText:${JSON.stringify(mode === "on" ? "original" : "edited-on")},newText:${JSON.stringify("edited-" + mode)}}]}); try{await tools.write({path:"blocked.txt",content:"no"});}catch(e){text(e.message);}`,
        );
        const changes = await app.workspace.changes(id, owner(app));

        assert.equal(
            changes.files.find((file) => file.path === filename)?.byPi,
            true,
            JSON.stringify(changes),
        );
        assert.equal(
            changes.files.find((file) => file.path === rewritten)?.byPi,
            true,
            JSON.stringify(changes),
        );
        assert.equal(
            changes.files.find((file) => file.path === "base.txt")?.byPi,
            true,
            JSON.stringify(changes),
        );
        assert.equal(readFileSync(join(repo, rewritten), "utf8"), "rewritten\n");
        assert.equal(existsSync(join(repo, "requested.txt")), false);
        assert.equal(existsSync(join(repo, "blocked.txt")), false);
        assert.ok(
            !changes.files.some(
                (file) => file.path === "requested.txt" || file.path === "blocked.txt",
            ),
        );
        const outside = changes.piOnly.find((file) => file.path === rewritten);

        assert.equal(
            outside,
            undefined,
            "the rewritten file is in the repository list, not an invented outside path",
        );
    });
}

test("Changes keeps a completed write when Stop cuts off the parent before result delivery", async () => {
    app.setExtensionSettings(owner(app), "codemode", { mode: "only" });
    const id = await newSession(app, repo);
    const running = say(
        app,
        id,
        'script await tools.write({path:"near-stop.txt",content:"written before Stop\\n"});',
    );
    const settled = running.catch(() => {});

    await until(() => existsSync(gap), "committed child result, before parent delivery");
    assert.equal(readFileSync(join(repo, "near-stop.txt"), "utf8"), "written before Stop\n");
    const whileRunning = await app.workspace.changes(id, owner(app));

    assert.equal(
        whileRunning.files.find((file) => file.path === "near-stop.txt")?.byPi,
        false,
        "Changes uses published transcript facts; an unfinished parent has not published its receipt yet",
    );
    await app.commands.abort(id, owner(app));
    await settled;
    const changes = await app.workspace.changes(id, owner(app));

    assert.equal(
        changes.files.find((file) => file.path === "near-stop.txt")?.byPi,
        true,
        JSON.stringify(changes),
    );
    // The same attribution survives losing every in-memory workspace cache and reopening the isolated app.
    await app.close();
    app = await openApp(model, data, undefined, undefined, false);
    const restored = await app.workspace.changes(id, owner(app));

    assert.equal(
        restored.files.find((file) => file.path === "near-stop.txt")?.byPi,
        true,
        JSON.stringify(restored),
    );
});

test("Changes uses a durable applied receipt even when the script times out before result delivery", async () => {
    const id = await newSession(app, repo);

    await say(
        app,
        id,
        'script // @options: {"timeout_ms": 1000}\nawait tools.write({path:"near-timeout.txt",content:"applied before timeout\\n"});',
    );
    const changes = await app.workspace.changes(id, owner(app));

    assert.equal(readFileSync(join(repo, "near-timeout.txt"), "utf8"), "applied before timeout\n");
    assert.equal(
        changes.files.find((file) => file.path === "near-timeout.txt")?.byPi,
        true,
        JSON.stringify(changes),
    );
});

test("an attribution commit failure is visible, not silently reported as a successful attributed write", async () => {
    const id = await newSession(app, repo);

    await say(
        app,
        id,
        'script await tools.write({path:"unconfirmed.txt",content:"file effect before receipt failure\\n"});',
    );
    const view = await (await app.conversation(id)).context(context);
    const result = view.messages.findLast(
        (message) => message.role === "toolResult" && message.toolName === "codemode",
    );

    assert.ok(result && result.role === "toolResult");
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /fixture attribution commit failed/);
    const changes = await app.workspace.changes(id, owner(app));

    assert.equal(
        readFileSync(join(repo, "unconfirmed.txt"), "utf8"),
        "file effect before receipt failure\n",
    );
    assert.equal(
        changes.files.find((file) => file.path === "unconfirmed.txt")?.byPi,
        false,
        "without a durable success receipt, the file is visible but attribution is unconfirmed",
    );
});
