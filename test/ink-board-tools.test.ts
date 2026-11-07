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
