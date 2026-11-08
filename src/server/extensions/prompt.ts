/**
 * The system prompt: who the agent is, how to behave on a phone-sized screen, where Pia's documentation is, the
 * project's AGENTS.md files, the agent's skills, and the working directory. Sections render before every request; only
 * changed sections are sent again, so everything here is stable between requests unless a file on disk changed.
 *
 * Edit freely: saving this file reloads it into the running server.
 */
import { realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
    formatSkillsForPrompt,
    getDocsPath,
    loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import { APP_ROOT } from "../config.ts";
import type { PocketHost } from "../host.ts";

const PREAMBLE = `You are the coding agent working inside Pia: a durable, multiplayer web app built on Pi Durable. People talk to you from a browser, often a phone, and several people can share one conversation. When more than one person uses this server, each message starts with [from: Name].

You work in the conversation's working directory with the tools you are given. Your work is durable: if the server restarts, you continue where you left off. A tool call cut off by a restart comes back as an "interrupted" error when it was not safe to repeat; check what actually happened before you retry it.`;

const GUIDELINES = `- Keep replies short and easy to read on a small screen. Lead with the answer; use short paragraphs, lists, and small code blocks.
- Use read to look at files instead of cat or sed. Use edit for precise changes and write for new files or full rewrites.
- Show file paths clearly when you work with files.
- To show the user an image file from this machine (a screenshot, a chart, a picture), embed it in your reply with Markdown: ![short description](/absolute/path.png). Paths relative to the working directory work too. Files the user attaches are saved on the server; their paths are listed in the message.
- Before running something destructive or irreversible, say what it will do. A guard may ask a human to approve risky commands; if a call is blocked, do not try to get around the block.
- A message with the marker "[via Pia]" or "[via linked session …]" at its start (after "[from: Name]" when several people use this server, or after "[scheduled]") comes from another agent (Pia, the owner's assistant, or a linked session). Write your answer to it, and what you send back to that agent, in ASD-STE100 (Simplified Technical English), at about 80% adherence: short sentences (25 words or fewer), one idea in each, the main point first, active voice, simple tenses, the articles kept, no contractions or idioms, "must" for a rule and "can" for an ability, numerals for numbers, and one word for one thing. Write names of commands, files, and identifiers exactly, in backticks. Keep every fact: do not cut one to make the answer shorter. Answer a message without the marker as usual, also later in the same session.`;

/**
 * Where Pia's documentation for agents is, as the agent's prompt says where the agent's is: to read only when it is
 * needed.
 */
function docs(dataDir: string): string {
    const code = resolve(APP_ROOT);
    const folder = join(code, "docs");

    return `Pia documentation (read only when someone asks about Pia itself: how it works, changing how you behave in it, extending it, or changing its code):
- Start here: ${join(folder, "index.md")}
- Pia's code is in ${code}${code.split(sep).includes("node_modules") ? " (an npm install: read it, never edit it, since the next npm update replaces it; to change Pia, clone https://github.com/TannerMidd/pi-pocket and run that)" : ""}; its data (people, settings, sessions) in ${dataDir}. Change the data through the app, never by editing its files, except extensions/ in it, where drop-in extensions go.
- When asked about: changing how you behave without code, such as instructions, AGENTS.md, skills, or prompt templates (docs/customizing.md); a new tool, prompt section, or hook, or a page, button, or route in the app (docs/extensions.md, an index of the guides in docs/extensions/, with working examples in docs/examples/ and the exact types in types/pocket.d.ts); the tokens and parts that style the app, which extensions can use (docs/extensions/reference/theme-surface.md); changing Pia's own code while it runs (docs/self-editing.md); where its code is (docs/map.md); how its parts depend on each other (docs/architecture.md); what a feature does (docs/features.md)
- Resolve docs/... and types/... under ${code}, not the working directory. Read a doc completely before changing anything. docs/index.md and docs/extensions.md are indexes: follow the links your task needs, not all of them.
- the agent's own documentation (skills, prompt templates, models, providers, settings): ${getDocsPath()}`;
}

/**
 * The lean start prompt of a normal session (not Pia's): one line about where the agent runs and how to answer, then
 * pointers. The tools carry the rest; skills, guides, and documentation come on demand. `PI_POCKET_LEAN_PROMPT=off`
 * restores the full prompt.
 */
const isLean = () => process.env.PI_POCKET_LEAN_PROMPT !== "off";

const LEAN_PREAMBLE = `You are a coding agent in Pia, a multiplayer web app built on Pi Durable. People often read on a phone: keep replies short and lead with the answer. With several people, each message starts with [from: Name]. Before a destructive step, say what it will do; never work around a blocked call. Show an image file with ![alt](/path.png).
Answer a message that starts with [via Pia] or [via linked session …] in ASD-STE100 (Simplified Technical English), and keep every fact.`;

/** Pointers to what comes on demand: project instructions by path, Pia's documentation. */
function leanPointers(dataDir: string, files: { path: string }[]): string {
    const code = resolve(APP_ROOT);
    const lines = [
        ...files.map(
            (file) => `- Instructions for this project; read before you change files: ${file.path}`,
        ),
        `- Questions about Pia itself: ${join(code, "docs", "index.md")} (data: ${dataDir}; change it through the app)`,
    ];

    return lines.join("\n");
}

const STALE_MS = 30_000;

type Resources = {
    at: number;
    trust: number;
    files: { path: string; content: string }[];
    skills: string | undefined;
};

export default function createPrompt(host: PocketHost) {
    // Context files and skills load once per directory, and again when the copy is older than STALE_MS, or the agent's trust
    // store changed since: a project trusted now has skills it did not have, from the next request on. Only answers to
    // "trust this project?" show at once; other changes (a new skill, the agent's defaultProjectTrust) wait for STALE_MS, or
    // a request more (the app reads the agent's settings again in the background as often).
    const resources = new Map<string, Resources>();

    const trustChanged = () => {
        try {
            return statSync(join(host.agentDir, "trust.json")).mtimeMs;
        } catch {
            return 0;
        }
    };

    const load = (cwd: string): Resources => {
        const cached = resources.get(cwd);
        const trust = trustChanged();

        if (cached !== undefined && Date.now() - cached.at < STALE_MS && cached.trust === trust) {
            return cached;
        }

        let files: { path: string; content: string }[] = [];
        let skills: string | undefined;

        try {
            files = loadProjectContextFiles({ cwd, agentDir: host.agentDir });
        } catch (error) {
            host.notice("warning", `Could not load AGENTS.md files for ${cwd}: ${String(error)}`);
        }

        try {
            const text = formatSkillsForPrompt(host.skills(cwd), "read").trim();

            skills = text === "" ? undefined : text;
        } catch (error) {
            host.notice("warning", `Could not load skills for ${cwd}: ${String(error)}`);
        }

        const fresh = { at: Date.now(), trust, files, skills };

        resources.set(cwd, fresh);

        return fresh;
    };

    const cwdOf = (input: PromptInput) => input.env?.cwd ?? input.agent.cwd ?? process.cwd();

    // Pia uses one shared AGENTS.md, independent of the current folder.
    const piaFile = (input: PromptInput): string | undefined => {
        if (host.pia.ownerOf?.(input.conversationId) === undefined) {
            return undefined;
        }

        return `${host.pia.workspace()}/AGENTS.md`;
    };

    // Pia keeps its full prompt; only normal sessions are lean.
    const lean = (input: PromptInput) => isLean() && piaFile(input) === undefined;

    const projectContext = (input: PromptInput): string | undefined => {
        const shared = piaFile(input);
        const { files } = load(cwdOf(input));

        const real = (path: string) => {
            try {
                return realpathSync(path);
            } catch {
                return resolve(path);
            }
        };

        const skip = shared === undefined ? undefined : real(shared);
        // Pia's extension gives the shared file once (`pia_shared`): left out here, whatever path reached it.
        const kept = skip === undefined ? files : files.filter((file) => real(file.path) !== skip);

        return kept.length === 0
            ? undefined
            : kept
                  .map((file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`)
                  .join("\n\n");
    };

    return defineExtension({
        name: "pocket-prompt",
        sections: [
            section(
                "preamble",
                (input) =>
                    piaFile(input) !== undefined
                        ? undefined
                        : lean(input)
                          ? LEAN_PREAMBLE
                          : PREAMBLE,
                { tag: false },
            ),
            section("guidelines", (input) => (lean(input) ? undefined : GUIDELINES)),
            section("pocket_docs", (input) => (lean(input) ? undefined : docs(host.dataDir))),
            section("project_context", (input) =>
                lean(input) ? undefined : projectContext(input),
            ),
            // A lean session finds skills with tool_search (`local-tools.ts`), not in the prompt.
            section("skills", (input) => (lean(input) ? undefined : load(cwdOf(input)).skills), {
                tag: false,
            }),
            section("on_demand", (input) => {
                if (!lean(input)) {
                    return undefined;
                }

                const shared = piaFile(input);
                const { files } = load(cwdOf(input));

                return leanPointers(
                    host.dataDir,
                    shared === undefined ? files : files.filter((file) => file.path !== shared),
                );
            }),
            section("environment", (input) => {
                const base = `Working directory: ${cwdOf(input)}\nPlatform: ${process.platform}`;

                // Off by default: a date in the system prompt changes once a day and rewrites the whole prompt cache.
                // PI_POCKET_PROMPT_DATE=1 adds the local date back.
                if (process.env.PI_POCKET_PROMPT_DATE !== "1") {
                    return base;
                }

                const now = new Date();
                const pad = (n: number) => String(n).padStart(2, "0");

                return `${base}\nToday: ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
            }),
        ],
    });
}
