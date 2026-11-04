// Owner settings commands shared by the command launcher and the session-list search.
import { openSheet, store } from "./store.js";

/** The owner settings commands available from text search. */
export function settingsCommands() {
    if (store.state.me?.role !== "owner") {
        return [];
    }

    return [
        {
            id: "memory",
            key: "action:memory-settings",
            label: "Memory settings",
            searchLabel: "Memory",
            detail: "lesson storage and editor",
            keywords: "memory lessons persistent storage manager",
            icon: "sparkle",
            run: () => openSheet({ type: "memory-settings" }),
        },
        {
            id: "instructions",
            key: "action:instruction-files",
            label: "Instructions (AGENTS.md)",
            searchLabel: "Instructions (AGENTS.md)",
            detail: "global and folder instruction files",
            keywords: "instructions agents.md agents context files",
            icon: "sparkle",
            run: () => openSheet({ type: "instruction-files" }),
        },
    ];
}

/** Matching commands for the session-list field, alongside its unchanged session results. */
export function sessionSearchCommands(query) {
    const needle = String(query ?? "")
        .trim()
        .replace(/^>\s*/, "")
        .toLowerCase();

    if (needle === "") {
        return [];
    }

    const terms = needle.split(/\s+/).filter((term) => !["and", "the"].includes(term));

    return settingsCommands().filter((command) => {
        const words =
            `${command.searchLabel} ${command.label} ${command.detail} ${command.keywords}`
                .toLowerCase()
                .replace(/[()]/g, " ");

        return terms.every((term) => words.includes(term));
    });
}
