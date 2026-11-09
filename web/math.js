// TeX math in Markdown: the parsing half. Marked extensions that find math in a reply and leave it as a placeholder
// (`<span lang="x-tex-inline">` or `<div lang="x-tex-display">`, TeX escaped inside) that survives the sanitizer;
// `math-view.js` turns the placeholders into typeset math afterwards. No imports, so tests can load it in Node.
//
// Four delimiter styles: `\( … \)` and `$ … $` inline, `\[ … \]` and `$$ … $$` display. Code spans and code blocks
// are tokens of their own in marked and never reach these rules. A lone `$` is math only as in Pandoc: no space after
// the opening one or before the closing one, no digit after the closing one, so "$5 and $10" stays text; shell
// variables such as `$HOME/$USER` (all capitals) stay text too. `\$` is a literal dollar sign.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text) => text.replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** The most TeX one formula may hold; a longer one stays text (typesetting it could hold up the page). */
export const MAX_TEX = 20_000;

/** Whether the character at `index` is escaped by an odd run of backslashes before it. */
function escaped(text, index) {
    let count = 0;

    for (let at = index - 1; at >= 0 && text[at] === "\\"; at--) {
        count++;
    }

    return count % 2 === 1;
}

/** The index of the first unescaped `needle` in `text` from `from`, or -1. */
function closer(text, needle, from) {
    for (let at = text.indexOf(needle, from); at !== -1; at = text.indexOf(needle, at + 1)) {
        if (!escaped(text, at)) {
            return at;
        }
    }

    return -1;
}

/**
 * The math that starts `src` (at its first character), as `{ raw, tex, display }`, or undefined. `src` may begin
 * mid-line, so a rule that needs what comes before the opener is also checked by `startOf`.
 */
export function mathAt(src) {
    let end;

    if (src.startsWith("\\(")) {
        end = closer(src, "\\)", 2);

        return end > 2 ? take(src, 2, end, 2, false) : undefined;
    }

    if (src.startsWith("\\[")) {
        end = closer(src, "\\]", 2);

        return end > 2 ? take(src, 2, end, 2, true) : undefined;
    }

    if (src.startsWith("$$")) {
        end = closer(src, "$$", 2);

        return end > 2 ? take(src, 2, end, 2, true) : undefined;
    }

    if (src[0] !== "$") {
        return undefined;
    }

    // A lone `$`: not before a space, and (see the header) not text that only looks like it.
    if (/^\$[\s$]/.test(src) || src.length < 3) {
        return undefined;
    }

    for (let at = closer(src, "$", 1); at !== -1; at = closer(src, "$", at + 1)) {
        const before = src[at - 1];
        const after = src[at + 1];

        if (/\s/.test(before) || after === "$") {
            continue;
        }

        // "$5 and $10": the closing sign is followed by a digit.
        if (after !== undefined && /\d/.test(after)) {
            continue;
        }

        const tex = src.slice(1, at);

        // Shell variables and such: `$HOME/$USER`.
        if (/^[A-Z_][A-Z0-9_]{2,}\b/.test(tex) || tex.includes("\n\n")) {
            return undefined;
        }

        return take(src, 1, at, 1, false);
    }

    return undefined;
}

/** The math between `open` and `end` of `src`, or undefined when it is empty or too long. */
function take(src, open, end, width, display) {
    const tex = src.slice(open, end);

    if (tex.trim() === "" || tex.length > MAX_TEX) {
        return undefined;
    }

    return { raw: src.slice(0, end + width), tex: tex.trim(), display };
}

/**
 * Where math may start in `src`, for marked to cut the text before it: the first `\(`, `\[`, or `$` that is not
 * escaped, and for `$` not glued to a word before it (`a$b$`).
 */
export function startOf(src) {
    for (let at = 0; at < src.length; at++) {
        const char = src[at];

        if (char === "\\" && (src[at + 1] === "(" || src[at + 1] === "[")) {
            if (!escaped(src, at)) {
                return at;
            }
        } else if (char === "$" && !escaped(src, at) && !(at > 0 && /[\w$]/.test(src[at - 1]))) {
            return at;
        }
    }

    return -1;
}

/** `\[ … \]` or `$$ … $$` alone on its lines (it may span lines and blank lines), a block of its own. */
const BLOCK = /^ {0,3}(\$\$|\\\[)[ \t]*\n?([\s\S]*?)\n? {0,3}(\$\$|\\\])[ \t]*(?:\n|$)/;

/** The marked extensions: pass as `marked.use({ extensions: mathExtensions })`. */
export const mathExtensions = [
    {
        name: "mathBlock",
        level: "block",
        start(src) {
            const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(src);

            return match === null ? undefined : match.index + (match[0][0] === "\n" ? 1 : 0);
        },
        tokenizer(src) {
            const match = BLOCK.exec(src);

            if (
                match === null ||
                (match[1] === "$$") !== (match[3] === "$$") ||
                match[2].trim() === "" ||
                match[2].length > MAX_TEX
            ) {
                return undefined;
            }

            return { type: "mathBlock", raw: match[0], tex: match[2].trim(), display: true };
        },
        renderer: (token) => `<div lang="x-tex-display">${escapeHtml(token.tex)}</div>\n`,
    },
    {
        name: "mathInline",
        level: "inline",
        start: startOf,
        tokenizer(src) {
            const found = mathAt(src);

            return found === undefined
                ? undefined
                : { type: "mathInline", raw: found.raw, tex: found.tex, display: found.display };
        },
        renderer: (token) =>
            `<span lang="${token.display ? "x-tex-display" : "x-tex-inline"}">${escapeHtml(token.tex)}</span>`,
    },
];
