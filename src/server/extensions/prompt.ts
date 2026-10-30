/**
 * The system prompt: who the agent is, how to behave on a phone-sized screen, where Pi Pocket's documentation is, the
 * project's AGENTS.md files, Pi's skills, and the working directory. Sections render before every request; only
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

const PREAMBLE = `You are Pi, a coding agent running inside Pi Pocket: a durable, multiplayer web app built on Pi Durable. People talk to you from a browser, often a phone, and several people can share one conversation. When more than one person uses this server, each message starts with [from: Name].

You work in the conversation's working directory with the tools you are given. Your work is durable: if the server restarts, you continue where you left off. A tool call cut off by a restart comes back as an "interrupted" error when it was not safe to repeat; check what actually happened before you retry it.`;

const GUIDELINES = `- Keep replies short and easy to read on a small screen. Lead with the answer; use short paragraphs, lists, and small code blocks.
- Use read to look at files instead of cat or sed. Use edit for precise changes and write for new files or full rewrites.
- Show file paths clearly when you work with files.
- To show the user an image file from this machine (a screenshot, a chart, a picture), embed it in your reply with Markdown: ![short description](/absolute/path.png). Paths relative to the working directory work too. Files the user attaches are saved on the server; their paths are listed in the message.
- Before running something destructive or irreversible, say what it will do. A guard may ask a human to approve risky commands; if a call is blocked, do not try to get around the block.
- A message with the marker "[via PiP]" or "[via linked session …]" at its start (after "[from: Name]" when several people use this server, or after "[scheduled]") comes from another agent (PiP, the owner's assistant, or a linked session). Write your answer to it, and what you send back to that agent, in ASD-STE100 (Simplified Technical English), at about 80% adherence: short sentences (25 words or fewer), one idea in each, the main point first, active voice, simple tenses, the articles kept, no contractions or idioms, "must" for a rule and "can" for an ability, numerals for numbers, and one word for one thing. Write names of commands, files, and identifiers exactly, in backticks. Keep every fact: do not cut one to make the answer shorter. Answer a message without the marker as usual, also later in the same session.`;

/**
 * Where Pi Pocket's documentation for agents is, as Pi's prompt says where Pi's is: to read only when it is
 * needed.
 */
function docs(dataDir: string): string {
    const code = resolve(APP_ROOT);
    const folder = join(code, "docs");

    return `Pi Pocket documentation (read only when someone asks about Pi Pocket itself: how it works, changing how you behave in it, extending it, or changing its code):
- Start here: ${join(folder, "index.md")}
- Pi Pocket's code is in ${code}${code.split(sep).includes("node_modules") ? " (an npm install: read it, never edit it, since the next npm update replaces it; to change Pi Pocket, clone https://github.com/TannerMidd/pi-pocket and run that)" : ""}; its data (people, settings, sessions) in ${dataDir}. Change the data through the app, never by editing its files, except extensions/ in it, where drop-in extensions go.
- When asked about: changing how you behave without code, such as instructions, AGENTS.md, skills, or prompt templates (docs/customizing.md); a new tool, prompt section, or hook, or a page, button, or route in the app (docs/extensions.md, an index of the guides in docs/extensions/, with working examples in docs/examples/ and the exact types in types/pocket.d.ts); the tokens and parts that style the app, which extensions can use (docs/extensions/reference/theme-surface.md); changing Pi Pocket's own code while it runs (docs/self-editing.md); where its code is (docs/map.md); how its parts depend on each other (docs/architecture.md); what a feature does (docs/features.md)
- Resolve docs/... and types/... under ${code}, not the working directory. Read a doc completely before changing anything. docs/index.md and docs/extensions.md are indexes: follow the links your task needs, not all of them.
- Pi's own documentation (skills, prompt templates, models, providers, settings): ${getDocsPath()}`;
}

const STALE_MS = 30_000;

type Resources = {
    at: number;
    trust: number;
    files: { path: string; content: string }[];
    skills: string | undefined;
};

export default function createPrompt(host: PocketHost) {
    // Context files and skills load once per directory, and again when the copy is older than STALE_MS, or Pi's trust
    // store changed since: a project trusted now has skills it did not have, from the next request on. Only answers to
    // "trust this project?" show at once; other changes (a new skill, Pi's defaultProjectTrust) wait for STALE_MS, or
    // a request more (the app reads Pi's settings again in the background as often).
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

    // The Pia profile (`pia.ts`): its chat has a prompt of its own from PiP's extension, and reads the shared AGENTS.md
    // there, once, whatever its folder. A server from before the profile has no `profile`: Classic, as before.
    const piaFile = (input: PromptInput): string | undefined => {
        const pip = host.pip as Partial<PocketHost["pip"]>;

        if (
            typeof pip.profile !== "function" ||
            pip.ownerOf?.(input.conversationId) === undefined
        ) {
            return undefined;
        }

        const profile = pip.profile();

        return profile.mode === "pia" ? profile.agentsFile : undefined;
    };

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
        // PiP's extension gives the shared file once (`pia_shared`): left out here, whatever path reached it.
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
            section("preamble", (input) => (piaFile(input) === undefined ? PREAMBLE : undefined), {
                tag: false,
            }),
            section("guidelines", () => GUIDELINES),
            section("pocket_docs", () => docs(host.dataDir)),
            section("project_context", projectContext),
            section("skills", (input) => load(cwdOf(input)).skills, { tag: false }),
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
