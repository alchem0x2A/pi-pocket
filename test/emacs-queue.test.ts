import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lispString } from "../src/server/emacs.ts";

// A batch Emacs is not a daemon and never connects to the owner's daemon.
test(
    "the Emacs queue keeps FIFO order, ignores duplicates and removes killed buffers",
    { skip: spawnSync("emacs", ["--version"]).error ? "no Emacs" : false },
    () => {
        const dir = mkdtempSync(join(tmpdir(), "pia-queue-test-"));
        const a = join(dir, 'a "quoted".el');
        const b = join(dir, "b.txt");
        const marker = join(dir, "local-eval-ran");

        try {
            writeFileSync(
                a,
                `;; Local Variables:\n;; eval: (write-region "bad" nil ${JSON.stringify(marker)})\n;; End:\n`,
            );
            writeFileSync(b, "second\n");
            const form = `(progn
          (pia-web-enqueue ${lispString(a)})
          (pia-web-enqueue ${lispString(b)})
          (pia-web-enqueue ${lispString(a)})
          (unless (and (= (length pia-web-queue) 2) (equal (pia-web-first-file) ${lispString(a)})) (error "FIFO or duplicate failure"))
          (kill-buffer (car pia-web-queue))
          (unless (equal (pia-web-first-file) ${lispString(b)}) (error "kill failure"))
          (kill-buffer (car pia-web-queue))
          (when (pia-web-first-file) (error "queue not empty")))`;

            execFileSync(
                "emacs",
                [
                    "--batch",
                    "-Q",
                    "--load",
                    fileURLToPath(new URL("../src/server/emacs-queue.el", import.meta.url)),
                    "--eval",
                    form,
                ],
                { timeout: 15000 },
            );
            assert.equal(existsSync(marker), false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    },
);
