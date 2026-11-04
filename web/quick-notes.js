// The device-side idea inbox. Synchronization stores data only; it never sends a chat message.
export const MAX_NOTE_LENGTH = 2000;
export const NOTES_PREFIX = "pocket.quick-notes.v2.";
export const ACCOUNT_KEY = "pocket.inbox.account";

export function readInboxAccount(storage) {
    try {
        const value = JSON.parse(storage.getItem(ACCOUNT_KEY));

        return typeof value?.id === "string" ? value : null;
    } catch {
        return null;
    }
}

export function forgetInboxAccount(storage) {
    try {
        storage.removeItem(ACCOUNT_KEY);
    } catch {
        // A refused storage operation must not prevent signing out.
    }
}

/** This is a local device hint, never proof of server authentication. */
export function rememberInboxAccount(storage, user) {
    if (user?.role !== "owner") {
        forgetInboxAccount(storage);

        return;
    }

    try {
        storage.setItem(ACCOUNT_KEY, JSON.stringify({ id: user.id, name: user.name }));
    } catch {
        // Offline capture is unavailable when this browser refuses storage.
    }
}

let lockDatabase;
const memoryLocks = new WeakMap();

/** Serialize each synchronous storage mutation across tabs, including the initial migration. */
function storageLock(storage, key, update) {
    if (globalThis.navigator?.locks) {
        return navigator.locks.request(`pocket.inbox:${key}`, update);
    }

    if (globalThis.indexedDB) {
        lockDatabase ??= new Promise((resolve, reject) => {
            const request = indexedDB.open("pocket-inbox-locks", 1);

            request.onupgradeneeded = () => request.result.createObjectStore("locks");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error("Close older inbox tabs and try again."));
        });

        return lockDatabase.then(
            (database) =>
                new Promise((resolve, reject) => {
                    const transaction = database.transaction("locks", "readwrite");
                    const request = transaction.objectStore("locks").get(key);
                    let result;
                    let problem;

                    request.onsuccess = () => {
                        try {
                            result = update();
                        } catch (error) {
                            problem = error;
                            transaction.abort();
                        }
                    };

                    transaction.oncomplete = () => resolve(result);
                    transaction.onabort = () => reject(problem ?? transaction.error);
                    transaction.onerror = () => reject(problem ?? transaction.error);
                }),
        );
    }

    if (typeof document !== "undefined") {
        return Promise.reject(
            new Error("This browser cannot safely save local notes. Enable browser storage."),
        );
    }

    // Node tests have no browser lock service. Their independent writers share this storage-scoped mutex.
    let locks = memoryLocks.get(storage);

    if (!locks) {
        locks = new Map();
        memoryLocks.set(storage, locks);
    }

    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(update);

    locks.set(key, next);

    return next;
}

