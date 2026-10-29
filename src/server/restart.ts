/**
 * Restarting the server, as the owner asks for it: what changed in the server's code since this process started (so
 * the app can say whether a restart is needed), a check that the new code loads before this process stops, the way to
 * restart (the launcher, or the owner's own command, such as a systemd reload), a restart that waits until no tool call
 * runs, and Pi's requests for a restart, which only the owner can carry out.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, watch } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { HttpError } from "./errors.ts";

/** How long the check that the new code loads may take. */
const CHECK_LIMIT_MS = 60_000;

/** How long a restart that waits for tool calls to end waits at most, before it restarts anyway. */
export const IDLE_LIMIT_MS = 10 * 60_000;
/** How often a waiting restart looks at the tool calls again. */
const IDLE_POLL_MS = 2000;
/** The most changed files the status lists. */
const MAX_LISTED = 30;
/** The most characters of the check's or the command's error output kept. */
const MAX_OUTPUT = 4000;
/** The most requests from Pi kept at once. */
const MAX_REQUESTS = 20;

/** The longest restart command, and the longest reason a request may give. */
export const MAX_COMMAND = 500;
const MAX_REASON = 300;

export interface RestartRequest {
    id: string;
    conversationId: number;
    reason: string;
    at: number;
}

export interface RestartStatus {
    /** Something can restart this server: the launcher, or the owner's command. */
    available: boolean;
    /** How a restart is done: the owner's command, the launcher (exit code 75), or nothing. */
    method: "command" | "launcher" | "none";
    /** The owner's restart command; empty: none. */
    command: string;
    startedAt: number;
    /** The server's code differs from what this process started with. */
    needed: boolean;
    /** The files that differ, under the app's folder, at most `MAX_LISTED`. */
    changed: string[];
    /** How many differ in all. */
    changedCount: number;
    /** The launcher's own code changed too: only a restart of the launcher (or its service) takes that. */
    launcherChanged: boolean;
    /** The checkout's commit when this process started, and now; undefined outside a git checkout. */
    commitAtStart?: string;
    commitNow?: string;
    /** A restart that waits for tool calls to end: since when, and how many still run. */
    waiting?: { since: number; tools: number };
    /** Pi's requests for a restart, newest last. */
    requests: RestartRequest[];
    /** Why the last restart did not happen: the check's output, or the command's. */
    lastError?: string;
}

export interface RestartOptions {
    /** Pi Pocket's own folder. */
    appRoot: string;
    /** Restart through the launcher (exit code 75); undefined when no launcher runs this server. */
    restart?: () => void;
    /** The owner's restart command, read each time; empty: none. */
    command: () => string;
    /** How many tool calls run now, in every session. */
    runningTools: () => Promise<number>;
    /** The status changed: tell the owner's tabs. */
    changed: (status: RestartStatus) => void;
    /** A note for the owner, as a notice. */
    notice: (level: "info" | "warning" | "error", message: string) => void;
    log: (line: string) => void;
    /** Tests: the clock, and the waits. */
    now?: () => number;
    idleLimitMs?: number;
    idlePollMs?: number;
    /** Tests: watch the folder for changes (default true). */
    watch?: boolean;
}

/** The server's own code (not its extension modules, which load again by themselves) and its packages. */
function serverFiles(appRoot: string): string[] {
    const server = join(appRoot, "src", "server");
    const extensions = join(server, "extensions");
    const files: string[] = [];

    const walk = (directory: string) => {
        let entries;

        try {
            entries = readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const path = join(directory, entry.name);

            if (entry.isDirectory()) {
                if (path !== extensions && entry.name !== "node_modules") {
                    walk(path);
                }
            } else if (entry.name.endsWith(".ts")) {
                files.push(path);
            }
        }
    };

    walk(server);

    return [...files, join(appRoot, "package.json"), join(appRoot, "package-lock.json")];
}

