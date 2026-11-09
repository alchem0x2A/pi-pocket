/**
 * Local session tool policy: a small initial set, with tool_search for discovery and tool_load for explicit loading.
 * This registry view leaves the upstream registry, extension loader, execution environment, and Pia unchanged.
 */
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
    defineExtension,
    defineTool,
    section,
    type ConversationId,
    type Extension,
    type RegistryReader,
    type RegistrySnapshot,
    type PromptSection,
    type ToolRegistration,
    type Wrap,
} from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import {
    createToolSearchTool,
    type ToolSearchToolDetails,
} from "@earendil-works/pi-durable/tool-search";

const POLICY = "pocket-local-tools";
/** Offered from the start. The note tools too: the prompt tells the agent to search notes before it acts. */
const BASE = new Set([
    "read",
    "write",
    "bash",
    "ls",
    "rg",
    "tool_search",
    "tool_load",
    "note_search",
    "note_load",
]);

/** Local catalog metadata, not an upstream ToolRegistration or MCP field. */
export type CatalogTool = ToolRegistration & { readonly shortDescription?: string };

// Keep upstream registrations untouched. New local tools can instead supply shortDescription with Object.assign.
const SHORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
    read: "Read files and images",
    write: "Create or replace files",
    edit: "Apply precise file changes",
    bash: "Execute shell commands",
    ls: "List directory entries",
    rg: "Search file contents",
    tool_search: "Find tools by purpose",
    tool_load: "Load selected tool schemas",
    artifact: "Publish interactive pages and documents",
    artifact_inline: "Embed interactive reply cards",
    browser: "Browse and inspect websites",
    subagent: "Delegate work to background agents",
    team: "Manage linked agent sessions",
    schedule: "Schedule future agent messages",
    background: "Manage background shell commands",
    memory: "Propose notes for approval",
    watch_pr: "Monitor pull requests on GitHub",
    request_restart: "Request Pia server restart",
    design_preview: "Preview designs at screen sizes",
    design_export: "Export designs to files",
    design_system: "Read or write design rules",
    ask_someone: "Request answers from other people",
};
const UNKNOWN_DESCRIPTION = "Search for tool details";

/**
 * The lean start prompt (`extensions/prompt.ts`): short schemas for the base tools, every guide on demand. On by
 * default; `PI_POCKET_LEAN_PROMPT=off` restores the full prompt. With `PI_POCKET_TOOL_DISCOVERY=off` this whole view is
 * bypassed, so no combination of the two switches leaves a session without its sections or its search route.
 */
export const isLean = () => process.env.PI_POCKET_LEAN_PROMPT !== "off";
/** The lean prompt names no file rules, so edit comes from the start too. */
const inBase = (name: string) => BASE.has(name) || (isLean() && name === "edit");

/**
 * Short model-facing declarations of the base tools. The harness validates a call against the offered (lean) schema,
 * then the original execute runs: each lean schema accepts a subset of what the original accepts.
 */
const LEAN_DECLARATIONS: Readonly<Record<string, { description: string; parameters: unknown }>> = {
    read: {
        description:
            "Read a file (text or image). Long text is cut at 2000 lines; use offset and limit.",
        parameters: Type.Object({
            path: Type.String(),
            offset: Type.Optional(Type.Number()),
            limit: Type.Optional(Type.Number()),
        }),
    },
    write: {
        description: "Create or replace a file.",
        parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    },
    edit: {
        description:
            "Replace exact text in a file. Each oldText must be unique in the file and must not overlap another.",
        parameters: Type.Object({
            path: Type.String(),
            edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
        }),
    },
    bash: {
        description:
            "Run a shell command in the working directory. Output is cut at 2000 lines; timeout in seconds.",
        parameters: Type.Object({
            command: Type.String(),
            timeout: Type.Optional(Type.Number()),
        }),
    },
    tool_search: {
        description: "Find optional tools by task or name. Loads nothing.",
        parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
    },
    tool_load: {
        description: "Load tools by exact name; they work from the next step on.",
        parameters: Type.Object({
            names: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
        }),
    },
    note_search: {
        description:
            "Search notes from earlier sessions (facts, rules, preferences) at the start of a task. Notes can be out of date.",
        parameters: Type.Object({
            query: Type.String(),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        }),
    },
    note_load: {
        description: "Read whole notes by id.",
        parameters: Type.Object({
            ids: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
        }),
    },
    ls: {
        description: "List a directory.",
        parameters: Type.Object({
            path: Type.Optional(Type.String()),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
        }),
    },
};