/** Make an account-specific inbox. Network callbacks must enforce the expected authenticated account. */
export function createQuickNotes({
    storage,
    key,
    legacyKey,
    sync,
    list,
    archive,
    continueNote,
    makeId,
    now = Date.now,
}) {
    const listeners = new Set();
    const statusKey = `${key}.sync-status`;
    let flight = null;
    let migrationFailure = null;

    function load() {
        const value = JSON.parse(storage.getItem(key) ?? "[]");

        return Array.isArray(value)
            ? value.filter(
                  (note) =>
                      typeof note?.id === "string" &&
                      typeof note.text === "string" &&
                      ["local", "synced", "archived"].includes(note.state),
              )
            : [];
    }

    function loadStatus() {
        try {
            const value = JSON.parse(storage.getItem(statusKey));

            if (value && (value.error === null || typeof value.error === "string")) {
                return { error: value.error, attempted: value.attempted === true };
            }
        } catch {
            // A damaged status record must not prevent access to the separately stored notes.
        }

        return { error: null, attempted: false };
    }

    // Merge on every initialization and mutation. An older tab can append a cached note after the first migration.
    function migrate() {
        if (!legacyKey) {
            return;
        }

        let legacy;

        try {
            legacy = JSON.parse(storage.getItem(legacyKey) ?? "[]");
        } catch {
            migrationFailure =
                "The older note cache could not be read. It stays unchanged on this device.";

            return;
        }

        if (!Array.isArray(legacy)) {
            migrationFailure =
                "The older note cache has an unsupported format. It stays unchanged on this device.";

            return;
        }

        migrationFailure = null;

        const current = load();
        const ids = new Set(current.map((note) => note.id));
        let changed = false;

        for (const note of legacy) {
            if (
                typeof note?.id !== "string" ||
                typeof note.text !== "string" ||
                !["cached", "delivered"].includes(note.state) ||
                ids.has(note.id)
            ) {
                continue;
            }

            current.push({
                id: note.id,
                text: note.text,
                createdAt: note.createdAt ?? now(),
                state: note.state === "delivered" ? "archived" : "local",
                pendingSync: true,
                ...(note.state === "delivered" ? { archivePending: true } : {}),
            });
            ids.add(note.id);
            changed = true;
        }

        if (changed) {
            storage.setItem(key, JSON.stringify(current));
        }
    }

    let notes = load();
    let syncStatus = loadStatus();
    const ready = storageLock(storage, key, () => {
        migrate();
        notes = load();
        syncStatus = loadStatus();
        publish();
    });

    ready.catch(() => {});

    function publish() {
        for (const listener of listeners) {
            listener(notes.slice(), { ...syncStatus });
        }
    }

    function setSyncStatus(error) {
        syncStatus = { error, attempted: true };

        try {
            storage.setItem(statusKey, JSON.stringify(syncStatus));
        } catch {
            // Keep the failure visible in this tab if the browser refuses status persistence. Never remove a note.
        }

        publish();
    }

    async function change(update) {
        await ready;

        return storageLock(storage, key, () => {
            migrate();
            const next = update(load());

            storage.setItem(key, JSON.stringify(next));
            notes = next;
            publish();
        });
    }

    const needsCapture = (note) => note.pendingSync || note.state === "local";
    const queued = (note) => needsCapture(note) || note.archivePending !== undefined;
    const validRemote = (note) =>
        typeof note?.id === "string" &&
        typeof note.text === "string" &&
        ["synced", "archived"].includes(note.state);

    const sameRecord = (left, right) => JSON.stringify(left) === JSON.stringify(right);

    async function accept(remote, observed) {
        if (!validRemote(remote)) {
            throw new Error(
                "The server did not acknowledge an inbox note. Retrying automatically.",
            );
        }

        await change((current) => {
            const local = current.find((note) => note.id === remote.id);

            if (
                observed &&
                local &&
                !sameRecord(local, observed) &&
                (!needsCapture(local) || local.text !== remote.text)
            ) {
                // A newer completed archive, restore, or Continue from another tab wins over this older response.
                return current;
            }

            const saved = { ...remote };

            delete saved.pendingSync;
            delete saved.archivePending;
            const kept =
                local?.archivePending !== undefined
                    ? {
                          ...saved,
                          state: local.archivePending ? "archived" : "synced",
                          archivePending: local.archivePending,
                      }
                    : saved;

            return [...current.filter((note) => note.id !== remote.id), kept];
        });
    }

    const inbox = {
        ready,
        get notes() {
            return notes.slice();
        },
        get syncStatus() {
            return { ...syncStatus };
        },
        subscribe(listener) {
            listeners.add(listener);
            listener(notes.slice(), { ...syncStatus });

            return () => listeners.delete(listener);
        },
        async add(text) {
            const value = text.trim();

            if (value === "" || value.length > MAX_NOTE_LENGTH) {
                throw new RangeError(`A note must contain 1 to ${MAX_NOTE_LENGTH} characters.`);
            }

            const note = {
                id: makeId(),
                text: value,
                createdAt: now(),
                state: "local",
                pendingSync: true,
            };

            await change((current) => [...current, note]);

            return note;
        },
        refresh() {
            notes = load();
            syncStatus = loadStatus();
            publish();

            return notes.slice();
        },
        /** Every queued note gets an attempt. A failed older note cannot block a newer capture. */
        flush() {
            if (flight) {
                return flight;
            }

            let count = 0;
            let failure = null;
            const attempted = new Set();
            const acknowledged = new Set();
            const archivedAttempts = new Set();

            const failed = (error) => {
                failure = error?.message || "Inbox synchronization failed. Retrying automatically.";
                setSyncStatus(failure);
            };

            const drain = async () => {
                while (true) {
                    const pending = sync
                        ? load()
                              .filter((note) => needsCapture(note) && !attempted.has(note.id))
                              .sort(
                                  (a, b) =>
                                      Number(a.state === "archived") -
                                      Number(b.state === "archived"),
                              )
                        : [];

                    for (const note of pending) {
                        attempted.add(note.id);

                        try {
                            const result = await sync(note);

                            if (
                                !validRemote(result?.note) ||
                                result.note.id !== note.id ||
                                result.note.text !== note.text
                            ) {
                                throw new Error(
                                    "The server did not acknowledge this exact note. It stays on this device.",
                                );
                            }

                            await accept(result.note, note);
                            acknowledged.add(note.id);
                            count++;
                        } catch (error) {
                            failed(error);
                        }
                    }

                    const archives = archive
                        ? load().filter(
                              (note) =>
                                  !needsCapture(note) &&
                                  note.archivePending !== undefined &&
                                  !archivedAttempts.has(`${note.id}:${note.archivePending}`),
                          )
                        : [];

                    for (const note of archives) {
                        const desired = note.archivePending;

                        archivedAttempts.add(`${note.id}:${desired}`);

                        try {
                            const result = await archive(note.id, desired);

                            if (
                                !validRemote(result?.note) ||
                                result.note.id !== note.id ||
                                result.note.text !== note.text ||
                                result.note.state !== (desired ? "archived" : "synced")
                            ) {
                                throw new Error(
                                    "The server did not acknowledge the exact archive change. Retrying automatically.",
                                );
                            }

                            await change((current) =>
                                current.map((each) => {
                                    if (each.id !== note.id) {
                                        return each;
                                    }

                                    return sameRecord(each, note) ? result.note : each;
                                }),
                            );
                        } catch (error) {
                            failed(error);
                        }
                    }

                    if (
                        !load().some(
                            (note) =>
                                (sync && needsCapture(note) && !attempted.has(note.id)) ||
                                (archive &&
                                    !needsCapture(note) &&
                                    note.archivePending !== undefined &&
                                    !archivedAttempts.has(`${note.id}:${note.archivePending}`)),
                        )
                    ) {
                        break;
                    }
                }
            };

            const run = async () => {
                try {
                    await ready;
                    await drain();

                    if (list) {
                        try {
                            const observed = new Map(load().map((note) => [note.id, note]));
                            const result = await list();

                            if (!Array.isArray(result?.notes) || !result.notes.every(validRemote)) {
                                throw new Error(
                                    "The server did not return an inbox list. Retrying automatically.",
                                );
                            }

                            await change((current) => {
                                const remote = new Map(result.notes.map((note) => [note.id, note]));

                                for (const note of current) {
                                    if (queued(note) || !sameRecord(note, observed.get(note.id))) {
                                        remote.set(note.id, note);
                                    } else if (
                                        !remote.has(note.id) ||
                                        remote.get(note.id).text !== note.text
                                    ) {
                                        // A capture receipt wins over a stale list. An older missing record is retried, never discarded.
                                        remote.set(
                                            note.id,
                                            acknowledged.has(note.id)
                                                ? note
                                                : {
                                                      ...note,
                                                      pendingSync: true,
                                                      ...(note.state === "archived"
                                                          ? { archivePending: true }
                                                          : { state: "local" }),
                                                  },
                                        );
                                    }
                                }

                                return [...remote.values()];
                            });
                        } catch (error) {
                            failed(error);
                        }
                    }

                    // Check the server before waiting for a queued writer, so an account rejection can hide stale views.
                    // Merge later legacy writes even when the server list failed, and keep every local capture visible.
                    await change((current) => current);

                    if (migrationFailure) {
                        failed(new Error(migrationFailure));
                    }

                    // Capture can happen during a list request. Complete that work without requesting another list.
                    await drain();

                    if (!failure && load().some(queued)) {
                        failed(
                            new Error("Some notes remain on this device. Retrying automatically."),
                        );
                    }

                    if (!failure) {
                        setSyncStatus(null);
                    }
                } catch (error) {
                    failed(error);
                }

                return count;
            };

            flight = run().finally(() => {
                flight = null;
            });

            return flight;
        },
        async setArchived(id, archived) {
            await change((current) =>
                current.map((note) =>
                    note.id === id
                        ? {
                              ...note,
                              state: archived ? "archived" : note.pendingSync ? "local" : "synced",
                              archivePending: archived,
                          }
                        : note,
                ),
            );
            await inbox.flush();
        },
        async continueNote(id) {
            if (!continueNote) {
                throw new Error("Connect to the server to continue in a conversation.");
            }

            await inbox.flush();
            const note = load().find((each) => each.id === id);

            if (!note || queued(note)) {
                throw new Error("The note must sync to the inbox first.");
            }

            const result = await continueNote(id);

            if (!validRemote(result?.note) || result.note.id !== id) {
                throw new Error("The server did not acknowledge the new conversation.");
            }

            await accept(result.note, note);

            return result;
        },
    };

    return inbox;
}
