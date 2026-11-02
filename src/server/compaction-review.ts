/**
 * A separate model can review and write session summaries, without changing the model that continues the conversation.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    clampThinkingLevel,
    type Api,
    type AssistantMessage,
    type Message,
    type Model,
    type ModelThinkingLevel,
    type Usage,
} from "@earendil-works/pi-ai";
import {
    type CompactionReason,
    type ConversationId,
    type HookApi,
    DEFAULT_COMPACTION_POLICY,
    ProviderDoc,
    UsageDoc,
} from "@earendil-works/pi-durable";
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import type { ModelChoice } from "./config.ts";
import type { PocketApp } from "./app.ts";
import { CompactionReviewDoc, SpendDoc } from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { clip, defang } from "./fence.ts";
import { findModel, isThinkingLevel, resolveModel } from "./models.ts";
import { noWait } from "./limit-gate.ts";

const context = BACKGROUND_CONTEXT;
const MEMO = "pocket.compaction-review";
const REQUEST_PREFIX = "\u001fpocket-compaction-review:";
const SUMMARY_TOKENS = 8192;
const SUMMARY_CHARS = 16_000;

const SUMMARY_SYSTEM =
    "You are a context summarization assistant. Read a conversation between a user and an AI assistant, then produce a structured summary in the required format. Do not continue the conversation or answer questions in it. Only output the summary.";

const SUMMARY_PROMPT = `Create a structured context checkpoint for another model to continue the work. If the conversation starts with an earlier summary, preserve its information and fold in the newer messages.

Use this exact format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements and preferences, or "(none)"]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, or "(none)"]

## Key Decisions
- **[Decision]**: [Brief reason]

## Next Steps
1. [Ordered next steps]

## Critical Context
- [Required paths, names, examples, and references, or "(none)"]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

type RequestMarker = {
    version: 1;
    model: ModelChoice;
    payer: string;
    instructions?: string;
};

export type CompactionRequest = {
    model?: ModelChoice;
    payer?: string;
    instructions?: string;
    marked: boolean;
};

type Made = {
    summary: string;
    model: string;
    usage: Record<string, JsonValue>;
    failure: string | null;
};

/** Add the chosen model and payer to Durable's instruction string; the task persists this through restarts. */
export function compactionInstructions(
    instructions: string | undefined,
    model: ModelChoice | undefined,
    payer: string,
): string | undefined {
    if (model === undefined) {
        return instructions;
    }

    const marker: RequestMarker = {
        version: 1,
        model,
        payer,
        ...(instructions === undefined ? {} : { instructions }),
    };

    return `${REQUEST_PREFIX}${Buffer.from(JSON.stringify(marker)).toString("base64url")}\n`;
}

/** Read a private request marker, leaving ordinary instructions unchanged. */
export function readCompactionRequest(instructions: string | undefined): CompactionRequest {
    if (instructions === undefined || !instructions.startsWith(REQUEST_PREFIX)) {
        return { instructions, marked: false };
    }

    const lineEnd = instructions.indexOf("\n", REQUEST_PREFIX.length);

    if (lineEnd < 0) {
        return { instructions, marked: false };
    }

    try {
        const marker = JSON.parse(
            Buffer.from(instructions.slice(REQUEST_PREFIX.length, lineEnd), "base64url").toString(
                "utf8",
            ),
        ) as RequestMarker;

        if (
            marker.version !== 1 ||
            typeof marker.model?.provider !== "string" ||
            typeof marker.model.modelId !== "string" ||
            typeof marker.payer !== "string"
        ) {
            return { instructions, marked: false };
        }

        return {
            model: marker.model,
            payer: marker.payer,
            ...(marker.instructions === undefined ? {} : { instructions: marker.instructions }),
            marked: true,
        };
    } catch {
        return { instructions, marked: false };
    }
}

function summaryText(message: AssistantMessage): string | undefined {
    if (message.stopReason !== "stop" || message.content.some((part) => part.type === "toolCall")) {
        return undefined;
    }

    const text = message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim();

    return text === "" ? undefined : text;
}

function plainUsage(usage: Usage): Record<string, JsonValue> {
    return {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
        cost: {
            input: usage.cost.input,
            output: usage.cost.output,
            cacheRead: usage.cost.cacheRead,
            cacheWrite: usage.cost.cacheWrite,
            total: usage.cost.total,
        },
        ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
        ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    };
}

