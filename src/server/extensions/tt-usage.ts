/**
 * Provider usage: reads the remaining usage of each provider account (Codex, OpenAI, Claude org, Claude personal), with a page, a tool for the agent, and a probe session.
 *
 * Read-only. It reads each account's access token from the file you name in the settings, sends it only to the
 * address you set for that account, and never prints, logs, stores, or returns it. It adds to the limit gate
 * (`limit-gate.ts`): it only reads `provider-limits.json`, to show the gate beside the numbers. The probe starts one
 * small linked session on the cheapest model, reads its result, then stops and archives it.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook } from "@earendil-works/pi-durable";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionWeb as Web, PocketHost as Host } from "../host.ts";

export const pocketApi = 2;

const ZONE = "America/Edmonton";

/** How one account's usage is found. The owner edits it as JSON in the module's settings. */
type Config = {
    label?: string;
    enabled?: boolean;
    /** The file with the token, and dotted paths into its JSON. `~` is the home folder. */
    credential?: {
        file: string;
        tokenPath: string;
        accountIdPath?: string;
        expiresAtPath?: string;
    };
    url?: string;
    method?: string;
    /** `{{token}}` and `{{accountId}}` are filled in from the credential. */
    headers?: Record<string, string>;
    /** Dotted paths (`a.b.0.c`) into the JSON answer. */
    fields?: {
        sessionPercent?: string;
        sessionResetAt?: string;
        weeklyPercent?: string;
        weeklyResetAt?: string;
        /** A path that is true when the account is blocked. */
        blocked?: string;
        /** A path that is false when the account is blocked. */
        allowed?: string;
        plan?: string;
        extras?: Record<string, string>;
    };
    cacheSeconds?: number;
    /** A shell command that prints the same kind of JSON. Used alone, or when the URL fails. */
    command?: string;
    /** The cheapest model for the probe: `provider/modelId`. */
    probeModel?: string;
    /** No usage endpoint: send one tiny request, but only when a person presses Refresh. */
    probeOnRefresh?: boolean;
};

const CLAUDE_HEADERS = {
    Authorization: "Bearer {{token}}",
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": "2023-06-01",
};
const CLAUDE_FIELDS = {
    sessionPercent: "five_hour.utilization",
    sessionResetAt: "five_hour.resets_at",
    weeklyPercent: "seven_day.utilization",
    weeklyResetAt: "seven_day.resets_at",
    extras: {
        extraUsageEnabled: "extra_usage.is_enabled",
        extraUsageReason: "extra_usage.disabled_reason",
        bucketRemainingUsd: "iguana_necktie.remaining_dollars",
        bucketUsedUsd: "iguana_necktie.used_dollars",
    },
};

const DEFAULTS: Record<string, Config> = {
    "openai-codex": {
        label: "Codex (org)",
        enabled: true,
        credential: {
            file: "~/.pi/agent/auth.json",
            tokenPath: "openai-codex.access",
            accountIdPath: "openai-codex.accountId",
            expiresAtPath: "openai-codex.expires",
        },
        // Node `fetch` and `curl` always get a Cloudflare 403 here, so the URL is left out: one try with the helper.
        url: "",
        method: "GET",
        headers: {
            Authorization: "Bearer {{token}}",
            "Chatgpt-Account-Id": "{{accountId}}",
            originator: "codex_cli_rs",
            "User-Agent": "codex_cli_rs/0.50.0 (Linux 6.11.0 x86_64)",
            Accept: "application/json",
        },
        fields: {
            sessionPercent: "rate_limit.primary_window.used_percent",
            sessionResetAt: "rate_limit.primary_window.reset_at",
            weeklyPercent: "rate_limit.secondary_window.used_percent",
            weeklyResetAt: "rate_limit.secondary_window.reset_at",
            blocked: "rate_limit.limit_reached",
            allowed: "rate_limit.allowed",
            plan: "plan_type",
            extras: {
                blockedReason: "rate_limit_reached_type.type",
                creditsBalance: "credits.balance",
                resetCreditsAvailable: "rate_limit_reset_credits.available_count",
                overageLimitReached: "credits.overage_limit_reached",
            },
        },
        // Node `fetch` and `curl` are challenged by Cloudflare on this host; Python's HTTP stack is not (measured
        // 2026-11-03). So the URL is tried once (fast), then this private helper.
        command: `python3 -I ${join(import.meta.dirname, "tt-usage-codex.py")}`,
        cacheSeconds: 300,
        probeModel: "openai-codex/gpt-6-luna",
        probeOnRefresh: true,
    },
    "claude-code": {
        label: "Claude (org)",
        enabled: true,
        credential: {
            file: "~/.claude/.credentials.json",
            tokenPath: "claudeAiOauth.accessToken",
            expiresAtPath: "claudeAiOauth.expiresAt",
        },
        url: "https://api.anthropic.com/api/oauth/usage",
        method: "GET",
        headers: CLAUDE_HEADERS,
        fields: { ...CLAUDE_FIELDS, plan: "" },
        cacheSeconds: 300,
        probeModel: "claude-code/claude-haiku-5-5",
    },
    "claude-code-personal": {
        label: "Claude (personal)",
        enabled: true,
        credential: {
            file: "~/.claude-personal/.credentials.json",
            tokenPath: "claudeAiOauth.accessToken",
            expiresAtPath: "claudeAiOauth.expiresAt",
        },
        url: "https://api.anthropic.com/api/oauth/usage",
        method: "GET",
        headers: CLAUDE_HEADERS,
        fields: { ...CLAUDE_FIELDS, plan: "" },
        cacheSeconds: 300,
        probeModel: "claude-code-personal/claude-haiku-5-5",
    },
    // No readable usage endpoint exists for this login (checked 2026-11-03): the probe is its only check.
    openai: {
        label: "OpenAI (personal)",
        enabled: true,
        method: "GET",
        cacheSeconds: 300,
        probeModel: "openai/gpt-6-luna",
        probeOnRefresh: true,
    },
    aleph: { label: "Aleph (optional)", enabled: false, url: "", method: "GET", cacheSeconds: 300 },
    "local-inference": {
        label: "Local inference (optional)",
        enabled: false,
        url: "",
        method: "GET",
        cacheSeconds: 60,
    },
};
/** The order everywhere (settings, page, tool): OpenAI personal, Codex org, Claude personal, Claude org. */
const IDS = [
    "openai",
    "openai-codex",
    "claude-code-personal",
    "claude-code",
    "aleph",
    "local-inference",
];