/**
 * The lean model-facing declaration of a base tool. The harness validates a call against the offered declaration,
 * and the original execute still gets the same arguments.
 */ function leanDeclaration(tool: ToolRegistration): ToolRegistration {
    const lean = LEAN_DECLARATIONS[tool.name];

    return lean === undefined
        ? tool
        : ({
              ...tool,
              description: lean.description,
              parameters: lean.parameters,
          } as ToolRegistration);
}

/** Ignore invalid metadata instead of truncating its meaning. A catalog must remain compact and single-line. */
function shortDescription(tool: CatalogTool): string {
    const summary = tool.shortDescription;

    if (typeof summary === "string") {
        const normalized = summary.replace(/\s+/g, " ").trim();

        if (normalized !== "" && normalized.length <= 80 && normalized.split(" ").length <= 5) {
            return normalized;
        }
    }

    return Object.hasOwn(SHORT_DESCRIPTIONS, tool.name)
        ? SHORT_DESCRIPTIONS[tool.name]!
        : UNKNOWN_DESCRIPTION;
}

/**
 * Whether a conversation is the one long-running Pia chat. It is decided by the stored identity of the conversation
 * (who its assistant is), never by the tools it happens to have: a tool name is not an identity, and an excluded or
 * renamed tool must not change the prompt. `prompt.ts` uses the same check.
 */
export type PiaIdentity = (conversationId: ConversationId) => boolean;

