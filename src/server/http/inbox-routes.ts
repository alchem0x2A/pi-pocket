/** Owner-only idea inbox routes. Capture and reconnect sync store notes, never messages or agent work. */
import { HttpError } from "../errors.ts";
import { type ApiRequest, json, readJson } from "./io.ts";

export async function inboxRoutes(route: ApiRequest, parts: string[]): Promise<void> {
    const { app, user, request, response, url } = route;
    const current = app.config.userById(user.id);
    const expected = request.headers["x-pocket-account"];

    if (expected !== undefined && expected !== user.id) {
        throw new HttpError(
            409,
            "The signed-in account changed. Reconnect before using the inbox.",
        );
    }

    if (current?.role !== "owner" || current.sessions !== undefined) {
        throw new HttpError(403, "Only the owner can use the idea inbox.");
    }

    const method = request.method ?? "GET";
    const [id, action] = parts;

    if (parts.length === 0 && method === "GET") {
        return json(response, 200, {
            notes: await app.inbox.list(user, url.searchParams.get("archived") === "true"),
        });
    }

    if (parts.length === 0 && method === "POST") {
        const body = await readJson<{ id?: unknown; text?: unknown; createdAt?: unknown }>(request);

        return json(response, 200, { note: await app.inbox.capture(user, body) });
    }

    if (parts.length === 2 && id !== undefined && method === "POST") {
        if (action === "archive") {
            const body = await readJson<{ archived?: unknown }>(request);

            return json(response, 200, { note: await app.inbox.archive(user, id, body.archived) });
        }

        if (action === "continue") {
            return json(response, 200, await app.inbox.continue(user, id));
        }
    }

    throw new HttpError(404, "Unknown inbox route");
}
