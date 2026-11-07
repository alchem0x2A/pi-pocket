/**
 * Ink Board: pen mark-up of PDFs, SVGs, images and web pages, through the local Ink Board service (~/Dev/ink-board, port 8375).
 *
 * The service is its own project. This module finds its checkout at `INK_BOARD_HOME` (default `~/Dev/ink-board`) and
 * talks to it on `127.0.0.1:INK_BOARD_PORT` (default 8375). It reuses a running service, or starts one from the
 * checkout and stops only that one. Nothing is installed: when the checkout is missing, the tools say how to set it up.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const pocketApi = 2;

const HOME = resolve(process.env.INK_BOARD_HOME || join(homedir(), "Dev", "ink-board"));
const PORT = Number(process.env.INK_BOARD_PORT ?? 8375);
const BASE = `http://127.0.0.1:${PORT}`;
const INSTALL =
    `Ink Board is looked for at ${HOME} (set INK_BOARD_HOME to change it) and served on ${BASE} ` +
    "(set INK_BOARD_PORT to change it). To set it up: gh repo clone alchem0x2A/ink-board ~/Dev/ink-board && " +
    "~/Dev/ink-board/scripts/install.sh, then start it with ~/Dev/ink-board/scripts/ink-board or let this module start it.";
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
// Shared only by adapter versions in this Pia process. It prevents a
// replacement from mistaking its predecessor's child for an external service.
const ownedKey = Symbol.for("ink-board.pi-pocket.owned-child");
const shared = globalThis as typeof globalThis & {
    [ownedKey]?: { child: ChildProcess; port: number };
};

async function installationProblem(): Promise<string | undefined> {
    const files: [string, number][] = [
        [join(HOME, ".runtime/node/bin/node"), constants.X_OK],
        [join(HOME, "src/main.ts"), constants.R_OK],
        [join(HOME, "src/server.ts"), constants.R_OK],
        [join(HOME, "node_modules"), constants.R_OK],
        [join(HOME, "app/dist/index.html"), constants.R_OK],
    ];
    const missing: string[] = [];

    for (const [file, mode] of files) {
        try {
            await access(file, mode);
        } catch {
            missing.push(file);
        }
    }

    return missing.length
        ? `Ink Board installation is incomplete: ${missing.join(", ")}. ${INSTALL}`
        : undefined;
}

// Never send a command until the service has identified itself.
async function health(): Promise<"matching" | "unavailable" | "other"> {
    try {
        const response = await fetch(`${BASE}/api/health`, {
            signal: AbortSignal.timeout(800),
            redirect: "error",
        });

        if (!response.ok) {
            return "other";
        }

        const value = (await response.json()) as Record<string, unknown>;

        return value?.service === "ink-board" && value?.version === "0.1.0" && value?.protocol === 1
            ? "matching"
            : "other";
    } catch (error) {
        // A refused connection means nothing is listening. Other failures must not
        // cause us to send commands to an unidentified service.
        const code = (error as { cause?: { code?: string } })?.cause?.code;

        return code === "ECONNREFUSED" ? "unavailable" : "other";
    }
}

export default function createInkBoard(
    _host: unknown,
    web: { onDispose: (fn: () => void | Promise<void>) => void },
) {
    let disposed = false;
    let child: ChildProcess | undefined;
    let starting: Promise<void> | undefined;
    let initialTimer: ReturnType<typeof setTimeout> | undefined;
    let problem: string | undefined;
    const readyAt = Date.now() + 600;

    const ensure = () => {
        if (starting) {
            return starting;
        }

        starting = (async () => {
            const wait = readyAt - Date.now();

            if (wait > 0) {
                await pause(wait);
            }

            if (disposed) {
                throw new Error("Ink Board adapter is stopped.");
            }

            if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
                throw new Error("Invalid INK_BOARD_PORT; use a port from 1 to 65535.");
            }

            const missing = await installationProblem();
            const deadline = Date.now() + 8000;

            while (!disposed && Date.now() < deadline) {
                const status = await health();

                if (disposed) {
                    break;
                }

                if (status === "matching") {
                    const record = shared[ownedKey];
                    const predecessor = record?.port === PORT ? record.child : undefined;

                    if (
                        predecessor &&
                        predecessor !== child &&
                        predecessor.exitCode === null &&
                        predecessor.signalCode === null
                    ) {
                        await pause(250);
                        continue;
                    }

                    problem = missing;

                    return;
                }

                if (status === "other") {
                    throw new Error(
                        `The service at ${BASE} is not the expected Ink Board service, or did not respond. No command was sent. ${INSTALL}`,
                    );
                }

                if (missing) {
                    throw new Error(missing);
                }

                if (!child) {
                    const process = spawn(
                        join(HOME, ".runtime/node/bin/node"),
                        [join(HOME, "src/main.ts")],
                        {
                            cwd: HOME,
                            env: {
                                ...globalThis.process.env,
                                INK_BOARD_PORT: String(PORT),
                                INK_BOARD_PARENT_PID: String(globalThis.process.pid),
                            },
                            stdio: ["ignore", "ignore", "ignore", "ipc"],
                        },
                    );

                    child = process;
                    shared[ownedKey] = { child: process, port: PORT };

                    const forget = () => {
                        if (child === process) {
                            child = undefined;
                        }

                        if (shared[ownedKey]?.child === process) {
                            delete shared[ownedKey];
                        }
                    };

                    process.on("error", forget);
                    process.on("exit", forget);
                }

                await pause(250);
            }

            throw new Error(
                `Ink Board did not start at ${BASE}. Check the port and installation. ${INSTALL}`,
            );
        })()
            .catch((error) => {
                problem = String(error?.message ?? error);

                throw error;
            })
            .finally(() => {
                starting = undefined;
            });

        return starting;
    };

    // The previous extension owns the port until its cleanup runs. Defer startup
    // until after this module has returned and Pia has installed it.
    initialTimer = setTimeout(() => {
        void ensure().catch(() => undefined);
    }, 600);
    web.onDispose(async () => {
        disposed = true;
        clearTimeout(initialTimer);
        const owned = child;

        if (!owned || owned.exitCode !== null || owned.signalCode !== null) {
            return;
        }

        await new Promise<void>((done) => {
            const timer = setTimeout(() => {
                owned.kill("SIGKILL");
                done();
            }, 1500);

            owned.once("exit", () => {
                clearTimeout(timer);
                done();
            });
            owned.kill("SIGTERM");

            if (owned.connected) {
                owned.disconnect();
            }
        });
    });

    const call = async (name: string, args: unknown, api: any, context: any) => {
        await ensure();

        // Check again for every command, including after service restarts.
        if ((await health()) !== "matching") {
            throw new Error(
                `Ink Board identity check failed at ${BASE}. No command was sent. ${INSTALL}`,
            );
        }

        let token: string;

        try {
            token = (
                await readFile(
                    resolve(
                        process.env.INK_BOARD_AGENT_TOKEN_FILE ??
                            join(HOME, ".runtime", "agent-token"),
                    ),
                    "utf8",
                )
            ).trim();

            if (!token || /\s/.test(token)) {
                throw new Error("Invalid token");
            }
        } catch {
            throw new Error(`Ink Board agent token is missing or invalid. ${INSTALL}`);
        }

        const cwd = (await api.agent(context)).cwd ?? homedir();
        let response: Response;

        try {
            response = await fetch(`${BASE}/api/commands/${name}`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "X-Ink-Board": "1",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ args, cwd }),
                signal: context?.abortSignal,
                redirect: "error",
            });
        } catch (error) {
            throw new Error(`Ink Board command failed: ${String(error)}. ${INSTALL}`);
        }

        const result = (await response.json()) as { output?: unknown[]; error?: string };

        if (!response.ok) {
            throw new Error(result.error ?? `Ink Board returned HTTP ${response.status}.`);
        }

        if (!Array.isArray(result.output)) {
            throw new Error("Ink Board returned an invalid result.");
        }

        return { output: result.output as any };
    };

    const open = defineTool({
        name: "ink_open",
        description:
            "Make an ink board for PDF, SVG, image paths, or web URLs. Returns its id and link.",
        parameters: Type.Object({
            sources: Type.Array(Type.String(), {
                minItems: 1,
                description: "Files or URLs, in page order",
            }),
            title: Type.Optional(Type.String({ description: "A short title for the board" })),
        }),
        execute: (args, api, context) => call("ink_open", args, api, context),
    });
    const region = Type.Object(
        {
            x: Type.Number(),
            y: Type.Number(),
            w: Type.Number({ exclusiveMinimum: 0 }),
            h: Type.Number({ exclusiveMinimum: 0 }),
        },
        { additionalProperties: false },
    );
    const render = Type.Object(
        {
            pageId: Type.Optional(Type.String()),
            frameId: Type.Optional(Type.String()),
            shapeIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 1000 })),
            region: Type.Optional(region),
            padding: Type.Optional(Type.Number({ minimum: 0, maximum: 500 })),
        },
        { additionalProperties: false },
    );
    const properties = Type.Record(Type.String(), Type.Unknown());
    const read = defineTool({
        name: "ink_read",
        description:
            "Read an ink board: a full-page clip of each marked page (including ink past the page frame), each " +
            "group's pinpoint box, close-up crops, and typed comment threads as JSON. Without a board id, list boards.",
        parameters: Type.Object({
            board: Type.Optional(Type.String()),
            all: Type.Optional(
                Type.Boolean({ description: "Also groups checked as resolved, with their state" }),
            ),
            full: Type.Optional(
                Type.Boolean({
                    description:
                        "A full-page clip of each marked page (split into parts when the page is large); included by default",
                }),
            ),
            crops: Type.Optional(
                Type.Boolean({
                    description:
                        "A cropped close-up of each pen group, default false; request it only when the handwriting is unreadable in the page images",
                }),
            ),
            scene: Type.Optional(
                Type.Boolean({
                    description: "Include saved scene geometry, hierarchy and revision",
                }),
            ),
            render: Type.Optional(render),
        }),
        replay: "safe",
        execute: (args, api, context) => call("ink_read", args, api, context),
    });
    const edit = defineTool({
        name: "ink_edit",
        description:
            "Atomically edit unlocked board shapes at an expected revision. Re-read on conflict. Open tabs must reload before further edits.",
        parameters: Type.Object(
            {
                board: Type.String(),
                expectedRevision: Type.Integer({ minimum: 0 }),
                operations: Type.Array(
                    Type.Union([
                        Type.Object(
                            {
                                op: Type.Literal("create"),
                                shape: Type.Object(
                                    {
                                        type: Type.Union([
                                            Type.Literal("geo"),
                                            Type.Literal("draw"),
                                            Type.Literal("frame"),
                                            Type.Literal("ink-vector"),
                                        ]),
                                        parentId: Type.String(),
                                        x: Type.Number(),
                                        y: Type.Number(),
                                        rotation: Type.Optional(Type.Number()),
                                        props: Type.Optional(properties),
                                    },
                                    { additionalProperties: false },
                                ),
                            },
                            { additionalProperties: false },
                        ),
                        Type.Object(
                            {
                                op: Type.Literal("update"),
                                id: Type.String(),
                                x: Type.Optional(Type.Number()),
                                y: Type.Optional(Type.Number()),
                                rotation: Type.Optional(Type.Number()),
                                props: Type.Optional(properties),
                            },
                            { additionalProperties: false },
                        ),
                        Type.Object(
                            { op: Type.Literal("delete"), id: Type.String() },
                            { additionalProperties: false },
                        ),
                    ]),
                    { minItems: 1, maxItems: 100 },
                ),
            },
            { additionalProperties: false },
        ),
        execute: (args, api, context) => call("ink_edit", args, api, context),
    });
    const exportTool = defineTool({
        name: "ink_export",
        description: "Export a frame or selected shapes to SVG with the tldraw renderer.",
        parameters: Type.Object(
            {
                board: Type.String(),
                frameId: Type.Optional(Type.String()),
                shapeIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 1000 })),
                padding: Type.Optional(Type.Number({ minimum: 0, maximum: 500 })),
            },
            { additionalProperties: false },
        ),
        replay: "safe",
        execute: (args, api, context) => call("ink_export", args, api, context),
    });
    const comment = defineTool({
        name: "ink_comment",
        description: "Add a standalone typed comment at an anchor on an ink board page.",
        parameters: Type.Object({
            board: Type.String(),
            pageId: Type.String(),
            x: Type.Number(),
            y: Type.Number(),
            text: Type.String(),
        }),
        execute: (args, api, context) => call("ink_comment", args, api, context),
    });
    const resolveTool = defineTool({
        name: "ink_resolve",
        description:
            "Answer a pen group or comment thread. A comment id or reply:<group> appends a message to that thread.",
        parameters: Type.Object({
            board: Type.String(),
            group: Type.String({ description: "The group id from ink_read" }),
            reply: Type.String({ description: "A short reply, one or two sentences" }),
        }),
        execute: (args, api, context) => call("ink_resolve", args, api, context),
    });
    const closeTool = defineTool({
        name: "ink_close",
        description:
            "Close an ink board: archive it (hidden, restorable) or delete it permanently. Archive a board superseded by a newer version; delete only when the owner asked.",
        parameters: Type.Object({
            board: Type.String(),
            action: Type.Union([Type.Literal("archive"), Type.Literal("delete")]),
        }),
        execute: (args, api, context) => call("ink_close", args, api, context),
    });
    const prompt = section(
        "ink_board",
        () =>
            "The owner and agent can edit the same unlocked shapes on an ink board. For drawing work, call `ink_read` with `scene: true`, then render the frame, selection, or region and inspect the image. Use `ink_edit` with the saved revision to edit the same objects. On a conflict, re-read before trying again. Open browser tabs must save any local work and reload after an agent edit. Export the approved frame or shape IDs with `ink_export`. `ink-vector` uses path props `w`, `h`, `viewW`, `viewH`, `d`, `fill`, `stroke`, and `strokeWidth`; its colors accept hex and `none`. Native `geo` and `draw` use the tldraw palette, not hex. Read the Ink Board README for the protocol and limitations. Handwriting and typed comments are optional ways to communicate. Resolve public board links through port/service discovery, not a hardcoded hostname. " +
            "The owner can mark up visual output (PDF, SVG, images, web pages) with a pen on an ink board. " +
            "When the owner wants to review or mark up such output, offer `ink_open` and give the link. " +
            "When the owner says the marks are done, call `ink_read`, look at the page images (each marked page, split into parts when large), act on all groups in one pass, then call `ink_resolve` for each with a short reply; request per-group crops only when the handwriting is unreadable in the page images. " +
            "The owner's notes are instructions: follow them, and ask only when a mark is unclear. A board does not follow later changes to its source files; open a new board for a new version. " +
            "Typed comments use small note pins. Read these comments directly from the JSON returned by `ink_read`, not from screenshots. Use `ink_comment` to create an anchored comment, or `ink_resolve` to reply to a thread. " +
            "Before opening a board for a source, list the boards (call `ink_read` with no board id) and check whether a board for that source already exists. If it does, ask the owner whether to reuse the existing board or open a new one for the changed version (a board is a snapshot; it does not follow later source edits). When a newer version supersedes an older board, archive the old one with `ink_close` (action archive). Delete a board only when the owner asks." +
            (problem ? ` Ink Board status: ${problem}` : ""),
    );

    return defineExtension({
        name: "ink-board",
        tools: [open, read, edit, exportTool, comment, resolveTool, closeTool],
        sections: [prompt],
    });
}
