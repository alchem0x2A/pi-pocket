/** Fork-aware reference history. A reset cuts retention; no remembered ID or name grants access. */
import type { Context } from "@earendil-works/chord";
import {
    CompactionEntry,
    ResetEntry,
    type EntryRecord,
    type HookApi,
} from "@earendil-works/pi-durable";

export async function compactedReferences(
    head: EntryRecord | undefined,
    history: Pick<HookApi, "entries">,
    context: Context,
): Promise<{ summary: string; ids: string[]; tools: string[] }> {
    if (head?.kind !== CompactionEntry.kind || head.head === undefined) {
        return { summary: "", ids: [], tools: [] };
    }

    const summary = (head.model ?? [])
        .flatMap((message) =>
            message.role === "user" && typeof message.content !== "string"
                ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
                : message.role === "user"
                  ? [message.content]
                  : [],
        )
        .join("");
    const newestFirst: string[] = [];
    const discovered: string[] = [];
    let cursor: Parameters<HookApi["entries"]>[2];

    scan: do {
        const page = await history.entries(
            { maxEntryId: (head.head - 1) as typeof head.head, order: "descending" },
            200,
            cursor,
            context,
        );

        for (const entry of page.items) {
            if (entry.kind === ResetEntry.kind) {
                break scan;
            }

            for (const message of entry.model ?? []) {
                if (
                    message.role !== "toolResult" ||
                    (message.toolName !== "note_load" && message.toolName !== "codemode")
                ) {
                    continue;
                }

                const details = message.details as
                    { readNoteIds?: unknown; discoveredTools?: unknown } | undefined;
                const ids = details?.readNoteIds;

                if (message.toolName === "codemode" && Array.isArray(details?.discoveredTools)) {
                    for (const name of [...details.discoveredTools].reverse()) {
                        if (typeof name === "string") {
                            discovered.push(name);
                        }
                    }
                }

                if (Array.isArray(ids)) {
                    for (const id of [...ids].reverse()) {
                        if (typeof id === "string") {
                            newestFirst.push(id);
                        }
                    }
                } else if (message.toolName === "note_load") {
                    // Direct results stored before readNoteIds was introduced remain readable.
                    const text = message.content
                        .flatMap((part) => (part.type === "text" ? [part.text] : []))
                        .join("\n");

                    for (const found of [...text.matchAll(/<note id="([^"]+)"/g)].reverse()) {
                        newestFirst.push(found[1]!);
                    }
                }
            }
        }

        cursor = page.next;
    } while (cursor !== undefined);

    return {
        summary,
        ids: [...new Set(newestFirst)].reverse(),
        tools: [...new Set(discovered)].reverse(),
    };
}
