import {
    ACCOUNT_KEY,
    NOTES_PREFIX,
    createQuickNotes,
    readInboxAccount,
    forgetInboxAccount,
} from "/quick-notes.js";

const $ = (id) => document.getElementById(id);
const status = $("status");
let selected = null;
let model = null;
let checking = false;
let lockVersion = 0;
const drafts = new Map();

function hint() {
    try {
        const account = readInboxAccount(localStorage);

        return typeof account?.id === "string" && account.id ? account : null;
    } catch {
        return null;
    }
}

function lock(message) {
    lockVersion++;

    if (selected && $("note").value) {
        drafts.set(selected, $("note").value);
    }

    selected = null;
    model = null;
    $("inbox").hidden = true;
    $("locked").hidden = false;
    $("notes").replaceChildren();
    $("note").value = "";
    const account = hint();

    $("account").textContent = account
        ? `Last confirmed local account: ${account.name || account.id}`
        : "No confirmed local account is available. Sign in online first.";
    $("unlock").hidden = !account;

    if (message) {
        status.textContent = message;
    }
}

async function verify(account) {
    try {
        const response = await fetch("/api/me", {
            cache: "no-store",
            signal: AbortSignal.timeout(4000),
        });

        if (response.status === 401 || response.status === 403) {
            if (hint()?.id === account.id) {
                forgetInboxAccount(localStorage);
            }

            return "Sign in online before opening this inbox.";
        }

        if (!response.ok) {
            return "The server could not verify your account. Try again.";
        }

        const data = await response.json();

        if (data.user?.id !== account.id || data.user?.role !== "owner") {
            if (hint()?.id === account.id) {
                forgetInboxAccount(localStorage);
            }

            return "The signed-in account changed. Sign in to Pia to select the correct inbox.";
        }
    } catch (error) {
        // A network failure leaves identity unknown. The explicit device unlock is the only offline check.
        if (!(error instanceof TypeError) && error?.name !== "TimeoutError") {
            return "The account check failed. Try again.";
        }
    }

    return hint()?.id === account.id ? null : "The local account changed. Unlock again.";
}

function render() {
    $("notes").replaceChildren();
    const pending = model.notes.filter((note) => note.state === "local");

    if (!pending.length) {
        const item = document.createElement("li");

        item.textContent = "No pending notes.";
        $("notes").append(item);

        return;
    }

    for (const note of pending) {
        const item = document.createElement("li");

        item.textContent = note.text;
        $("notes").append(item);
    }
}

$("unlock").addEventListener("click", async () => {
    if (checking) {
        return;
    }

    const account = hint();

    if (!account) {
        return lock("No confirmed local account is available.");
    }

    checking = true;
    const version = lockVersion;

    $("unlock").disabled = true;
    status.textContent = "Checking account…";
    const problem = await verify(account);

    checking = false;
    $("unlock").disabled = false;

    if (problem) {
        return lock(problem);
    }

    if (version !== lockVersion) {
        return;
    }

    try {
        const inbox = createQuickNotes({
            storage: localStorage,
            key: NOTES_PREFIX + account.id,
            legacyKey: `pocket.quick-notes.${account.id}`,
            makeId: () => crypto.randomUUID(),
        });

        await inbox.ready;

        if (lockVersion !== version || hint()?.id !== account.id) {
            return;
        }

        model = inbox;
        selected = account.id;
        $("note").value = drafts.get(account.id) ?? "";
        render();
        $("locked").hidden = true;
        $("inbox").hidden = false;
        status.textContent = "Local inbox unlocked on this device.";
    } catch {
        lock("Could not open the local inbox. Check device storage and try again.");
    }
});

$("form").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (checking || !selected) {
        return;
    }

    const account = hint();
    const id = selected;

    if (!account || account.id !== id) {
        return lock("The local account changed. Unlock again.");
    }

    checking = true;
    status.textContent = "Checking account…";
    const problem = await verify(account);

    checking = false;

    if (problem || selected !== id || hint()?.id !== id) {
        return lock(problem || "The local account changed. Unlock again.");
    }

    const text = $("note").value;

    checking = true;

    try {
        await model.add(text);

        if (selected !== id || hint()?.id !== id) {
            return lock("The local account changed. Unlock again.");
        }

        if ($("note").value === text) {
            $("note").value = "";
            drafts.delete(id);
        }

        render();
        status.textContent = "Saved locally";
    } catch {
        status.textContent = "Could not save locally. Your note is still in the text box.";
    } finally {
        checking = false;
    }

    void probe();
});

$("lock").addEventListener("click", () => lock("Inbox locked."));
window.addEventListener("storage", (event) => {
    if (event.key === ACCOUNT_KEY || event.key === null) {
        lock("The local account changed. Unlock again.");
    } else if (selected && event.key === NOTES_PREFIX + selected) {
        model.refresh();
        render();
    }
});

// Only a fresh server confirmation permits the normal app to synchronize this inbox.
async function probe() {
    if (checking || !selected || document.visibilityState === "hidden") {
        return;
    }

    const id = selected;
    const version = lockVersion;

    if (hint()?.id !== id) {
        return lock("The local account changed. Unlock again.");
    }

    checking = true;
    let response;

    try {
        response = await fetch("/api/me", { cache: "no-store", signal: AbortSignal.timeout(4000) });

        if (response.status === 401 || response.status === 403) {
            if (hint()?.id === id) {
                forgetInboxAccount(localStorage);
            }

            if (selected === id && lockVersion === version) {
                lock("Sign in online before opening this inbox.");
            }

            return;
        }

        if (!response.ok) {
            return;
        }

        const data = await response.json();

        if (selected !== id || lockVersion !== version || hint()?.id !== id) {
            return;
        }

        if (data.user?.id !== id || data.user?.role !== "owner") {
            forgetInboxAccount(localStorage);
            lock(
                "The signed-in account changed. Your unfinished text stays in this page until it closes.",
            );

            return;
        }

        if ($("note").value) {
            status.textContent = "Connection restored. Save or clear your unfinished note to sync.";

            return;
        }

        location.assign("/");
    } catch {
        // A failed probe cannot confirm an account.
    } finally {
        checking = false;
    }
}

window.addEventListener("online", () => void probe());
document.addEventListener("visibilitychange", () => void probe());
setInterval(() => void probe(), 15000);
lock("Unlock the last confirmed local account to capture notes.");
