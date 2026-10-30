// The assistant profile: Classic is PiP as upstream; Pia shares PiP's conversation with the normal tools, one workspace,
// and one AGENTS.md. Module defaults follow the profile; the owner's own choices always win.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";
import { PIP_EXTENSIONS } from "../src/server/pip.ts";
import { piaAgentsFile, piaWorkspace } from "../src/server/pia.ts";
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
    work,
    type App,
} from "./helpers.ts";

const model = scriptedModel(() => fauxAssistantMessage([fauxText("ok")]));
const data = join(root, "pia-profile");
let app: App;

before(async () => {
    app = await openApp(model, data);
});
after(async () => {
    await app?.close();
    cleanUp();
});

const agent = async (id: ConversationId) => (await app.conversation(id)).agent(context);
const tools = async (id: ConversationId) => (await agent(id)).tools.map((tool) => tool.name);

const render = async (id: ConversationId, key: string) => {
    const current = await agent(id);
    const section = current.sections.find((each) => each.key === key);

    return section?.render(
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

test("Classic is the default and keeps PiP as upstream", async () => {
    const person = owner(app);

    assert.equal(app.pip.profile().mode, "classic");
    assert.equal(app.pip.profile().name, "PiP");
    assert.deepEqual((await app.hello(person)).server.assistant, {
        profile: "classic",
        name: "PiP",
    });

    const id = await app.pip.ensure(person);
    const state = await app.agentState(id);

    assert.deepEqual(state?.extensions, PIP_EXTENSIONS);
    assert.equal(state?.cwd, work);
    assert.ok(!(await tools(id)).includes("bash"));
    assert.ok((await tools(id)).includes("session_start"));
    assert.ok(app.loader.enabled("subagents.ts"));
    assert.ok(app.loader.enabled("background.ts"));
    assert.equal(app.pip.runsCommands(id), false);
    assert.ok(!existsSync(piaWorkspace(data)));
    // Classic PiP selects no prompt module; ordinary sessions keep their preamble.
    assert.equal(await render(id, "preamble"), undefined);
    assert.match(
        String(await render(await newSession(app), "preamble")),
        /You are Pi, a coding agent/,
    );
    await assert.rejects(
        app.background.start(id, { command: "true", notify: false }),
        /PiP does not run commands/,
    );
});

test("Pia: same conversation, normal tools, workspace, shared AGENTS.md, module defaults", async () => {
    const person = owner(app);
    const id = await app.pip.ensure(person);

    await app.setAssistantProfile(person, "pia");
    assert.equal(app.pip.profile().mode, "pia");
    assert.equal(app.pip.profile().name, "Pia");
    assert.equal(await app.pip.ensure(person), id);

    const state = await app.agentState(id);
    const workspace = piaWorkspace(data);

    assert.equal(state?.cwd, workspace);
    assert.equal(app.sessionMeta(id)?.cwd, workspace);
    assert.ok(existsSync(piaAgentsFile(data)));
    assert.match(readFileSync(piaAgentsFile(data), "utf8"), /\/tmp/);

    const offered = await tools(id);

    for (const name of ["bash", "write", "edit", "session_start", "session_follow"]) {
        assert.ok(offered.includes(name), `${name} in ${offered.join(", ")}`);
    }

    // No capability filter: artifact_inline is enabled (shown when opened as a conversation).
    assert.ok(
        (await agent(id)).callable.some((tool) => tool.name === "artifact_inline") ||
            (await agent(id)).deferred.some((tool) => tool.name === "artifact_inline") ||
            offered.includes("artifact_inline"),
    );
    // Subagents and Background are off by default in Pia, and nothing was written to config.
    assert.ok(!app.loader.enabled("subagents.ts"));
    assert.ok(!app.loader.enabled("background.ts"));
    assert.equal(app.config.extensionChoice("subagents.ts"), undefined);
    assert.equal(app.config.extensionChoice("background.ts"), undefined);
    assert.equal(app.pip.runsCommands(id), true);
    // Its prompt: Pia's preamble, no ordinary preamble, and the shared file once.
    assert.equal(await render(id, "preamble"), undefined);
    assert.match(String(await render(id, "pip")), /You are Pia/);
    assert.match(String(await render(id, "pia_shared")), /Standing instructions for Pia/);
    assert.doesNotMatch(
        String((await render(id, "project_context")) ?? ""),
        /Standing instructions/,
    );
});

test("Pia: the shared AGENTS.md is read whatever the folder, and a chosen folder stays", async () => {
    const person = owner(app);
    const id = await app.pip.ensure(person);
    const elsewhere = join(work, "pia-elsewhere");

    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(piaAgentsFile(data), "# Pia\n\nshared-marker-123\n");
    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentDoc, id)).cwd = elsewhere;
    }, context);
    // ensure (a panel open) does not force the workspace back.
    await app.pip.ensure(person);
    assert.equal((await app.agentState(id))?.cwd, elsewhere);
    assert.match(String(await render(id, "pia_shared")), /shared-marker-123/);
    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentDoc, id)).cwd = piaWorkspace(data);
    }, context);
});

