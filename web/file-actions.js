// Shared actions for a regular file, in a preview or the image lightbox.
import { useState } from "preact/hooks";
import { api, notify, store } from "./store.js";
import { html, Icon } from "./ui.js";

const DOWNLOAD = "M12 3v12M7 10l5 5 5-5M4 16v5h16v-5";
// The Emacs mark, simplified to the app's stroked style: an E inside a round badge.
const EMACS =
    "M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 1 0 0-19zM15.5 7.5H10.2a1.2 1.2 0 0 0-1.2 1.2v6.6a1.2 1.2 0 0 0 1.2 1.2h5.3M9 12h5";

/** Only authenticated local file URLs have a path to download or edit. Stored tool images and artifacts do not. */
export function localImageFile(src) {
    try {
        const url = new URL(src, location.href);
        const match = /^\/api\/c\/(\d+)\/file$/.exec(url.pathname);
        const path = url.searchParams.get("path");

        return url.origin === location.origin && match && path
            ? { path, conversationId: match[1] }
            : null;
    } catch {
        return null;
    }
}

/** Fetch the attachment, so HTTP failures stay visible instead of replacing the app with a JSON error page. */
async function downloadFile(conversationId, path) {
    const response = await fetch(
        `/api/c/${conversationId}/download?${new URLSearchParams({ path })}`,
    );

    if (!response.ok) {
        const failure = await response.json().catch(() => null);

        throw new Error(failure?.error || `Download failed (${response.status}).`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(
        response.headers.get("content-disposition") || "",
    )?.[1];

    link.href = url;
    link.download = encoded ? decodeURIComponent(encoded) : path.split("/").pop() || "download";
    document.body.append(link);
    link.click();
    link.remove();
    // Give the browser time to take the blob before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** These actions never run when a preview loads. The Emacs action uses the owner's existing terminal only. */
export function FileTransfers({ path, conversationId = store.state.conversationId }) {
    const [busy, setBusy] = useState(null);
    const [failure, setFailure] = useState(null);
    const [terminal, setTerminal] = useState(null);

    const download = async () => {
        setBusy("download");
        setFailure(null);
        setTerminal(null);

        try {
            await downloadFile(conversationId, path);
            notify("info", "Download ready.");
        } catch (error) {
            setFailure(error.message || "Could not download the file.");
        } finally {
            setBusy(null);
        }
    };

    const emacs = async () => {
        setBusy("emacs");
        setFailure(null);
        setTerminal(null);

        try {
            const result = await api(`c/${conversationId}/emacs`, { path });

            setTerminal(result.url);

            if (!result.opened) {
                setFailure(result.error);
            } else {
                // A new WeTTY connection creates a new scratch frame, not the frame we just selected.
                notify(
                    "info",
                    "Opened in your existing Emacs terminal. Switch to that terminal tab.",
                );
            }
        } catch (error) {
            setFailure(error.message || "Could not open the file in Emacs.");
        } finally {
            setBusy(null);
        }
    };

    return html`<button
        class="icon-button file-transfer"
        title=${busy === "download" ? "Preparing download…" : "Download original file"}
        aria-label="Download original file"
        aria-busy=${busy === "download"}
        disabled=${busy !== null}
        onClick=${download}
    >
        <${Icon} path=${busy === "download" ? undefined : DOWNLOAD} name="clock" size=${18} />
    </button>
    ${
        store.state.me?.role === "owner" &&
        html`<button
            class="icon-button file-transfer"
            title=${busy === "emacs" ? "Opening in Emacs…" : "Open in the existing Emacs terminal (text files, in WeTTY)"}
            aria-label="Open in Emacs"
            aria-busy=${busy === "emacs"}
            disabled=${busy !== null}
            onClick=${emacs}
        >
            <${Icon} path=${busy === "emacs" ? undefined : EMACS} name="clock" size=${18} />
        </button>`
    }
    ${
        failure &&
        html`<span class="file-action-error small" role="alert">
            ${failure}
            ${terminal && html` <a href=${terminal} target="_blank" rel="noopener">Open Emacs terminal</a>`}
        </span>`
    }`;
}
