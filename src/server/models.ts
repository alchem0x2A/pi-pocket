/**
 * Models as browsers see them: the ones available, the one a conversation runs with, finding one by name, and the
 * thinking levels.
 */
import {
    type Api,
    getSupportedThinkingLevels,
    type Model,
    type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ModelRuntime, ScopedModel } from "@earendil-works/pi-coding-agent";
import type { AgentState, ModelRef } from "@earendil-works/pi-durable";

import { words } from "./model-names.ts";

// A record, so a level Pi adds fails the type check until it is here too.
const LEVELS: Record<ModelThinkingLevel, true> = {
    off: true,
    minimal: true,
    low: true,
    medium: true,
    high: true,
    xhigh: true,
    max: true,
};

/** Every thinking level, lowest first: what a session's model picker, the default model, and the subagent tool take. */
export const THINKING_LEVELS: readonly ModelThinkingLevel[] = Object.freeze(
    Object.keys(LEVELS) as ModelThinkingLevel[],
);

/** Whether `level` names a thinking level. */
export function isThinkingLevel(level: unknown): level is ModelThinkingLevel {
    return typeof level === "string" && Object.hasOwn(LEVELS, level);
}

type ModelSummary = {
    provider: string;
    id: string;
    name: string;
    contextWindow: number;
    reasoning: boolean;
    images: boolean;
    levels: string[];
    scoped?: true;
    /** Its provider's sign-in expired and could not be renewed: it works again once someone signs in. */
    signIn?: true;
};

/** Whether a provider's sign-in expired and needs a person to sign in again (`Providers.needsSignIn`). */
export type SignInNeeded = (provider: string) => boolean;

/** The highest of `model`'s thinking levels that is not above `level`; undefined when even its lowest is. */
export function levelAtMost(
    model: Model<Api>,
    level: ModelThinkingLevel,
): ModelThinkingLevel | undefined {
    const supported = model.reasoning ? getSupportedThinkingLevels(model) : ["off"];

    return THINKING_LEVELS.slice(0, THINKING_LEVELS.indexOf(level) + 1)
        .reverse()
        .find((each) => supported.includes(each));
}

/** The level a model thinks at when `level` is asked: `level` itself, else its nearest lower one, else its lowest. */
export function levelFor(model: Model<Api>, level: ModelThinkingLevel): ModelThinkingLevel {
    const supported = model.reasoning ? getSupportedThinkingLevels(model) : ["off"];

    return levelAtMost(model, level) ?? THINKING_LEVELS.find((each) => supported.includes(each))!;
}

/** Whether a model thinks, and at which levels, and whether it takes images. */
function capabilities(model: Model<Api>) {
    return {
        reasoning: model.reasoning === true,
        images: model.input.includes("image"),
        levels: model.reasoning ? getSupportedThinkingLevels(model) : ["off"],
    };
}

/** A `*` and `?` glob as a case-insensitive regular expression that matches the whole text. */
function globPattern(glob: string): RegExp {
    const source = glob
        .split("")
        .map((char) =>
            char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\/]/g, "\\$&"),
        )
        .join("");

    return new RegExp(`^${source}$`, "i");
}

/**
 * Whether a model is hidden by Pi Pocket's `hiddenModels` setting: each pattern is a glob that matches `provider/id`,
 * or the id alone. Invalid entries are ignored.
 */
export function hiddenBy(patterns: unknown): (provider: string, id: string) => boolean {
    const globs = Array.isArray(patterns)
        ? patterns
              .filter((pattern): pattern is string => typeof pattern === "string" && pattern !== "")
              .map(globPattern)
        : [];

    return (provider, id) => globs.some((glob) => glob.test(`${provider}/${id}`) || glob.test(id));
}

/**
 * The models people can pick: the ones with a configured sign-in, marked when that sign-in needs renewing. `hidden`
 * leaves out models a person asked not to see; a scoped model always stays.
 */
export function modelList(
    models: ModelRuntime,
    signInNeeded: SignInNeeded = () => false,
    scopedModels: readonly ScopedModel[] = [],
    hidden: (provider: string, id: string) => boolean = () => false,
): ModelSummary[] {
    const scoped = new Set(scopedModels.map(({ model }) => `${model.provider}/${model.id}`));

    return models
        .getAvailableSnapshot()
        .filter(
            (model) =>
                scoped.has(`${model.provider}/${model.id}`) || !hidden(model.provider, model.id),
        )
        .map((model) => ({
            provider: model.provider,
            id: model.id,
            name: model.name,
            contextWindow: model.contextWindow,
            ...capabilities(model),
            ...(scoped.has(`${model.provider}/${model.id}`) ? { scoped: true as const } : {}),
            ...(signInNeeded(model.provider) ? { signIn: true as const } : {}),
        }));
}

/** A signed-in model by `provider/id`, or by id alone; undefined when there is none. */
export function findModel(models: ModelRuntime, spec: string): Model<Api> | undefined {
    const trimmed = spec.trim();
    const available = models.getAvailableSnapshot();
    const slash = trimmed.indexOf("/");

    return slash > 0
        ? available.find(
              (model) =>
                  model.provider === trimmed.slice(0, slash) &&
                  model.id === trimmed.slice(slash + 1),
          )
        : available.find((model) => model.id === trimmed);
}

