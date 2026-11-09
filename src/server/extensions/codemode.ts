/**
 * Codemode runs scripts through Pi Durable's native executor, with owner-selected tool exposure and Pia's history adapters.
 * The sandbox has no Node, file system, network, or timers. Nested calls use Durable's tools, guards, and replay policy.
 */
import type { Context } from "@earendil-works/chord";
import {
    CodemodeSandbox,
    type CodemodeRun,
    type CodemodeRunOptions,
} from "@earendil-works/pi-codemode";
import {
    defineExtension,
    GenerationTask,
    hook,
    section,
    wrapSection,
    wrapTool,
    type HookApi,
    type ToolExecutionApi,
    type ToolExecutionResult,
    type ToolRegistration,
    type ToolTaskInput,
    ToolTask,
} from "@earendil-works/pi-durable";
import {
    createCodemodeExtension,
    createCodemodeTool,
    CodemodeStoreDoc as NativeStoreDoc,
} from "@earendil-works/pi-durable/codemode";
import { CodemodeStoreDoc, CodemodeTransitionDoc, CodemodeReferencesDoc } from "../docs.ts";
import { compactedReferences } from "../compacted-references.ts";
import type { ExtensionWeb, PocketHost } from "../host.ts";

export const CODEMODE_TOOL = "codemode";
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/** Only actual UI requirements stay direct; ordinary script tools never gain model-facing schemas. */
const DIRECT_UI = new Set([CODEMODE_TOOL, "ink_read", "browser", "tool_load"]);
const DIRECT_UI_READS = new Set(["browser", "ink_read"]);

/** Record native discovery results, not schemas. The native implementation still ranks and describes tools. */
class DiscoverySandbox extends CodemodeSandbox {
    readonly discovered = new Set<string>();
    record: (names: string[]) => Promise<void> = async () => {};

    override start(code: string, options: CodemodeRunOptions): CodemodeRun {
        const lookups = new Map<number, { name: string; asked: unknown }>();
        const names = (name: unknown) =>
            options.tools?.filter((tool) => tool.name === name || tool.jsName === name) ?? [];
        const controller = new AbortController();
        const abort = () => controller.abort(options.signal?.reason);

        options.signal?.addEventListener("abort", abort, { once: true });

        if (options.signal?.aborted) {
            abort();
        }

        let delivering = Promise.resolve();
        let failure: unknown;
        const run = super.start(code, {
            ...options,
            signal: controller.signal,
            onCall: (call) => {
                if (
                    call.target === "global" &&
                    ["describeTool", "searchTools", "describeNamespace"].includes(call.name)
                ) {
                    lookups.set(call.id, {
                        name: call.name,
                        asked: Array.isArray(call.args) ? call.args[0] : undefined,
                    });
                }

                options.onCall(call);
            },
        });

        return {
            get finished() {
                return run.finished;
            },
            result: run.result
                .then(async (result) => {
                    await delivering;

                    if (failure !== undefined) {
                        throw failure;
                    }

                    return result;
                })
                .finally(() => options.signal?.removeEventListener("abort", abort)),
            deliver: (seq, now, id, outcome) => {
                const lookup = lookups.get(id);
                const found: string[] = [];

                if (outcome.ok && lookup !== undefined) {
                    const value = outcome.value;
                    const asked =
                        lookup.name === "describeTool" && typeof value === "string"
                            ? [lookup.asked]
                            : lookup.name === "searchTools" && Array.isArray(value)
                              ? value.map((item) => item?.name)
                              : lookup.name === "describeNamespace" &&
                                  typeof value === "object" &&
                                  value !== null &&
                                  "tools" in value &&
                                  Array.isArray(value.tools)
                                ? value.tools
                                : [];

                    for (const name of asked) {
                        const matches = names(name);

                        if (matches.length === 1 && !this.discovered.has(matches[0]!.name)) {
                            this.discovered.add(matches[0]!.name);
                            found.push(matches[0]!.name);
                        }
                    }
                }

                // Persist the reference before the VM can use it. Native's journal already holds the result.
                delivering = delivering
                    .then(async () => {
                        if (found.length > 0) {
                            await this.record(found);
                        }

                        if (!run.finished) {
                            run.deliver(seq, now, id, outcome);
                        }
                    })
                    .catch((error: unknown) => {
                        failure = error;
                        controller.abort(error);
                    });
            },
        };
    }
}

