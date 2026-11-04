// App-lifetime inbox synchronization. A phone conversation does not need a mounted rail to retry.
import { revalidateAccount, store, uid } from "./store.js";
import {
    ACCOUNT_KEY,
    createQuickNotes,
    forgetInboxAccount,
    NOTES_PREFIX,
    readInboxAccount,
} from "./quick-notes.js";

export let accountGeneration = 0;
export let revalidating = false;

let activeAccount;
let activeInbox;
let retryQueued = false;
let lastRevalidation = -Infinity;
const RETRY_MS = 15000;
const ownerAccount = () => (store.state.me?.role === "owner" ? store.state.me.id : undefined);
let observedAccount = ownerAccount();

function discardActiveInbox() {
    accountGeneration++;
    activeAccount = undefined;
    activeInbox = undefined;
}

function invalidateAccount(account, generation) {
    if (revalidating || generation !== accountGeneration || ownerAccount() !== account) {
        return;
    }

    revalidating = true;
    discardActiveInbox();

    if (readInboxAccount(localStorage)?.id === account) {
        forgetInboxAccount(localStorage);
    }

    // Hide the rejected inbox immediately, including while a repeated rejection waits for the retry limit.
    store.set({});

    const confirm = () => {
        lastRevalidation = Date.now();
        // Close the stale stream before /api/me can confirm the current cookie. Never move an account's cache.
        void revalidateAccount()
            .catch(() => {
                // start() reports connection failures. A later app-lifetime retry can try again.
            })
            .finally(() => {
                revalidating = false;
                store.set({});
                scheduleRetry();
            });
    };

    const delay = Math.max(0, RETRY_MS - (Date.now() - lastRevalidation));

    if (delay > 0) {
        setTimeout(confirm, delay);
    } else {
        confirm();
    }
}

/** Bind every operation and its response to both the authenticated account and this model's generation. */
async function inboxRequest(account, generation, path = "", body) {
    if (revalidating || generation !== accountGeneration || ownerAccount() !== account) {
        throw new Error("The signed-in account changed.");
    }

    if (readInboxAccount(localStorage)?.id !== account) {
        invalidateAccount(account, generation);

        throw new Error("Confirm your account before using the inbox.");
    }

    if (globalThis.navigator?.onLine === false) {
        throw new Error("Offline. Notes remain on this device. Retrying automatically.");
    }

    let response;

    try {
        response = await fetch(`/api/inbox${path}`, {
            method: body === undefined ? "GET" : "POST",
            credentials: "same-origin",
            cache: "no-store",
            signal: AbortSignal.timeout(10000),
            headers: {
                "X-Pocket": "1",
                "X-Pocket-Account": account,
                "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    } catch (error) {
        throw new Error(
            error?.name === "TimeoutError"
                ? "The server did not respond within 10 seconds. Retrying automatically."
                : "Cannot reach the server. Notes remain on this device. Retrying automatically.",
        );
    }

    if ([401, 403, 409].includes(response.status)) {
        invalidateAccount(account, generation);

        throw new Error("Confirm your account before using the inbox.");
    }

    if (response.status === 404 || response.status === 405) {
        throw new Error(
            `HTTP ${response.status}: The inbox endpoint is unavailable. The server may need a restart. Retrying automatically.`,
        );
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
        const reason = typeof data?.error === "string" ? ` ${data.error.slice(0, 240)}` : "";

        throw new Error(
            `HTTP ${response.status}: The server refused inbox synchronization.${reason} Retrying automatically.`,
        );
    }

    if (body === undefined ? !Array.isArray(data?.notes) : typeof data?.note?.id !== "string") {
        throw new Error("The server did not return an inbox response. Retrying automatically.");
    }

    if (
        revalidating ||
        generation !== accountGeneration ||
        ownerAccount() !== account ||
        readInboxAccount(localStorage)?.id !== account
    ) {
        if (generation === accountGeneration && ownerAccount() === account) {
            invalidateAccount(account, generation);
        }

        throw new Error("The signed-in account changed.");
    }

    return data;
}

/** One model for the current owner. Inactive account caches remain intact in local storage. */
export function inboxFor(account) {
    if (revalidating || ownerAccount() !== account) {
        throw new Error("Confirm your account before using the inbox.");
    }

    if (activeAccount !== account) {
        const generation = accountGeneration;
        const inbox = createQuickNotes({
            storage: localStorage,
            key: `${NOTES_PREFIX}${account}`,
            legacyKey: `pocket.quick-notes.${account}`,
            makeId: uid,
            sync: (note) =>
                inboxRequest(account, generation, "", {
                    id: note.id,
                    text: note.text,
                    createdAt: note.createdAt,
                }),
            list: () => inboxRequest(account, generation, "?archived=true"),
            archive: (id, archived) =>
                inboxRequest(account, generation, `/${encodeURIComponent(id)}/archive`, {
                    archived,
                }),
            continueNote: (id) =>
                inboxRequest(account, generation, `/${encodeURIComponent(id)}/continue`, {}),
        });

        activeAccount = account;
        activeInbox = inbox;
    }

    return activeInbox;
}

function retry() {
    const account = ownerAccount();

    if (revalidating || account === undefined) {
        return;
    }

    if (readInboxAccount(localStorage)?.id !== account) {
        invalidateAccount(account, accountGeneration);

        return;
    }

    try {
        void inboxFor(account)
            .flush()
            .catch(() => {});
    } catch {
        // The rail reports unreadable storage when present. Keep retrying without removing any cached notes.
    }
}

function scheduleRetry() {
    if (retryQueued) {
        return;
    }

    retryQueued = true;
    queueMicrotask(() => {
        retryQueued = false;
        retry();
    });
}

let connection = store.state.connection;
let stream = store.state.streamId;

store.subscribe((state) => {
    const account = ownerAccount();
    const changedAccount = account !== observedAccount;
    const changedConnection = connection !== state.connection || stream !== state.streamId;

    if (changedAccount) {
        observedAccount = account;
        discardActiveInbox();
    }

    connection = state.connection;
    stream = state.streamId;

    if (changedAccount || changedConnection) {
        scheduleRetry();
    }
});

addEventListener("storage", (event) => {
    const account = ownerAccount();

    if (account === undefined || revalidating) {
        return;
    }

    if (event.key === ACCOUNT_KEY || event.key === null) {
        if (readInboxAccount(localStorage)?.id !== account) {
            invalidateAccount(account, accountGeneration);
        }

        scheduleRetry();
    }

    const key = `${NOTES_PREFIX}${account}`;
    const statusChanged = event.key === `${key}.sync-status`;

    if (
        event.key === null ||
        event.key === key ||
        statusChanged ||
        event.key === `pocket.quick-notes.${account}`
    ) {
        try {
            activeInbox?.refresh();
        } catch {
            // A damaged cache must not stop later retries or another account's inbox.
        }

        // A peer's status publication updates the display, but must not create a cross-tab retry loop.
        if (!statusChanged) {
            scheduleRetry();
        }
    }
});

setInterval(scheduleRetry, RETRY_MS);
addEventListener("online", scheduleRetry);
addEventListener("focus", scheduleRetry);
addEventListener("pageshow", scheduleRetry);
document.addEventListener("visibilitychange", scheduleRetry);
scheduleRetry();