function failureOf(message: AssistantMessage): string | undefined {
    if (message.stopReason === "error" || message.stopReason === "aborted") {
        return `Summary failed: ${message.errorMessage ?? message.stopReason}`;
    }

    if (message.stopReason === "length") {
        return "Summary reached the output limit and may be incomplete.";
    }

    if (message.content.some((part) => part.type === "toolCall")) {
        return "Summary model tried to call a tool.";
    }

    return "Summary model returned no text.";
}

/** Summary requests made by the extension's beforeCompact hook. */
export class CompactionReview {
    readonly #app: PocketApp;
    readonly #failures = new Map<number, string>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Resolve a model choice for a manual request or the owner's setting. */
    resolveChoice(input: unknown, fallback: ModelThinkingLevel = "high"): ModelChoice {
        let model =
            typeof input === "string"
                ? findModel(this.#app.models, input)
                : typeof input === "object" && input !== null
                  ? this.#app.models.getModel(
                        String((input as { provider?: unknown }).provider ?? ""),
                        String((input as { modelId?: unknown }).modelId ?? ""),
                    )
                  : undefined;

        if (model === undefined && typeof input === "string") {
            const name = input.trim().toLowerCase();

            model = this.#app.models
                .getAvailableSnapshot()
                .find((each) => each.name.toLowerCase() === name);
        }

        if (model === undefined) {
            throw new HttpError(400, `Model ${String(input)} is not available here.`);
        }

        const ref = resolveModel(
            this.#app.models,
            `${model.provider}/${model.id}`,
            this.#app.signInNeeded,
        );
        const askedLevel =
            typeof input === "object" && input !== null
                ? (input as { thinkingLevel?: unknown }).thinkingLevel
                : undefined;

        if (askedLevel !== undefined && !isThinkingLevel(askedLevel)) {
            throw new HttpError(400, "thinkingLevel must be a valid thinking level");
        }

        const thinkingLevel = clampThinkingLevel(
            model,
            (askedLevel as ModelThinkingLevel | undefined) ?? fallback,
        );

        return { ...ref, thinkingLevel };
    }

