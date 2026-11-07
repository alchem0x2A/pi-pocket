import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lispString, openInEmacs } from "../src/server/emacs.ts";

const terminalUrl = async () => "https://test.ts.net:9450/";

test("Emacs uses the existing socket with literal Lisp data, no shell, daemon start, or new frame", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pocket-emacs-"));
    const path = join(folder, 'my \\"file $(touch nope) 雪.txt');
    const calls: string[][] = [];

    try {
        await writeFile(path, "hello\n");
        const result = await openInEmacs(path, {
            terminalUrl,
            socket: "/test/web",
            run: async (args) => {
                calls.push(args);
            },
        });

        assert.deepEqual(result, { url: await terminalUrl(), opened: true });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0]!.slice(0, 4), [
            "--socket-name",
            "/test/web",
            "--alternate-editor=false",
            "--eval",
        ]);
        assert.ok(calls[0]![4]!.includes(lispString(path)));
        assert.match(calls[0]![4]!, /enable-local-variables nil/);
        assert.match(calls[0]![4]!, /enable-local-eval nil/);
        assert.match(calls[0]![4]!, /concat "\/:"/);
        // The daemon's headless default frame is visible but has no terminal, so the form must
        // filter to tty frames (a non-nil tty parameter) and prefer the selected one.
        assert.match(calls[0]![4]!, /frame-parameter f 'tty/);
        assert.match(calls[0]![4]!, /selected-frame/);
        assert.doesNotMatch(calls[0]![4]!, /visible-frame-list/);
        assert.doesNotMatch(calls[0]!.join(" "), /--create-frame|--daemon/);
        assert.equal(lispString('a"b\\c'), '"a\\"b\\\\c"');
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
});

test("unavailable Emacs offers its discovered terminal; unsupported files never invoke emacsclient", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pocket-emacs-"));
    let calls = 0;

    const run = async () => {
        calls++;

        throw new Error("no socket");
    };

    try {
        const path = join(folder, "text file.txt");

        await writeFile(path, "text");
        const result = await openInEmacs(path, { terminalUrl, run });

        assert.equal(result.opened, false);
        assert.equal(result.url, await terminalUrl());
        assert.match(result.error!, /Open the Emacs terminal/);
        assert.equal(calls, 1);
        await assert.rejects(openInEmacs(path, { terminalUrl: async () => undefined, run }), {
            status: 409,
        });
        assert.equal(calls, 1);

        const binary = join(folder, "binary.bin");

        await writeFile(binary, Buffer.from([0, 255, 42]));
        await assert.rejects(openInEmacs(binary, { terminalUrl, run }), /Download/);
        await assert.rejects(openInEmacs(folder, { terminalUrl, run }), /regular text files/);
        assert.equal(calls, 1);
        await writeFile(binary, Buffer.from([255, 254, 128]));
        await assert.rejects(openInEmacs(binary, { terminalUrl, run }), /UTF-8/);
        const missing = await openInEmacs(path, {
            terminalUrl,
            run: async () => {
                throw Object.assign(new Error("missing"), { code: "ENOENT" });
            },
        });

        assert.match(missing.error!, /emacsclient is unavailable/);

        const svg = join(folder, "drawing.svg");

        await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
        assert.equal((await openInEmacs(svg, { terminalUrl, run: async () => {} })).opened, true);
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
});