/** What a person reads for each state. One short sentence; no internals. */
const WORDS = {
    "not-checked": "Press Refresh to check.",
    ok: "Within limit.",
    near: "Near the limit.",
    "at-limit": "At the limit.",
    blocked: "Blocked.",
    failed: "Could not check. Try again.",
    "sign-in": "Sign in again.",
} as const;

type State = keyof typeof WORDS;

type Verdict = "ok" | "near-limit" | "blocked" | "unknown";

type Window = { percent: number; resetsAt?: number; resetsAtLocal?: string; resetsIn?: string };

type Report = {
    provider: string;
    label: string;
    verdict: Verdict;
    /** One of `WORDS`. */
    state: State;
    /** The words for `state`: all a person reads. */
    reason: string;
    /** The technical cause, for the owner's logs only. It is never shown. */
    detail?: string;
    session?: Window;
    weekly?: Window;
    plan?: string;
    extras?: Record<string, unknown>;
    /** The limit gate's open gate for this provider, from `provider-limits.json`. */
    gate?: { scope: string; until: string; reason: string; model?: string };
    source: "url" | "command" | "none";
    cached: boolean;
    at: number;
    ms?: number;
    error?: string;
};

// ─── helpers ─────────────────────────────────────────────────────────────────

const home = (path: string) => (path.startsWith("~") ? join(homedir(), path.slice(1)) : path);

function dig(value: unknown, path: string | undefined): unknown {
    if (path === undefined || path === "") {
        return undefined;
    }

    let at: unknown = value;

    for (const part of path.split(".")) {
        if (at === null || typeof at !== "object") {
            return undefined;
        }

        at = (at as Record<string, unknown>)[part];
    }

    return at;
}

/** Milliseconds since 1970 from an ISO string, or from seconds or milliseconds. */
function toMs(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value < 1e11 ? value * 1000 : value;
    }

    if (typeof value === "string" && value !== "") {
        const ms = Date.parse(value);

        return Number.isNaN(ms) ? undefined : ms;
    }

    return undefined;
}

function local(ms: number): string {
    // The system's time data is newer than Node's bundled copy (Alberta changed its rules in 2026), so ask `date`.
    try {
        return execFileSync("date", ["-d", `@${Math.floor(ms / 1000)}`, "+%b %-d, %H:%M %Z"], {
            env: { ...process.env, TZ: ZONE },
            encoding: "utf8",
            timeout: 2000,
        }).trim();
    } catch {
        return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    }
}

function span(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);

    return days > 0
        ? `${days}d ${hours}h`
        : hours > 0
          ? `${hours}h ${minutes % 60}m`
          : `${minutes}m`;
}