    /** Another model's summary, or undefined to let Pi Durable use the conversation's model. */
    async summarize(
        compaction: {
            readonly reason: CompactionReason;
            readonly messages: readonly Message[];
            readonly instructions?: string;
        },
        api: HookApi,
        hookContext: Context,
    ): Promise<{ summary: string } | { decline: true } | undefined> {
        const request = readCompactionRequest(compaction.instructions);
        const choice =
            request.model ?? this.#app.config.compactionModel ?? this.#app.config.defaultModel;

        if (choice === undefined) {
            return undefined;
        }

        try {
            const made = await this.#write(
                compaction.messages,
                request.instructions,
                choice,
                request.payer,
                api,
                hookContext,
            );

            if (made.failure !== null) {
                this.#failed(api.taskId, compaction.reason, api.conversationId, made.failure);

                return { decline: true };
            }

            return { summary: made.summary };
        } catch (error) {
            if (hookContext.abortSignal?.aborted === true) {
                throw error;
            }

            const why = describe(error);

            this.#failed(api.taskId, compaction.reason, api.conversationId, why);
            this.#app.log(`Compaction review failed: ${why}`);

            return { decline: true };
        }
    }

    #failed(taskId: number, reason: CompactionReason, id: ConversationId, message: string): void {
        if (reason === "manual") {
            this.#failures.set(Number(taskId), message);

            for (const old of [...this.#failures.keys()].slice(0, -20)) {
                this.#failures.delete(old);
            }
        } else {
            this.#app.notice("error", `Compaction review failed: ${message}`, id);
        }
    }

    /** Why the newest selected-model summary was not written, once. */
    failure(taskId: number): string | undefined {
        const why = this.#failures.get(taskId);

        this.#failures.delete(taskId);

        return why;
    }

    async #write(
        messages: readonly Message[],
        instructions: string | undefined,
        choice: ModelChoice,
        payer: string | undefined,
        api: HookApi,
        hookContext: Context,
    ): Promise<Made> {
        let made = await api.memo<Made>(MEMO, hookContext);

        if (made === undefined) {
            const model = api.models.getModel(choice.provider, choice.modelId);

            if (model === undefined) {
                throw new Error(`Model ${choice.provider}/${choice.modelId} is not available now.`);
            }

            const now = this.#app.now();
            const transcript = defang(serializeConversation([...messages]));
            const focus = instructions?.trim();
            const userText = `<conversation>\n${transcript}\n</conversation>\n\n${SUMMARY_PROMPT}${focus ? `\n\nAdditional focus: ${defang(focus)}` : ""}`;
            const thinkingLevel = isThinkingLevel(choice.thinkingLevel)
                ? choice.thinkingLevel
                : "off";
            const response = await api.models.completeSimple(
                model,
                {
                    messages: [
                        { role: "system", content: SUMMARY_SYSTEM, timestamp: now },
                        {
                            role: "user",
                            content: [{ type: "text", text: userText }],
                            timestamp: now,
                        },
                    ],
                },
                noWait({
                    ...this.#app.streamSettings(),
                    sessionId: await this.#providerSession(api.conversationId, api, hookContext),
                    maxTokens: this.#maxTokens(model),
                    cacheRetention: "none",
                    ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
                    ...(hookContext.abortSignal === undefined
                        ? {}
                        : { signal: hookContext.abortSignal }),
                }),
            );
            const summary = summaryText(response);
            const result: Made = {
                summary: summary === undefined ? "" : clip(defang(summary), SUMMARY_CHARS),
                model: `${response.provider}/${response.model}`,
                usage: plainUsage(response.usage),
                failure: summary === undefined ? (failureOf(response) ?? "Summary failed.") : null,
            };

            made = await api.memo<Made>(MEMO, result, hookContext);
        }

        await this.#count(
            api.conversationId,
            Number(api.taskId),
            payer ?? this.#app.spend.payer(api.conversationId),
            made,
        );

        return made;
    }

    async #providerSession(
        id: ConversationId,
        api: HookApi,
        hookContext: Context,
    ): Promise<string> {
        const saved = await api.snapshot(ProviderDoc, id, hookContext);

        if (saved !== undefined) {
            return saved.sessionId;
        }

        return this.#app.harness.commit(
            async (tx) => (await tx.doc(ProviderDoc, id)).sessionId,
            context,
        );
    }

    #maxTokens(model: Model<Api>): number {
        let policy;

        try {
            policy = this.#app.settings.getCompactionSettings({
                provider: model.provider,
                id: model.id,
            });
        } catch {
            policy = {};
        }

        return Math.min(
            SUMMARY_TOKENS,
            Math.floor(0.8 * (policy.reserveTokens ?? DEFAULT_COMPACTION_POLICY.reserveTokens)),
            model.maxTokens > 0 ? model.maxTokens : SUMMARY_TOKENS,
        );
    }

    async #count(id: ConversationId, taskId: number, payer: string, made: Made): Promise<void> {
        await this.#app.harness.commit(async (tx) => {
            const counted = await tx.doc(CompactionReviewDoc, id);

            if (counted.counted.includes(taskId)) {
                return;
            }

            counted.counted = [...counted.counted, taskId].slice(-50);
            const models = (await tx.doc(UsageDoc, id)).models as Record<string, Usage>;
            const total = Object.hasOwn(models, made.model) ? models[made.model] : undefined;

            const usage = made.usage as unknown as Usage;

            if (total === undefined) {
                models[made.model] = usage;
            } else {
                for (const field of [
                    "input",
                    "output",
                    "cacheRead",
                    "cacheWrite",
                    "totalTokens",
                ] as const) {
                    total[field] += usage[field];
                }

                for (const field of ["cacheWrite1h", "reasoning"] as const) {
                    if (usage[field] !== undefined) {
                        total[field] = (total[field] ?? 0) + usage[field]!;
                    }
                }

                for (const field of [
                    "input",
                    "output",
                    "cacheRead",
                    "cacheWrite",
                    "total",
                ] as const) {
                    total.cost[field] += usage.cost[field];
                }
            }

            const spend = await tx.doc(SpendDoc);

            spend.counted[String(id)] = (spend.counted[String(id)] ?? 0) + usage.cost.total;
            spend.people[payer] = (spend.people[payer] ?? 0) + usage.cost.total;
        }, context);
        this.#app.spend.auxiliaryUsageRecorded();
    }
}