function availableTools(isPiaChat: PiaIdentity): PromptSection {
    return section("available_tools", (input) => {
        if (isLean() && !isPiaChat(input.conversationId)) {
            // Names only, of the tools not offered yet: the offered ones carry their own schemas. Skills are not
            // tools: the prompt points to the skill directories, and tool_search finds no skills.
            const offered = new Set(input.agent.tools.map((tool) => tool.name));
            const names = [...new Set(input.agent.deferred.map((tool) => tool.name))]
                .filter((name) => !offered.has(name))
                .sort((a, b) => a.localeCompare(b));

            return names.length === 0
                ? undefined
                : `Load with tool_load when needed: ${names.join(", ")}.`;
        }

        const tools = new Map(
            [...input.agent.tools, ...input.agent.deferred].map((tool) => [tool.name, tool]),
        );

        return [...tools.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((tool) => `- \`${tool.name}\`: ${shortDescription(tool)}`)
            .join("\n");
    });
}

// Only known tool guides are lazy. Unknown extensions can mix tools with standing policy or project context.
const LAZY_GUIDES = new Set([
    "pocket-artifacts",
    "pocket-browser",
    "pocket-subagents",
    "pocket-agent-teams",
    "pocket-schedules",
    "pocket-background",
    "pocket-codemode",
    "pocket-design",
]);
/** In the lean prompt, these guides wait for their tools too. Memory's rules move into note_search and memory. */
const LEAN_LAZY_GUIDES = new Set(["ink-board", "pocket-inbox-notes", "pocket-memory"]);

/** Probe once at startup. Execution still uses the conversation's environment, never a separate shell or cwd. */
export async function hasRipgrep(): Promise<boolean> {
    for (const folder of (process.env.PATH ?? "").split(delimiter)) {
        try {
            const executable = join(folder, process.platform === "win32" ? "rg.exe" : "rg");

            await access(executable, constants.X_OK);

            if ((await stat(executable)).isFile()) {
                return true;
            }
        } catch {
            // Try the next PATH entry.
        }
    }

    return false;
}

function directoryTool(): ToolRegistration {
    return Object.assign(
        defineTool({
            name: "ls",
            description:
                "List a directory, including hidden entries. Paths use the session working directory. Output is bounded.",
            parameters: Type.Object({
                path: Type.Optional(Type.String()),
                limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
            }),
            replay: "safe",
            async execute({ path = ".", limit = 200 }, api, context) {
                if (api.env === undefined) {
                    throw new Error("ls needs a file system environment.");
                }

                const absolute = getOrThrow(await api.env.absolutePath(path, context));
                const reader = getOrThrow(await api.env.openDirReader(absolute, context));

                try {
                    const page = getOrThrow(await reader.next(limit + 1, context));
                    const entries = page.entries.slice(0, limit);
                    const more = page.entries.length > limit || !page.done;
                    const text = entries
                        .map(
                            (entry) =>
                                `${JSON.stringify(entry.name)}${entry.kind === "directory" ? "/" : entry.kind === "symlink" ? "@" : ""}`,
                        )
                        .join("\n");

                    return {
                        output: [
                            {
                                type: "text",
                                text:
                                    (text || "(empty directory)") +
                                    (more
                                        ? "\n[Listing truncated; increase limit or use bash.]"
                                        : ""),
                            },
                        ],
                    };
                } finally {
                    await reader.close(context);
                }
            },
        }),
        { annotations: { readOnlyHint: true } },
    );
}

function ripgrepTool(): ToolRegistration {
    return Object.assign(
        defineTool({
            name: "rg",
            description:
                "Search file contents with ripgrep. Respects ignore files. Returns file names and line numbers. No matches is success.",
            parameters: Type.Object({
                pattern: Type.String(),
                path: Type.Optional(Type.String()),
                glob: Type.Optional(Type.String()),
                ignoreCase: Type.Optional(Type.Boolean()),
            }),
            replay: "safe",
            async execute({ pattern, path = ".", glob, ignoreCase }, api, context) {
                if (api.env === undefined) {
                    throw new Error("rg needs an execution environment.");
                }

                const args = [
                    "rg",
                    "--no-config",
                    "--color=never",
                    "--line-number",
                    "--with-filename",
                    "--max-count=100",
                ];

                if (ignoreCase) {
                    args.push("--ignore-case");
                }

                if (glob !== undefined) {
                    args.push("--glob", glob);
                }

                args.push("--", pattern, path);

                const result = getOrThrow(
                    await api.env.exec(
                        args,
                        {
                            timeout: 10_000,
                            onOutput: (text, _context, info) => api.output(text, info.skipped),
                            spill: { afterBytes: 50_000, afterLines: 2000 },
                            ...(api.outputWindow === undefined ? {} : { window: api.outputWindow }),
                        },
                        context,
                    ),
                );

                if (result.spillPath !== undefined) {
                    api.diagnostic({
                        severity: "info",
                        code: "full_output",
                        message: `Full output: ${result.spillPath}`,
                    });
                }

                return {
                    ...(result.exitCode === 1
                        ? { output: [{ type: "text" as const, text: "No matches." }] }
                        : {}),
                    isError: result.exitCode > 1,
                };
            },
        }),
        { annotations: { readOnlyHint: true } },
    );
}

function discoveryTool(): ToolRegistration {
    const search = createToolSearchTool();

    return Object.assign(
        defineTool({
            name: "tool_search",
            description:
                "Find optional tools by task or exact name. Returns names and short descriptions only; loads nothing. Select relevant names with tool_load. Default 3 matches, maximum 10.",
            parameters: Type.Object({
                query: Type.String({ description: "A task description or exact tool name." }),
                // Keep fractions intact for strict validation; integer schemas can round them.
                limit: Type.Optional(
                    Type.Number({ description: "Maximum matches: integer 1 to 10; default 3." }),
                ),
            }),
            callers: ["model"],
            replay: "safe",
            async execute({ query, limit = 3 }, api, context) {
                query = query.trim();

                if (query === "") {
                    throw new Error("query must not be empty.");
                }

                if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
                    throw new Error("limit must be an integer from 1 to 10.");
                }

                const agent = await api.agent(context);
                const candidates = [...agent.tools, ...agent.deferred];
                const exact = candidates.find((tool) => tool.name === query);
                let names: string[];

                if (exact !== undefined) {
                    names = [exact.name];
                } else {
                    // Reuse upstream ranking, but never return its addTools control or verbose output.
                    // Upstream search only proposes a control; the harness applies returned controls later.
                    const ranked = await search.execute({ query, limit }, api, context);

                    names = (ranked.details as ToolSearchToolDetails).loaded;
                }

                const matches = names.map((name) => {
                    const tool = candidates.find((tool) => tool.name === name)!;
                    const summary = tool.description.replace(/\s+/g, " ").trim();

                    return {
                        name,
                        description: summary.length > 160 ? `${summary.slice(0, 157)}...` : summary,
                        loaded: agent.tools.some((tool) => tool.name === name),
                    };
                });

                const text =
                    matches.length === 0
                        ? "No matching tools found."
                        : "Matches (nothing loaded). Use tool_load for selected names:\n" +
                          matches
                              .map(
                                  (match) =>
                                      `- ${match.name}${match.loaded ? " (already available)" : ""}: ${match.description}`,
                              )
                              .join("\n");

                return {
                    output: [{ type: "text", text }],
                    details: { matches },
                };
            },
        }),
        { annotations: { readOnlyHint: true } },
    );
}