/** The launcher's code: a change there needs the launcher itself to start again. */
function launcherFiles(appRoot: string): string[] {
    const launcher = join(appRoot, "src", "launcher");
    let names: string[] = [];

    try {
        names = readdirSync(launcher).filter((name) => name.endsWith(".ts"));
    } catch {
        // Not there: nothing to compare.
    }

    return [
        ...names.map((name) => join(launcher, name)),
        join(appRoot, "bin", "pi-pocket.js"),
        join(appRoot, "src", "server", "update-state.ts"),
    ];
}

function hashes(files: string[]): Map<string, string> {
    const map = new Map<string, string>();

    for (const file of files) {
        try {
            map.set(file, createHash("sha1").update(readFileSync(file)).digest("hex"));
        } catch {
            // Gone: missing from the map, which counts as a change when it was there.
        }
    }

    return map;
}

function differences(before: Map<string, string>, now: Map<string, string>): string[] {
    const changed = new Set<string>();

    for (const [file, hash] of now) {
        if (before.get(file) !== hash) {
            changed.add(file);
        }
    }

    for (const file of before.keys()) {
        if (!now.has(file)) {
            changed.add(file);
        }
    }

    return [...changed].sort();
}

function commit(appRoot: string): string | undefined {
    const result = spawnSync(
        "git",
        ["-c", "core.fsmonitor=false", "rev-parse", "--short", "HEAD"],
        {
            cwd: appRoot,
            encoding: "utf8",
            timeout: 5000,
        },
    );

    return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function cut(text: string): string {
    const trimmed = text.trim();

    return trimmed.length > MAX_OUTPUT ? `…${trimmed.slice(-MAX_OUTPUT)}` : trimmed;
}

/**
 * Load every server module in a new Node process, as a new server would: a syntax error, an import that does not
 * resolve, or a missing package shows here, while this process still serves. Its extension modules and `main.ts` are
 * left out: those load again by themselves, and `main.ts` starts a server.
 */
export function checkLoads(appRoot: string): Promise<{ ok: true } | { ok: false; output: string }> {
    const files = serverFiles(appRoot).filter(
        (file) => file.endsWith(".ts") && file !== join(appRoot, "src", "server", "main.ts"),
    );
    // From an npm install, Node strips no types: the server starts with the hook that does, and so does this.
    const flags = appRoot.split(sep).includes("node_modules")
        ? ["--import", pathToFileURL(join(appRoot, "bin", "strip-types.js")).href]
        : [];
    const urls = files.map((file) => pathToFileURL(file).href);
    const code = [
        `const urls = ${JSON.stringify(urls)};`,
        "let failed = false;",
        "for (const url of urls) {",
        "    try { await import(url); } catch (error) {",
        "        failed = true;",
        '        console.error(`${url.replace(/^file:\\/\\//, "")}: ${error?.stack ?? error}`);',
        "    }",
        "}",
        "process.exit(failed ? 1 : 0);",
    ].join("\n");

    return new Promise((resolve) => {
        const child = spawn(
            process.execPath,
            ["--disable-warning=ExperimentalWarning", ...flags, "--input-type=module", "-e", code],
            {
                cwd: appRoot,
                stdio: ["ignore", "ignore", "pipe"],
                env: { ...process.env, PI_POCKET_LAUNCHER: "", PI_POCKET_CHECK: "1" },
            },
        );
        let output = "";
        const timer = setTimeout(() => {
            output += `\nThe check did not end in ${CHECK_LIMIT_MS / 1000} seconds.`;
            child.kill("SIGKILL");
        }, CHECK_LIMIT_MS);

        child.stderr.on("data", (chunk: Buffer) => {
            output = cut(output + chunk.toString("utf8"));
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({ ok: false, output: error.message });
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            resolve(
                code === 0
                    ? { ok: true }
                    : { ok: false, output: cut(output) || `The check stopped (code ${code}).` },
            );
        });
    });
}

export class Restarts {
    readonly #options: RestartOptions;
    readonly #now: () => number;
    readonly startedAt: number;
    readonly #atStart: Map<string, string>;
    readonly #launcherAtStart: Map<string, string>;
    readonly #commitAtStart: string | undefined;
    /** The comparison with the code now; undefined until something changes on disk, or someone asks. */
    #compared:
        { changed: string[]; launcherChanged: boolean; commitNow: string | undefined } | undefined;
    #requests: RestartRequest[] = [];
    #waiting: { since: number; tools: number; timer?: NodeJS.Timeout } | undefined;
    #lastError: string | undefined;
    #restarting = false;
    #watcher: { close(): void } | undefined;
    #watchTimer: NodeJS.Timeout | undefined;

    constructor(options: RestartOptions) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
        this.startedAt = this.#now();
        this.#atStart = hashes(serverFiles(options.appRoot));
        this.#launcherAtStart = hashes(launcherFiles(options.appRoot));
        this.#commitAtStart = commit(options.appRoot);

        if (options.watch !== false) {
            this.#watch();
        }
    }

    #watch(): void {
        try {
            this.#watcher = watch(
                join(this.#options.appRoot, "src"),
                { recursive: true },
                (_event, name) => {
                    // Extension modules load again by themselves; the web app is not under src/.
                    if (name?.toString().startsWith(`server${sep}extensions${sep}`)) {
                        return;
                    }

                    clearTimeout(this.#watchTimer);
                    this.#watchTimer = setTimeout(() => this.refresh(), 500);
                },
            );
        } catch {
            // No recursive watch here: the status is compared when someone asks.
        }
    }

    /** Compare the code with what this process started on again, and tell the owner when that changed. */
    refresh(): void {
        const before = JSON.stringify(this.#compared);

        this.#compare();

        if (JSON.stringify(this.#compared) !== before) {
            this.#options.changed(this.status());
        }
    }

    #compare() {
        const root = this.#options.appRoot;

        this.#compared = {
            changed: differences(this.#atStart, hashes(serverFiles(root))).map((file) =>
                relative(root, file),
            ),
            launcherChanged:
                differences(this.#launcherAtStart, hashes(launcherFiles(root))).length > 0,
            commitNow: commit(root),
        };

        return this.#compared;
    }

    #method(): RestartStatus["method"] {
        if (this.#options.command().trim() !== "") {
            return "command";
        }

        return this.#options.restart === undefined ? "none" : "launcher";
    }

    status(): RestartStatus {
        const compared = this.#compared ?? this.#compare();
        const method = this.#method();

        return {
            available: method !== "none",
            method,
            command: this.#options.command(),
            startedAt: this.startedAt,
            needed: compared.changed.length > 0,
            changed: compared.changed.slice(0, MAX_LISTED),
            changedCount: compared.changed.length,
            launcherChanged: compared.launcherChanged,
            ...(this.#commitAtStart === undefined ? {} : { commitAtStart: this.#commitAtStart }),
            ...(compared.commitNow === undefined ? {} : { commitNow: compared.commitNow }),
            ...(this.#waiting === undefined
                ? {}
                : { waiting: { since: this.#waiting.since, tools: this.#waiting.tools } }),
            requests: [...this.#requests],
            ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
        };
    }

    #changed(): void {
        this.#options.changed(this.status());
    }

    /**
     * Pi asks for a restart: the owner gets a button for it. The same `id` (the tool call's) asks once, so a call run
     * again after a restart does not ask twice.
     */
    request(id: string, conversationId: number, reason: string): RestartRequest {
        const known = this.#requests.find((each) => each.id === id);

        if (known !== undefined) {
            return known;
        }

        const request: RestartRequest = {
            id,
            conversationId,
            reason: reason.trim().replace(/\s+/g, " ").slice(0, MAX_REASON),
            at: this.#now(),
        };

        this.#requests = [...this.#requests, request].slice(-MAX_REQUESTS);
        this.#options.notice(
            "info",
            `Pi asks for a server restart${request.reason ? `: ${request.reason}` : ""}. Menu → Restart server.`,
        );
        this.#changed();

        return request;
    }

    dismiss(id: string): boolean {
        const before = this.#requests.length;

        this.#requests = this.#requests.filter((each) => each.id !== id);

        if (this.#requests.length === before) {
            return false;
        }

        this.#changed();

        return true;
    }

    /** Stop a restart that waits for tool calls. */
    cancel(): boolean {
        if (this.#waiting === undefined) {
            return false;
        }

        clearTimeout(this.#waiting.timer);
        this.#waiting = undefined;
        this.#changed();

        return true;
    }

    /**
     * Restart: check that the new code loads (unless `force`), then restart at once, or (`idle`) once no tool call
     * runs, waiting `IDLE_LIMIT_MS` at most; it returns when the wait starts. Throws an `HttpError` when nothing can restart this server, or when the
     * new code does not load: this process then goes on serving.
     */
    async restart(options: { when?: "now" | "idle"; force?: boolean } = {}): Promise<void> {
        if (this.#method() === "none") {
            throw new HttpError(
                409,
                "Nothing can restart this server: start it with bin/pi-pocket.js, or set a restart command.",
            );
        }

        if (this.#restarting) {
            return;
        }

        if (options.force !== true) {
            const checked = await checkLoads(this.#options.appRoot);

            if (!checked.ok) {
                this.#lastError = `The new code does not load, so the server did not restart:\n${checked.output}`;
                this.#changed();

                throw new HttpError(409, this.#lastError);
            }
        }

        if (options.when === "idle") {
            this.cancel();
            this.#waiting = { since: this.#now(), tools: 0 };
            this.#changed();
            // It answers once the wait starts: its progress goes out as status changes.
            void this.#waitForIdle();

            return;
        }

        this.#go();
    }

    async #waitForIdle(): Promise<void> {
        const waiting = this.#waiting;

        if (waiting === undefined) {
            return;
        }

        let tools: number;

        try {
            tools = await this.#options.runningTools();
        } catch {
            tools = 0;
        }

        // Cancelled, or a newer wait, while it counted.
        if (this.#waiting !== waiting) {
            return;
        }

        const limit = this.#options.idleLimitMs ?? IDLE_LIMIT_MS;
        const over = this.#now() - waiting.since >= limit;

        if (tools === 0 || over) {
            if (over && tools > 0) {
                this.#options.log(
                    `Restarting after ${limit / 60_000} minutes of waiting, with ${tools} tool calls still running.`,
                );
            }

            this.#waiting = undefined;
            this.#go();

            return;
        }

        if (tools !== waiting.tools) {
            waiting.tools = tools;
            this.#changed();
        }

        waiting.timer = setTimeout(
            () => void this.#waitForIdle(),
            this.#options.idlePollMs ?? IDLE_POLL_MS,
        );
    }

    #go(): void {
        const command = this.#options.command().trim();

        this.#restarting = true;
        this.#requests = [];

        if (command === "") {
            this.#options.log("Restarting through the launcher.");
            // The answer to the request that asked goes out first.
            setTimeout(() => this.#options.restart?.(), 100);

            return;
        }

        this.#options.log(`Restarting with the owner's command: ${command}`);
        // Its own process group, apart from the server's: a command that stops this server does not stop itself.
        const child = spawn("/bin/sh", ["-c", command], {
            cwd: this.#options.appRoot,
            detached: true,
            stdio: ["ignore", "ignore", "pipe"],
        });
        let output = "";

        child.stderr.on("data", (chunk: Buffer) => {
            output = cut(output + chunk.toString("utf8"));
        });
        child.on("error", (error) => this.#failed(error.message));
        child.on("exit", (code) => {
            // A command that restarts the server ends this process before it gets here, or ends well and the stop
            // comes after: only a failure needs words.
            if (code !== 0) {
                this.#failed(output || `The restart command stopped with code ${code}.`);
            }
        });
        child.unref();
    }

    #failed(output: string): void {
        this.#restarting = false;
        this.#lastError = `The restart command failed:\n${cut(output)}`;
        this.#options.notice("error", "The restart command failed: see Menu → Restart server.");
        this.#changed();
    }

    close(): void {
        clearTimeout(this.#watchTimer);
        clearTimeout(this.#waiting?.timer);
        this.#watcher?.close();
    }
}
