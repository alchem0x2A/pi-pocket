/**
 * Updates of Pi Pocket itself: it looks for a new release every 6 hours, fetches the upstream remote, and starts a Pi
 * session that migrates the checkout to it (merge or rebase), with a notice to the owner. It never installs a version by
 * itself. Its routes and screens are the owner's alone (`updates.ts` does the work).
 */
import { defineExtension } from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost, WebHandler, WebRequest } from "../host.ts";

/** How often it looks for a new release, and how long after the start it first looks. */
const CHECK_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;

export default function createUpdates(host: PocketHost, web: ExtensionWeb) {
    const updates = (host as Partial<PocketHost>).updates;

    web.client("updates", { access: "owner" });

    if (updates === undefined) {
        // A server from before updates: its next start has them.
        web.route("GET", "status", () => {
            throw web.error(503, "Restart the server (menu → Restart server) to use updates");
        });

        return defineExtension({ name: "pocket-updates" });
    }

    web.settings([
        {
            name: "check",
            label: "Look for new versions",
            description:
                "Ask GitHub for the newest release every 6 hours. When there is one, fetch the upstream remote and start a Pi session that migrates to it.",
            type: "boolean",
            default: true,
        },
    ]);

    /** Errors as they are, to the owner: they say what stands in the way, and name nothing secret. */
    const handle =
        (run: (request: WebRequest) => unknown): WebHandler =>
        async (request) => {
            try {
                return await run(request);
            } catch (error) {
                // Core's refusals carry their status (`HttpError`), told by their shape: this module imports no core.
                const status = (error as { status?: unknown } | null)?.status;

                if (
                    error instanceof Error &&
                    typeof status === "number" &&
                    status >= 400 &&
                    status <= 599
                ) {
                    throw web.error(status, error.message);
                }

                throw error;
            }
        };

    web.route(
        "GET",
        "status",
        handle(() => updates.status()),
    );
    web.route(
        "POST",
        "check",
        handle(({ signal }) => updates.check(signal)),
    );
    web.route(
        "POST",
        "migrate",
        handle(() => updates.migrate()),
    );

    web.onDispose(updates.subscribe((status) => web.send("status", status)));

    const look = () => {
        if (web.setting("check") === false) {
            return;
        }

        // A new version starts its migration session in `check`: nothing installs by itself.
        void updates.check().catch(() => {});
    };

    const first = setTimeout(look, FIRST_CHECK_MS);
    const every = setInterval(look, CHECK_MS);

    first.unref();
    every.unref();
    web.onDispose(() => {
        clearTimeout(first);
        clearInterval(every);
    });

    return defineExtension({ name: "pocket-updates" });
}