function loadTool(): ToolRegistration {
    return Object.assign(
        defineTool({
            name: "tool_load",
            description:
                "Load explicitly selected tool names, usually from tool_search. Schemas and guides appear on the next model request and stay loaded in this conversation. Unknown or disabled names reject the whole request.",
            parameters: Type.Object({
                names: Type.Array(Type.String(), {
                    minItems: 1,
                    maxItems: 10,
                    description: "Exact tool names to load (1 to 10).",
                }),
            }),
            callers: ["model"],
            replay: "safe",
            async execute({ names }, api, context) {
                if (
                    names.length < 1 ||
                    names.length > 10 ||
                    names.some((name) => name.trim() === "")
                ) {
                    throw new Error("names must contain 1 to 10 nonempty tool names.");
                }

                const selected = [...new Set(names.map((name) => name.trim()))];
                const agent = await api.agent(context);
                const available = new Set(
                    [...agent.tools, ...agent.deferred].map((tool) => tool.name),
                );
                const unknown = selected.filter((name) => !available.has(name));

                if (unknown.length > 0) {
                    throw new Error(
                        `Unknown or disabled tools: ${unknown.join(", ")}. Nothing loaded.`,
                    );
                }

                const offered = new Set(agent.tools.map((tool) => tool.name));
                const loaded = selected.filter((name) => !offered.has(name));
                const text =
                    loaded.length === 0
                        ? "Selected tools are already available."
                        : `Loaded: ${loaded.join(", ")}. Available on the next model request.`;

                return {
                    output: [{ type: "text", text }],
                    details: { loaded },
                    ...(loaded.length === 0 ? {} : { control: { addTools: loaded } }),
                };
            },
        }),
        { annotations: { readOnlyHint: true } },
    );
}

/** Tools of this extension stay offered: Pia's session management must not need discovery first. */
const NEVER_DEFERRED = new Set(["pocket-pip"]);
/** Base tools that a lean session loads only when needed: bash covers them. */
const LEAN_START_DEFERRED = new Set(["ls", "rg"]);

const TASK_FOCUS =
    "Focus on the request this session was given, and finish it; do not start unrelated work.";

