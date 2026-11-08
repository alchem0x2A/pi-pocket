import assert from "node:assert/strict";
import { test } from "node:test";
import { Marked } from "marked";

const { mathAt, mathExtensions, startOf } = (await import(
    new URL("../web/math.js", import.meta.url).href
)) as {
    mathAt: (src: string) => unknown;
    mathExtensions: unknown;
    startOf: (src: string) => number;
};

const md = new Marked({ extensions: mathExtensions as never, gfm: true });
const render = (text: string) => md.parse(text, { async: false }) as string;
const inline = (tex: string) => `<span lang="x-tex-inline">${tex}</span>`;
const display = (tex: string) => `<span lang="x-tex-display">${tex}</span>`;

test("the four delimiter styles", () => {
    assert.match(render("see \\(\\phi(r)\\) here"), new RegExp(inline("\\\\phi\\(r\\)")));
    assert.match(render("see $x^2$ here"), new RegExp(inline("x\\^2")));
    assert.match(render("see $$x^2$$ here"), new RegExp(display("x\\^2")));
    assert.match(render("see \\[x^2\\] here"), new RegExp(display("x\\^2")));
});

test("display blocks on their own lines, over several lines", () => {
    const out = render("before\n\n\\[\nE=\\sum_i F(\\rho_i)\n\\]\n\nafter");

    assert.match(out, /<div lang="x-tex-display">E=\\sum_i F\(\\rho_i\)<\/div>/);
    assert.match(out, /<p>after<\/p>/);

    const aligned = render("$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$");

    assert.match(aligned, /<div lang="x-tex-display">\\begin\{aligned\}/);
    assert.match(aligned, /\\end\{aligned\}<\/div>/);
});

test("TeX is escaped, so it cannot become markup", () => {
    const out = render("$a<b>c$ and \\(<img src=x onerror=1>\\)");

    assert.ok(!out.includes("<img"));
    assert.match(out, /a&lt;b&gt;c/);
});

test("prices and shell variables stay text", () => {
    assert.equal(mathAt("$5 and $10 total"), undefined);
    assert.equal(render("It costs $5 and $10."), "<p>It costs $5 and $10.</p>\n");
    assert.equal(render("Run $HOME/$USER now"), "<p>Run $HOME/$USER now</p>\n");
    assert.equal(render("a lone $ sign"), "<p>a lone $ sign</p>\n");
    assert.equal(render("cost \\$5 and \\$6"), "<p>cost $5 and $6</p>\n");
    assert.equal(render("$ not math $"), "<p>$ not math $</p>\n");
});

test("never inside code", () => {
    assert.equal(render("`$x$ and \\(y\\)`"), "<p><code>$x$ and \\(y\\)</code></p>\n");

    const block = render("```sh\necho $HOME $x$ \\(y\\)\n```\n");

    assert.ok(!block.includes("x-tex"));
    assert.match(block, /echo \$HOME \$x\$ \\\(y\\\)/);
});

test("matrices, bold, and a price beside math", () => {
    const out = render(
        "$\\mathbf{v}$ costs $5, and \\(\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\\)",
    );

    assert.match(out, /x-tex-inline">\\mathbf\{v\}</);
    assert.match(out, /pmatrix/);
    assert.match(out, /costs \$5,/);
});

test("an unclosed or empty opener is text", () => {
    assert.equal(mathAt("\\(never closed"), undefined);
    assert.equal(mathAt("\\(\\)"), undefined);
    assert.equal(mathAt("$$$$"), undefined);
    assert.equal(startOf("plain text"), -1);
    assert.equal(startOf("a\\$b"), -1);
    assert.equal(startOf("x \\(y\\)"), 2);
});
