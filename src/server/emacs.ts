/** Open a text file in the existing WeTTY Emacs daemon. Never start a daemon or a terminal here. */
import { execFile } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { promisify } from "node:util";
import { HttpError } from "./errors.ts";
import { tailnetServiceUrl } from "./network-links.ts";

const execFileAsync = promisify(execFile);
const queueLisp = readFileSync(new URL("./emacs-queue.el", import.meta.url), "utf8");

async function queueEval(form: string): Promise<string> {
    const socket = emacsSocket();

    if (!socket) {
        throw new HttpError(503, "The Emacs socket is not configured.");
    }

    try {
        const { stdout } = await execFileAsync(
            "emacsclient",
            ["--socket-name", socket, "--alternate-editor=false", "--eval", form],
            { timeout: 8000, maxBuffer: 256 * 1024 },
        );

        return stdout.trim();
    } catch {
        throw new HttpError(503, "The Emacs queue is unavailable.");
    }
}

/** Read the queue without opening or visiting any files. */
export async function emacsQueue(): Promise<string[]> {
    const result = await queueEval(
        `(progn (require 'json) (if (fboundp 'pia-web-prune) (pia-web-prune)) (base64-encode-string (encode-coding-string (json-encode (vconcat (mapcar (lambda (b) (file-name-unquote (buffer-file-name b))) (and (boundp 'pia-web-queue) pia-web-queue)))) 'utf-8) t))`,
    );

    try {
        return JSON.parse(Buffer.from(JSON.parse(result), "base64").toString("utf8")) as string[];
    } catch {
        throw new HttpError(503, "The Emacs queue could not be read.");
    }
}

/** Remove one queued file without killing its buffer. */
export async function removeFromEmacsQueue(path: string): Promise<string[]> {
    await queueEval(
        `(when (boundp 'pia-web-queue) (setq pia-web-queue (seq-remove (lambda (b) (and (buffer-live-p b) (equal (file-name-unquote (buffer-file-name b)) ${lispString(path)}))) pia-web-queue)))`,
    );

    return emacsQueue();
}

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
        // Load only our fixed Lisp, then pass the authorized path as a quoted string. No shell.
        const form = `(progn (eval (read ${lispString(`(progn ${queueLisp})`)})) (pia-web-enqueue ${lispString(path)}) (let* ((frames (seq-filter (lambda (f) (frame-parameter f 'tty)) (frame-list))) (frame (or (car (seq-filter (lambda (f) (eq f (selected-frame))) frames)) (car frames)))) (when frame (with-selected-frame frame (switch-to-buffer (car pia-web-queue)) (redisplay t))) (if frame t 'queued)))`;

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
