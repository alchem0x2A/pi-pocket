// Isolated synthetic markup exercises the Quick Notes CSS without a server or account data.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";

test(
    "quick note expansion stays within a phone panel",
    {
        skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
    },
    async () => {
        const dir = mkdtempSync(join(tmpdir(), "inbox-layout-"));
        const browsers = new Browsers({
            dataDir: dir,
            load: async () => undefined,
            save: () => {},
        });

        try {
            const page = await browsers.open(1);

            await page.setViewport(VIEWPORTS.mobile);
            const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");

            await page.evaluate(`
            document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1">';
            const style = document.createElement('style');
            style.textContent = ${JSON.stringify(css)};
            document.head.append(style);
            document.body.innerHTML = '<section class="quick-notes-panel" style="left:15px;top:100px;width:360px;max-height:520px" aria-label="Quick note inbox"><header class="quick-notes-head"><strong>Quick notes</strong></header><form class="quick-notes-form"><textarea></textarea><div class="quick-notes-capture-actions"><button type="button" class="icon-button mic-button quick-notes-mic" aria-label="Dictate">Mic</button><button type="button" class="button small primary quick-notes-send">Save note</button></div></form><ol class="quick-notes-list"><li class="quick-note"><button class="quick-note-select" type="button" aria-expanded="false"><span class="quick-note-text"></span><span class="quick-note-state">Synced to inbox</span></button></li></ol><footer>Footer</footer></section>';
            const button = document.querySelector('.quick-note-select');
            for (let i = 0; i < 8; i++) {
                const row = document.createElement('li');
                row.className = 'quick-note';
                row.textContent = 'Synthetic row';
                document.querySelector('.quick-notes-list').append(row);
            }
            button.addEventListener('click', () => button.setAttribute('aria-expanded', button.getAttribute('aria-expanded') === 'true' ? 'false' : 'true'));
        `);

            for (const text of [
                "Synthetic note words ".repeat(20).slice(0, 400),
                "x".repeat(400),
            ]) {
                await page.evaluate(
                    `document.querySelector('.quick-note-text').textContent = ${JSON.stringify(text)};`,
                );
                const measure = async () =>
                    JSON.parse(
                        await page.evaluate(`
                const panel = document.querySelector('.quick-notes-panel');
                const list = document.querySelector('.quick-notes-list');
                const text = document.querySelector('.quick-note-text');
                const footer = document.querySelector('footer');
                const button = document.querySelector('.quick-note-select');
                const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; };
                const style = getComputedStyle(text);
                return JSON.stringify({ panel: box(panel), list: box(list), text: box(text), footer: box(footer), clamp: style.webkitLineClamp, lineHeight: parseFloat(style.lineHeight), scrollHeight: text.scrollHeight, listScrollHeight: list.scrollHeight, listClientHeight: list.clientHeight, listScrollWidth: list.scrollWidth, listClientWidth: list.clientWidth, expanded: button.getAttribute('aria-expanded'), docWidth: document.documentElement.scrollWidth, viewport: innerWidth, length: text.textContent.length, actions: [...document.querySelectorAll('.quick-notes-capture-actions button')].map(box) });
            `),
                    );

                const contained = (m: any) => {
                    assert.equal(m.viewport, 390);
                    assert.ok(m.docWidth <= m.viewport);
                    assert.ok(m.panel.left >= 0 && m.panel.right <= m.viewport);
                    assert.ok(m.list.left >= m.panel.left && m.list.right <= m.panel.right);
                    assert.ok(m.listScrollWidth <= m.listClientWidth);
                    assert.ok(m.text.left >= m.list.left && m.text.right <= m.list.right);
                    assert.ok(m.list.top >= m.panel.top && m.list.bottom <= m.panel.bottom);
                    assert.ok(m.footer.bottom <= m.panel.bottom);
                    assert.ok(
                        m.actions.every(
                            (button: any) =>
                                button.height >= 40 &&
                                button.right - button.left >= 40 &&
                                button.right - button.left <= 48,
                        ),
                    );
                    assert.ok(m.actions[0].bottom <= m.actions[1].top);
                };

                const collapsed = await measure();

                contained(collapsed);
                assert.equal(collapsed.length, 400);
                assert.equal(collapsed.clamp, "3");
                assert.ok(collapsed.text.height <= collapsed.lineHeight * 3 + 1);
                assert.ok(collapsed.scrollHeight > collapsed.text.height);
                await page.evaluate(`document.querySelector('.quick-note-select').click()`);
                const expanded = await measure();

                contained(expanded);
                assert.equal(expanded.expanded, "true");
                assert.equal(expanded.clamp, "none");
                assert.ok(expanded.text.height > collapsed.text.height);
                assert.ok(expanded.scrollHeight <= expanded.text.height + 1);
                assert.ok(expanded.listScrollHeight > expanded.listClientHeight);
                await page.evaluate(`document.querySelector('.quick-note-select').click()`);
                const again = await measure();

                contained(again);
                assert.equal(again.expanded, "false");
                assert.equal(again.clamp, "3");
                assert.ok(Math.abs(again.text.height - collapsed.text.height) < 1);
            }
        } finally {
            await browsers.closeAll({ final: true });
            await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    },
);
