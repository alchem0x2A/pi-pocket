/**
 * Restart requests: Pi's request_restart tool asks the owner to restart the server after it changes the server's code,
 * with a button in the app that restarts once no tool call runs. Pi never restarts the server itself.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

export const RESTART_EXTENSION = "pocket-restart";

export default function createRestart(host: PocketHost) {
    // A server started before restart requests has no `host.restarts`: the module installs nothing until it restarts.
    const restarts = (host as Partial<PocketHost>).restarts;

    if (restarts === undefined) {
        return defineExtension({ name: RESTART_EXTENSION });
    }

    const tool = defineTool({
        name: "request_restart",
        description:
            "Ask the owner to restart the Pi Pocket server, after you changed its server code (src/server/, not its extensions/ or web/). The owner gets a button that checks that the new code loads, then restarts once no tool call runs. Finish your edits and checks first; never restart the server another way. Actions: request (reason), status.",
        parameters: Type.Object({
            action: Type.Union([Type.Literal("request"), Type.Literal("status")]),
            reason: Type.Optional(
                Type.String({ description: "request: what changed, in one short sentence" }),
            ),
        }),
        // Safe to run again: the same call asks once (its id is the call's).
        replay: "safe",
        execute: async (args, api) => {
            const status = restarts.status();
            const changes =
                status.changedCount === 0
                    ? "No server file differs from what this server started with."
                    : `${status.changedCount} server files differ from what this server started with: ${status.changed.slice(0, 10).join(", ")}${status.changedCount > 10 ? ", …" : ""}.`;
            const launcher = status.launcherChanged
                ? " The launcher's code changed too: only a restart of the launcher or its service takes that."
                : "";

            if (args.action === "status") {
                const how =
                    status.method === "command"
                        ? `A restart runs the owner's command: ${status.command}.`
                        : status.method === "launcher"
                          ? "A restart goes through the launcher."
                          : "Nothing can restart this server from the app.";

                return {
                    output: [
                        {
                            type: "text" as const,
                            text: `${changes}${launcher} ${how} Requests waiting: ${status.requests.length}.`,
                        },
                    ],
                };
            }

            if (!status.available) {
                throw new Error(
                    "Nothing can restart this server from the app: ask the person to restart it where it runs.",
                );
            }

            restarts.request(
                `${api.taskId}:${api.callId}`,
                Number(api.conversationId),
                args.reason ?? "",
            );

            return {
                output: [
                    {
                        type: "text" as const,
                        text: `Asked the owner to restart. ${changes}${launcher} The restart waits for the owner's tap (Menu → Restart server), then for this and every other tool call to end. End your turn now, so the restart can happen.`,
                    },
                ],
            };
        },
    });

    return defineExtension({ name: RESTART_EXTENSION, tools: [tool] });
}
