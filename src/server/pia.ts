/** Assistant naming and its shared workspace. */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

/** The default name, unless the owner sets another name. */
export const PIA_DEFAULT_NAME = "Pia";
/** The longest name the owner can give the assistant. */
export const ASSISTANT_NAME_MAX = 40;
const SHARED_MAX = 64 * 1024;

/** A name the owner gave, trimmed to one line; undefined when there is none to keep. */
export function cleanName(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const name = value.replace(/\s+/g, " ").trim();

    return name === "" ? undefined : name.slice(0, ASSISTANT_NAME_MAX);
}

/** The shared workspace for the owner's assistant, kept after Start fresh. */
export function piaWorkspace(dataDir: string): string {
    return join(dataDir, "pia");
}

/** The one AGENTS.md every assistant chat reads, whatever its folder. */
export function piaAgentsFile(dataDir: string): string {
    return join(piaWorkspace(dataDir), "AGENTS.md");
}

const STARTER = `# Pia

Standing instructions for Pia, the owner's assistant. Every Pia chat reads this file, whatever its working folder is.
Edit it to change how Pia works.

- Keep lasting notes and files in this folder.
- Put temporary files in /tmp, not here.
`;

/** Make the workspace and a starter AGENTS.md; never replace a file that exists. */
export function ensurePiaWorkspace(dataDir: string): string {
    const folder = piaWorkspace(dataDir);

    mkdirSync(folder, { recursive: true, mode: 0o700 });

    try {
        const fd = openSync(piaAgentsFile(dataDir), "wx", 0o600);

        try {
            writeSync(fd, STARTER);
        } finally {
            closeSync(fd);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }
    }

    return folder;
}

/** The shared AGENTS.md as the assistant prompt gets it, bounded; undefined when it is missing, empty, or not a file. */
export function readShared(dataDir: string): string | undefined {
    const file = piaAgentsFile(dataDir);

    try {
        if (!statSync(file).isFile()) {
            return undefined;
        }

        const text = readFileSync(file, "utf8").slice(0, SHARED_MAX).trim();

        return text === "" ? undefined : `<file path="${file}">\n${text}\n</file>`;
    } catch {
        return undefined;
    }
}

/** Whether `folder` is the workspace or inside it. */
export function inWorkspace(dataDir: string, folder: string | undefined): boolean {
    const workspace = piaWorkspace(dataDir);

    return folder !== undefined && (folder === workspace || folder.startsWith(`${workspace}/`));
}
