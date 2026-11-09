/** Shared reset choices and server time formatting for the provider usage sheet and tool. */
import { execFileSync } from "node:child_process";

export type UsageWindow = {
    percent: number;
    resetsAtLocal?: string;
    resetsIn?: string;
};

export type UsageReset = {
    label: "5h" | "wk";
    resetsAtLocal: string;
    resetsIn?: string;
};

/** Show each used window's reset. An unused window has no useful reset time. */
export function usageResets(
    session: UsageWindow | undefined,
    weekly: UsageWindow | undefined,
): UsageReset[] {
    const candidates: { label: UsageReset["label"]; window: UsageWindow | undefined }[] = [
        { label: "5h", window: session },
        { label: "wk", window: weekly },
    ];

    return candidates.flatMap(({ label, window }) => {
        if (window === undefined || window.percent <= 0 || !window.resetsAtLocal) {
            return [];
        }

        return [
            {
                label,
                resetsAtLocal: window.resetsAtLocal,
                ...(window.resetsIn === undefined ? {} : { resetsIn: window.resetsIn }),
            },
        ];
    });
}

/** Format a timestamp with the server's configured zone and its existing label. */
export function localZoneTime(ms: number, zone: string): string {
    try {
        return execFileSync("date", ["-d", `@${Math.floor(ms / 1000)}`, "+%b %-d, %H:%M %Z"], {
            env: { ...process.env, TZ: zone },
            encoding: "utf8",
            timeout: 2000,
        }).trim();
    } catch {
        return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    }
}
