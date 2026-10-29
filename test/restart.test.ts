// Restarting the server (`src/server/restart.ts`), on a small copy of the server's folder made here: what changed since
// the start, the check that the new code loads, the owner's restart command, a restart that waits for tool calls, and
// Pi's requests.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    checkLoads,
    Restarts,
    type RestartOptions,
    type RestartStatus,
} from "../src/server/restart.ts";

const roots: string[] = [];

after(() => {
    for (const root of roots) {
        rmSync(root, { recursive: true, force: true });
    }
});

/** A folder shaped like Pi Pocket's, with two server modules and an extension module. */
function appRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "pi-pocket-restart-"));

    roots.push(root);
    mkdirSync(join(root, "src", "server", "extensions"), { recursive: true });
    mkdirSync(join(root, "src", "launcher"), { recursive: true });
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "package.json"), '{ "type": "module" }\n');
    writeFileSync(
        join(root, "src", "server", "a.ts"),
        'import { b } from "./b.ts";\nexport const a: number = b;\n',
    );
    writeFileSync(join(root, "src", "server", "b.ts"), "export const b: number = 1;\n");
    writeFileSync(join(root, "src", "server", "main.ts"), "process.exit(3);\n");
    writeFileSync(join(root, "src", "server", "extensions", "x.ts"), "export default 1;\n");
    writeFileSync(join(root, "src", "launcher", "main.ts"), "export {};\n");
    writeFileSync(join(root, "bin", "pi-pocket.js"), "export {};\n");

    return root;
}

function restarts(root: string, extra: Partial<RestartOptions> = {}) {
    const events: RestartStatus[] = [];
    const notices: string[] = [];
    let restarted = 0;
    const made = new Restarts({
        appRoot: root,
        restart: () => restarted++,
        command: () => "",
        runningTools: async () => 0,
        changed: (status) => events.push(status),
        notice: (_level, message) => notices.push(message),
        log: () => {},
        watch: false,
        ...extra,
    });

    return { made, events, notices, restarted: () => restarted };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a change to a server module needs a restart; one to an extension module does not", () => {
    const root = appRoot();
    const { made } = restarts(root);

    assert.equal(made.status().needed, false);
    assert.equal(made.status().method, "launcher");

    writeFileSync(join(root, "src", "server", "extensions", "x.ts"), "export default 2;\n");
    made.refresh();
    assert.equal(made.status().needed, false);

    writeFileSync(join(root, "src", "server", "b.ts"), "export const b: number = 2;\n");
    writeFileSync(join(root, "src", "server", "c.ts"), "export const c = 3;\n");
    made.refresh();
    const status = made.status();

    assert.equal(status.needed, true);
    assert.deepEqual(status.changed, ["src/server/b.ts", "src/server/c.ts"]);
    assert.equal(status.launcherChanged, false);

    writeFileSync(join(root, "src", "launcher", "main.ts"), "export const x = 1;\n");
    made.refresh();
    assert.equal(made.status().launcherChanged, true);
    made.close();
});

test("the check finds a module that does not load, and the restart does not happen", async () => {
    const root = appRoot();

    assert.deepEqual(await checkLoads(root), { ok: true });

    writeFileSync(join(root, "src", "server", "b.ts"), "export const b: number = ;\n");
    const failed = await checkLoads(root);

    assert.equal(failed.ok, false);
    assert.match(!failed.ok ? failed.output : "", /b\.ts/);

    const { made, restarted } = restarts(root);

    await assert.rejects(made.restart(), /does not load/);
    assert.equal(restarted(), 0);
    assert.match(made.status().lastError ?? "", /does not load/);

    // A restart request does not hide the failed check while this process still runs.
    await made.restart({ force: true });
    await wait(150);
    assert.equal(restarted(), 1);
    assert.match(made.status().lastError ?? "", /does not load/);
    made.close();
});

test("an import that does not resolve fails the check too", async () => {
    const root = appRoot();

    writeFileSync(
        join(root, "src", "server", "a.ts"),
        'import { gone } from "./gone.ts";\nexport const a = gone;\n',
    );
    const failed = await checkLoads(root);

    assert.equal(failed.ok, false);
});

