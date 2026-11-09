// TeX math in Markdown: the drawing half. `math.js` leaves each formula as a placeholder; `typeset` turns the
// placeholders of a sanitized fragment into KaTeX output. KaTeX makes only elements, classes, and inline styles of its
// own (`trust` off: no links, no raw HTML), and it runs after the sanitizer, on the app's own output, never on a reply's
// markup. The TeX stays in `data-tex`, for copying (`copyMath` in ui.js).

import katex from "katex";

const OPTIONS = {
    throwOnError: false,
    strict: "ignore",
    maxExpand: 1000,
    maxSize: 20,
    trust: false,
};

/** Draws each formula placeholder in `root`. A formula KaTeX cannot read stays as its TeX, in a span marked `bad`. */
export function typeset(root) {
    for (const node of root.querySelectorAll("[lang='x-tex-inline'], [lang='x-tex-display']")) {
        const display = node.getAttribute("lang") === "x-tex-display";
        const tex = node.textContent ?? "";
        const out = document.createElement(display ? "div" : "span");

        out.className = display ? "math math-display" : "math math-inline";
        out.dataset.part = display ? "math-display" : "math-inline";
        out.dataset.tex = tex;

        try {
            const view = document.createElement("span");

            view.className = "math-view";
            view.innerHTML = katex.renderToString(tex, { ...OPTIONS, displayMode: display });
            out.append(view);
        } catch {
            out.classList.add("bad");
            out.textContent = display ? `\\[${tex}\\]` : `\\(${tex}\\)`;
        }

        if (display) {
            const copy = document.createElement("button");

            copy.type = "button";
            copy.className = "math-copy";
            copy.dataset.copyTex = "";
            copy.title = "Copy TeX";
            copy.setAttribute("aria-label", "Copy TeX");
            copy.textContent = "TeX";
            out.append(copy);
        }

        node.replaceWith(out);
    }
}
