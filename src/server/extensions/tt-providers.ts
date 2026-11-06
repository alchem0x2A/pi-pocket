/** Registers 2 Claude Code subscriptions: org (~/.claude) and personal (~/.claude-personal). */
import { createJiti } from "jiti";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    createModels,
    defaultProviderAuthContext,
    InMemoryModelsStore,
    lazyStream,
    type AnyModel,
    type Api,
    type AssistantMessage,
    type AuthContext,
    type CredentialStore,
    type Model,
    type Provider,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { ExtensionWeb as Web, PocketHost as Host } from "../host.ts";

const CLAUDE_COMMAND = join(homedir(), ".local", "bin", "claude");
const CLAUDE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pi-claude-code", "src");

const CLAUDE_ORG_ID = "claude-code";
const CLAUDE_PERSONAL_ID = "claude-code-personal";
const CLAUDE_ORG_CONFIG_DIR = join(homedir(), ".claude");
const CLAUDE_PERSONAL_CONFIG_DIR = join(homedir(), ".claude-personal");

interface ClaudeModule {
    createClaudeCodeProvider(): Provider;
}

interface ClaudeCliModule {
    closeClaudeProcesses(): Promise<void>;
}

interface LoadedClaude {
    provider: Provider;
    close(): Promise<void>;
}

function claudeLoader() {
    return createJiti(import.meta.url, {
        moduleCache: false,
        alias: {
            "@earendil-works/pi-ai/providers/all": fileURLToPath(
                import.meta.resolve("@earendil-works/pi-ai/providers/all"),
            ),
            "@earendil-works/pi-ai/providers/anthropic.models": fileURLToPath(
                import.meta.resolve("@earendil-works/pi-ai/providers/anthropic.models"),
            ),
            "@earendil-works/pi-ai": fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")),
        },
    });
}

/** Load one isolated upstream module graph. */
async function loadClaudeCode(): Promise<LoadedClaude> {
    const loader = claudeLoader();
    const module = (await loader.import(join(CLAUDE_SOURCE, "provider.ts"))) as ClaudeModule;
    const cli = (await loader.import(join(CLAUDE_SOURCE, "claude-cli.ts"))) as ClaudeCliModule;

    return {
        provider: module.createClaudeCodeProvider(),
        close: cli.closeClaudeProcesses,
    };
}

function localModel<T extends AnyModel>(model: T, provider: string): T {
    return { ...model, provider } as T;
}

function scopedClaudeProvider(provider: Provider, id: string, name: string): Provider {
    const upstreamId = provider.id;

    return {
        ...provider,
        id,
        name,
        getModels: () => provider.getModels().map((model) => localModel(model, id)),
        getAllModels: () =>
            (provider.getAllModels?.() ?? provider.getModels()).map((model) =>
                localModel(model, id),
            ),
        ...(provider.refreshModels
            ? {
                  refreshModels: async (
                      context: Parameters<NonNullable<Provider["refreshModels"]>>[0],
                  ) =>
                      provider.refreshModels!({
                          ...context,
                          stored: context.stored
                              ? {
                                    ...context.stored,
                                    models: context.stored.models.map((model) =>
                                        localModel(model, upstreamId),
                                    ),
                                }
                              : undefined,
                          publish: (publication) =>
                              context.publish({
                                  ...publication,
                                  persist: publication.persist
                                      ? {
                                            ...publication.persist,
                                            models: publication.persist.models.map((model) =>
                                                localModel(model, id),
                                            ),
                                        }
                                      : publication.persist,
                              }),
                      }),
              }
            : {}),
        ...(provider.filterModels
            ? {
                  filterModels: (
                      models: readonly Model<Api>[],
                      credential: Parameters<NonNullable<Provider["filterModels"]>>[1],
                  ) =>
                      provider.filterModels!(
                          models.map((model) => localModel(model, upstreamId)),
                          credential,
                      ).map((model) => localModel(model, id)),
              }
            : {}),
        ...(provider.filterAllModels
            ? {
                  filterAllModels: (
                      models: readonly AnyModel[],
                      credential: Parameters<NonNullable<Provider["filterAllModels"]>>[1],
                  ) =>
                      provider.filterAllModels!(
                          models.map((model) => localModel(model, upstreamId)),
                          credential,
                      ).map((model) => localModel(model, id)),
              }
            : {}),
    };
}

function claudeAuthContext(configDir: string): AuthContext {
    const base = defaultProviderAuthContext();

    return {
        async env(name) {
            if (name === "PI_CLAUDE_CODE_COMMAND") {
                return CLAUDE_COMMAND;
            }

            if (name === "PI_CLAUDE_CODE_CONFIG_DIR" || name === "CLAUDE_CONFIG_DIR") {
                return configDir;
            }

            return base.env(name);
        },
        fileExists: base.fileExists,
    };
}

