import { context, lastText, openApp, newSession, say, scriptedModel } from "./helpers.ts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, ToolTask, GenerationTask } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
const root = process.env.FIX!;
const stage = process.env.STAGE!;
const dir = process.env.DATA!;

if (
    !root?.startsWith("/tmp/pia-codemode-upgrade-") ||
    !dir?.startsWith(root + "/") ||
    !["seed", "upgrade", "restore"].includes(stage)
) {
    throw new Error(
        "Use a new /tmp/pia-codemode-upgrade-* fixture, an isolated DATA folder under it, and STAGE=seed|upgrade|restore.",
    );
}

const work = join(root, "work");

mkdirSync(work, { recursive: true });
const p = join(work, "old.txt");
const png = join(work, "old.png");
const model = scriptedModel((req) => {
    const last = lastText(req);

    if (last.role === "user" && last.text.startsWith("script ")) {
        return fauxAssistantMessage([fauxToolCall("codemode", { code: last.text.slice(7) })], {
            stopReason: "toolUse",
        });
    }

    if (last.role === "user" && last.text.startsWith("read ")) {
        return fauxAssistantMessage([fauxToolCall("read", { path: last.text.slice(5) })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText("done")]);
});
const app = await openApp(model, dir, undefined, undefined, false);
let id;

try {
    if (stage === "seed") {
        writeFileSync(p, "old fixture");
        writeFileSync(
            png,
            Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                "base64",
            ),
        );
        id = await newSession(app, work);
        await say(app, id, `read ${p}`);
        await say(app, id, `read ${png}`);
        await say(app, id, `read ${join(work, "missing")}`);
        await say(
            app,
            id,
            'script store("oldCount",7); text("old nested");text(await tools.read({path:' +
                JSON.stringify(p) +
                "}));",
        );
        writeFileSync(join(root, "session"), String(id));
    } else {
        id = Number(readFileSync(join(root, "session"), "utf8")) as never;
        const view = await (await app.conversation(id)).context(context);

        assert.ok(view.messages.some((m) => m.role === "toolResult" && m.isError));
        assert.ok(
            view.messages.some(
                (m) => m.role === "toolResult" && m.content.some((b) => b.type === "image"),
            ),
        );
        assert.match(JSON.stringify(view.messages), /old nested/);
        const entries = await app.transcripts.allEntries(id, true);

        assert.ok(entries.length > 5);
        assert.ok(entries.some((e) => e.kind === "toolResult" && (e.images ?? 0) > 0));
        assert.ok(entries.some((e) => e.kind === "toolResult" && e.isError));
        await say(app, id, 'script text(load("oldCount")); store("oldCount",8);');
        const next = await (await app.conversation(id)).context(context);
        const result = next.messages.findLast(
            (m) => m.role === "toolResult" && m.toolName === "codemode",
        );

        assert.ok(result && result.role === "toolResult" && !result.isError);
        assert.ok(
            result.content.some((p) => p.type === "text" && p.text === "7"),
            JSON.stringify(result.content),
        );
    }

    console.log(
        JSON.stringify({
            stage,
            id,
            entries: (await app.transcripts.allEntries(id, true)).length,
            liveVersion: LiveDoc.definition.version,
            toolVersion: ToolTask.definition.version,
            generationVersion: GenerationTask.definition.version,
            package: JSON.parse(
                readFileSync(
                    join(
                        import.meta.dirname,
                        "../node_modules/@earendil-works/pi-durable/package.json",
                    ),
                    "utf8",
                ),
            ).version,
        }),
    );
} finally {
    await app.close();
}

const db = new DatabaseSync(join(dir, "pocket.sqlite"), { readOnly: true });

console.log("sqlite schema", db.prepare("SELECT * FROM durable_schema").all());
db.close();
