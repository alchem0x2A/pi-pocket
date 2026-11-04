// The device-side inbox for short notes to PiP. A cached note keeps its request id so a retry is safe after a lost reply.
export const MAX_NOTE_LENGTH = 2000;
const HISTORY_LIMIT = 40;

/** Keep cached notes and the newest delivered notes when the inbox grows. */
function keepRecent(notes) {
    const delivered = notes.filter((note) => note.state === "delivered");
    const keep = new Set(delivered.slice(-HISTORY_LIMIT).map((note) => note.id));

    return notes.filter((note) => note.state === "cached" || keep.has(note.id));
}

/** Make a per-person inbox, with storage and delivery supplied by the browser app. */
export function createQuickNotes({ storage, key, send, makeId, now = Date.now }) {
    let notes = load();
    const listeners = new Set();
    let flight = null;

    function load() {
        try {
            const value = JSON.parse(storage.getItem(key) ?? "[]");

            return Array.isArray(value)
                ? value.filter(
                      (note) =>
                          typeof note?.id === "string" &&
                          typeof note.text === "string" &&
                          (note.state === "cached" || note.state === "delivered"),
                  )
                : [];
        } catch {
            return [];
        }
    }

    function publish() {
        for (const listener of listeners) {
            listener(notes.slice());
        }
    }

    function save(next, { accepted = false } = {}) {
        const updated = keepRecent(next);

        try {
            storage.setItem(key, JSON.stringify(updated));
        } catch (error) {
            if (!accepted) {
                throw error;
            }
        }

        notes = updated;
        publish();
    }

    return {
        get notes() {
            return notes.slice();
        },
        subscribe(listener) {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
        /** Add and persist a cached note before any network request starts. */
        add(text) {
            const value = text.trim();

            if (value === "" || value.length > MAX_NOTE_LENGTH) {
                throw new RangeError(`A note must contain 1 to ${MAX_NOTE_LENGTH} characters.`);
            }

            const note = {
                id: makeId(),
                text: value,
                createdAt: now(),
                state: "cached",
            };

            save([...notes, note]);

            return note;
        },
        /** Refresh after another tab changes this person's local inbox. */
        refresh() {
            notes = load();
            publish();

            return notes.slice();
        },
        /** Send cached notes in order. A rejected request stays cached and stops this pass. */
        flush() {
            if (flight) {
                return flight;
            }

            const run = (async () => {
                let delivered = 0;

                while (true) {
                    const note = notes.find((each) => each.state === "cached");

                    if (!note) {
                        return delivered;
                    }

                    try {
                        await send(note);
                    } catch {
                        return delivered;
                    }

                    save(
                        notes.map((each) =>
                            each.id === note.id && each.state === "cached"
                                ? { ...each, state: "delivered", deliveredAt: now() }
                                : each,
                        ),
                        { accepted: true },
                    );
                    delivered++;
                }
            })();

            flight = run.finally(() => {
                flight = null;
            });

            return flight;
        },
    };
}