test("Pia: an existing AGENTS.md is never overwritten", async () => {
    const person = owner(app);

    writeFileSync(piaAgentsFile(data), "kept-by-owner\n");
    await app.setAssistantProfile(person, "classic");
    await app.setAssistantProfile(person, "pia");
    assert.equal(readFileSync(piaAgentsFile(data), "utf8"), "kept-by-owner\n");
});

test("Explicit enablement wins in Pia and persists across a restart", async () => {
    const person = owner(app);

    await app.setExtensionEnabled(person, "background.ts", true);
    assert.ok(app.loader.enabled("background.ts"));
    assert.equal(app.config.extensionChoice("background.ts"), true);
    await app.close();
    app = await openApp(model, data);
    assert.equal(app.pip.profile().mode, "pia");
    assert.ok(app.loader.enabled("background.ts"));
    assert.ok(!app.loader.enabled("subagents.ts"));

    // Background runs in the Pia chat once enabled (its backend allows a Pia chat).
    const id = await app.pip.ensure(owner(app));
    const task = await app.background.start(id, { command: "true", notify: false });

    assert.ok(task.id !== undefined);
});

test("Tool discovery is Pia's: Classic sessions keep upstream exposure", async () => {
    const person = owner(app);
    const prior = process.env.PI_POCKET_TOOL_DISCOVERY;

    // The shared test helper turns discovery off for scripted fixtures; this test exercises the profile gate.
    delete process.env.PI_POCKET_TOOL_DISCOVERY;
    await app.close();
    app = await openApp(model, data);

    try {
        const session = await newSession(app);

        assert.ok((await tools(session)).includes("tool_search"));
        assert.ok(!(await tools(session)).includes("browser"));
        assert.match(String(await render(session, "task_focus")), /Focus on the request/);

        await app.setAssistantProfile(owner(app), "classic");
        assert.ok(!(await tools(session)).includes("tool_search"));
        assert.ok((await tools(session)).includes("browser"));
        assert.equal(await render(session, "task_focus"), undefined);
        // Back in Classic: PiP has its upstream selection again, and the default folder.
        const id = await app.pip.ensure(owner(app));

        assert.deepEqual((await app.agentState(id))?.extensions, PIP_EXTENSIONS);
        assert.equal((await app.agentState(id))?.cwd, work);
        assert.ok(app.loader.enabled("subagents.ts"));
    } finally {
        if (prior === undefined) {
            delete process.env.PI_POCKET_TOOL_DISCOVERY;
        } else {
            process.env.PI_POCKET_TOOL_DISCOVERY = prior;
        }
    }

    void person;
});

test("Only the owner changes the profile and name, and values are checked", async () => {
    const person = owner(app);
    const { user: guest } = app.config.addUser("Guest", "guest");

    await assert.rejects(app.setAssistantProfile(guest, "pia"), /owner/);
    await assert.rejects(app.setAssistantProfile(person, "other"), /classic or pia/);
    await app.setAssistantProfile(person, "pia");
    await app.setAssistantName(person, "  Nova\n Helper ");
    assert.equal(app.pip.profile().name, "Nova Helper");
    await app.setAssistantName(person, null);
    assert.equal(app.pip.profile().name, "Pia");
    await assert.rejects(app.setAssistantName(person, 5), /text/);
    await app.setAssistantProfile(person, "classic");
    assert.equal(app.pip.profile().name, "PiP");
});

test("Compaction: Pia compacts as sessions do; Classic keeps PiP's own summary", async () => {
    const person = owner(app);
    const id = await app.pip.ensure(person);
    const summarize = (conversationId: ConversationId) =>
        app.pipCompaction.summarize(
            { messages: [] },
            { conversationId, taskId: 0 } as never,
            { ...context, abortSignal: AbortSignal.abort() } as never,
        );

    await app.setAssistantProfile(person, "pia");
    // Undefined: the hook leaves the summary to Pi Durable, as for any session.
    assert.equal(await summarize(id), undefined);
    await app.setAssistantProfile(person, "classic");
    // Classic: PiP's own summary is attempted (aborted here, so it throws rather than call a model).
    await assert.rejects(summarize(id));
});