const STOP_WORDS = new Set(["the", "a", "an", "model", "use", "on", "with", "via", "from", "at", "to", "please", "mode", "thinking", "effort"]);

/** The numbers in a model's words, for preferring a newer version among equals. */
const versionOf = (tokens: readonly string[]) =>
    tokens.filter((token) => /^\d+$/u.test(token)).map(Number);

/** Whether version `a` is newer than `b`. */
function newer(a: readonly number[], b: readonly number[]): boolean {
    for (let at = 0; at < Math.max(a.length, b.length); at += 1) {
        const diff = (a[at] ?? 0) - (b[at] ?? 0);

        if (diff !== 0) {
            return diff > 0;
        }
    }

    return false;
}

/**
 * Best-effort reading of a loose model name ("luna max", "codex sol", "opus", "gpt-6.1-sol high"): the candidates that
 * fit it, best first, and a thinking level it names. Every word of the text should appear in the model's provider, id,
 * or name (a word may start one); words that name a provider ("codex") put that provider's models first; of equals,
 * the shorter name, then the newer version, then the earlier in the list.
 */
export function rankModels<T extends { provider: string; id: string; name?: string }>(
    text: string,
    candidates: readonly T[],
): { models: T[]; level: ModelThinkingLevel | undefined } {
    const said = words(text.replace(/[/_]/gu, " "));
    const levelAt = said.findLastIndex((word) => isThinkingLevel(word));
    const level = levelAt < 0 ? undefined : (said[levelAt] as ModelThinkingLevel);
    const wanted = said.filter((word, at) => at !== levelAt && !STOP_WORDS.has(word));
    const scored = candidates.flatMap((candidate, order) => {
        const own = words(`${candidate.provider} ${candidate.id} ${candidate.name ?? ""}`);
        const matched = wanted.filter((word) =>
            own.some((each) => each === word || (word.length > 2 && each.startsWith(word))),
        ).length;
        const provider = words(candidate.provider);
        const named = wanted.filter((word) => provider.includes(word)).length;

        return wanted.length === 0 || matched < wanted.length
            ? []
            : [{ candidate, order, matched, named, extra: new Set(own).size, version: versionOf(own) }];
    });

    scored.sort(
        (a, b) =>
            b.matched - a.matched ||
            b.named - a.named ||
            a.extra - b.extra ||
            (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0) ||
            a.order - b.order,
    );

    return { models: scored.map((each) => each.candidate), level };
}

/** Local metadata for one exact model, including models without configured auth. Never contacts a provider. */
export function modelInfo(models: ModelRuntime, spec: string) {
    const slash = spec.indexOf("/");
    const model =
        slash > 0 ? models.getModel(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;

    return model === undefined
        ? undefined
        : {
              model: { provider: model.provider, modelId: model.id },
              name: model.name,
              thinkingLevels: capabilities(model).levels as ModelThinkingLevel[],
              contextWindow: model.contextWindow,
              // Dollars per million tokens; left out when the catalog has no price.
              ...(model.cost.input > 0 || model.cost.output > 0
                  ? { cost: { input: model.cost.input, output: model.cost.output } }
                  : {}),
          };
}

/** Whether `spec` (`provider/id`, or an id alone) names the model `ref`. */
export function sameModel(spec: string, ref: ModelRef | undefined): boolean {
    const trimmed = spec.trim();

    return (
        ref !== undefined &&
        (trimmed === `${ref.provider}/${ref.modelId}` || trimmed === ref.modelId)
    );
}

/**
 * A signed-in model by `provider/id`, or by id alone, whose sign-in works as far as anyone knows. The error names no
 * other models: offered a list, Pi would pick from it, and models are a person's to choose.
 */
export function resolveModel(
    models: ModelRuntime,
    spec: string,
    signInNeeded: SignInNeeded = () => false,
): ModelRef {
    const found = findModel(models, spec);

    if (found === undefined) {
        throw new Error(`Model ${spec} is not available here.`);
    }

    if (signInNeeded(found.provider)) {
        throw new Error(
            `Model ${spec} is not available: the sign-in of its provider, ${found.provider}, expired and needs a person to sign in again.`,
        );
    }

    return { provider: found.provider, modelId: found.id };
}

/** What a conversation runs with, for its view: its model and what the model can do, thinking, folder, instructions. */
export function agentInfo(
    models: ModelRuntime,
    agent: AgentState,
    defaultCwd: string,
    signInNeeded: SignInNeeded = () => false,
) {
    const model =
        agent.model === undefined
            ? undefined
            : models.getModel(agent.model.provider, agent.model.modelId);

    return {
        model: agent.model ?? null,
        thinkingLevel: agent.thinkingLevel ?? "off",
        cwd: agent.cwd ?? defaultCwd,
        ...(agent.instructions === undefined ? {} : { instructions: agent.instructions }),
        available:
            model !== undefined &&
            models.hasConfiguredAuth(model.provider) &&
            !signInNeeded(model.provider),
        ...(model === undefined
            ? {}
            : {
                  modelName: model.name,
                  contextWindow: model.contextWindow,
                  ...capabilities(model),
              }),
    };
}
