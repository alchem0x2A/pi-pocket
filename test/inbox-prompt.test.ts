// Temporary HTTP proof: normal tests use a dynamic port. Run serially with PI_POCKET_INBOX_PROOF=1 for 127.0.0.2:18799.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { AgentDoc, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import { SessionsDoc, SubagentsDoc } from "../src/server/docs.ts";
import createPia from "../src/server/extensions/pip.ts";
import type { PocketHost } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";

const host = "127.0.0.2";
const proof = process.env.PI_POCKET_INBOX_PROOF === "1";
const port = proof ? 18799 : 0;
const data = join(root, "inbox-prompt-data");
const secret = "PRIVATE_NOTE_TEXT_MUST_NOT_ENTER_THE_SYSTEM_PROMPT";
const prompts = new Map<string, string>();
const model = scriptedModel((request) => {
    const text = lastText(request as never).text;
    const label = /PROMPT_PROOF:([a-z-]+)/.exec(text)?.[1];

    if (label !== undefined) {
        // Replay the captured system-section deltas, including null removals, as the provider does.
        prompts.set(label, getCurrentSystemPrompt(request.messages));
    }

    return fauxAssistantMessage([fauxText("ok")]);
});

after(cleanUp);

async function listen(server: Server): Promise<void> {
    const deadline = Date.now() + 10_000;

    for (;;) {
        try {
            await new Promise<void>((resolve, reject) => {
                const failed = (error: Error) => reject(error);

                server.once("error", failed);
                server.listen(port, host, () => {
                    server.off("error", failed);
                    resolve();
                });
            });

            return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || Date.now() >= deadline) {
                throw error;
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
}

async function render(app: App, id: ConversationId) {
    const agent = await (await app.conversation(id)).agent(context);
    const input = { conversationId: id, agent, env: undefined, shown: {}, read: {} as never };
    const section = agent.sections.find((item) => item.key === "pia_inbox");

    return { input, text: await section?.render(input, context) };
}

function present(label: string): boolean {
    const prompt = prompts.get(label);

    assert.equal(typeof prompt, "string", "the scripted model must capture a real request");
    assert.equal(prompt!.includes(secret), false, "no note text in the system prompt");
    assert.equal(prompt!.includes("private-proof-note"), false, "no note ids in the system prompt");

    return prompt!.includes("<pia_inbox>");
}

test("Pia gets only a durable pending count; private ownership, legacy hosts, and HTTP prompts stay safe", async () => {
    let app = await openApp(model, data);
    let server: Server | undefined;

    try {
        const me = owner(app);

        app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
        const pia = await app.pia.ensure(me);
        const normal = await newSession(app);

        assert.equal((await app.hello(me)).server.inboxPendingCount, true);
        const guest = app.config.addUser("Guest", "guest");

        assert.equal((await app.hello(guest.user)).server.inboxPendingCount, false);
        assert.equal(await app.inbox.pendingCountForAssistant(pia), 0);
        assert.equal((await render(app, pia)).text, undefined);
        server = createServer(
            createHandler({
                app,
                listen: { host, port },
                restart() {
                    throw new Error("The proof must not restart a server");
                },
            }),
        );
        await listen(server);
        const bound = server.address() as { address: string; port: number };
        const base = `http://${host}:${String(bound.port)}`;

        const post = async (path: string, body: unknown, token = app.config.ownerToken) => {
            const response = await fetch(`${base}${path}`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                body: JSON.stringify(body),
            });

            assert.equal(response.status, 200, "the authenticated proof request must succeed");

            return response.json() as Promise<{ submissionId: SubmissionId }>;
        };

        const send = async (id: ConversationId, label: string, token?: string) => {
            const result = await post(
                `/api/c/${String(id)}/submit`,
                { text: `PROMPT_PROOF:${label}`, requestId: crypto.randomUUID() },
                token,
            );

            await (await app.harness.submission(result.submissionId, context))!.wait(context);
        };

        const capture = (id: string) => post("/api/inbox", { id, text: secret });
        const archive = (id: string, archived: boolean) =>
            post(`/api/inbox/${id}/archive`, { archived });

        await capture("private-proof-note");
        assert.equal(prompts.size, 0, "capture must not call the model");
        // Do not use either list path to count, even when the first prompt has no requester yet.
        const originalList = app.inbox.list;
        const originalTool = app.inbox.forAssistant;

        app.inbox.list = async () => {
            throw new Error("Prompt counting must not list note text");
        };

        app.inbox.forAssistant = async () => {
            throw new Error("Prompt counting must not call the explicit inbox tool");
        };

        try {
            assert.equal(app.attribution.requesterOf(pia), undefined);
            assert.equal(await app.inbox.pendingCountForAssistant(pia), 1);
            const first = (await render(app, pia)).text;

            assert.equal(first, "Inbox: 1 note pending. Use the inbox tool to list it.");
            assert.equal(
                (await render(app, pia)).text,
                first,
                "unchanged counts render identically",
            );
            await send(pia, "pending");
            assert.equal(present("pending"), true);
            assert.equal(prompts.get("pending")!.includes(String(first)), true);
        } finally {
            app.inbox.list = originalList;
            app.inbox.forAssistant = originalTool;
        }

        // This separate private helper has no attribution and no notes. It must not get the first owner's count.
        const other = app.config.addUser("Other owner", "owner").user;
        const otherPia = await app.pia.ensure(other);

        assert.equal(await app.inbox.pendingCountForAssistant(otherPia), 0);
        assert.equal((await render(app, otherPia)).text, undefined);
        await assert.rejects(app.inbox.forAssistant(otherPia, { action: "list" }), { status: 403 });
        const originalRequester = app.attribution.requesterOf.bind(app.attribution);

        app.attribution.requesterOf = (id) => (id === pia ? other.id : originalRequester(id));

        try {
            assert.equal(await app.inbox.pendingCountForAssistant(pia), undefined);
            await assert.rejects(app.inbox.forAssistant(pia, { action: "list" }), { status: 403 });
        } finally {
            app.attribution.requesterOf = originalRequester;
        }

        await archive("private-proof-note", true);
        assert.equal(await app.inbox.pendingCountForAssistant(pia), 0);
        await send(pia, "archived");
        assert.equal(present("archived"), false);
        await archive("private-proof-note", false);
        await capture("private-proof-note-two");
        assert.equal(await app.inbox.pendingCountForAssistant(pia), 2);
        await send(pia, "plural");
        assert.equal(present("plural"), true);
        assert.equal(
            prompts
                .get("plural")!
                .includes("Inbox: 2 notes pending. Use the inbox tool to list them."),
            true,
        );
        await archive("private-proof-note-two", true);
        await send(normal, "normal");
        await send(normal, "shared", guest.token);
        assert.equal(present("normal"), false);
        assert.equal(present("shared"), false);

        // Tool/extension selection is not an authorization boundary.
        await app.harness.commit(async (tx) => {
            (await tx.doc(AgentDoc, normal)).extensions = ["pocket-pip"];
        }, context);
        assert.equal(await app.inbox.pendingCountForAssistant(normal), undefined);
        await send(normal, "explicit-extension");
        assert.equal(present("explicit-extension"), false);
        await assert.rejects(app.inbox.forAssistant(normal, { action: "list" }), { status: 403 });
        const child = await app.harness.commit(async (tx) => {
            const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
            const agent = await tx.doc(AgentDoc, child.id);

            agent.model = { provider: "faux", modelId: "faux-1" };
            agent.extensions = ["pocket-pip"];
            (await tx.doc(SubagentsDoc, pia)).agents.child = {
                conversationId: child.id,
                reported: [],
            };

            return child.id;
        }, context);

        assert.equal(await app.inbox.pendingCountForAssistant(child), undefined);
        await send(child, "subagent");
        assert.equal(present("subagent"), false);
        await assert.rejects(app.inbox.forAssistant(child, { action: "list" }), { status: 403 });

        // An older host can have the inbox tool but no count method, or no inbox capability at all.
        const { input } = await render(app, pia);

        for (const inbox of [undefined, { forAssistant: originalTool }]) {
            const legacy = createPia({
                pia: {
                    name: () => "Pia",
                    workspace: () => work,
                    defaultFolder: () => work,
                    ownerName: () => me.name,
                    sharedContext: () => undefined,
                    task: app.pia.task,
                    inbox,
                },
            } as unknown as PocketHost);
            const section = legacy.sections!.find((item) => item.key === "pia_inbox")!;

            assert.equal(await section.render(input, context), undefined);
        }

        // Revoke the private mapping in durable state. Do not infer ownership from attribution.
        await app.harness.commit(async (tx) => {
            delete (await tx.doc(SessionsDoc)).items[String(pia)]!.pia;
        }, context);
        assert.equal(await app.inbox.pendingCountForAssistant(pia), undefined);
        await app.harness.commit(async (tx) => {
            (await tx.doc(SessionsDoc)).items[String(pia)]!.pia = me.id;
        }, context);

        console.log(
            JSON.stringify({
                pendingCount: 1,
                pendingPresent: present("pending"),
                archivedCount: 0,
                archivedPresent: present("archived"),
                normalPresent: present("normal"),
                sharedPresent: present("shared"),
                subagentPresent: present("subagent"),
            }),
        );
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve())),
        );
        server = undefined;
        await app.close();
        app = await openApp(model, data);
        assert.equal(
            await app.inbox.pendingCountForAssistant(pia),
            1,
            "the count survives a throwaway app restart",
        );
        assert.equal(
            (await render(app, pia)).text,
            "Inbox: 1 note pending. Use the inbox tool to list it.",
        );
    } finally {
        if (server?.listening) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server!.close(() => resolve()));
        }

        await app.close();
    }
});
