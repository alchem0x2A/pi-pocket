/** Manual model smoke test. Reads only a temporary credential copy; all app data and fixtures are isolated. */
import { context, root, openApp, newSession, owner, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import {
    copyFileSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    existsSync,
    unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ConfigStore } from "../src/server/config.ts";
import { UsageDoc } from "@earendil-works/pi-durable";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

const credentials = process.env.PIA_SMOKE_CREDENTIALS;

if (!credentials?.startsWith("/tmp/pia-codemode-models-")) {
    throw new Error(
        "Set PIA_SMOKE_CREDENTIALS to an isolated /tmp/pia-codemode-models-* copy of auth.json and models.json.",
    );
}

for (const name of ["auth.json", "models.json"]) {
    copyFileSync(join(credentials, name), join(process.env.PI_CODING_AGENT_DIR!, name));
}

process.env.PI_POCKET_TOOL_DISCOVERY = "on";
process.env.PI_POCKET_LEAN_PROMPT = "on";
const fixtureRoot = join(root, "project");

for (const folder of ["amber", "birch"]) {
    mkdirSync(join(fixtureRoot, folder), { recursive: true });
}

execFileSync("git", ["init", "-q", fixtureRoot]);
writeFileSync(join(fixtureRoot, "amber/README.md"), "# Amber\n\nTODO ship\nStable.\n");
writeFileSync(join(fixtureRoot, "birch/README.md"), "# Birch\n\nTODO test\nTODO docs\nComplete.\n");
const outputPath = join(fixtureRoot, "report.md");
const task = `Inspect the two fixture project READMEs in amber and birch. Report their line counts, first headings, and TODO occurrences. Find the approved project convention relevant to generated reports. Use the available project-status extension to obtain the fixture's current status. Write a concise report to ${outputPath}. Do not change project files or create memory notes.`;

console.log(
    JSON.stringify({
        fixtureRoot,
        expected: {
            amber: { lines: 4, heading: "# Amber", todos: 1 },
            birch: { lines: 5, heading: "# Birch", todos: 2 },
            status: "ready",
            reportHeading: "# Fixture Report",
        },
    }),
);

for (const ref of [
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "xhigh" as const },
    {
        provider: "local-inference",
        modelId: "strata/qwen3.8-flash-next-iq3_xxs",
        thinkingLevel: "off" as const,
    },
]) {
    if (existsSync(outputPath)) {
        unlinkSync(outputPath);
    }

    const data = join(root, ref.provider);

    mkdirSync(join(data, "extensions"), { recursive: true });
    writeFileSync(
        join(data, "extensions/status-fixture.ts"),
        `/** Fixture project build status. */
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
export default () => defineExtension({name:"status-fixture",tools:[defineTool({
    name:"project_status",description:"Get the fixture project's current build status",parameters:Type.Object({}),
    async execute(){return {output:[{type:"text",text:'{"status":"ready","queue":0}'}]};}
})]});`,
    );
    const config = new ConfigStore(data);

    for (const file of [
        "artifacts.ts",
        "design.ts",
        "agent-teams.ts",
        "background.ts",
        "gallery.ts",
        "goals.ts",
        "subagents.ts",
        "triggers.ts",
        "updates.ts",
        "browser.ts",
        "schedules.ts",
        "inbox-notes.ts",
        "restart.ts",
    ]) {
        config.setExtensionEnabled(file, false);
    }

    const app = await openApp(scriptedModel(), data, undefined, undefined, false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();
    const offered: string[][] = [];
    let error: string | undefined;

    try {
        await app.setExtensionEnabled(owner(app), "status-fixture.ts", true);
        app.setExtensionSettings(owner(app), "codemode", { mode: "only" });
        app.settings.applyOverrides({ retry: { enabled: false, maxRetries: 0 } });
        assert.ok(app.models.getModel(ref.provider, ref.modelId), "resolved model");
        const original = app.models.streamSimple.bind(app.models);

        app.models.streamSimple = (model, request, options) => {
            if (model.provider === ref.provider && model.id === ref.modelId) {
                offered.push(
                    (request.tools?.length ? request.tools : getCurrentTools(request.messages)).map(
                        (t) => t.name,
                    ),
                );
            }

            return original(model, request, { ...options, maxTokens: 5000 });
        };

        const id = await newSession(app, fixtureRoot);

        await (
            await app.conversation(id)
        ).configure({ model: ref, thinkingLevel: ref.thinkingLevel, maxTurns: 8 }, context);
        await app.memory.add(
            id,
            fixtureRoot,
            { userId: owner(app).id, byPi: false, name: "Owner" },
            {
                title: "Generated reports convention",
                text: "Generated reports must start with # Fixture Report and include the current build status and per-project TODO counts.",
                scope: "project",
            },
        );
        const stop = new Promise<void>((_, reject) => {
            timer = setTimeout(() => {
                void app.commands.abort(id, owner(app));
                reject(new Error("smoke timeout after 120 seconds"));
            }, 120000);
        });

        try {
            await Promise.race([say(app, id, task), stop]);
        } catch (e) {
            error = String(e);
        }

        const entries = await app.transcripts.allEntries(id, true);
        const results = entries.filter((e) => e.kind === "toolResult");
        const nested = results.flatMap(
            (r) =>
                (r.details as { calls?: { name: string; status: string }[] } | undefined)?.calls ??
                [],
        );
        const usage = await app.harness.snapshot(UsageDoc, id, context);
        const view = await (await app.conversation(id)).context(context);
        const report = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : null;

        console.log(
            JSON.stringify(
                {
                    model: ref,
                    offered: offered[0],
                    requests: offered.length,
                    directCalls: results.map((r) => r.name),
                    nestedCalls: nested,
                    toolFailures: results
                        .filter((r) => r.isError)
                        .map((r) => ({ name: r.name, text: r.text })),
                    usage,
                    wallSeconds: (performance.now() - started) / 1000,
                    error,
                    report,
                    tail: view.messages.slice(-2),
                },
                null,
                2,
            ),
        );
    } finally {
        clearTimeout(timer);
        await app.close();
    }
}

// Some provider transports keep idle sockets. No live service shares this manual test process.
process.exit(0);