/** A synthetic extension exposes local tool discovery. */
function policy(
    snapshot: RegistrySnapshot,
    extras: readonly ToolRegistration[],
    isPiaChat: PiaIdentity,
): Extension {
    const wraps: Wrap[] = [];

    for (const { extension, tool } of snapshot.tools()) {
        if (!inBase(tool.name) && !NEVER_DEFERRED.has(extension.name)) {
            wraps.push({
                tool: tool.name,
                wrap: (original: ToolRegistration) => ({ ...original, deferred: true as const }),
            });
        } else if (isLean() && Object.hasOwn(LEAN_DECLARATIONS, tool.name)) {
            wraps.push({ tool: tool.name, wrap: leanDeclaration });
        }
    }

    for (const extension of snapshot.installed()) {
        const names = extension.tools?.map((tool) => tool.name) ?? [];

        // Lessons, policy, and unknown extension sections stay present even when tools are not loaded.
        const leanOnly = !LAZY_GUIDES.has(extension.name);
        const lazy = !leanOnly || (isLean() && LEAN_LAZY_GUIDES.has(extension.name));

        if (names.length === 0 || !lazy) {
            continue;
        }

        // Memory's guide waits for the memory tool, not for the note tools that are always offered.
        const triggers = extension.name === "pocket-memory" ? ["memory"] : names;

        for (const guide of extension.sections ?? []) {
            wraps.push({
                section: guide.key,
                wrap: (original: PromptSection) => ({
                    ...original,
                    render: (...[input, context]: Parameters<PromptSection["render"]>) =>
                        (leanOnly && isPiaChat(input.conversationId)) ||
                        triggers.some((name) =>
                            input.agent.tools.some((tool) => tool.name === name),
                        )
                            ? original.render(input, context)
                            : undefined,
                }),
            });
        }
    }

    const registered = new Set(snapshot.tools().map(({ tool }) => tool.name));

    // Lean: the local extras get lean declarations too, and ls (bash covers it) waits for tool_load.
    const own = extras
        .filter((tool) => !registered.has(tool.name))
        .map((tool) =>
            !isLean()
                ? tool
                : LEAN_START_DEFERRED.has(tool.name)
                  ? { ...leanDeclaration(tool), deferred: true as const }
                  : leanDeclaration(tool),
        );

    return defineExtension({
        name: POLICY,
        tools: own,
        wraps,
        sections: [
            availableTools(isPiaChat),
            section("tool_discovery", (input) =>
                isLean() && !isPiaChat(input.conversationId)
                    ? undefined
                    : "The available_tools catalog lists enabled tools, not loaded schemas. If a tool's purpose is clear, use tool_load with its exact name; already-offered tools need no loading. If unsure, use tool_search with an exact name or keywords for descriptions, then load only the tools needed for this session. Search loads nothing. tool_load supplies authoritative schemas and guides on the next request; they persist in this conversation. Disabled tools cannot be loaded.",
            ),
            // Task sessions only: the Pia chat, known by its stored identity, gets its own prompt from Pia's extension.
            section("task_focus", (input) =>
                isPiaChat(input.conversationId) ? undefined : TASK_FOCUS,
            ),
        ],
    });
}

/**
 * A cached read-only view follows loader publications without mutating installed extensions or stored agent choices.
 * `PI_POCKET_TOOL_DISCOVERY=off` turns it off for rollback and tests.
 * `isPiaChat` says which conversation is the one long-running Pia chat, by its stored identity: the same check
 * `extensions/prompt.ts` uses.
 */
export function localToolRegistry(
    registry: RegistryReader,
    ripgrep: boolean,
    isPiaChat: PiaIdentity = () => false,
): RegistryReader & { changed(): void } {
    // A local rollback switch also lets legacy scripted-model tests keep their fixed, eager tool manifests.
    if (process.env.PI_POCKET_TOOL_DISCOVERY === "off") {
        return {
            subscribe: (listener) => registry.subscribe(listener),
            snapshot: () => registry.snapshot(),
            changed() {},
        };
    }

    const extras = [
        directoryTool(),
        ...(ripgrep ? [ripgrepTool()] : []),
        discoveryTool(),
        loadTool(),
    ];
    let previous: RegistrySnapshot | undefined;
    let current: RegistrySnapshot;
    const listeners = new Set<() => void>();

    return {
        subscribe(listener) {
            const off = registry.subscribe(listener);

            listeners.add(listener);

            return () => {
                listeners.delete(listener);
                off();
            };
        },
        // Rebuild the cached policy after a registry publication.
        changed() {
            previous = undefined;

            for (const listener of [...listeners]) {
                listener();
            }
        },
        snapshot() {
            const snapshot = registry.snapshot();

            if (snapshot !== previous) {
                const local = policy(snapshot, extras, isPiaChat);

                current = {
                    tasks: () => snapshot.tasks(),
                    task: (name) => snapshot.task(name),
                    installed: () => [...snapshot.installed(), local],
                    extension: (name) => (name === POLICY ? local : snapshot.extension(name)),
                    tools: () => [
                        ...snapshot.tools(),
                        ...(local.tools ?? []).map((tool) => ({ extension: local, tool })),
                    ],
                    sections: () => [
                        ...snapshot.sections(),
                        ...(local.sections ?? []).map((section) => ({ extension: local, section })),
                    ],
                };
                previous = snapshot;
            }

            return current;
        },
    };
}