const noCredentials: CredentialStore = {
    async read() {
        return undefined;
    },
    async list() {
        return [];
    },
    async modify() {
        throw new Error("Claude CLI owns authentication; no credential writes allowed.");
    },
    async delete() {
        throw new Error("Use Claude CLI to log out.");
    },
};

// Normalize foreign replay without changing the durable transcript. Native
// replay carriers and signed thinking are preserved only for the same model.
export function prepareClaudeContext(
    context: TranscriptContext,
    model: { provider: string; api: string; id: string },
): TranscriptContext {
    const validId = /^[A-Za-z0-9_-]{1,64}$/;
    const ids: string[] = [];
    const nativeIds = new Set<string>();

    for (const message of context.messages) {
        if (message.role === "assistant") {
            const native =
                message.provider === model.provider &&
                message.api === model.api &&
                message.model === model.id;

            for (const block of message.content) {
                if (block.type === "toolCall") {
                    ids.push(block.id);

                    if (native) {
                        nativeIds.add(block.id);
                    }
                }
            }
        } else if (message.role === "toolResult") {
            ids.push(message.toolCallId);
        }
    }

    const reserved = new Set(ids.filter((id) => validId.test(id)));
    const used = new Set(nativeIds);
    const pending = new Map<string, string>();

    const assign = (id: string, native: boolean): string => {
        if (pending.has(id)) {
            throw new Error("Claude replay has ambiguous concurrent tool-call IDs.");
        }

        if (native && !validId.test(id)) {
            throw new Error("Claude replay has an invalid native tool-call ID.");
        }

        let replacement = id;

        if (!native && (!validId.test(id) || used.has(id))) {
            const hash = createHash("sha256").update(id).digest("hex");

            replacement = `pi_${hash.slice(0, 61)}`;

            for (let n = 1; reserved.has(replacement) || used.has(replacement); n++) {
                const suffix = `_${n}`;

                replacement = `pi_${hash.slice(0, 61 - suffix.length)}${suffix}`;
            }

            reserved.add(replacement);
        }

        used.add(replacement);
        pending.set(id, replacement);

        return replacement;
    };

    const messages = context.messages.map((message) => {
        if (message.role === "toolResult") {
            const id = pending.get(message.toolCallId);

            if (id === undefined) {
                throw new Error("Claude replay has a tool result without a matching call.");
            }

            pending.delete(message.toolCallId);

            return id === message.toolCallId ? message : { ...message, toolCallId: id };
        }

        if ((message.role === "user" || message.role === "assistant") && pending.size) {
            throw new Error(
                "Claude replay has a tool call without a result before the next message.",
            );
        }

        if (message.role !== "assistant") {
            return message;
        }

        const native =
            message.provider === model.provider &&
            message.api === model.api &&
            message.model === model.id;

        if (native) {
            for (const block of message.content) {
                if (block.type === "toolCall") {
                    assign(block.id, true);
                }
            }

            return message;
        }

        return {
            ...message,
            diagnostics: message.diagnostics?.filter(
                (item) => item.type !== "claude-code.native-assistant.v1",
            ),
            content: message.content.flatMap((block): AssistantMessage["content"] => {
                if (block.type === "thinking") {
                    return !block.redacted && block.thinking.trim()
                        ? [{ type: "text", text: block.thinking }]
                        : [];
                }

                if (block.type === "text") {
                    return [{ type: "text", text: block.text }];
                }

                const { thoughtSignature: _signature, ...toolCall } = block;

                return [{ ...toolCall, id: assign(block.id, false) }];
            }),
        };
    });

    if (pending.size) {
        throw new Error("Claude replay has a tool call without a matching result.");
    }

    return { ...context, messages };
}

/**
 * Opus 4.6, kept for second opinions. The CLI's model menu no longer lists it, so discovery never returns it; the
 * CLI still accepts it by name. The `[1m]` suffix asks the CLI for the 1M-context variant (upstream's `nativeModel`
 * keeps the suffix), which only the org account may use without usage credits.
 */
interface ExtraModel {
    id: string;
    name: string;
    contextWindow: number;
}

function extraModel(provider: Provider, extra: ExtraModel): Model<Api> | undefined {
    const template = provider.getModels()[0];
    const builtin = getBuiltinModel("anthropic", "claude-opus-4-6") as Model<Api> | undefined;

    if (!template || !builtin) {
        return undefined;
    }

    return {
        ...builtin,
        id: extra.id,
        name: extra.name,
        api: template.api,
        provider: provider.id,
        baseUrl: template.baseUrl,
        contextWindow: extra.contextWindow,
        maxTokens: 64_000,
    } as Model<Api>;
}

