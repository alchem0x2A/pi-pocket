/**
 * The assistant profile: Classic (upstream PiP, unchanged) or Pia, an opt-in profile on the same conversation, panel,
 * follows, and session tools. Pia keeps the session tools and adds the normal enabled tools, works in one stable
 * workspace, and reads one shared AGENTS.md whatever its folder is. This module holds the profile's pure parts, so the
 * rest of Pi Pocket changes in a few additive places only.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

export type AssistantProfile = "classic" | "pia";

/** What Pia is called until the owner names it. */
export const PIA_DEFAULT_NAME = "Pia";
/** The longest name the owner can give it. */
export const ASSISTANT_NAME_MAX = 40;
/** The most of the shared AGENTS.md that goes into Pia's prompt. */
const SHARED_MAX = 64 * 1024;

/**
 * Built-in modules whose default is off in the Pia profile. The owner's own choice (on or off) always wins, and the
 * modules themselves do not change.
 */
export const PIA_OFF_BY_DEFAULT: ReadonlySet<string> = new Set(["subagents.ts", "background.ts"]);

/** The profile a config value names; anything else is Classic. */
export function profileOf(value: unknown): AssistantProfile {
    return value === "pia" ? "pia" : "classic";
}

/** A name the owner gave, trimmed to one line; undefined when there is none to keep. */
export function cleanName(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const name = value.replace(/\s+/g, " ").trim();

    return name === "" ? undefined : name.slice(0, ASSISTANT_NAME_MAX);
}

/** The module default for `file` in a profile; undefined: the loader's own default applies. */
export function profileDefault(profile: AssistantProfile, file: string): boolean | undefined {
    return profile === "pia" && PIA_OFF_BY_DEFAULT.has(file) ? false : undefined;
}

/** Pia's stable workspace, in the data folder: shared by every Pia chat, and kept after Start fresh. */
export function piaWorkspace(dataDir: string): string {
    return join(dataDir, "pia");
}

/** The one AGENTS.md every Pia chat reads, whatever its folder. */
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

/** The shared AGENTS.md as Pia's prompt gets it, bounded; undefined when it is missing, empty, or not a file. */
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

/**
 * What the Pia conversation selects: the host's default extensions (every installed one but PiP's, and with the
 * module defaults above), plus PiP's own for the session tools, follows, and prompt. No tool is filtered out: the
 * panel does not draw `artifact_inline` cards, but Open as a conversation does.
 */
export function piaExtensions(pipExtension: string): { add: string[] } {
    return { add: [pipExtension] };
}

/** Whether `folder` is the workspace or inside it: there, the project context already holds the shared AGENTS.md. */
export function inWorkspace(dataDir: string, folder: string | undefined): boolean {
    const workspace = piaWorkspace(dataDir);

    return folder !== undefined && (folder === workspace || folder.startsWith(`${workspace}/`));
}
