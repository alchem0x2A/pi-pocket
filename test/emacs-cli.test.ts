// Exercise the real process adapter and service discovery without contacting the owner's Emacs or Tailscale service.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lispString, openInEmacs } from "../src/server/emacs.ts";

test("local CLI arguments and the WeTTY URL come from the existing socket and backend-port mapping", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocket-emacs-cli-"));
    const names = ["PATH", "PI_POCKET_EMACS_SOCKET", "EMACS_WEB_PORT"];
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    const log = join(directory, "client-arguments.json");
    const tailscaleLog = join(directory, "tailscale-arguments.json");
    const path = join(directory, 'file "with quotes" 雪.txt');

    try {
        await writeFile(path, "text\n");
        await writeFile(
            join(directory, "emacsclient"),
            `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`,
            { mode: 0o700 },
        );
        await writeFile(
            join(directory, "tailscale"),
            `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(tailscaleLog)}, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({TCP: {"9449": {HTTPS: true}, "9555": {HTTPS: true}}, Web: {"editor.example.ts.net:9449": {Handlers: {"/": {Proxy: "http://127.0.0.1:8765"}}}, "other.example.ts.net:9555": {Handlers: {"/": {Proxy: "http://127.0.0.1:5555"}}}}}));\n`,
            { mode: 0o700 },
        );
        process.env.PATH = `${directory}:${previous.get("PATH")}`;
        process.env.PI_POCKET_EMACS_SOCKET = join(directory, "web");
        process.env.EMACS_WEB_PORT = "8765";
        const result = await openInEmacs(path);
        const args = JSON.parse(await readFile(log, "utf8")) as string[];

        assert.deepEqual(result, { url: "https://editor.example.ts.net:9449/", opened: true });
        assert.deepEqual(args.slice(0, 4), [
            "--socket-name",
            join(directory, "web"),
            "--alternate-editor=false",
            "--eval",
        ]);
        assert.equal(args.length, 5);
        assert.ok(args[4]!.includes(lispString(path)));
        assert.deepEqual(JSON.parse(await readFile(tailscaleLog, "utf8")), [
            "serve",
            "status",
            "--json",
        ]);
    } finally {
        for (const [name, value] of previous) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }

        await rm(directory, { recursive: true, force: true });
    }
});