test("the owner's command restarts in place of the launcher", async () => {
    const root = appRoot();
    const marker = join(root, "ran");
    const { made, restarted } = restarts(root, { command: () => `touch ${marker}` });

    assert.equal(made.status().method, "command");
    await made.restart();

    for (let tries = 0; tries < 50 && !existsSync(marker); tries++) {
        await wait(20);
    }

    assert.ok(existsSync(marker));
    assert.equal(restarted(), 0);
    made.close();
});

test("a command that fails says why, and the server keeps running", async () => {
    const root = appRoot();
    const { made, notices } = restarts(root, { command: () => "echo nope >&2; exit 4" });

    await made.restart();

    for (let tries = 0; tries < 50 && made.status().lastError === undefined; tries++) {
        await wait(20);
    }

    assert.match(made.status().lastError ?? "", /nope/);
    assert.ok(notices.some((each) => /restart command failed/.test(each)));
    made.close();

    // A successful reboot creates a new Restarts instance, so it does not keep the old process's error.
    const next = restarts(root);

    assert.equal(next.made.status().lastError, undefined);
    next.made.close();
});

test("nothing to restart with: a clear refusal", async () => {
    const root = appRoot();
    const made = new Restarts({
        appRoot: root,
        command: () => "",
        runningTools: async () => 0,
        changed: () => {},
        notice: () => {},
        log: () => {},
        watch: false,
    });

    assert.equal(made.status().available, false);
    await assert.rejects(made.restart(), /Nothing can restart/);
    made.close();
});

test("a restart when tools finish waits for the running tool calls, and can be cancelled", async () => {
    const root = appRoot();
    let tools = 2;
    const { made, events, restarted } = restarts(root, {
        runningTools: async () => tools,
        idlePollMs: 10,
    });

    await made.restart({ when: "idle", force: true });
    await wait(40);
    assert.equal(restarted(), 0);
    assert.equal(made.status().waiting?.tools, 2);
    assert.ok(events.some((each) => each.waiting !== undefined));

    tools = 0;
    await wait(200);
    assert.equal(restarted(), 1);
    assert.equal(made.status().waiting, undefined);
    made.close();

    const second = restarts(root, { runningTools: async () => 1, idlePollMs: 10 });

    await second.made.restart({ when: "idle", force: true });
    assert.equal(second.made.cancel(), true);
    await wait(60);
    assert.equal(second.restarted(), 0);
    second.made.close();
});

test("a wait for tool calls ends at its limit", async () => {
    const root = appRoot();
    let now = 1000;
    const { made, restarted } = restarts(root, {
        runningTools: async () => 1,
        idlePollMs: 10,
        idleLimitMs: 100,
        now: () => now,
    });

    await made.restart({ when: "idle", force: true });
    await wait(30);
    assert.equal(restarted(), 0);
    now += 200;
    await wait(200);
    assert.equal(restarted(), 1);
    made.close();
});

test("Pi's request asks once per call, tells the owner, and a restart clears it", async () => {
    const root = appRoot();
    const { made, notices } = restarts(root);

    made.request("7:call", 3, "changed  restart.ts\n");
    made.request("7:call", 3, "again");
    assert.equal(made.status().requests.length, 1);
    assert.equal(made.status().requests[0]!.reason, "changed restart.ts");
    assert.equal(notices.length, 1);

    made.request("8:call", 3, "");
    assert.equal(made.dismiss("8:call"), true);
    assert.equal(made.dismiss("8:call"), false);
    assert.equal(made.status().requests.length, 1);

    await made.restart({ force: true });
    assert.equal(made.status().requests.length, 0);
    made.close();
});

test("the server's code itself loads in the check", async () => {
    // The real folder: the check a restart runs must pass on the code as it is.
    const root = join(import.meta.dirname, "..");

    assert.deepEqual(await checkLoads(root), { ok: true });
    assert.ok(readFileSync(join(root, "src", "server", "restart.ts"), "utf8").length > 0);
});
