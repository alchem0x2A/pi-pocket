/** Open a text file in the existing WeTTY Emacs daemon. Never start a daemon or a terminal here. */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { promisify } from "node:util";
import { HttpError } from "./errors.ts";
import { tailnetServiceUrl } from "./network-links.ts";

const execFileAsync = promisify(execFile);

const runClient = async (args: string[]) => {
    await execFileAsync("emacsclient", args, { timeout: 8000, maxBuffer: 64 * 1024 });
};

type Options = {
    run?: (args: string[]) => Promise<void>;
    terminalUrl?: () => Promise<string | undefined>;
    socket?: string;
};

/** The local emacs-web-session script uses this named daemon, not the desktop's default server. */
export function emacsSocket(): string | undefined {
    return (
        process.env.PI_POCKET_EMACS_SOCKET ||
        (process.platform === "linux" && process.getuid !== undefined
            ? `/tmp/emacs${process.getuid()}/web`
            : undefined)
    );
}

/** Quote a literal Lisp string. Only the surrounding quotes and backslashes have syntax inside it. */
export const lispString = (value: string) =>
    `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The caller must authorize this regular file through Workspace.readableFile first. */
export async function openInEmacs(path: string, options: Options = {}) {
    const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );

    try {
        const stats = await handle.stat();

        if (!stats.isFile()) {
            throw new HttpError(
                409,
                "Emacs opens regular text files only. Use Download for binary files.",
            );
        }

        const bytes = Buffer.alloc(Math.min(stats.size, 8000));

        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const sample = bytes.subarray(0, bytesRead);
        let utf8 = true;

        try {
            new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
        } catch {
            utf8 = false;
        }

        if (
            !utf8 ||
            sample.includes(0) ||
            /\.(png|jpe?g|gif|webp|avif|bmp|ico|pdf|woff2?|ttf|otf|zip)$/i.test(path)
        ) {
            throw new HttpError(
                409,
                "Emacs opens UTF-8 text files only here. Use Download for images and binary files.",
            );
        }
    } finally {
        await handle.close();
    }

    const url = await (
        options.terminalUrl ?? (() => tailnetServiceUrl(Number(process.env.EMACS_WEB_PORT || 7681)))
    )();

    if (url === undefined) {
        throw new HttpError(
            409,
            "The Emacs WeTTY HTTPS address is unavailable. Check the service in Links.",
        );
    }

    const socket = options.socket ?? emacsSocket();

    if (socket === undefined) {
        return { url, opened: false, error: "The WeTTY Emacs socket is not configured." };
    }

    try {
        // The same CLI protocol as pi-emacs and tt-pi-extensions. No shell and no user-supplied Lisp.
        // The daemon also keeps a headless default frame that is visible but has no terminal, so it
        // would swallow find-file. Target only real tty frames (a non-nil tty parameter, i.e. the pty
        // WeTTY attached), preferring the selected one, and force a redisplay there: a tty frame only
        // redraws while selected. WeTTY makes a new frame on every connection, and those start on
        // *scratch*; a phone browser reconnects whenever the tab comes back. So remember the buffer
        // and show it in each new tty frame (server-after-make-frame-hook), and with no terminal
        // open, still visit the file so the next connection shows it. Suppress file-local evaluation.
        const form = `(let* ((buffer (let ((enable-local-variables nil) (enable-local-eval nil)) (find-file-noselect (concat "/:" ${lispString(path)})))) (frames (seq-filter (lambda (f) (frame-parameter f 'tty)) (frame-list))) (frame (or (car (seq-filter (lambda (f) (eq f (selected-frame))) frames)) (car frames)))) (defvar pia-web-last-buffer nil) (setq pia-web-last-buffer buffer) (unless (fboundp 'pia-web-show-last) (defalias 'pia-web-show-last (lambda () (when (and (buffer-live-p pia-web-last-buffer) (frame-parameter nil 'tty)) (switch-to-buffer pia-web-last-buffer))))) (add-hook 'server-after-make-frame-hook 'pia-web-show-last) (when frame (with-selected-frame frame (switch-to-buffer buffer) (redisplay t))) (if frame t 'queued))`;

        await (options.run ?? runClient)([
            "--socket-name",
            socket,
            "--alternate-editor=false",
            "--eval",
            form,
        ]);

        return { url, opened: true };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return {
                url,
                opened: false,
                error: "emacsclient is unavailable on the server's PATH.",
            };
        }

        return {
            url,
            opened: false,
            error: "Emacs could not open the file. Open the Emacs terminal, then try again. Check emacsclient and the web daemon if it still fails.",
        };
    }
}