/** Keep compact reference and Changes metadata with success, error, and aborted results. */
function enrich(
    result: ToolExecutionResult,
    refs:
        | Readonly<{
              notes: readonly string[];
              tools: readonly string[];
              paths: Readonly<Record<string, { name: string; path: string }>>;
          }>
        | undefined,
): ToolExecutionResult {
    if (refs === undefined) {
        return result;
    }

    const details = result.details as
        { calls?: { id: number; name?: string; status?: string; path?: string }[] } | undefined;
    const calls = [...(details?.calls ?? [])];

    for (const [id, item] of Object.entries(refs.paths)) {
        if (!calls.some((call) => call.id === Number(id))) {
            calls.push({ id: Number(id), ...item, status: "ok" });
        }
    }

    return {
        ...result,
        details: {
            ...details,
            ...(refs.notes.length === 0 ? {} : { readNoteIds: [...refs.notes] }),
            ...(refs.tools.length === 0 ? {} : { discoveredTools: [...refs.tools] }),
            ...(calls.length === 0
                ? {}
                : {
                      calls: calls.map((call) => ({
                          ...call,
                          ...(refs.paths[String(call.id)] === undefined
                              ? {}
                              : { path: refs.paths[String(call.id)]!.path, applied: true }),
                      })),
                  }),
        },
    };
}

