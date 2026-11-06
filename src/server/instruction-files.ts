/**
 * the agent's context files: the files its resource loader reads from the agent directory and from each session's folder chain.
 * The owner can see and edit these files from Settings. Memory lessons are durable documents in `pocket.sqlite`, not files.
 */
import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import { join, resolve } from "node:path";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";
import { piaAgentsFile } from "./pia.ts";

const MAX_FILE = 512 * 1024;

export type InstructionFile = {
    path: string;
    content: string;
    exists: boolean;
    editable: boolean;
};

function requireOwner(user: User): void {
    if (user.role !== "owner") {
        throw new HttpError(403, "Only the owner can edit instruction files.");
    }
}

function filesFor(app: PocketApp, user: User): Map<string, string> {
    requireOwner(user);

    const agentDir = getAgentDir();
    const files = new Map<string, string>();

    const add = (path: string, content = "") => {
        files.set(path, content);
    };

    // Show the standard global file even when it does not exist yet.
    add(join(resolve(agentDir), "AGENTS.md"));

    const folders = new Set([
        app.defaultCwd,
        ...app.sessions(user).map((session) => app.cwdOf(session.id as unknown as ConversationId)),
    ]);

    for (const cwd of folders) {
        try {
            for (const file of loadProjectContextFiles({ cwd, agentDir })) {
                add(file.path, file.content);
            }
        } catch {
            // A removed or unreadable session folder does not hide the other instruction files.
        }

        // Let the owner create a top-level project file when the agent has no context file there yet.
        add(join(resolve(cwd), "AGENTS.md"));
    }

    add(piaAgentsFile(app.dataDir));

    return files;
}

function fileView(path: string, loaded: string): InstructionFile {
    try {
        const stats = lstatSync(path);

        if (!stats.isFile() || stats.isSymbolicLink()) {
            return { path, content: loaded, exists: true, editable: false };
        }

        if (stats.size > MAX_FILE) {
            return { path, content: "", exists: true, editable: false };
        }

        return {
            path,
            content: readFileSync(path, "utf8"),
            exists: true,
            editable: true,
        };
    } catch {
        return { path, content: loaded, exists: false, editable: true };
    }
}

/** The owner's memory database path and each context file the agent can load from current session folders. */
export function instructionFiles(app: PocketApp, user: User) {
    const files = [...filesFor(app, user)]
        .map(([path, content]) => fileView(path, content))
        .sort((a, b) => a.path.localeCompare(b.path));

    return { memoryPath: join(resolve(app.dataDir), "pocket.sqlite"), files };
}

/** Save one listed context file, without following a link or accepting an arbitrary path. */
export function saveInstructionFile(
    app: PocketApp,
    user: User,
    path: unknown,
    content: unknown,
): void {
    if (typeof path !== "string" || typeof content !== "string") {
        throw new HttpError(400, "Send a file path and text.");
    }

    if (Buffer.byteLength(content, "utf8") > MAX_FILE) {
        throw new HttpError(413, "Instruction files can be up to 512 KB.");
    }

    const allowed = filesFor(app, user);

    if (!allowed.has(path)) {
        throw new HttpError(404, "That instruction file is not available.");
    }

    try {
        const stats = lstatSync(path);

        if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_FILE) {
            throw new HttpError(409, "This instruction file cannot be edited safely.");
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error instanceof HttpError
                ? error
                : new HttpError(409, "This instruction file cannot be opened safely.");
        }
    }

    let fd: number;

    try {
        fd = openSync(
            path,
            constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_TRUNC |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK,
            0o600,
        );
    } catch {
        throw new HttpError(409, "This instruction file cannot be opened safely.");
    }

    try {
        if (!fstatSync(fd).isFile()) {
            throw new HttpError(409, "This instruction path is not a regular file.");
        }

        writeFileSync(fd, content, "utf8");
    } finally {
        closeSync(fd);
    }
}
