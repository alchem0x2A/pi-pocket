// Shared actions for a regular file, in a preview or the image lightbox.
import { useState } from "preact/hooks";
import { api, notify, store } from "./store.js";
import { html, Icon } from "./ui.js";

const DOWNLOAD = "M12 3v12M7 10l5 5 5-5M4 16v5h16v-5";
// GNU Emacs glyph from Simple Icons (CC0), copied exactly, not redrawn:
// https://cdn.simpleicons.org/gnuemacs/7F5AB6
// Same path as https://github.com/simple-icons/simple-icons/blob/develop/icons/gnuemacs.svg
// It is a filled path in a 24-unit viewBox, so it does not go through the stroked Icon component.
// It takes the theme accent, and a thin stroke in the same color makes its fine lines read at 20 px.
const EMACS_GLYPH =
    "M12,24C5.448,24,0.118,18.617,0.118,12S5.448,0,12,0c6.552,0,11.882,5.383,11.882,12S18.552,24,12,24z M12,0.661 C5.813,0.661,0.779,5.748,0.779,12S5.813,23.339,12,23.339c6.187,0,11.221-5.086,11.221-11.339S18.187,0.661,12,0.661z M8.03,20.197 c0,0,0.978,0.069,2.236-0.042c0.51-0.045,2.444-0.235,3.891-0.552c0,0,1.764-0.377,2.707-0.725c0.987-0.364,1.524-0.673,1.766-1.11 c-0.011-0.09,0.074-0.408-0.381-0.599c-1.164-0.488-2.514-0.4-5.185-0.457c-2.962-0.102-3.948-0.598-4.472-0.997 c-0.503-0.405-0.25-1.526,1.907-2.513c1.086-0.526,5.345-1.496,5.345-1.496c-1.434-0.709-4.109-1.955-4.659-2.224 c-0.482-0.236-1.254-0.591-1.421-1.021c-0.19-0.413,0.448-0.768,0.804-0.87c1.147-0.331,2.766-0.536,4.24-0.56 c0.741-0.012,0.861-0.059,0.861-0.059c1.022-0.17,1.695-0.869,1.414-1.976c-0.252-1.13-1.579-1.795-2.84-1.565 c-1.188,0.217-4.05,1.048-4.05,1.048c3.539-0.031,4.131,0.028,4.395,0.398c0.156,0.218-0.071,0.518-1.015,0.672 c-1.027,0.168-3.163,0.37-3.163,0.37c-2.049,0.122-3.492,0.13-3.925,1.046C6.202,7.564,6.787,8.094,7.043,8.425 c1.082,1.204,2.646,1.853,3.652,2.331c0.379,0.18,1.49,0.52,1.49,0.52c-3.265-0.18-5.619,0.823-7.001,1.977 c-1.562,1.445-0.871,3.168,2.33,4.228c1.891,0.626,2.828,0.921,5.648,0.667c1.661-0.09,1.923-0.036,1.939,0.1 c0.023,0.192-1.845,0.669-2.355,0.816C11.448,19.438,8.047,20.193,8.03,20.197z";
const EMACS_LINE = 0.7;

/** The filled GNU Emacs glyph, in the theme accent. Only this button uses it. */
const EmacsGlyph = ({ size }) => html`<svg
    class="icon emacs-glyph"
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="currentColor"
    stroke-width=${EMACS_LINE}
    stroke-linejoin="round"
    style="color: var(--accent); overflow: visible"
    aria-hidden="true"
>
    <path d=${EMACS_GLYPH} />
</svg>`;

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
            ${busy === "emacs" ? html`<${Icon} name="clock" size=${18} />` : html`<${EmacsGlyph} size=${20} />`}
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
