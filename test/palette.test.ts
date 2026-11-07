import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
const page = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const blocks = {
    dark: css.split(":root {", 2)[1]!.split("/* Surfaces", 1)[0]!,
    light: css.split(':root[data-mode="light"] {', 2)[1]!.split("--sh:", 1)[0]!,
};

function luminance(hex: string): number {
    const channels = [1, 3, 5].map((offset) => {
        const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;

        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });

    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(a: string, b: string): number {
    const values = [luminance(a), luminance(b)].sort((a, b) => a - b);

    return (values[1]! + 0.05) / (values[0]! + 0.05);
}

for (const [mode, block] of Object.entries(blocks)) {
    test(`${mode} violet palette keeps body and semantic text readable`, () => {
        const colors = Object.fromEntries(
            [...block.matchAll(/--o-([\w-]+):\s*(#[\da-f]{6});/g)].map((match) => [
                match[1],
                match[2],
            ]),
        );

        for (const surface of ["bg", "bg-dark", "bg-darker", "bg-light"]) {
            assert.ok(contrast(colors.fg, colors[surface]) >= 7, `${surface}: body contrast >= 7`);
        }

        for (const name of [
            "fg-dim",
            "accent",
            "red",
            "yellow",
            "orange",
            "green",
            "cyan",
            "blue",
            "magenta",
        ]) {
            assert.ok(contrast(colors[name], colors.bg) >= 4.5, `${name}: text contrast >= 4.5`);
        }

        assert.ok(
            page.includes(colors.bg),
            "the first-paint browser theme color matches the palette",
        );
    });
}