test("Profile switches: concurrent and rapid switches end as the last one asked, modules and PiP in step", async () => {
    const person = owner(app);
    const id = await app.pip.ensure(person);

    await app.setAssistantProfile(person, "classic");
    await Promise.all([
        app.setAssistantProfile(person, "pia"),
        app.setAssistantProfile(person, "classic"),
        app.setAssistantProfile(person, "pia"),
        app.setAssistantProfile(person, "classic"),
        app.setAssistantProfile(person, "pia"),
    ]);
    assert.equal(app.pip.profile().mode, "pia");
    assert.ok(!app.loader.enabled("subagents.ts"));
    assert.deepEqual((await app.agentState(id))?.extensions, {
        add: ["pocket-pip"],
    });
    assert.equal((await app.agentState(id))?.cwd, piaWorkspace(data));

    await Promise.all([
        app.setAssistantProfile(person, "classic"),
        app.setAssistantProfile(person, "pia"),
        app.setAssistantProfile(person, "classic"),
    ]);
    assert.equal(app.pip.profile().mode, "classic");
    assert.ok(app.loader.enabled("subagents.ts"));
    assert.deepEqual((await app.agentState(id))?.extensions, PIP_EXTENSIONS);
    assert.equal((await app.agentState(id))?.cwd, work);

    // A failed switch does not block the next one.
    await assert.rejects(app.setAssistantProfile(person, "nope"));
    await app.setAssistantProfile(person, "pia");
    assert.equal(app.pip.profile().mode, "pia");
    await app.setAssistantProfile(person, "classic");
});

test("Profile switches: refused while the assistant works; its run keeps what it started with", async () => {
    const person = owner(app);
    const id = await app.pip.ensure(person);
    const before = JSON.stringify(await app.agentState(id));

    await app.harness.commit(async (tx) => {
        const { LiveDoc } = await import("@earendil-works/pi-durable");

        (await tx.doc(LiveDoc, id)).compactions = [{ taskId: 999_999 } as never];
    }, context);

    try {
        await assert.rejects(app.setAssistantProfile(person, "pia"), /working/);
        assert.equal(app.pip.profile().mode, "classic");
        assert.equal(JSON.stringify(await app.agentState(id)), before);
    } finally {
        await app.harness.commit(async (tx) => {
            const { LiveDoc } = await import("@earendil-works/pi-durable");

            (await tx.doc(LiveDoc, id)).compactions = [];
        }, context);
    }

    await app.setAssistantProfile(person, "pia");
    assert.equal(app.pip.profile().mode, "pia");
    await app.setAssistantProfile(person, "classic");
});

test("Profile switches: refused while a session's subagent runs; allowed once it ends", async () => {
    let release = false;
    const busyModel = scriptedModel((request) => {
        const { role, text } = lastText(request as never);
        const system = JSON.stringify(
            (request as { messages: { role: string }[] }).messages.filter(
                (message) => message.role === "system",
            ),
        );

        // The subagent: it keeps working (a tool round each time) until the test releases it.
        if (system.includes('You are the subagent \\"slow-helper\\"')) {
            return release
                ? fauxAssistantMessage([fauxText("helper done")])
                : fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.2" })], {
                      stopReason: "toolUse",
                  });
        }

        // The parent: it spawns once, then finishes its run, so `say` returns while the child still works.
        if (role === "user" && text.includes("Spawn the slow helper.")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("subagent", {
                        action: "spawn",
                        name: "slow-helper",
                        message: "slow-helper-task",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText("ok")]);
    });
    const busy = await openApp(busyModel, join(root, "pia-profile-busy"));

    try {
        const person = owner(busy);
        const session = await newSession(busy);

        await say(busy, session, "Spawn the slow helper.");
        await until(
            async () =>
                (await busy.harness.snapshot(SubagentsDoc, session, context))?.agents[
                    "slow-helper"
                ] !== undefined,
            "the subagent",
        );
        await assert.rejects(busy.setAssistantProfile(person, "pia"), /subagent or background/);
        assert.equal(busy.pip.profile().mode, "classic");
        assert.ok(busy.loader.enabled("subagents.ts"));

        // Once the subagent's work ends, the switch goes through and Pia's defaults apply.
        release = true;
        await until(async () => {
            const graph = await busy.harness.taskGraph(context);

            try {
                return !Object.values(graph.value.tasks).some((task) =>
                    task.kind.startsWith("pocket.subagent-"),
                );
            } finally {
                graph.dispose();
            }
        }, "the subagent's work to end");
        await busy.setAssistantProfile(person, "pia");
        assert.equal(busy.pip.profile().mode, "pia");
        assert.ok(!busy.loader.enabled("subagents.ts"));
    } finally {
        await busy.close();
    }
});