export default function createCodemode(host: PocketHost, web?: ExtensionWeb) {
    web?.settings([
        {
            name: "mode",
            label: "Mode",
            description:
                "On permits direct tools and scripts. Only hides ordinary tool schemas; use native script discovery. Both modes use the same executor and store.",
            type: "choice",
            default: "on",
            choices: [
                { value: "on", label: "On" },
                { value: "only", label: "Only" },
            ],
        },
        {
            name: "piaOnly",
            label: "Use Only in Pia chat",
            description: "Off keeps direct tools in Pia chat, even when Mode is Only.",
            type: "boolean",
            default: false,
        },
    ]);
    const only = (id: ToolExecutionApi["conversationId"]) =>
        web?.setting("mode") === "only" &&
        (host.pia?.ownerOf?.(id) === undefined || web?.setting("piaOnly") === true);
    const direct = (tool: ToolRegistration) =>
        DIRECT_UI.has(tool.name) ||
        (tool.callers?.includes("model") === true &&
            !tool.callers.includes("tools") &&
            tool.name !== "tool_search");
    const sandbox = new CodemodeSandbox({ memoryLimitBytes: MEMORY_LIMIT_BYTES });

    web?.onDispose(() => sandbox.close());
    const native = createCodemodeExtension({ sandbox, models: false });
    const nativeTool = native.tools![0]!;

    const runNative = async (args: { code: string }, api: ToolExecutionApi, context: Context) => {
        // The old definition remains readable. Existing native values win over old values on an explicit transition.
        if (
            (await api.snapshot(CodemodeTransitionDoc, api.conversationId, context))?.done !== true
        ) {
            await api.commit(async (tx) => {
                const transition = await tx.doc(CodemodeTransitionDoc, api.conversationId);

                if (transition.done) {
                    return;
                }

                const old = await tx.doc(CodemodeStoreDoc, api.conversationId);
                const current = await tx.doc(NativeStoreDoc, api.conversationId);

                current.values = { ...old.values, ...current.values };
                transition.done = true;
            }, context);
        }

        const record = async (update: { notes?: string[]; tools?: string[] }) => {
            await api.commit(async (tx) => {
                const refs = await tx.doc(CodemodeReferencesDoc, api.taskId);

                for (const id of update.notes ?? []) {
                    if (!refs.notes.includes(id)) {
                        refs.notes.push(id);
                    }
                }

                for (const name of update.tools ?? []) {
                    if (!refs.tools.includes(name)) {
                        refs.tools.push(name);
                    }
                }
            }, context);
        };

        const agent = await api.agent(context);
        const deferred = new Set(
            agent.callable.filter((tool) => tool.deferred).map((tool) => tool.name),
        );
        const nestedApi: ToolExecutionApi = {
            ...api,
            // UI read tools keep their existing On-mode script access. Only filters the script catalog per
            // conversation; a global callers wrapper would also restrict On and Pia's independent mode.
            agent: async (scope) => {
                const current = await api.agent(scope);

                return only(api.conversationId)
                    ? {
                          ...current,
                          callable: current.callable.filter(
                              (tool) => !DIRECT_UI_READS.has(tool.name),
                          ),
                      }
                    : current;
            },
            executeTool: async (name, input, scope, options) => {
                const result = await api.executeTool(name, input, scope, options);

                if (deferred.has(name)) {
                    await record({ tools: [name] });
                }

                const noteDetails = result.details as { readNoteIds?: unknown } | undefined;

                if (
                    name === "note_load" &&
                    !result.isError &&
                    Array.isArray(noteDetails?.readNoteIds)
                ) {
                    await record({
                        notes: noteDetails.readNoteIds.filter(
                            (id): id is string => typeof id === "string",
                        ),
                    });
                }

                return result;
            },
        };
        const tracking = new DiscoverySandbox({
            timeoutMs: Number.POSITIVE_INFINITY,
            memoryLimitBytes: MEMORY_LIMIT_BYTES,
        });

        tracking.record = (tools) => record({ tools });
        let result: Awaited<ReturnType<typeof nativeTool.execute>>;

        try {
            result = await createCodemodeTool({ sandbox: tracking, models: false }).execute(
                args,
                nestedApi,
                context,
            );
        } finally {
            await tracking.close();
        }

        return enrich(result, await api.snapshot(CodemodeReferencesDoc, api.taskId, context));
    };

    const active = async (api: HookApi, context: Context) => {
        if (!only(api.conversationId)) {
            return undefined;
        }

        const agent = await host.history(api.conversationId).agent(context);

        return agent.tools.some((tool) => tool.name === CODEMODE_TOOL) ? agent : undefined;
    };

    return defineExtension({
        name: "pocket-codemode",
        tools: [{ ...nativeTool, execute: runNative }],
        hooks: [
            hook(GenerationTask, {
                beforeRequest: async (request, api, context) => {
                    const conversation = host.history(api.conversationId);
                    const resolved = await conversation.agent(context);

                    if (!resolved.tools.some((tool) => tool.name === CODEMODE_TOOL)) {
                        return undefined;
                    }

                    const refs = await compactedReferences(
                        (await conversation.context(context)).head,
                        api,
                        context,
                    );
                    const allowed = new Set(
                        resolved.callable
                            .filter(
                                (tool) =>
                                    !only(api.conversationId) || !DIRECT_UI_READS.has(tool.name),
                            )
                            .map((tool) => tool.name),
                    );
                    const remembered = refs.tools.filter((name) => allowed.has(name));
                    const messages = [...request.messages];
                    const at = messages.findIndex(
                        (message) =>
                            message.role === "user" &&
                            (typeof message.content === "string"
                                ? message.content
                                : message.content
                                      .flatMap((p) => (p.type === "text" ? [p.text] : []))
                                      .join("")) === refs.summary,
                    );

                    if (at >= 0 && remembered.length > 0) {
                        messages.splice(at + 1, 0, {
                            role: "user",
                            timestamp: messages[at]!.timestamp,
                            content: `Tools you discovered before this compaction, still enabled for scripts: ${remembered.join(", ")}. Use describeTool() for current schemas; these names grant no permission.`,
                        });
                    }

                    if (!only(api.conversationId)) {
                        return { messages };
                    }

                    const ui = [...resolved.tools, ...resolved.deferred].filter(
                        (tool) => ![CODEMODE_TOOL, "tool_load"].includes(tool.name) && direct(tool),
                    );
                    const keep = new Set(
                        resolved.tools
                            .filter(
                                (tool) =>
                                    direct(tool) && (tool.name !== "tool_load" || ui.length > 0),
                            )
                            .map((tool) => tool.name),
                    );

                    return {
                        messages: messages.map((message) =>
                            message.role !== "system"
                                ? message
                                : {
                                      ...message,
                                      ...(message.toolsAdded === undefined
                                          ? {}
                                          : {
                                                toolsAdded: message.toolsAdded
                                                    .filter((tool) => keep.has(tool.name))
                                                    .map((tool) =>
                                                        tool.name === "tool_load"
                                                            ? {
                                                                  ...tool,
                                                                  description: `Load direct UI tools only: ${ui.map((tool) => tool.name).join(", ")}. Do not load script tools; use searchTools() and describeTool() in codemode.`,
                                                              }
                                                            : tool,
                                                    ),
                                            }),
                                      ...(message.toolsRemoved === undefined
                                          ? {}
                                          : {
                                                toolsRemoved: message.toolsRemoved.filter((tool) =>
                                                    keep.has(tool.name),
                                                ),
                                            }),
                                  },
                        ),
                    };
                },
            }),
            hook(ToolTask, {
                afterTool: async (call, result, api, context) =>
                    call.name === CODEMODE_TOOL
                        ? enrich(
                              result,
                              await api.snapshot(CodemodeReferencesDoc, api.taskId, context),
                          )
                        : undefined,
                beforeTool: async (call, api, context) => {
                    const agent = await active(api, context);

                    if (agent === undefined) {
                        return undefined;
                    }

                    if (call.parent !== undefined) {
                        return DIRECT_UI_READS.has(call.name)
                            ? {
                                  block: "Only mode requires this UI read tool to be called directly.",
                              }
                            : undefined;
                    }

                    const offered = agent.tools.find((tool) => tool.name === call.name);

                    if (call.name === "tool_load") {
                        const names = (call.arguments as { names?: unknown }).names;
                        const candidates = [...agent.tools, ...agent.deferred];

                        if (
                            !Array.isArray(names) ||
                            names.some((name) => {
                                const candidate = candidates.find((tool) => tool.name === name);

                                return (
                                    candidate === undefined ||
                                    !direct(candidate) ||
                                    name === "tool_load"
                                );
                            })
                        ) {
                            return {
                                block: "Only mode loads direct UI tools only. Discover other tools inside a codemode script.",
                            };
                        }
                    }

                    return offered !== undefined && direct(offered)
                        ? undefined
                        : {
                              block: "Only mode requires this tool to be called from a codemode script.",
                          };
                },
            }),
        ],
        wraps: [
            // Tool.execute receives the final validated arguments, after argument repair and beforeTool rewrites.
            // Record a successful nested write before the child reports success, not by reading ephemeral live slots
            // from the parent later. The parent keeps these facts even if it is stopped before it receives the result.
            ...["write", "edit"].map((name) =>
                wrapTool({ name } as ToolRegistration, (tool) => ({
                    ...tool,
                    execute: async (args, api, context) => {
                        const task = await api.getTask(api.taskId, context);

                        if (task?.kind !== ToolTask.definition.name) {
                            throw new Error(
                                "Cannot identify the write task for durable Changes attribution.",
                            );
                        }

                        const input = task.input as ToolTaskInput;
                        const key =
                            input.kind === "nested" ? /^c([1-9][0-9]*)$/.exec(input.key) : null;
                        const result = await tool.execute(args, api, context);
                        const path = (args as { path?: unknown }).path;

                        if (
                            result.isError !== true &&
                            input.kind === "nested" &&
                            key !== null &&
                            typeof path === "string"
                        ) {
                            await api.commit(async (tx) => {
                                const refs = await tx.doc(CodemodeReferencesDoc, input.parent);

                                refs.paths[key[1]!] = { name, path };
                            }, context);
                        }

                        return result;
                    },
                })),
            ),

            wrapSection("available_tools", (original) => ({
                ...original,
                render: (input, context) => {
                    if (!only(input.conversationId)) {
                        return original.render(input, context);
                    }

                    const waiting = input.agent.deferred.filter(direct).map((tool) => tool.name);

                    return (
                        "Use native searchTools() and describeTool() for scripts; no loading is needed. Discovery grants no permission." +
                        (waiting.length === 0
                            ? ""
                            : ` Direct UI tools (load with tool_load): ${waiting.join(", ")}.`) +
                        " tool_load cannot expand ordinary script schemas in Only mode."
                    );
                },
            })),
            wrapSection("tool_discovery", (original) => ({
                ...original,
                render: (input, context) =>
                    only(input.conversationId) ? undefined : original.render(input, context),
            })),
        ],
        sections: [
            section("codemode", async (input, context) => {
                const tools = new Set(input.agent.tools.map((tool) => tool.name));
                const callable = input.agent.callable.filter((tool) =>
                    only(input.conversationId) ? !direct(tool) : !tools.has(tool.name),
                );

                const guide = only(input.conversationId)
                    ? "Call ordinary tools only inside codemode as await tools.<name>(args). Do not emit direct calls or tool_call text for them. "
                    : "";

                return (
                    guide +
                    ((await native.sections![0]!.render(
                        { ...input, agent: { ...input.agent, callable } },
                        context,
                    )) ??
                        "Use codemode to batch independent calls (Promise.allSettled), chain them, or filter large output. Find enabled tools with searchTools() and describeTool(); no loading is needed for scripts.")
                );
            }),
        ],
    });
}
