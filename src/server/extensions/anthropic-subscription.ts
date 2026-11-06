/**
 * Claude subscription billing: adds the header that makes Anthropic count Pia's requests against a Claude
 * subscription. Anthropic says third-party apps draw from subscription limits, but its classifier can bill them as
 * extra usage instead, and refuse them when that pool is empty. Anthropic may change how it classifies requests. While
 * this is off, requests go out as the agent builds them.
 */
import { isClaudeCodeRequest, shapeRequest } from "../anthropic-shape.ts";
import type { ExtensionWeb, PocketHost } from "../host.ts";

export default function createAnthropicSubscription(host: PocketHost, web: ExtensionWeb): void {
    const stop = host.shapeModelRequests((payload, model) =>
        model.provider === "anthropic" && isClaudeCodeRequest(payload)
            ? shapeRequest(payload)
            : undefined,
    );

    web.onDispose(stop);
}