function windowOf(percent: unknown, reset: unknown, now: number): Window | undefined {
    const number = typeof percent === "number" ? percent : Number(percent);

    if (percent === undefined || percent === null || !Number.isFinite(number)) {
        return undefined;
    }

    const at = toMs(reset);

    return {
        percent: Math.round(number * 10) / 10,
        ...(at === undefined
            ? {}
            : { resetsAt: at, resetsAtLocal: local(at), resetsIn: span(at - now) }),
    };
}

/** Replaces every secret that is in `text` with `[hidden]`, so no error carries a token. */
function scrub(text: string, secrets: string[]): string {
    let out = text;

    for (const secret of secrets) {
        if (secret.length >= 8) {
            out = out.split(secret).join("[hidden]");
        }
    }

    return out.slice(0, 300);
}

function run(command: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            "bash",
            ["-c", command],
            { timeout: 20_000, maxBuffer: 1_000_000, signal },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
    });
}

// ─── the module ──────────────────────────────────────────────────────────────

export default function createUsage(host: Host, web: Web) {
    web.settings([
        {
            name: "refreshMinutes",
            label: "Refresh every (minutes, 0 = never)",
            description:
                "The timer only fetches accounts whose cache is older than their cache time.",
            type: "number",
            default: 10,
            min: 0,
            max: 1440,
        },
        {
            name: "nearLimitPercent",
            label: "Near-limit at (percent)",
            type: "number",
            default: 80,
            min: 1,
            max: 99,
        },
        ...IDS.map((id) => ({
            name: `config_${id.replaceAll("-", "_")}`,
            label: `Lookup for ${id} (JSON)`,
            description:
                "url, method, headers ({{token}}, {{accountId}}), fields (dotted paths), cacheSeconds, command (shell), credential (file and paths), probeModel, enabled. Clear the box to use the default.",
            type: "text" as const,
            default: JSON.stringify(DEFAULTS[id]),
        })),
    ]);

    const configOf = (id: string): { config: Config; error?: string } => {
        const raw = String(web.setting(`config_${id.replaceAll("-", "_")}`) ?? "").trim();

        if (raw === "") {
            return { config: DEFAULTS[id]! };
        }

        try {
            const parsed = JSON.parse(raw) as Config;

            if (parsed === null || typeof parsed !== "object") {
                throw new Error("not an object");
            }

            return { config: parsed };
        } catch (error) {
            return { config: { enabled: false }, error: `Bad JSON in settings: ${String(error)}` };
        }
    };

    const cache = new Map<string, Report>();
    /** The last probe of each account, shown beside its numbers. */
    const probes = new Map<string, { text: string; at: number }>();
    /** The reasoning effort the last request to each model carried (a record only; it changes nothing). */
    const efforts = new Map<string, string>();

    if (typeof host.shapeModelRequests === "function") {
        web.onDispose(
            host.shapeModelRequests((payload, model) => {
                const body = payload as {
                    reasoning?: { effort?: string };
                    reasoning_effort?: string;
                    thinking?: unknown;
                };

                efforts.set(
                    `${model.provider}/${model.id}`,
                    JSON.stringify(
                        body?.reasoning ?? body?.reasoning_effort ?? body?.thinking ?? "none-sent",
                    ),
                );

                return undefined;
            }),
        );
    }

    const inflight = new Map<string, Promise<Report>>();

    /** The open gates of the reactive limit gate. Read only. */
    function gateOf(id: string, now: number): Report["gate"] {
        try {
            const file = JSON.parse(
                readFileSync(join(host.dataDir, "provider-limits.json"), "utf8"),
            );

            for (const gate of file.gates ?? []) {
                if (gate.provider === id && typeof gate.until === "number" && gate.until > now) {
                    return {
                        scope: String(gate.scope),
                        until: local(gate.until),
                        reason: String(gate.reason ?? "").slice(0, 200),
                        ...(gate.modelId ? { model: String(gate.modelId) } : {}),
                    };
                }
            }
        } catch {
            // No file, or a damaged one: no gate is known.
        }

        return undefined;
    }

    /**
     * Ask the agent's own provider to renew a sign-in (it renews a token near its end and writes `auth.json` itself; this
     * module never writes it). Returns the agent's words when the provider refuses, else undefined.
     */
    async function renewWithPi(spec: string | undefined): Promise<string | undefined> {
        if (spec === undefined || typeof host.modelProblem !== "function") {
            return undefined;
        }

        try {
            return await host.modelProblem(host.resolveModel(spec), true);
        } catch (error) {
            return String((error as Error).message ?? error).slice(0, 160);
        }
    }

    async function lookup(id: string, signal: AbortSignal): Promise<Report> {
        const started = Date.now();
        const { config, error: configError } = configOf(id);
        const base = {
            provider: id,
            label: config.label ?? id,
            at: started,
            cached: false,
        };
        const secrets: string[] = [];
        const fail = (
            detail: string,
            source: Report["source"] = "none",
            state: State = "failed",
        ): Report => ({
            ...base,
            verdict: "unknown",
            state,
            reason: WORDS[state],
            detail: scrub(detail, secrets),
            source,
            error: scrub(detail, secrets),
            ms: Date.now() - started,
        });

        if (configError !== undefined) {
            return fail(configError);
        }

        if (config.enabled === false) {
            return fail("Turned off in the settings.");
        }

        let token = "";
        let accountId = "";
        let agedAt: number | undefined;
        let refreshKept = false;
        let noRefresh = false;

        if (config.credential !== undefined) {
            try {
                const file = JSON.parse(readFileSync(home(config.credential.file), "utf8"));

                token = String(dig(file, config.credential.tokenPath) ?? "");
                accountId = String(dig(file, config.credential.accountIdPath) ?? "");

                const expires = toMs(dig(file, config.credential.expiresAtPath));

                secrets.push(token, accountId);

                if (token === "") {
                    return fail("No token in the credential file.", "none", "sign-in");
                }

                // An aged access token is not an expired login. The agent's own sign-ins (a `probeModel` of this account) are
                // renewed by the agent; a Claude token belongs to the Claude CLI, which renews it itself.
                if (expires !== undefined && expires < started && id === "openai-codex") {
                    const refused = await renewWithPi(config.probeModel);

                    if (refused !== undefined) {
                        return fail(`the agent could not renew this sign-in: ${refused}`);
                    }

                    const again = JSON.parse(readFileSync(home(config.credential.file), "utf8"));

                    token = String(dig(again, config.credential.tokenPath) ?? "");
                    accountId = String(dig(again, config.credential.accountIdPath) ?? "");
                    secrets.push(token, accountId);
                }

                agedAt = expires !== undefined && expires < started ? expires : undefined;
                const base = config.credential.tokenPath.split(".").slice(0, -1).join(".");

                refreshKept =
                    dig(file, `${base}.refresh`) !== undefined ||
                    dig(file, `${base}.refreshToken`) !== undefined;
            } catch (error) {
                return fail(`Cannot read the credential file: ${(error as Error).message}`);
            }
        }

        let data: unknown;
        let source: Report["source"] = "none";
        let urlError = "";

        if ((config.url ?? "") !== "") {
            try {
                const headers: Record<string, string> = {};

                for (const [name, value] of Object.entries(config.headers ?? {})) {
                    headers[name] = value
                        .replaceAll("{{token}}", token)
                        .replaceAll("{{accountId}}", accountId);
                }

                const ask = async () => {
                    const response = await fetch(config.url!, {
                        method: config.method ?? "GET",
                        headers,
                        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
                    });

                    return { response, text: await response.text() };
                };

                let { response, text } = await ask();

                // A Cloudflare challenge page (HTML 403) often passes on a retry (up to 3).
                for (const wait of (config.command ?? "") === "" ? [4000, 8000, 12000] : []) {
                    if (response.status !== 403 || !/^\s*</.test(text)) {
                        break;
                    }

                    await new Promise((resolve) => setTimeout(resolve, wait));
                    ({ response, text } = await ask());
                }

                if (!response.ok) {
                    const html = /^\s*</.test(text);

                    throw new Error(
                        `HTTP ${response.status}${html ? " (an HTML challenge page: check the headers)" : `: ${text.slice(0, 120)}`}`,
                    );
                }

                data = JSON.parse(text);
                source = "url";
            } catch (error) {
                urlError = scrub(String((error as Error).message ?? error), secrets);

                if (agedAt !== undefined && /HTTP 401/.test(urlError)) {
                    urlError = refreshKept
                        ? "The provider answered 401; a refresh token exists."
                        : "The provider answered 401 and there is no refresh token.";
                    noRefresh = !refreshKept;
                }
            }
        }

        if (data === undefined && (config.command ?? "") !== "") {
            try {
                data = JSON.parse(await run(config.command!, signal));
                source = "command";
            } catch (error) {
                return fail(
                    `${urlError === "" ? "" : `URL failed (${urlError}); `}Command failed: ${scrub(String((error as Error).message), secrets)}`,
                    "command",
                );
            }
        }

        if (data === undefined) {
            return urlError === ""
                ? { ...fail("No usage endpoint is set.", "url", "not-checked"), verdict: "unknown" }
                : fail(urlError, "url", noRefresh ? "sign-in" : "failed");
        }

        const fields = config.fields ?? {};
        const now = Date.now();
        const session = windowOf(
            dig(data, fields.sessionPercent),
            dig(data, fields.sessionResetAt),
            now,
        );
        const weekly = windowOf(
            dig(data, fields.weeklyPercent),
            dig(data, fields.weeklyResetAt),
            now,
        );
        const extras: Record<string, unknown> = {};

        for (const [name, path] of Object.entries(fields.extras ?? {})) {
            const value = dig(data, path);

            if (value !== undefined && value !== null && typeof value !== "object") {
                extras[name] = value;
            }
        }

        const plan = dig(data, fields.plan);
        const flagged = dig(data, fields.blocked) === true || dig(data, fields.allowed) === false;
        const near = Number(web.setting("nearLimitPercent") ?? 80);
        const worst = Math.max(session?.percent ?? 0, weekly?.percent ?? 0);
        const gate = gateOf(id, now);
        let verdict: Verdict;
        let reason: string;
        let state: State;

        if (session === undefined && weekly === undefined && !flagged) {
            verdict = "unknown";
            reason = "The answer had none of the configured fields.";
            state = "failed";
        } else if (flagged || worst >= 100) {
            verdict = "blocked";
            reason = flagged
                ? `The provider says the limit is reached${extras.blockedReason ? ` (${String(extras.blockedReason)})` : ""}.`
                : "A window is at 100 percent.";
            state = flagged ? "blocked" : "at-limit";
        } else if (worst >= near) {
            verdict = "near-limit";
            reason = `A window is at ${worst} percent.`;
            state = "near";
        } else {
            verdict = "ok";
            reason = `The highest window is at ${worst} percent.`;
            state = "ok";
        }

        if (gate !== undefined && verdict === "ok") {
            verdict = "blocked";
            reason = "The numbers look fine, but the limit gate holds this provider.";
            state = "blocked";
        }

        return {
            ...base,
            verdict,
            state,
            reason: WORDS[state],
            detail: reason,
            ...(session ? { session } : {}),
            ...(weekly ? { weekly } : {}),
            ...(typeof plan === "string" && plan !== "" ? { plan } : {}),
            ...(Object.keys(extras).length > 0 ? { extras } : {}),
            ...(gate ? { gate } : {}),
            source,
            ms: Date.now() - started,
        };
    }

    const withProbe = (report: Report & { probe?: string }): Report & { probe?: string } => {
        const probe = probes.get(report.provider);

        return probe === undefined
            ? report
            : { ...report, probe: `${probe.text} (${new Date(probe.at).toISOString()})` };
    };

    /**
     * the agent's own model runtime (`api.models`), kept from the last tool call. A route has no `models`, so the Refresh
     * button can probe only after a tool of this module ran once in this server's life.
     */
    let runtime:
        | {
              getModel(provider: string, modelId: string): unknown;
              completeSimple(model: never, context: never, options?: never): Promise<never>;
          }
        | undefined;

    /**
     * One tiny completion through the agent's own runtime: no system prompt, no tools, nothing saved, no session. The runtime
     * renews the sign-in and writes `auth.json` itself; this module reads no token. The reply text is never read.
     */
    async function probeDirect(id: string, signal: AbortSignal): Promise<Report> {
        const started = Date.now();
        const { config } = configOf(id);
        const base = {
            provider: id,
            label: config.label ?? id,
            at: started,
            cached: false,
            source: "none" as const,
        };
        const [provider, modelId] = String(config.probeModel ?? "").split("/");
        const done = (verdict: Verdict, state: State, detail: string): Report => ({
            ...base,
            verdict,
            state,
            reason: WORDS[state],
            detail: detail.slice(0, 300),
            ms: Date.now() - started,
        });
        const model = runtime?.getModel(provider ?? "", modelId ?? "");

        if (runtime === undefined || model === undefined) {
            return done(
                "unknown",
                "not-checked",
                "No model runtime yet: no session has sent a request.",
            );
        }

        try {
            const reply = (await runtime.completeSimple(
                model as never,
                {
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text", text: "Reply with OK." }],
                            timestamp: Date.now(),
                        },
                    ],
                } as never,
                {
                    maxTokens: 16,
                    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
                } as never,
            )) as { stopReason?: string; errorMessage?: string };

            if (reply.stopReason === "error" || reply.stopReason === "aborted") {
                const kind = classify(String(reply.errorMessage ?? ""));

                return done(
                    kind === "limit" ? "blocked" : "unknown",
                    kind === "limit" ? "at-limit" : "failed",
                    `Probe failed, class ${kind}: ${String(reply.errorMessage ?? "no error text")
                        .replace(/\s+/g, " ")
                        .slice(0, 200)}`,
                );
            }

            return done("ok", "ok", `Answered a probe in ${Date.now() - started} ms.`);
        } catch (error) {
            return done(
                "unknown",
                "failed",
                `Probe failed (class ${classify(String((error as Error).message))}): ${(error as Error).message}`,
            );
        }
    }

    /** One report: from the cache when it is fresh, else asked again. Calls for one account share one request. */
    async function usage(
        id: string,
        force: boolean,
        signal: AbortSignal,
        probe = false,
    ): Promise<Report> {
        // Accounts with a `probeOnRefresh` config have no usage endpoint: the tiny request runs ONLY when a person
        // presses Refresh (`probe`). The timer, the page load, and the tool never send it; they show the last result.
        if (configOf(id).config.probeOnRefresh === true) {
            if (probe) {
                const checked = await probeDirect(id, signal);
                let report = checked;

                // One try for numbers, when this account has a way to read them. The probe still decides when it fails.
                if (
                    checked.state !== "not-checked" &&
                    ((configOf(id).config.command ?? "") !== "" ||
                        (configOf(id).config.url ?? "") !== "")
                ) {
                    const numbers = await lookup(id, signal);

                    if (numbers.session !== undefined || numbers.weekly !== undefined) {
                        report =
                            checked.verdict === "blocked"
                                ? {
                                      ...numbers,
                                      verdict: "blocked",
                                      state: checked.state,
                                      reason: checked.reason,
                                  }
                                : numbers;
                    }
                }

                cache.set(id, report);

                return report;
            }

            const kept = cache.get(id);

            return kept === undefined
                ? {
                      provider: id,
                      label: configOf(id).config.label ?? id,
                      verdict: "unknown" as const,
                      state: "not-checked" as const,
                      reason: WORDS["not-checked"],
                      source: "none" as const,
                      cached: false,
                      at: Date.now(),
                  }
                : { ...kept, cached: true };
        }

        const seconds = Number(configOf(id).config.cacheSeconds ?? 300);
        const kept = cache.get(id);

        if (!force && kept !== undefined && Date.now() - kept.at < seconds * 1000) {
            return withProbe({ ...kept, cached: true });
        }

        let pending = inflight.get(id);

        if (pending === undefined) {
            pending = lookup(id, signal).finally(() => inflight.delete(id));
            inflight.set(id, pending);
        }

        const report = await pending;

        cache.set(id, report);

        return withProbe(report);
    }

    async function all(
        force: boolean,
        signal: AbortSignal,
        only?: string,
        probe = false,
    ): Promise<Report[]> {
        const ids =
            only === undefined ? IDS.filter((id) => configOf(id).config.enabled !== false) : [only];

        return Promise.all(ids.map((id) => usage(id, force, signal, probe)));
    }

    /** The limit gate's wait setting, read only. */
    function waitHours(): number | undefined {
        try {
            return JSON.parse(readFileSync(join(host.dataDir, "config.json"), "utf8"))
                .limitWaitHours;
        } catch {
            return undefined;
        }
    }

    function describe(reports: Report[]): string {
        const lines = reports.map((report) => {
            const parts = [`${report.label}: ${report.reason}`];

            if (report.session) {
                parts.push(
                    `  5-hour window: ${report.session.percent}%${report.session.resetsAtLocal ? `, resets ${report.session.resetsAtLocal} (in ${report.session.resetsIn})` : ""}`,
                );
            }

            if (report.weekly) {
                parts.push(
                    `  weekly window: ${report.weekly.percent}%${report.weekly.resetsAtLocal ? `, resets ${report.weekly.resetsAtLocal} (in ${report.weekly.resetsIn})` : ""}`,
                );
            }

            if (report.plan) {
                parts.push(`  plan: ${report.plan}`);
            }

            if (report.extras) {
                parts.push(`  extras: ${JSON.stringify(report.extras)}`);
            }

            if (report.gate) {
                parts.push(`  Held until ${report.gate.until}.`);
            }

            parts.push(`  checked ${local(report.at)}`);

            return parts.join("\n");
        });

        return `${lines.join("\n")}\nTimes are ${ZONE}.`;
    }

    /** Private to the owner: a tool call from a session that another person steers must not show these numbers. */
    function requireOwner(conversationId: Parameters<typeof host.requesterOf>[0]): void {
        let users: { id: string; role: string }[] = [];

        try {
            users = JSON.parse(readFileSync(join(host.dataDir, "config.json"), "utf8")).users ?? [];
        } catch {
            throw new Error("Cannot check who asked, so usage is not shown.");
        }

        const by = host.requesterOf(conversationId);
        const owner =
            by === undefined
                ? users.length === 1
                : users.some((user) => user.id === by && user.role === "owner");

        if (!owner) {
            throw new Error("Provider usage is private to the owner.");
        }
    }

    // ─── tools ───────────────────────────────────────────────────────────────

    const provider = Type.Optional(
        Type.String({
            description: `One of: ${IDS.join(", ")}. Leave out for all enabled accounts.`,
        }),
    );

    const usageTool = Object.assign(
        defineTool({
            name: "provider_usage",
            description:
                "Remaining usage of each provider account (Codex, OpenAI, Claude org, Claude personal): the 5-hour and weekly percent, reset times in America/Edmonton, and a verdict (ok, near-limit, blocked, unknown). Read only; uses a cache.",
            parameters: Type.Object({
                provider,
                refresh: Type.Optional(Type.Boolean({ description: "Skip the cache" })),
            }),
            replay: "safe",
            execute: async (args, api) => {
                requireOwner(api.conversationId);
                runtime = api.models as never;

                if (args.provider !== undefined && !IDS.includes(args.provider)) {
                    throw new Error(`Unknown provider. Use one of: ${IDS.join(", ")}`);
                }

                const reports = await all(
                    args.refresh === true,
                    new AbortController().signal,
                    args.provider,
                );

                return {
                    output: [
                        { type: "text" as const, text: describe(reports) },
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                reports.map((r) => ({
                                    provider: r.provider,
                                    verdict: r.verdict,
                                    session: r.session,
                                    weekly: r.weekly,
                                })),
                            ),
                        },
                    ],
                };
            },
        }),
        { annotations: { readOnlyHint: true } },
    );

    // ─── the probe ───────────────────────────────────────────────────────────

    type Entry = {
        kind: string;
        text?: string;
        stopReason?: string;
        error?: string;
        blocks?: { type: string; text?: string }[];
    };

    /** The local API, as the owner: the one way to read a session's answer and to archive it. */
    function localApi() {
        const argv = process.argv;

        const at = (flag: string, fallback: string) => {
            const index = argv.indexOf(flag);

            return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
        };

        const token = String(
            JSON.parse(readFileSync(join(host.dataDir, "config.json"), "utf8")).ownerToken ?? "",
        );
        const base = `http://${at("--host", "127.0.0.1")}:${at("--port", "8787")}`;

        return async (path: string, body?: object) => {
            const response = await fetch(`${base}${path}`, {
                method: body === undefined ? "GET" : "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "X-Pocket": "1",
                    "content-type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(15_000),
            });

            if (!response.ok) {
                throw new Error(`local API ${path}: HTTP ${response.status}`);
            }

            return response.json() as Promise<unknown>;
        };
    }

    function classify(text: string): string {
        if (
            /rate.?limit|usage limit|quota|credits|limit reached|too many requests|429|out of/i.test(
                text,
            )
        ) {
            return "limit";
        }

        if (/401|403|unauthori[sz]ed|forbidden|not logged in|log ?in|expired|auth/i.test(text)) {
            return "auth";
        }

        if (
            /5\d\d|overloaded|timeout|timed out|network|ECONN|ENOTFOUND|fetch failed|unavailable/i.test(
                text,
            )
        ) {
            return "transient";
        }

        return "other";
    }

    const probeTool = defineTool({
        name: "provider_usage_probe",
        description:
            "Fallback when usage cannot be read: starts one throwaway linked session on the account's cheapest model (thinking off) with one tiny request, says if the provider answered, blocked the request, or failed (with the class), then stops and archives it. Costs one small request on that account.",
        parameters: Type.Object({
            provider: Type.String({ description: `One of: ${IDS.join(", ")}` }),
            model: Type.Optional(
                Type.String({ description: "provider/modelId; default: the account's cheapest" }),
            ),
            timeoutSeconds: Type.Optional(
                Type.Number({ description: "Wait at most this long; default 90" }),
            ),
        }),
        // A restart cuts it off: do not run it twice.
        execute: async (args, api) => {
            requireOwner(api.conversationId);

            if (!IDS.includes(args.provider)) {
                throw new Error(`Unknown provider. Use one of: ${IDS.join(", ")}`);
            }

            const spec = args.model ?? configOf(args.provider).config.probeModel;

            if (spec === undefined || spec === "") {
                throw new Error("This provider has no probeModel in the settings.");
            }

            if (typeof host.linkedSessions?.start !== "function") {
                throw new Error("This Pia has no linked sessions.");
            }

            const info = host.modelInfo(spec);
            const levels = info?.thinkingLevels ?? [];
            const thinking =
                levels.length === 0 || levels.includes("off" as never) ? "off" : String(levels[0]);
            const started = Date.now();
            const { session } = await host.linkedSessions.start(
                api.conversationId,
                {
                    title: `[usage probe] ${args.provider}`,
                    message: "Reply with the single word OK. Do not use any tool.",
                    model: spec,
                    thinking,
                },
                `tt-usage-probe:${api.taskId}:${api.callId}`,
            );
            const call = localApi();
            const limit = Math.min(300, Math.max(10, args.timeoutSeconds ?? 90)) * 1000;
            let outcome = "waiting";
            let detail = "";
            let answer: Entry | undefined;

            try {
                while (Date.now() - started < limit) {
                    await new Promise((resolve) => setTimeout(resolve, 2500));

                    const entries = (await call(
                        `/api/c/${session}/history?before=${Number.MAX_SAFE_INTEGER}`,
                    )) as Entry[];

                    answer = entries.filter((entry) => entry.kind === "assistant").at(-1);

                    if (answer?.stopReason !== undefined && answer.stopReason !== "toolUse") {
                        break;
                    }
                }

                if (answer?.stopReason === "stop" || answer?.stopReason === "length") {
                    outcome = "answered";
                    detail = (answer.blocks ?? [])
                        .map((block) => block.text ?? "")
                        .join("")
                        .slice(0, 80);
                } else if (answer?.stopReason === "error" || answer?.stopReason === "aborted") {
                    const kind = classify(answer.error ?? "");

                    outcome = kind === "limit" ? "blocked" : "failed";
                    detail = `class ${kind}: ${String(answer.error ?? "no error text")
                        .replace(/\s+/g, " ")
                        .slice(0, 240)}`;
                } else {
                    outcome = "blocked";
                    detail =
                        "no answer in time; the request most likely waits at the limit gate (class limit-wait)";
                }
            } finally {
                // Stop and archive the throwaway session, even when the check failed.
                await call(`/api/c/${session}/abort`, {}).catch(() => undefined);
                await call(`/api/sessions/${session}`, { archived: true }).catch(() => undefined);
            }

            const retry = /retry[- ]after[:= ]+"?(\d+)/i.exec(detail)?.[1];
            const effort = efforts.get(spec) ?? "not seen";

            probes.set(args.provider, {
                text: `${outcome}${retry ? `, retry-after ${retry} s` : ""}: ${detail.slice(0, 100)}`,
                at: Date.now(),
            });
            detail += `${retry ? ` retry-after ${retry} s.` : ""} effort sent: ${effort}.`;
            cache.delete(args.provider);

            return {
                output: [
                    {
                        type: "text" as const,
                        text: `probe ${args.provider} on ${spec} (thinking ${thinking}): ${outcome.toUpperCase()}. ${detail}\ntook ${Math.round((Date.now() - started) / 1000)} s; session ${session} stopped and archived.`,
                    },
                ],
            };
        },
    });

    // ─── the app ─────────────────────────────────────────────────────────────

    web.route(
        "GET",
        "usage",
        async ({ signal }) => ({
            zone: ZONE,
            limitWaitHours: waitHours() ?? null,
            reports: await all(false, signal),
        }),
        { access: "owner" },
    );
    web.route(
        "POST",
        "refresh",
        async ({ signal, body }) => {
            const only =
                typeof body.provider === "string" && IDS.includes(body.provider)
                    ? body.provider
                    : undefined;

            return {
                zone: ZONE,
                limitWaitHours: waitHours() ?? null,
                reports: await all(true, signal, only, true),
            };
        },
        { access: "owner" },
    );
    web.client("tt-usage.mjs", { access: "owner" });

    // The timer fetches only what is stale, so it costs one request per account per cache time at most.
    let timer: ReturnType<typeof setInterval> | undefined;

    const arm = () => {
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }

        const minutes = Number(web.setting("refreshMinutes") ?? 10);

        if (minutes > 0) {
            timer = setInterval(() => {
                void all(false, new AbortController().signal).then(
                    (reports) =>
                        web.send("usage", {
                            zone: ZONE,
                            limitWaitHours: waitHours() ?? null,
                            reports,
                        }),
                    () => undefined,
                );
            }, minutes * 60_000);
            timer.unref();
        }
    };

    arm();
    web.onSettings(() => {
        cache.clear();
        arm();
    });
    web.onDispose(() => {
        if (timer !== undefined) {
            clearInterval(timer);
        }
    });

    // Keeps the agent's model runtime from any session's next request. It changes nothing and returns nothing.
    const keepRuntime = hook(GenerationTask, {
        beforeRequest: (_request, api) => {
            runtime = api.models as never;

            return undefined;
        },
    });

    return defineExtension({
        name: "tt-usage",
        tools: [usageTool, probeTool],
        hooks: [keepRuntime],
    });
}
