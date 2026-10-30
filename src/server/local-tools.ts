/**
 * Local session tool policy: a small initial set, with tool_search for discovery and tool_load for explicit loading.
 * This registry view leaves the upstream registry, extension loader, execution environment, and PiP unchanged.
 */
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
    defineExtension,
    defineTool,
    section,
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
const BASE = new Set(["read", "write", "bash", "ls", "rg", "tool_search", "tool_load"]);

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
    memory: "Propose and manage saved lessons",
    watch_pr: "Monitor pull requests on GitHub",
    request_restart: "Request Pi Pocket server restart",
    design_preview: "Preview designs at screen sizes",
    design_export: "Export designs to files",
    design_system: "Read or write design rules",
    ask_someone: "Request answers from other people",
};
const UNKNOWN_DESCRIPTION = "Search for tool details";

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

function availableTools(): PromptSection {
    return section("available_tools", ({ agent }) => {
        const tools = new Map([...agent.tools, ...agent.deferred].map((tool) => [tool.name, tool]));

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

                return { output: [{ type: "text", text }], details: { matches } };
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

/** Tools of these extensions stay offered: the Pia chat's session management must not need discovery first. */
const NEVER_DEFERRED = new Set(["pocket-pip"]);

const TASK_FOCUS =
    "Focus on the request this session was given, and finish it; do not start unrelated work.";

/** A synthetic extension is selected by default, but not by PiP's explicit extension list. */
function policy(snapshot: RegistrySnapshot, extras: readonly ToolRegistration[]): Extension {
    const wraps: Wrap[] = [];

    for (const { extension, tool } of snapshot.tools()) {
        if (!BASE.has(tool.name) && !NEVER_DEFERRED.has(extension.name)) {
            wraps.push({
                tool: tool.name,
                wrap: (original: ToolRegistration) => ({ ...original, deferred: true as const }),
            });
        }
    }

    for (const extension of snapshot.installed()) {
        const names = extension.tools?.map((tool) => tool.name) ?? [];

        // Lessons, policy, and unknown extension sections stay present even when tools are not loaded.
        if (names.length === 0 || !LAZY_GUIDES.has(extension.name)) {
            continue;
        }

        for (const guide of extension.sections ?? []) {
            wraps.push({
                section: guide.key,
                wrap: (original: PromptSection) => ({
                    ...original,
                    render: (...[input, context]: Parameters<PromptSection["render"]>) =>
                        names.some((name) => input.agent.tools.some((tool) => tool.name === name))
                            ? original.render(input, context)
                            : undefined,
                }),
            });
        }
    }

    const registered = new Set(snapshot.tools().map(({ tool }) => tool.name));

    return defineExtension({
        name: POLICY,
        tools: extras.filter((tool) => !registered.has(tool.name)),
        wraps,
        sections: [
            availableTools(),
            section(
                "tool_discovery",
                () =>
                    "The available_tools catalog lists enabled tools, not loaded schemas. If a tool's purpose is clear, use tool_load with its exact name; already-offered tools need no loading. If unsure, use tool_search with an exact name or keywords for descriptions, then load only the tools needed for this session. Search loads nothing. tool_load supplies authoritative schemas and guides on the next request; they persist in this conversation. Disabled tools cannot be loaded.",
            ),
            // Task sessions only: the Pia chat, which has the session tools, gets its own prompt from PiP's extension.
            section("task_focus", (input) => {
                const all = [...input.agent.tools, ...input.agent.deferred];

                if (all.some((tool) => tool.name === "session_start")) {
                    return undefined;
                }

                return TASK_FOCUS;
            }),
        ],
    });
}

/**
 * A cached read-only view follows loader publications without mutating installed extensions or stored agent choices.
 * `active` says whether discovery is on now: the Pia profile only (`pia.ts`), so Classic keeps upstream's registry as it
 * is. `PI_POCKET_TOOL_DISCOVERY=off` turns it off and `=on` turns it on whatever the profile (rollback and tests).
 */
export function localToolRegistry(
    registry: RegistryReader,
    ripgrep: boolean,
    active: () => boolean = () => true,
): RegistryReader & { changed(): void } {
    // A local rollback switch also lets legacy scripted-model tests keep their fixed, eager tool manifests.
    if (process.env.PI_POCKET_TOOL_DISCOVERY === "off") {
        return {
            subscribe: (listener) => registry.subscribe(listener),
            snapshot: () => registry.snapshot(),
            changed() {},
        };
    }

    const on = process.env.PI_POCKET_TOOL_DISCOVERY === "on" ? () => true : active;

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
        // The profile changed: wake the harness as a registry publication does, so it resolves agents again.
        changed() {
            previous = undefined;

            for (const listener of [...listeners]) {
                listener();
            }
        },
        snapshot() {
            const snapshot = registry.snapshot();

            // Classic: upstream's own snapshot, so nothing is deferred and no discovery tool exists.
            if (!on()) {
                return snapshot;
            }

            if (snapshot !== previous) {
                const local = policy(snapshot, extras);

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
