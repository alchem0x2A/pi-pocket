import { test } from "node:test";
import assert from "node:assert/strict";
import createInkBoard from "../src/server/extensions/ink-board.ts";
import { BUILT_IN_TOOLS } from "../src/server/reload.ts";

test("Ink Board registers scene tools and reserves their names", async () => {
    let dispose: (() => void | Promise<void>) | undefined;
    const extension = createInkBoard(undefined, {
        onDispose: (fn) => {
            dispose = fn;
        },
    });

    try {
        const tools = extension.tools!;
        const names = tools.map((tool) => tool.name).sort();

        assert.deepEqual(names, [
            "ink_close",
            "ink_comment",
            "ink_edit",
            "ink_export",
            "ink_open",
            "ink_read",
            "ink_resolve",
        ]);
        assert(names.every((name) => BUILT_IN_TOOLS.has(name)));
        const read = tools.find((tool) => tool.name === "ink_read")!;
        const edit = tools.find((tool) => tool.name === "ink_edit")!;
        const exportTool = tools.find((tool) => tool.name === "ink_export")!;
        const readSchema = read.parameters as unknown as { properties: Record<string, unknown> };
        const editSchema = edit.parameters as unknown as { required: string[] };
        const exportSchema = exportTool.parameters as unknown as {
            properties: Record<string, unknown>;
        };

        assert("scene" in readSchema.properties && "render" in readSchema.properties);
        assert.deepEqual(editSchema.required, ["board", "expectedRevision", "operations"]);
        assert("frameId" in exportSchema.properties && "shapeIds" in exportSchema.properties);
    } finally {
        await dispose?.();
    }
});

test("Ink Board images and links use a verified isolated service and fixture token", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const dir = mkdtempSync(join(tmpdir(), "pia-ink-fixture-"));
    const token = join(dir, "token");
    const oldToken = process.env.INK_BOARD_AGENT_TOKEN_FILE;
    const original = globalThis.fetch;
    const disposers: (() => void | Promise<void>)[] = [];
    let identity = true;
    let commands = 0;

    writeFileSync(token, "fixture-token", { mode: 0o600 });
    process.env.INK_BOARD_AGENT_TOKEN_FILE = token;

    globalThis.fetch = async (url, init) => {
        if (String(url).endsWith("/api/health")) {
            return Response.json({
                service: identity ? "ink-board" : "other",
                version: "0.1.0",
                protocol: 1,
            });
        }

        commands++;
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
        assert.equal(init?.redirect, "error");
        assert.equal(JSON.parse(String(init?.body)).cwd, dir);

        return Response.json({
            output: [
                { type: "text", text: "Fixture board: http://fixture.invalid/board/one" },
                { type: "image", mimeType: "image/png", data: "fixture-image" },
            ],
        });
    };

    const extension = createInkBoard(undefined, { onDispose: (fn) => disposers.push(fn) });

    try {
        const tool = extension.tools!.find((t) => t.name === "ink_read")!;
        const api = { agent: async () => ({ cwd: dir }) };
        const result = await tool.execute(
            { board: "one" } as never,
            api as never,
            BACKGROUND_CONTEXT,
        );

        assert.equal(result.output?.[1]?.type, "image");
        assert.match(JSON.stringify(result.output), /fixture.invalid/);
        identity = false;
        await assert.rejects(
            tool.execute({ board: "one" } as never, api as never, BACKGROUND_CONTEXT),
            /not the expected|identity check failed/,
        );
        assert.equal(commands, 1, "an unidentified service gets no command or token");
    } finally {
        for (const dispose of disposers) {
            await dispose();
        }

        globalThis.fetch = original;

        if (oldToken === undefined) {
            delete process.env.INK_BOARD_AGENT_TOKEN_FILE;
        } else {
            process.env.INK_BOARD_AGENT_TOKEN_FILE = oldToken;
        }

        rmSync(dir, { recursive: true, force: true });
    }
});