export async function createClaudePocketConfig(
    provider: Provider,
    configDir: string,
    extras: readonly ExtraModel[] = [],
): Promise<ProviderConfig> {
    const models = createModels({
        authContext: claudeAuthContext(configDir),
        credentials: noCredentials,
        modelsStore: new InMemoryModelsStore(),
    });

    models.setProvider(provider);
    const first = provider.getModels()[0];

    if (!first || !provider.auth.apiKey?.check) {
        throw new Error("Claude Code adapter requires chat models and an external login check.");
    }

    const available = async (signal?: AbortSignal) => {
        const found = [...(await models.getAvailable(provider.id, { signal }))];

        // Logged out: no models at all, extras included.
        if (found.length === 0) {
            return found;
        }

        const seen = new Set(found.map((model) => model.id));
        const added = extras
            .filter((extra) => !seen.has(extra.id))
            .map((extra) => extraModel(provider, extra))
            .filter((model) => model !== undefined);

        return [...found, ...added];
    };

    return {
        name: provider.name,
        api: first.api,
        baseUrl: first.baseUrl,
        // Non-secret runtime marker, NOT a credential or an API-billing fallback.
        // Empty models hide this provider when upstream's CLI check says logged out.
        apiKey: "external-process",
        // Ask the CLI for its current list as the module loads (bounded), so the picker does not start from upstream's
        // older built-in list. Logged out, a slow CLI, or an error: fall back to what is known without the network.
        models: await (async () => {
            try {
                const signal = AbortSignal.timeout(20_000);

                if (!(await models.checkAuth(provider.id, { signal }))) {
                    return [];
                }

                const result = await models.refresh({
                    providers: [provider.id],
                    allowNetwork: true,
                    force: true,
                    signal,
                });

                if (result.errors.get(provider.id)) {
                    return available();
                }

                return available(signal);
            } catch {
                return available();
            }
        })(),
        async refreshModels(context) {
            if (!(await models.checkAuth(provider.id, { signal: context.signal }))) {
                return [];
            }

            const result = await models.refresh({
                providers: [provider.id],
                allowNetwork: context.allowNetwork,
                force: context.force,
                signal: context.signal,
            });
            const error = result.errors.get(provider.id);

            if (error) {
                throw error;
            }

            return available(context.signal);
        },
        streamSimple(model, context, options) {
            return lazyStream(model, async () => {
                if (!(await models.checkAuth(provider.id, { signal: options?.signal }))) {
                    throw new Error(
                        "Claude Code is not logged in. Use `claude auth login` in a terminal.",
                    );
                }

                // Discard Pocket's compatibility marker. Let native auth.resolve supply
                // request auth and the provider-scoped environment to the unchanged stream.
                const { apiKey: _key, ...rest } = options ?? {};

                return models.streamSimple(model, prepareClaudeContext(context, model), rest);
            });
        },
        ...(provider.auth.oauth
            ? {
                  oauth: {
                      name: provider.auth.oauth.name,
                      isSubscription: provider.auth.oauth.isSubscription,
                      async login() {
                          throw new Error(
                              "Claude Code owns this login. Run `claude auth login` in a terminal.",
                          );
                      },
                      async refreshToken() {
                          throw new Error(
                              "Claude CLI owns token refresh; do not store this provider's credentials in the agent.",
                          );
                      },
                      getApiKey() {
                          return "external-process";
                      },
                  },
              }
            : {}),
    };
}

export default async function (host: Host, web: Web) {
    const org = await loadClaudeCode();

    web.onDispose(org.close);
    const personal = await loadClaudeCode();

    web.onDispose(personal.close);

    const orgProvider = scopedClaudeProvider(
        org.provider,
        CLAUDE_ORG_ID,
        "Claude Code Subscription (org account; ~/.claude)",
    );
    const personalProvider = scopedClaudeProvider(
        personal.provider,
        CLAUDE_PERSONAL_ID,
        "Claude Code Subscription (personal account; ~/.claude-personal)",
    );

    // Both accounts ask the CLI for their model lists at once, inside Pocket's load limit.
    const [orgConfig, personalConfig] = await Promise.all([
        createClaudePocketConfig(orgProvider, CLAUDE_ORG_CONFIG_DIR, [
            {
                id: "claude-opus-4-6[1m]",
                name: "Claude Opus 4.6 (1M)",
                contextWindow: 1_000_000,
            },
        ]),
        createClaudePocketConfig(personalProvider, CLAUDE_PERSONAL_CONFIG_DIR, [
            {
                id: "claude-opus-4-6",
                name: "Claude Opus 4.6",
                contextWindow: 200_000,
            },
        ]),
    ]);

    web.onDispose(host.registerModelProvider(CLAUDE_ORG_ID, orgConfig));
    web.onDispose(host.registerModelProvider(CLAUDE_PERSONAL_ID, personalConfig));
}
