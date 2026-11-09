// Shared bits: htm binding, markdown, formatting, icons, the bottom sheet, and small controls (switches, menu rows).

import DOMPurify from "dompurify";
import htm from "htm";
import { marked } from "marked";
import { mathExtensions } from "./math.js";
import { typeset } from "./math-view.js";
import { Component, createContext, h } from "preact";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useDragToClose } from "./gestures.js";
import { highlight, langOf } from "./highlight.js";
import { actions, filesShown, notify, openSheet, store } from "./store.js";

export const html = htm.bind(h);

// ─── Images ──────────────────────────────────────────────────────────────────────

const currentConversation = () => store.state.view.conversation?.id;

/** An image file on the server (absolute, `~/…`, or relative to the session's folder), shown through the app. */
export const fileUrl = (path, conversationId = currentConversation()) =>
    `/api/c/${conversationId}/file?path=${encodeURIComponent(path)}`;

/** The `index`th image stored in a message: a pasted image or one a tool returned. */
export const entryImageUrl = (entryId, index, conversationId = currentConversation()) =>
    `/api/c/${conversationId}/image/${entryId}/${index}`;

/** Where the browser loads `![alt](src)` from. Web and data URLs stay; paths and file:// URLs point at the server. */
function imageSource(src, conversationId) {
    const value = String(src ?? "").trim();

    if (value === "" || conversationId === undefined || conversationId === null) {
        return value;
    }

    if (value.startsWith("/api/") || value.startsWith("/a/")) {
        return value;
    }

    const file = /^file:\/\//i.test(value);
    // A Windows path (C:\shot.png) is not a URL scheme.
    const drive = /^[a-z]:[\\/]/i.test(value);

    if (!file && !drive && /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) {
        return value;
    }

    // file:///C:/shot.png names C:/shot.png.
    let path = file
        ? value.replace(/^file:\/\/(localhost)?/i, "").replace(/^\/([a-z]:)/i, "$1")
        : value;

    try {
        path = decodeURIComponent(path);
    } catch {
        // keep it as written
    }

    return fileUrl(path, conversationId);
}

/** A tappable image thumbnail that opens full screen, or a chip when the image cannot load. */
export function Thumb({ src, alt = "image" }) {
    const [broken, setBroken] = useState(false);

    if (broken) {
        return html`<span class="chip" title="This image could not be loaded">🖼 ${alt}</span>`;
    }

    return html`<button
        class="thumb"
        type="button"
        onClick=${() => openSheet({ type: "image", src, alt })}
    >
        <img
            src=${src}
            alt=${alt}
            loading="lazy"
            decoding="async"
            onError=${() => setBroken(true)}
        />
    </button>`;
}

// ─── Markdown ──────────────────────────────────────────────────────────────────

// Line breaks are each `Markdown`'s to choose (`breaks`).
marked.setOptions({ gfm: true });

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text as HTML that shows it as written. */
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** A fence's language as it may be kept: a short name of safe characters, or nothing. */
const FENCE_NAME = /^[\w+#.-]{1,24}$/;

marked.use({ extensions: mathExtensions });

marked.use({
    renderer: {
        // Task list boxes as characters: the sanitizer drops form controls.
        checkbox: ({ checked }) => (checked ? "☑ " : "☐ "),
        // A code block keeps its language as data (the sanitizer drops classes), for colors and a label.
        code({ text, lang, escaped }) {
            const name = (lang ?? "").trim().split(/\s+/)[0];
            const attribute = FENCE_NAME.test(name) ? ` data-lang="${name}"` : "";

            return `<pre${attribute}><code>${escaped ? text : escapeHtml(text)}</code></pre>\n`;
        },
    },
});

/**
 * Replies are untrusted: a file or page the agent read can steer what it writes. No forms or controls, no media that loads by
 * itself, and no style, class, id, or data hooks that could lay a fake screen over the app: a theme styles
 * `[data-part="approval"]`, and a reply must not wear it. A code block's language is the one data attribute kept.
 */
const PURIFY = {
    FORBID_TAGS: [
        "form",
        "input",
        "button",
        "select",
        "textarea",
        "dialog",
        "style",
        "audio",
        "video",
        "source",
        "track",
        "picture",
    ],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ["data-lang"],
    // `data-path` is the app's own mark for file paths (`sanitize`): a reply may not set it.
    FORBID_ATTR: [
        "style",
        "class",
        "id",
        "srcset",
        "background",
        "poster",
        "action",
        "formaction",
        "data-path",
    ],
    RETURN_DOM_FRAGMENT: true,
};

/**
 * The app's own sanitizer, with its settings read once (`setConfig`): given them on each call, it reads them again for
 * each reply. Its own instance, so what it is set to and its hooks (below) change nothing for an extension's module that
 * imports `dompurify` too.
 */
const purify = DOMPurify(window);

purify.setConfig(PURIFY);

/** Images the app serves for a conversation (files, stored images, artifacts), or inline data. Nothing else loads. */
const localImage = (src) =>
    /^\/api\/c\/\d+\/(file\?|image\/)/.test(src) ||
    /^\/a\/\d+\//.test(src) ||
    /^data:image\//i.test(src);

/** Code blocks past this size show without colors: coloring them would hold up the conversation. */
export const COLOR_LIMIT = 200_000;
/** Code blocks longer than this many lines fold to their first lines, once they are written whole. */
const LONG_CODE = 40;

/**
 * What a code block shows besides its code, if anything: `html` (a page, previewed), `svg` (an image), or `diff`. Its
 * fence names it; a page or an image without a name is known by how it starts.
 */
function richKind(name, source) {
    const lang = name.toLowerCase();

    if (lang === "html" || lang === "htm" || lang === "xhtml") {
        return "html";
    }

    if (lang === "diff" || lang === "patch") {
        return "diff";
    }

    if (
        lang === "svg" ||
        ((lang === "xml" || lang === "") && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(source))
    ) {
        return "svg";
    }

    if (lang === "" && /^\s*(<!doctype html|<html[\s>])/i.test(source)) {
        return "html";
    }

    return undefined;
}

/**
 * A code block as the app draws it: a bar with its language (or "text") and a copy button above it, its code colored,
 * and a long one folded. A block that shows something besides its code is marked with its kind for `markdownParts`.
 */
function codeBlock(pre, fold) {
    const source = pre.textContent ?? "";
    const name = FENCE_NAME.test(pre.dataset.lang ?? "") ? pre.dataset.lang : "";
    const lang = langOf(name);
    const code = pre.querySelector("code") ?? pre;
    const wrap = document.createElement("div");
    const copy = document.createElement("button");
    const kind = richKind(name, source);

    // The highlighter's output is the source, escaped, in spans of its own: nothing from the reply becomes markup.
    if (lang && source.length <= COLOR_LIMIT) {
        code.innerHTML = highlight(source, lang);
    }

    wrap.className = "code";
    wrap.dataset.part = "code-block";
    copy.className = "copy";
    copy.type = "button";
    copy.dataset.copy = "";
    copy.textContent = "Copy";
    pre.replaceWith(wrap);

    if (kind) {
        wrap.dataset.kind = kind;
        wrap.dataset.lang = name;
    }

    const head = document.createElement("div");
    const label = document.createElement("span");

    head.className = "code-head";
    head.dataset.part = "code-head";
    label.className = "code-lang";
    label.textContent = name || "text";
    head.append(label, copy);
    wrap.append(head, pre);

    const lines = source.split("\n").length;

    if (fold && lines > LONG_CODE) {
        const more = document.createElement("button");

        wrap.classList.add("long");
        more.className = "code-more";
        more.type = "button";
        more.dataset.more = "";
        more.textContent = `Show all ${lines} lines`;
        wrap.append(more);
    }
}

/**
 * Sanitized HTML, changed only through the DOM afterwards: editing the sanitized string could turn text inside an
 * attribute into markup. An image from another site becomes a link, since its address could carry data out the moment
 * it loads, and code blocks are drawn by `codeBlock` (folded when long, if `fold`). Returns the element holding it.
 */
function sanitize(html, fold) {
    const fragment = purify.sanitize(html);

    // Math after the sanitizer: KaTeX's own markup, never a reply's.
    typeset(fragment);

    // `src/app.ts` in a reply opens the file: inline code that is a path, not code blocks.
    for (const code of fragment.querySelectorAll("code")) {
        // Code in a line of words, for themes; a code block is `code-block`.
        if (!code.closest("pre")) {
            code.dataset.part = "inline-code";
        }

        if (!code.closest("pre, a") && looksLikePath(code.textContent ?? "")) {
            code.dataset.path = code.textContent;
            // Keys open it too (`openFile` below).
            code.tabIndex = 0;
            code.setAttribute("role", "button");
        }
    }

    // Local Markdown links open the same viewer as inline code paths.
    for (const link of fragment.querySelectorAll("a[href]")) {
        const path = linkedPath(link.getAttribute("href") ?? "");

        if (path !== null) {
            link.dataset.path = fromBase(path);
            link.removeAttribute("target");
        }
    }

    for (const pre of fragment.querySelectorAll("pre")) {
        codeBlock(pre, fold);
    }

    for (const image of fragment.querySelectorAll("img")) {
        const src = image.getAttribute("src") ?? "";

        if (localImage(src)) {
            continue;
        }

        const label = `🖼 ${image.getAttribute("alt") || "image"}`;
        let host;

        try {
            host = /^https?:\/\//i.test(src) ? new URL(src).host : undefined;
        } catch {
            host = undefined;
        }

        // Inside a link already, or not a web address: the label alone.
        if (host === undefined || image.closest("a")) {
            image.replaceWith(label);
            continue;
        }

        const link = document.createElement("a");

        link.href = src;
        link.textContent = label;
        link.title = `Image from ${host}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        image.replaceWith(link);
    }

    const holder = document.createElement("div");

    holder.append(fragment);

    return holder;
}

/**
 * The parts of rendered markdown: runs of HTML, and between them the top-level code blocks that show more than code
 * (`{ kind, lang, source, html }`), for `Markdown` to draw with the component `setRichBlock` gave it.
 */
function partsOf(holder) {
    const parts = [];
    let run = "";

    for (const node of holder.childNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && node.matches(".code[data-kind]")) {
            if (run.trim() !== "") {
                parts.push({ html: run });
            }

            run = "";
            parts.push({
                kind: node.dataset.kind,
                lang: node.dataset.lang,
                source: node.querySelector("pre")?.textContent ?? "",
                html: node.outerHTML,
            });
            continue;
        }

        run +=
            node.nodeType === Node.ELEMENT_NODE
                ? node.outerHTML
                : escapeHtml(node.textContent ?? "");
    }

    if (run.trim() !== "" || parts.length === 0) {
        parts.push({ html: run });
    }

    return parts;
}

/** A reply that is a whole HTML page, not in a code block: shown as one, so it can be previewed rather than mangled. */
function fencePage(text) {
    if (!/^\s*(<!doctype html|<html[\s>])/i.test(text)) {
        return text;
    }

    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
    const fence = "`".repeat(longest + 1);

    return `${fence}html\n${text.trim()}\n${fence}`;
}

/** The conversation whose markdown is being sanitized, for image paths relative to its folder. */
let rendering = null;

/**
 * An element's attribute as the sanitizer reads it next. Before any of its checks (the URL check too), and before the
 * attributes are read: a hook on each attribute would make it copy its lists of allowed names on each call.
 */
function rewrite(node, name, change) {
    const value = node.getAttribute(name);

    if (value !== null) {
        const next = change(value.trim());

        if (next !== value) {
            node.setAttribute(name, next);
        }
    }
}

purify.addHook("beforeSanitizeAttributes", (node) => {
    // Before the URL check, so file:// and plain paths become app URLs instead of being dropped.
    if (node.nodeName === "IMG") {
        rewrite(node, "src", (src) => imageSource(src, rendering));
    } else if (node.nodeName === "A") {
        // `app.ts:42` looks like a URL scheme to the sanitizer; `./app.ts:42` is the same local file.
        rewrite(node, "href", (href) =>
            /^[a-z][a-z0-9+.-]*:/i.test(href) && linkedPath(href) !== null ? `./${href}` : href,
        );
    }
});

purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
    } else if (node.tagName === "IMG") {
        node.setAttribute("loading", "lazy");
        node.setAttribute("decoding", "async");
    }
});

const markdownCache = new Map();

const MARKDOWN_CACHE = 500;

/**
 * Markdown as sanitized parts (`partsOf`). Cached, least recently used out first: a transcript renders its rows in
 * order, and evicting the oldest insert would miss on every row once a thread outgrew the cache. Text still changing
 * (`cache` false) is not kept, and its long code blocks are not folded while they grow. With `breaks`, a single line
 * break is a new line rather than a space.
 */
function markdownParts(
    text,
    conversationId = currentConversation(),
    cache = true,
    base = null,
    breaks = true,
) {
    const key = `${conversationId ?? ""}\u0000${base ?? ""}\u0000${breaks ? "br" : ""}\u0000${text}`;
    let out = markdownCache.get(key);

    if (out !== undefined) {
        markdownCache.delete(key);
        markdownCache.set(key, out);

        return out;
    }

    out = renderParts(fencePage(text), conversationId, base, breaks, cache);

    if (cache) {
        if (markdownCache.size >= MARKDOWN_CACHE) {
            markdownCache.delete(markdownCache.keys().next().value);
        }

        markdownCache.set(key, out);
    }

    return out;
}

/** Markdown parsed, sanitized, and split into parts (`partsOf`), for the conversation and folder given. */
function renderParts(text, conversationId, base, breaks, fold) {
    rendering = conversationId ?? null;
    linkBase = base;

    try {
        return partsOf(sanitize(marked.parse(text, { async: false, breaks }), fold));
    } finally {
        rendering = null;
        linkBase = null;
    }
}

/**
 * Markdown still growing, as parts: each top-level block (a paragraph, a list, a code block) drawn on its own, and kept
 * in `kept` from one update to the next, so an update draws again only the blocks that changed, mostly the last. The
 * blocks are found again in the whole text each time (block level only, which is quick), so a block that a later line
 * turns into another (a paragraph into a heading, a list that goes on) is drawn as it is now. A reference link whose
 * definition is in another block shows as written until the text is whole. Returns `{ key, parts }` for each block.
 */
function liveBlocks(text, conversationId, base, breaks, kept) {
    const blocks = new marked.Lexer(marked.defaults)
        .blockTokens(text.replace(/\r\n|\r/g, "\n"), [])
        .filter((token) => token.type !== "space");
    const next = new Map();
    const out = blocks.map((token, index) => {
        const parts =
            next.get(token.raw) ??
            kept.get(token.raw) ??
            renderParts(token.raw, conversationId, base, breaks, false);

        next.set(token.raw, parts);

        return { key: index, parts };
    });

    kept.clear();

    for (const [raw, parts] of next) {
        kept.set(raw, parts);
    }

    return out;
}

/** What draws a code block that shows more than code (`rich.js`), given once at load: ui.js does not import it. */
let RichBlock = null;

export function setRichBlock(component) {
    RichBlock = component;
}

/**
 * Rendered markdown. `cache={false}` for text that is still changing, such as a streaming answer: its pages, images, and
 * diffs show as code until it is whole. A single line break is a new line, as the agent's terminal shows a reply and GitHub a
 * comment; `breaks={false}` for a Markdown file, where it is a space, as GitHub shows the file (hard-wrapped prose
 * stays one paragraph).
 */
export function Markdown({
    text,
    class: className = "",
    cache = true,
    base = null,
    breaks = true,
    conversationId = currentConversation(),
}) {
    const live = useRef(null);

    // Growing text, block by block (`liveBlocks`); a whole page is fenced as one block (`fencePage`), as before.
    if (!cache && fencePage(text) === text) {
        const settings = `${conversationId ?? ""}\u0000${base ?? ""}\u0000${breaks}`;

        if (live.current?.settings !== settings) {
            live.current = { settings, kept: new Map() };
        }

        const blocks = liveBlocks(text, conversationId, base, breaks, live.current.kept);

        return html`<div class=${`md ${className}`}>
            ${blocks.flatMap(({ key, parts }) =>
                parts
                    .filter((part) => part.kind !== undefined || part.html.trim() !== "")
                    .map((part, index) => drawPart(part, `${key}.${index}`, true)),
            )}
        </div>`;
    }

    live.current = null;
    const parts = markdownParts(text, conversationId, cache, base, breaks);

    if (parts.length === 1 && parts[0].kind === undefined) {
        return html`<div
            class=${`md ${className}`}
            dangerouslySetInnerHTML=${{ __html: parts[0].html }}
        ></div>`;
    }

    return html`<div class=${`md ${className}`}>
        ${parts.map((part, index) => drawPart(part, index, !cache))}
    </div>`;
}

/** One part of rendered markdown (`partsOf`): a run of HTML, or a code block that shows more than code. */
const drawPart = (part, key, streaming) =>
    part.kind === undefined || RichBlock === null
        ? html`<div
              key=${key}
              class="md-part"
              dangerouslySetInnerHTML=${{ __html: part.html }}
          ></div>`
        : html`<${RichBlock} key=${key} ...${part} streaming=${streaming} />`;

/** File types common enough that `name.ext` alone is surely a file, not code like `store.state`. */
const FILE_TYPES = new Set(
    "ts tsx js jsx mjs cjs json jsonc md mdx txt css scss html htm py rs go java kt rb php cs c h cc cpp hpp swift sh bash zsh fish yml yaml toml ini cfg conf env lock sql xml svg png jpg jpeg gif webp pdf vue svelte astro lua zig dart ex exs erl hs ml nix gradle csv log diff patch".split(
        " ",
    ),
);

/**
 * Whether inline code names a file: `src/app.ts`, `./run.sh`, `~/notes.md`, `app.ts:42`, `package.json`. A path with
 * folders needs an extension of some kind; a bare name needs a common one.
 */
function looksLikePath(text) {
    if (text.length > 300) {
        return false;
    }

    // Anchored at home, the top, or here: `~/.bashrc`, `/etc/hosts`, `./run`.
    if (
        /^(?:~|\.{1,2}|)\/[\w@.+-]+(?:\/[\w@.+-]+)*(?::\d+(?:-\d+)?)?$/.test(text) &&
        text !== "/"
    ) {
        return true;
    }

    if (/^(?:Makefile|Dockerfile|LICENSE|\.gitignore|\.env(?:\.\w+)?)$/.test(text)) {
        return true;
    }

    const match =
        /^((?:[\w@.+-]+\/)*)([\w@+-][\w@.+-]*\.([A-Za-z0-9]{1,10}))(?::\d+(?:-\d+)?)?$/.exec(text);

    return match !== null && (match[1] !== "" || FILE_TYPES.has(match[3].toLowerCase()));
}

/** A local file link, using the same path recognition as inline code. App routes and URL schemes stay links. */
function linkedPath(href) {
    let path;

    try {
        path = decodeURIComponent(href);
    } catch {
        return null;
    }

    const withoutLine = path.replace(/:\d+(?:-\d+)?$/, "");

    if (
        /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(withoutLine) ||
        /^\/(?:api|a|s|login|join|share)(?:\/|[?#]|$)/.test(path)
    ) {
        return null;
    }

    return looksLikePath(path) ? path : null;
}

/** The folder of the Markdown file being rendered (`Markdown`'s `base`): its relative links name its neighbors. */
let linkBase = null;

/** A linked path as the viewer opens it: relative to the Markdown file it is in, if any, else as written. */
function fromBase(path) {
    if (linkBase === null || /^[~/]/.test(path)) {
        return path;
    }

    const parts = linkBase.replace(/\/+$/, "").split("/");

    for (const part of path.split("/")) {
        if (part === "..") {
            if (parts.length > 1) {
                parts.pop();
            }
        } else if (part !== ".") {
            parts.push(part);
        }
    }

    return parts.join("/");
}

/**
 * Open a file (or folder) of the session in the viewer: in the Files tile while it is open, otherwise in a sheet.
 * `path:42` opens it at line 42.
 */
export function openFile(path) {
    const match = /^(.*?):(\d+)(?:-\d+)?$/.exec(path);
    const target = { path: match ? match[1] : path, line: match ? Number(match[2]) : undefined };

    if (filesShown()) {
        // From the tile's Changes tab, back from the file goes back there (files-panel.js).
        store.set((state) => ({
            sheet: null,
            filesTab: "files",
            filesTarget: { ...target, from: state.filesTab, n: (state.filesTarget?.n ?? 0) + 1 },
        }));

        return;
    }

    openSheet({ type: "file", id: target.path, line: target.line });
}

/**
 * Whether a click or key asks to show a path in the file manager rather than the viewer: Ctrl (⌘ on a Mac) held, by the
 * owner, whose machine the server runs on.
 */
export const revealAsked = (event) =>
    (APPLE ? event.metaKey : event.ctrlKey) && store.state.me?.role === "owner";

/** Show a file (or folder) of the session in the file manager of the machine the server runs on, selected. */
export function revealFile(path) {
    const match = /^(.*?):(\d+)(?:-\d+)?$/.exec(path);

    actions.reveal(match ? match[1] : path).then(
        () => notify("info", "Shown in the file manager on the server's machine."),
        (error) => notify("error", error.message ?? String(error)),
    );
}

/** File paths in rendered markdown open in the viewer, or with Ctrl (⌘) held, in the file manager. */
document.addEventListener("click", (event) => {
    const target = event.target.closest?.(".md code[data-path], .md a[data-path]");

    if (!target) {
        return;
    }

    if (revealAsked(event)) {
        event.preventDefault();
        event.stopPropagation();
        revealFile(target.dataset.path);

        return;
    }

    // A file link stays in the app even when selecting its text keeps it from opening: its href is a path, not a page.
    event.preventDefault();

    const selection = getSelection();

    // Selecting a link's text does not change the selection elsewhere: only one in it holds the file back.
    if (selection?.toString() && selection.containsNode(target, true)) {
        return;
    }

    event.stopPropagation();
    openFile(target.dataset.path);
});

// Enter or Space on a file path in inline code opens it, as a tap does: it is a button for keys.
document.addEventListener("keydown", (event) => {
    const target = event.target.closest?.(".md code[data-path]");

    if (target && (event.key === "Enter" || event.key === " ") && !event.repeat) {
        event.preventDefault();

        if (revealAsked(event)) {
            revealFile(target.dataset.path);
        } else {
            openFile(target.dataset.path);
        }
    }
});

/** Images in rendered markdown open full screen, unless they are links. */
document.addEventListener("click", (event) => {
    const image = event.target.closest?.(".md img");

    if (!image || image.closest("a") || image.classList.contains("broken")) {
        return;
    }

    openSheet({ type: "image", src: image.currentSrc || image.src, alt: image.alt });
});

/** A markdown image that cannot load says so instead of showing a broken icon. */
document.addEventListener(
    "error",
    (event) => {
        const image = event.target;

        if (
            image?.tagName !== "IMG" ||
            !image.closest(".md") ||
            image.classList.contains("broken")
        ) {
            return;
        }

        image.classList.add("broken");
        const note = document.createElement("span");

        note.className = "image-missing";
        note.textContent = `🖼 ${image.alt || "Image"} could not be loaded`;
        image.after(note);
    },
    true,
);

/** Copy buttons inside rendered markdown, handled once for the whole page. */
document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-copy]");

    if (!button) {
        return;
    }

    const pre = button.closest(".code")?.querySelector("pre");

    copyText(pre?.innerText ?? "").then(
        () => {
            button.textContent = "Copied";
            setTimeout(() => (button.textContent = "Copy"), 1200);
        },
        () => notify("error", "Could not copy."),
    );
});

/** Math: a tap on a formula, or the TeX button of a display one, copies its TeX; a copied selection holds TeX too. */
document.addEventListener("click", (event) => {
    const target = event.target;
    const button = target.closest?.("[data-copy-tex]");
    const math = (button ?? target.closest?.(".math-inline"))?.closest("[data-tex]");

    if (!math || (!button && getSelection()?.toString())) {
        return;
    }

    copyText(math.dataset.tex ?? "").then(
        () => notify("info", "Copied the TeX."),
        () => notify("error", "Could not copy."),
    );
});

document.addEventListener("copy", (event) => {
    const selection = getSelection();

    if (!selection || selection.isCollapsed || !event.clipboardData) {
        return;
    }

    const range = selection.getRangeAt(0);
    const formulas = [...document.querySelectorAll(".md .math")].filter((each) =>
        range.intersectsNode(each),
    );

    if (formulas.length === 0) {
        return;
    }

    // The selected text with each formula as `$tex$` (display: `$$tex$$`): the source, as the agent wrote it.
    const holder = document.createElement("div");

    holder.append(range.cloneContents());

    for (const each of holder.querySelectorAll(".math")) {
        const tex = each.dataset.tex ?? "";

        each.replaceWith(each.classList.contains("math-display") ? `\n$$${tex}$$\n` : `$${tex}$`);
    }

    for (const each of holder.querySelectorAll(".math-copy")) {
        each.remove();
    }

    event.clipboardData.setData("text/plain", holder.textContent ?? "");
    event.preventDefault();
});

/** A long code block's button shows all of it, and folds it again. */
document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-more]");
    const block = button?.closest(".code");

    if (!block) {
        return;
    }

    const open = block.classList.toggle("open");

    button.textContent = open
        ? "Fold"
        : `Show all ${block.querySelector("pre")?.textContent.split("\n").length ?? ""} lines`;
});

/** Copy text, with a fallback for plain-http addresses, where the clipboard API does not exist. */
export async function copyText(text) {
    if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text);
    }

    const area = document.createElement("textarea");

    area.value = text;
    area.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");

    area.remove();

    if (!ok) {
        throw new Error("Could not copy.");
    }
}

/** How full a context is, as the agent's own TUI colors its footer: `warn` above 70%, `err` above 90%. */
export function contextLevel(percent) {
    if (percent > 90) {
        return "err";
    }

    if (percent > 70) {
        return "warn";
    }

    return "";
}

export function formatTokens(count) {
    if (count === undefined || count === null) {
        return "?";
    }

    if (count >= 1_000_000) {
        return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`;
    }

    if (count >= 1000) {
        return `${Math.round(count / 1000)}k`;
    }

    return String(count);
}

export function formatBytes(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Times as this device writes them, each format made once: making one costs more than using it, and a transcript
// writes a time for each message.
const TIME = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });
const WEEKDAY = new Intl.DateTimeFormat([], { weekday: "short" });

/** Whether a date is today, on this device's clock. */
function isToday(date) {
    const now = new Date();

    return (
        date.getDate() === now.getDate() &&
        date.getMonth() === now.getMonth() &&
        date.getFullYear() === now.getFullYear()
    );
}

/** When something happened, on this device's clock: "10:42" today, "Oct 3 10:42" before. */
export function clockTime(date) {
    const time = TIME.format(date);

    return isToday(date) ? time : `${DAY.format(date)} ${time}`;
}

/** A time ahead, on this device's clock: "14:30" today, "Mon 09:00" this week, "Oct 20 09:00" later. */
export function formatWhen(ms) {
    const at = new Date(ms);
    const time = TIME.format(at);

    if (isToday(at)) {
        return time;
    }

    const day = ms - Date.now() < 6 * 86_400_000 ? WEEKDAY.format(at) : DAY.format(at);

    return `${day} ${time}`;
}

/** The minute now, for what shows a time ago: a memo that keys on it draws again as the minute turns (`useMinute`). */
const minuteNow = () => Math.floor(Date.now() / 60_000);

/** Listeners to the minute's turn, and its timer while any listen. */
const minuteListeners = new Set();
let minuteTimer = 0;

function tickMinute() {
    minuteTimer = setTimeout(tickMinute, 60_000 - (Date.now() % 60_000));

    for (const listener of minuteListeners) {
        listener(minuteNow());
    }
}

/**
 * The minute now, which draws the component again as it turns: memoized rows that show "5m" would otherwise keep it.
 * One timer for every component that uses it.
 */
export function useMinute() {
    const [minute, setMinute] = useState(minuteNow);

    useEffect(() => {
        minuteListeners.add(setMinute);

        if (minuteListeners.size === 1) {
            minuteTimer = setTimeout(tickMinute, 60_000 - (Date.now() % 60_000));
        }

        // A minute that turned before this effect ran.
        setMinute(minuteNow());

        return () => {
            minuteListeners.delete(setMinute);

            if (minuteListeners.size === 0) {
                clearTimeout(minuteTimer);
            }
        };
    }, []);

    return minute;
}

export function timeAgo(ms) {
    const seconds = Math.max(0, (Date.now() - ms) / 1000);

    if (seconds < 45) {
        return "now";
    }

    if (seconds < 3600) {
        return `${Math.round(seconds / 60)}m`;
    }

    if (seconds < 86400) {
        return `${Math.round(seconds / 3600)}h`;
    }

    if (seconds < 86400 * 30) {
        return `${Math.round(seconds / 86400)}d`;
    }

    return new Date(ms).toLocaleDateString();
}

/** Markdown as plain text, for one-line previews such as a quote: no emphasis, code ticks, or markers. */
export function plainText(markdown) {
    return String(markdown ?? "")
        .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/gm, "$1$2")
        .replace(/^[ \t]{0,3}(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+\.[ \t]+)/gm, "");
}

/** What separates a message to the agent from the list of files attached to it, which the server adds. */
export const ATTACHMENTS_HEADING = "\n\nAttached files (saved on the server):\n";

/**
 * A message to the agent in two: what the person wrote, and the list of attached files if any. One with files alone, sent
 * before 0.14.0, has the heading without the blank line before it.
 */
export function splitAttachments(text) {
    return (text.startsWith(ATTACHMENTS_HEADING.trimStart()) ? `\n\n${text}` : text).split(
        ATTACHMENTS_HEADING,
    );
}

/** What a person wrote in a message to the agent, without the list of attached files. */
export function writtenText(entry) {
    return splitAttachments(entry.text)[0];
}

/** What the agent wrote in a reply: its text blocks, without thinking or tool calls. */
export function replyText(entry) {
    return entry.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** `~/x` for paths under home. */
export function shortPath(path, home) {
    if (!path) {
        return "";
    }

    if (home && (path === home || path.startsWith(`${home}/`))) {
        return `~${path.slice(home.length)}`;
    }

    return path;
}

/** The ribbon mark's contour drawing: its pieces, each with its own stroke width, in one square box. */
const PIA_MARK = {
    viewBox: "4124.152 73.5714 874.7325 874.7325",
    paths: [
        {
            transform: "translate(4299.6524 493.9623)",
            d: "M216.89,0 q-7.79,2.9 -10.89,4.07 t-5.67,2.17 -4.85,1.9 -4.33,1.74 -3.98,1.66 -3.77,1.61 -3.63,1.6 -3.53,1.61 -3.46,1.62 -3.41,1.65 -3.38,1.67 -3.34,1.71 -3.32,1.75 -3.29,1.78 -3.26,1.82 -3.24,1.86 -3.22,1.9 -3.19,1.95 -3.16,1.98 -3.13,2.03 -3.11,2.08 -3.07,2.11 -3.05,2.16 -3.01,2.21 -2.98,2.24 -2.94,2.3 -2.91,2.34 -2.87,2.38 -2.84,2.43 -2.79,2.47 -2.76,2.51 -2.71,2.56 -2.67,2.61 -2.63,2.65 -2.59,2.69 -2.53,2.73 -2.49,2.78 -2.46,2.82 -2.41,2.84 -2.4,2.86 -2.36,2.89 -2.34,2.91 -2.32,2.93 -2.3,2.94 -2.27,2.96 -2.26,2.98 -2.23,2.99 -2.21,3.01 -2.19,3.02 -2.16,3.04 -2.15,3.06 -2.12,3.07 -2.11,3.08 -2.08,3.1 -2.05,3.12 -2.04,3.13 -2.01,3.14 -1.99,3.16 -1.96,3.18 -1.94,3.19 -1.92,3.2 -1.89,3.22 -1.87,3.24 -1.84,3.24 -1.81,3.27 -1.79,3.28 -1.75,3.29 -1.73,3.31 -1.7,3.33 -1.67,3.34 -1.63,3.35 -1.61,3.37 -1.56,3.39 -1.54,3.41 -1.49,3.42 -1.46,3.43 -1.41,3.46 -1.37,3.47 -1.33,3.49 -1.27,3.51 -1.23,3.52 -1.17,3.54 -1.11,3.57 -.65,3.17 .51,2.09 1.67,.99 2.39,.3 2.85,-.14 3.14,-.42 3.32,-.59 3.43,-.7 3.51,-.77 3.55,-.81 3.58,-.84 3.6,-.86 3.6,-.87 3.62,-.87 3.62,-.88 3.62,-.88 3.62,-.88 3.63,-.88 3.62,-.88 3.63,-.89 3.63,-.88 3.49,-.64 2.99,.34 2.37,1.5 1.99,2.25 1.75,2.7 1.59,2.99 1.5,3.18 1.43,3.29 1.4,3.37 1.37,3.41 1.36,3.44 1.35,3.45 1.35,3.47 1.34,3.48 1.34,3.48 1.33,3.48 1.34,3.49 1.33,3.48 1.34,3.49 1.33,3.49 1.34,3.48 1.33,3.49 1.33,3.49 1.34,3.49 1.33,3.48 1.34,3.49 1.33,3.49 1.33,3.49 1.34,3.49 1.33,3.48 1.34,3.49 1.33,3.49 1.33,3.49 1.34,3.48 1.33,3.49 1.34,3.49 1.33,3.49 1.38,2.5 1.45,.6 1.5,-.87 1.53,-1.8 1.54,-2.4 1.54,-2.77 1.53,-3 1.53,-3.16 1.51,-3.26 1.5,-3.32 1.48,-3.36 1.48,-3.39 1.47,-3.41 1.45,-3.43 1.44,-3.43 1.44,-3.44 1.42,-3.45 1.42,-3.45 1.41,-3.46 1.4,-3.46 1.39,-3.46 1.38,-3.47 1.38,-3.47 1.37,-3.47 1.37,-3.48 1.36,-3.48 1.35,-3.48 1.35,-3.48 1.34,-3.48 1.34,-3.49 1.33,-3.49 1.33,-3.49 1.33,-3.49 1.31,-3.49 1.32,-3.49 1.31,-3.5 1.31,-3.5 1.3,-3.5 1.3,-3.5 1.3,-3.5 1.29,-3.5 1.29,-3.51 1.29,-3.5 1.29,-3.51 1.28,-3.5 1.28,-3.51 1.27,-3.51 1.28,-3.51 1.27,-3.51 1.27,-3.51 1.26,-3.52 1.27,-3.51 1.26,-3.51 1.26,-3.52 1.26,-3.51 1.26,-3.52 1.25,-3.52 1.26,-3.51 1.25,-3.52 1.25,-3.52 1.25,-3.52 1.24,-3.52 1.25,-3.52 1.24,-3.52 1.25,-3.52 1.24,-3.52 1.24,-3.52 1.24,-3.52 1.24,-3.52 1.23,-3.53 1.24,-3.52 1.24,-3.53 1.23,-3.52 1.23,-3.52 1.24,-3.53 1.23,-3.52 1.23,-3.53 1.23,-3.53 1.23,-3.52 1.24,-3.53 1.23,-3.52 1.23,-3.53 1.23,-3.53 1.23,-3.52 1.23,-3.53 1.23,-3.52 1.23,-3.53 1.23,-3.53 1.23,-3.52 1.22,-3.53 1.69,-4.83 2.89,-8.28 l1.81,-5.21",
            width: 24.75,
        },
        {
            transform: "translate(4576.5016 493.9623)",
            d: "M29.98,0 q7.79,2.9 10.88,4.07 t5.68,2.17 4.85,1.9 4.32,1.74 3.99,1.66 3.77,1.61 3.63,1.6 3.53,1.61 3.46,1.62 3.41,1.64 3.38,1.68 3.34,1.71 3.32,1.75 3.29,1.78 3.26,1.82 3.24,1.86 3.22,1.9 3.18,1.95 3.17,1.98 3.13,2.03 3.1,2.07 3.08,2.12 3.04,2.16 3.02,2.2 2.97,2.25 2.95,2.3 2.91,2.33 2.87,2.39 2.83,2.42 2.8,2.48 2.75,2.51 2.72,2.56 2.67,2.61 2.63,2.65 2.58,2.69 2.54,2.73 2.49,2.78 2.45,2.82 2.42,2.84 2.39,2.86 2.37,2.89 2.34,2.91 2.32,2.93 2.3,2.94 2.27,2.96 2.25,2.98 2.24,2.99 2.21,3.01 2.19,3.02 2.16,3.04 2.15,3.06 2.12,3.07 2.1,3.08 2.08,3.1 2.06,3.12 2.04,3.13 2.01,3.14 1.99,3.16 1.96,3.18 1.94,3.19 1.92,3.2 1.89,3.22 1.87,3.23 1.84,3.25 1.81,3.27 1.78,3.28 1.76,3.29 1.73,3.31 1.7,3.32 1.67,3.34 1.63,3.36 1.6,3.37 1.57,3.39 1.53,3.4 1.5,3.42 1.45,3.44 1.42,3.46 1.37,3.47 1.33,3.49 1.27,3.5 1.23,3.53 1.17,3.54 1.11,3.56 .64,3.18 -.5,2.09 -1.67,.99 -2.39,.3 -2.85,-.14 -3.14,-.42 -3.32,-.59 -3.44,-.7 -3.5,-.77 -3.55,-.81 -3.58,-.84 -3.6,-.86 -3.61,-.87 -3.61,-.87 -3.62,-.88 -3.62,-.88 -3.63,-.88 -3.62,-.88 -3.63,-.88 -3.62,-.89 -3.63,-.88 -3.49,-.64 -2.99,.34 -2.37,1.5 -1.99,2.25 -1.75,2.7 -1.59,2.99 -1.5,3.18 -1.43,3.29 -1.4,3.37 -1.38,3.41 -1.36,3.44 -1.35,3.45 -1.34,3.47 -1.34,3.48 -1.34,3.48 -1.33,3.48 -1.34,3.49 -1.34,3.48 -1.33,3.49 -1.33,3.49 -1.34,3.48 -1.33,3.49 -1.34,3.49 -1.33,3.49 -1.33,3.48 -1.34,3.49 -1.33,3.49 -1.34,3.49 -1.33,3.49 -1.33,3.48 -1.34,3.49 -1.33,3.49 -1.34,3.49 -1.33,3.48 -1.33,3.49 -1.34,3.49 -1.33,3.49 -1.38,2.5 -1.45,.6 -1.5,-.87 -1.53,-1.8 -1.54,-2.4 -1.54,-2.77 -1.53,-3 -1.53,-3.16 -1.51,-3.26 -1.5,-3.32 -1.49,-3.36 -1.47,-3.39 -1.47,-3.41 -1.45,-3.43 -1.45,-3.43 -1.43,-3.44 -1.42,-3.45 -1.42,-3.45 -1.41,-3.46 -1.4,-3.46 -1.39,-3.46 -1.39,-3.47 -1.37,-3.47 -1.38,-3.47 -1.36,-3.48 -1.36,-3.48 -1.35,-3.48 -1.35,-3.48 -1.34,-3.48 -1.34,-3.49 -1.34,-3.49 -1.32,-3.49 -1.33,-3.49 -1.32,-3.49 -1.31,-3.49 -1.31,-3.5 -1.31,-3.5 -1.3,-3.5 -1.3,-3.5 -1.3,-3.5 -1.29,-3.5 -1.3,-3.51 -1.28,-3.5 -1.29,-3.51 -1.28,-3.5 -1.28,-3.51 -1.28,-3.51 -1.27,-3.51 -1.27,-3.51 -1.27,-3.51 -1.27,-3.52 -1.26,-3.51 -1.26,-3.51 -1.26,-3.52 -1.26,-3.51 -1.26,-3.52 -1.25,-3.52 -1.26,-3.51 -1.25,-3.52 -1.25,-3.52 -1.25,-3.52 -1.24,-3.52 -1.25,-3.52 -1.24,-3.52 -1.25,-3.52 -1.24,-3.52 -1.24,-3.52 -1.24,-3.52 -1.24,-3.52 -1.23,-3.53 -1.24,-3.52 -1.24,-3.53 -1.23,-3.52 -1.24,-3.52 -1.23,-3.53 -1.23,-3.52 -1.23,-3.53 -1.23,-3.53 -1.24,-3.52 -1.23,-3.53 -1.23,-3.52 -1.23,-3.53 -1.23,-3.53 -1.23,-3.52 -1.23,-3.53 -1.23,-3.52 -1.23,-3.53 -1.23,-3.53 -1.23,-3.52 -1.23,-3.53 -1.68,-4.83 -2.89,-8.28 l-1.81,-5.21",
            width: 24.75,
        },
        {
            transform: "translate(4140.129 186.5986)",
            d: "M357.76,142.73 q-5.44,-6.27 -7.72,-8.85 t-4.3,-4.79 -3.88,-4.18 -3.63,-3.8 -3.48,-3.53 -3.41,-3.35 -3.38,-3.22 -3.38,-3.11 -3.39,-3.04 -3.41,-2.97 -3.43,-2.91 -3.47,-2.86 -3.5,-2.81 -3.53,-2.77 -3.56,-2.71 -3.59,-2.67 -3.63,-2.63 -3.66,-2.58 -3.68,-2.54 -3.72,-2.49 -3.74,-2.46 -3.77,-2.41 -3.8,-2.36 -3.82,-2.33 -3.85,-2.28 -3.87,-2.25 -3.9,-2.2 -3.92,-2.16 -3.94,-2.11 -3.97,-2.08 -3.98,-2.04 -4.01,-2 -4.02,-1.95 -4.04,-1.92 -4.07,-1.88 -4.08,-1.83 -4.1,-1.8 -4.11,-1.76 -4.13,-1.72 -4.15,-1.68 -4.17,-1.64 -4.18,-1.6 -4.19,-1.56 -4.21,-1.52 -4.23,-1.48 -4.23,-1.44 -4.25,-1.41 -4.26,-1.36 -4.28,-1.33 -4.29,-1.29 -4.3,-1.24 -4.31,-1.21 -4.32,-1.17 -4.33,-1.13 -4.34,-1.1 -4.35,-1.05 -4.36,-1.01 -4.37,-.97 -4.37,-.94 -4.39,-.89 -4.39,-.85 -4.41,-.81 -4.41,-.78 -4.41,-.73 -4.42,-.69 -4.43,-.65 -4.44,-.61 -4.43,-.57 -4.45,-.52 -4.45,-.49 -4.45,-.44 -4.46,-.4 -4.46,-.29 -4.44,.04 -4.32,.61 -4.12,1.28 -3.82,1.9 -3.5,2.45 -3.17,2.88 -2.86,3.23 -2.59,3.49 -2.35,3.69 -2.13,3.85 -1.95,3.96 -1.79,4.06 -1.64,4.13 -1.52,4.19 -1.41,4.23 -1.31,4.26 -1.22,4.3 -1.14,4.32 -1.07,4.34 -1,4.36 -.95,4.37 -.88,4.39 -.84,4.39 -.78,4.41 -.74,4.41 -.69,4.42 -.66,4.43 -.61,4.43 -.58,4.44 -.54,4.44 -.51,4.45 -.47,4.45 -.44,4.45 -.41,4.46 -.39,4.46 -.35,4.46 -.32,4.47 -.3,4.47 -.27,4.46 -.24,4.47 -.21,4.47 -.19,4.48 -.17,4.47 -.14,4.47 -.11,4.48 -.09,4.47 -.06,4.48 -.04,4.48 -.02,4.47 .01,4.48 .04,4.47 .06,4.48 .09,4.48 .11,4.47 .14,4.47 .18,4.48 .21,4.47 .24,4.47 .26,4.47 .28,4.46 .31,4.47 .33,4.46 .35,4.46 .38,4.46 .4,4.46 .44,4.46 .47,4.45 .51,4.45 .55,4.44 .59,4.43 .64,4.43 .7,4.42 .76,4.41 .83,4.4 .91,4.38 .99,4.36 1.08,4.34 1.19,4.31 1.31,4.28 1.44,4.23 1.59,4.17 1.76,4.1 1.94,4.02 2.15,3.9 2.37,3.76 2.61,3.59 2.86,3.38 3.13,3.13 3.37,2.84 3.61,2.51 3.83,2.17 4.01,1.79 4.15,1.43 4.27,1.06 4.34,.73 4.39,.48 4.42,.29 4.44,.13 4.46,.01 4.45,-.1 4.46,-.2 4.46,-.29 4.46,-.36 4.45,-.44 4.44,-.5 4.44,-.56 4.43,-.61 4.43,-.67 4.41,-.71 4.41,-.76 4.41,-.81 4.39,-.84 4.39,-.89 4.38,-.91 4.37,-.96 4.37,-.98 4.36,-1.02 4.35,-1.04 4.34,-1.07 4.34,-1.1 4.34,-1.12 4.32,-1.14 4.32,-1.17 4.32,-1.19 4.31,-1.2 4.31,-1.23 4.3,-1.24 4.29,-1.27 4.29,-1.27 4.29,-1.3 4.28,-1.31 4.27,-1.32 4.28,-1.33 4.26,-1.35 4.27,-1.36 4.26,-1.37 4.26,-1.39 4.25,-1.39 4.25,-1.4 4.25,-1.41 4.25,-1.42 4.24,-1.42 4.24,-1.44 4.24,-1.44 4.24,-1.45 4.23,-1.45 4.23,-1.46 4.23,-1.46 4.23,-1.47 4.23,-1.47 4.22,-1.48 4.23,-1.48 4.22,-1.48 4.23,-1.48 4.22,-1.48 4.23,-1.49 4.22,-1.48 4.22,-1.49 4.22,-1.48 4.23,-1.49 5,-1.75 7.81,-2.74 l4.91,-1.72",
            width: 24.75,
        },
        {
            transform: "translate(4622.7757 186.5986)",
            d: "M2.38,142.73 q5.44,-6.27 7.72,-8.85 t4.3,-4.78 3.88,-4.19 3.62,-3.8 3.49,-3.53 3.41,-3.35 3.38,-3.21 3.38,-3.12 3.38,-3.04 3.41,-2.97 3.44,-2.91 3.47,-2.86 3.49,-2.81 3.53,-2.76 3.57,-2.72 3.59,-2.67 3.63,-2.62 3.65,-2.59 3.69,-2.53 3.72,-2.5 3.74,-2.45 3.77,-2.41 3.8,-2.37 3.82,-2.33 3.85,-2.28 3.87,-2.24 3.9,-2.2 3.92,-2.16 3.94,-2.12 3.96,-2.08 3.99,-2.04 4,-1.99 4.03,-1.96 4.04,-1.92 4.06,-1.87 4.09,-1.84 4.09,-1.8 4.12,-1.76 4.13,-1.71 4.15,-1.68 4.17,-1.64 4.18,-1.6 4.19,-1.56 4.21,-1.52 4.22,-1.49 4.24,-1.44 4.25,-1.4 4.26,-1.37 4.28,-1.33 4.29,-1.28 4.29,-1.25 4.31,-1.21 4.32,-1.17 4.33,-1.13 4.35,-1.09 4.35,-1.05 4.36,-1.02 4.36,-.97 4.38,-.93 4.39,-.9 4.39,-.85 4.4,-.81 4.41,-.77 4.42,-.74 4.42,-.69 4.43,-.65 4.43,-.61 4.44,-.56 4.45,-.53 4.45,-.48 4.45,-.44 4.46,-.4 4.46,-.3 4.43,.04 4.33,.62 4.11,1.27 3.83,1.91 3.49,2.44 3.17,2.88 2.87,3.23 2.59,3.49 2.34,3.69 2.14,3.85 1.94,3.97 1.79,4.06 1.64,4.13 1.52,4.18 1.41,4.23 1.31,4.27 1.22,4.29 1.14,4.32 1.07,4.35 1.01,4.35 .94,4.38 .88,4.38 .84,4.4 .78,4.4 .74,4.41 .7,4.43 .65,4.42 .61,4.44 .58,4.43 .54,4.45 .51,4.44 .47,4.46 .44,4.45 .42,4.46 .38,4.46 .35,4.46 .32,4.46 .3,4.47 .27,4.47 .24,4.47 .22,4.47 .19,4.47 .16,4.47 .14,4.48 .11,4.47 .09,4.48 .06,4.47 .04,4.48 .02,4.47 -.01,4.48 -.04,4.48 -.06,4.47 -.09,4.48 -.11,4.47 -.14,4.48 -.17,4.47 -.22,4.47 -.23,4.47 -.27,4.47 -.28,4.47 -.31,4.46 -.33,4.47 -.35,4.46 -.38,4.46 -.4,4.46 -.44,4.45 -.47,4.45 -.51,4.45 -.54,4.44 -.6,4.44 -.64,4.43 -.7,4.42 -.76,4.41 -.83,4.39 -.9,4.39 -.99,4.36 -1.09,4.34 -1.19,4.31 -1.31,4.27 -1.44,4.23 -1.59,4.17 -1.76,4.11 -1.94,4.01 -2.15,3.9 -2.37,3.77 -2.61,3.59 -2.86,3.38 -3.12,3.13 -3.38,2.84 -3.61,2.51 -3.83,2.16 -4.01,1.8 -4.15,1.42 -4.26,1.06 -4.34,.73 -4.39,.48 -4.43,.29 -4.44,.14 -4.45,0 -4.46,-.1 -4.46,-.2 -4.46,-.29 -4.45,-.36 -4.45,-.43 -4.45,-.5 -4.43,-.56 -4.44,-.62 -4.42,-.66 -4.42,-.72 -4.41,-.76 -4.4,-.8 -4.39,-.85 -4.39,-.88 -4.38,-.92 -4.37,-.95 -4.37,-.99 -4.36,-1.01 -4.35,-1.04 -4.35,-1.08 -4.34,-1.09 -4.33,-1.12 -4.33,-1.15 -4.32,-1.16 -4.31,-1.19 -4.31,-1.21 -4.31,-1.23 -4.3,-1.24 -4.29,-1.26 -4.29,-1.28 -4.29,-1.29 -4.28,-1.31 -4.28,-1.32 -4.27,-1.34 -4.27,-1.35 -4.26,-1.36 -4.27,-1.37 -4.25,-1.38 -4.26,-1.39 -4.25,-1.4 -4.25,-1.41 -4.24,-1.42 -4.25,-1.43 -4.24,-1.43 -4.23,-1.44 -4.24,-1.45 -4.24,-1.45 -4.23,-1.46 -4.23,-1.47 -4.23,-1.46 -4.22,-1.48 -4.23,-1.47 -4.23,-1.48 -4.22,-1.48 -4.22,-1.48 -4.23,-1.48 -4.22,-1.49 -4.22,-1.48 -4.23,-1.49 -4.22,-1.49 -4.22,-1.48 -5.01,-1.76 -7.81,-2.73 l-4.91,-1.72",
            width: 24.75,
        },
        {
            transform: "translate(4388.1663 375.45)",
            d: "M0,0 q4.04,-.36 5.55,-.47 t2.71,-.19 2.19,-.12 1.87,-.06 1.67,-.02 1.56,.01 1.49,.04 1.45,.06 1.43,.08 1.42,.1 1.42,.12 1.42,.15 1.43,.16 1.43,.17 1.44,.2 1.44,.22 1.46,.23 1.45,.25 1.47,.27 1.47,.29 1.48,.31 1.48,.33 1.49,.34 1.49,.36 1.49,.39 1.5,.4 1.5,.41 1.5,.44 1.5,.46 1.5,.47 1.5,.5 1.5,.51 1.5,.53 1.5,.55 1.49,.57 1.5,.58 1.49,.61 1.48,.62 1.48,.65 1.48,.66 1.47,.68 1.46,.7 1.46,.72 1.45,.74 1.44,.76 1.43,.77 1.43,.8 1.41,.81 1.41,.84 1.39,.85 1.38,.87 1.37,.89 1.36,.91 1.34,.93 1.34,.95 1.31,.97 1.31,.98 1.28,1.01 1.27,1.03 1.26,1.04 1.24,1.07 1.22,1.08 1.2,1.1 1.18,1.13 1.17,1.14 1.14,1.16 1.12,1.18 1.67,1.92 2.99,3.55 l1.88,2.24",
            width: 18,
        },
        {
            transform: "translate(4626.8148 377.576)",
            d: "M108,0 q-4.04,-.36 -5.55,-.47 t-2.71,-.19 -2.19,-.12 -1.87,-.06 -1.67,-.02 -1.56,.01 -1.49,.04 -1.45,.06 -1.43,.08 -1.42,.1 -1.42,.12 -1.42,.15 -1.43,.16 -1.43,.17 -1.44,.2 -1.44,.22 -1.46,.23 -1.45,.25 -1.47,.27 -1.47,.29 -1.48,.31 -1.48,.33 -1.49,.34 -1.49,.36 -1.49,.39 -1.5,.4 -1.5,.41 -1.5,.44 -1.5,.46 -1.5,.47 -1.5,.5 -1.5,.51 -1.5,.53 -1.5,.55 -1.49,.57 -1.5,.58 -1.49,.61 -1.48,.62 -1.48,.65 -1.48,.66 -1.47,.68 -1.46,.7 -1.46,.72 -1.45,.74 -1.44,.76 -1.43,.77 -1.43,.8 -1.41,.81 -1.41,.84 -1.39,.85 -1.38,.87 -1.37,.89 -1.36,.91 -1.34,.93 -1.34,.95 -1.31,.97 -1.31,.98 -1.28,1.01 -1.27,1.03 -1.26,1.04 -1.24,1.07 -1.22,1.08 -1.2,1.1 -1.18,1.13 -1.17,1.14 -1.14,1.16 -1.12,1.18 -1.67,1.92 -2.99,3.55 l-1.88,2.24",
            width: 18,
        },
        {
            transform: "translate(4497.1419 304.0589)",
            d: "M24.91,6.3 q5.04,-1.48 6.94,-2.01 t3.44,-.91 2.8,-.68 2.42,-.52 2.17,-.41 2.03,-.33 1.92,-.28 1.87,-.23 1.82,-.2 1.81,-.16 1.79,-.14 1.79,-.12 1.78,-.09 1.78,-.08 1.77,-.05 1.78,-.03 1.77,-.01 1.77,0 1.78,.03 1.77,.04 1.77,.07 1.77,.08 1.77,.11 1.77,.12 1.76,.15 1.77,.17 1.76,.19 1.76,.22 1.75,.24 1.75,.26 1.75,.3 1.74,.32 1.74,.36 1.73,.39 1.72,.42 1.7,.48 1.7,.51 1.67,.58 1.64,.64 1.61,.74 1.55,.83 1.51,.91 1.45,.99 1.4,1.08 1.33,1.15 1.27,1.22 1.21,1.28 1.14,1.34 1.07,1.4 1.01,1.44 .95,1.49 .89,1.52 .83,1.56 .77,1.59 .72,1.61 .66,1.64 .62,1.66 .57,1.67 .53,1.69 .48,1.7 .45,1.71 .4,1.73 .37,1.73 .34,1.74 .31,1.74 .28,1.75 .25,1.75 .22,1.76 .2,1.76 .17,1.76 .15,1.77 .13,1.77 .11,1.77 .09,1.76 .07,1.78 .05,1.77 .04,1.77 .01,1.77 .01,1.77 -.01,1.78 -.03,1.77 -.04,1.77 -.05,1.77 -.06,1.77 -.08,1.77 -.09,1.78 -.09,1.77 -.11,1.76 -.12,1.77 -.13,1.77 -.14,1.77 -.15,1.77 -.15,1.76 -.16,1.77 -.17,1.76 -.18,1.77 -.19,1.76 -.19,1.76 -.2,1.76 -.21,1.76 -.21,1.76 -.22,1.76 -.22,1.76 -.23,1.76 -.23,1.76 -.24,1.75 -.23,1.76 -.24,1.76 -.23,1.75 -.24,1.76 -.24,1.76 -.24,1.75 -.25,1.76 -.26,1.75 -.26,1.76 -.27,1.75 -.28,1.75 -.28,1.75 -.3,1.75 -.3,1.74 -.3,1.75 -.32,1.75 -.32,1.74 -.33,1.74 -.34,1.74 -.35,1.74 -.36,1.73 -.37,1.74 -.37,1.73 -.39,1.73 -.4,1.73 -.4,1.72 -.42,1.73 -.43,1.72 -.44,1.71 -.46,1.71 -.47,1.71 -.48,1.71 -.5,1.7 -.51,1.7 -.54,1.69 -.55,1.68 -.57,1.68 -.59,1.67 -.62,1.66 -.64,1.65 -.67,1.64 -.71,1.63 -.74,1.61 -.78,1.58 -.84,1.57 -.88,1.53 -.96,1.48 -1.05,1.41 -1.18,1.27 -1.33,1.11 -1.42,.98 -1.51,.87 -1.56,.78 -1.6,.7 -1.64,.64 -1.67,.57 -1.68,.52 -1.7,.47 -1.72,.42 -1.73,.38 -1.73,.34 -1.75,.29 -1.75,.27 -1.75,.23 -1.76,.19 -1.77,.16 -1.76,.13 -1.77,.1 -1.77,.07 -1.77,.04 -1.77,.01 -1.78,-.02 -1.77,-.05 -1.77,-.08 -1.76,-.11 -1.77,-.15 -1.76,-.17 -1.76,-.21 -1.76,-.24 -1.75,-.28 -1.74,-.31 -1.73,-.35 -1.73,-.4 -1.72,-.43 -1.7,-.48 -1.69,-.54 -1.67,-.58 -1.64,-.65 -1.62,-.71 -1.56,-.81 -1.45,-.96 -1.33,-1.11 -1.24,-1.23 -1.15,-1.31 -1.08,-1.38 -1.01,-1.43 -.95,-1.48 -.91,-1.51 -.86,-1.54 -.82,-1.57 -.78,-1.58 -.74,-1.61 -.72,-1.61 -.68,-1.64 -.66,-1.64 -.64,-1.65 -.61,-1.67 -.59,-1.67 -.56,-1.68 -.55,-1.68 -.53,-1.69 -.52,-1.7 -.5,-1.7 -.48,-1.71 -.46,-1.71 -.46,-1.71 -.44,-1.72 -.42,-1.72 -.42,-1.72 -.4,-1.73 -.39,-1.73 -.38,-1.73 -.37,-1.73 -.36,-1.74 -.34,-1.73 -.34,-1.74 -.33,-1.75 -.32,-1.74 -.31,-1.75 -.3,-1.74 -.29,-1.75 -.29,-1.75 -.27,-1.75 -.27,-1.76 -.26,-1.75 -.25,-1.75 -.24,-1.76 -.24,-1.76 -.23,-1.75 -.24,-1.76 -.23,-1.76 -.23,-1.76 -.22,-1.75 -.22,-1.76 -.21,-1.76 -.2,-1.76 -.2,-1.77 -.2,-1.76 -.18,-1.76 -.18,-1.76 -.18,-1.77 -.16,-1.76 -.16,-1.77 -.15,-1.77 -.14,-1.76 -.13,-1.77 -.12,-1.77 -.11,-1.77 -.11,-1.77 -.09,-1.77 -.08,-1.77 -.07,-1.77 -.06,-1.77 -.05,-1.78 -.04,-1.77 -.02,-1.77 -.01,-1.77 .01,-1.77 .02,-1.78 .03,-1.77 .05,-1.77 .07,-1.77 .09,-1.77 .1,-1.77 .12,-1.77 .15,-1.77 .16,-1.76 .18,-1.76 .21,-1.76 .24,-1.76 .26,-1.75 .28,-1.75 .32,-1.75 .34,-1.73 .38,-1.74 .4,-1.72 .45,-1.71 .48,-1.71 .52,-1.69 .56,-1.68 .61,-1.66 .65,-1.65 .7,-1.63 .75,-1.6 .8,-1.57 .86,-1.55 .91,-1.51 .97,-1.48 1.04,-1.43 1.09,-1.39 1.16,-1.33 2.32,-1.98 4.67,-3.59 l2.93,-2.26",
            width: 24.75,
        },
    ],
};

const ICONS = {
    menu: "M3 6h18M3 12h18M3 18h18",
    // A ribbon bow, with soft loops, folded tails, and a central knot.
    pia: "M11.5 11.8C9.3 10.1 6 7.5 5.4 5.1 4.9 2.7 7.1 2 8.9 3.9c1.7 1.8 2.7 4.9 3.2 7.8m.4.1c2.2-1.7 5.5-4.3 6.1-6.7.5-2.4-1.7-3.1-3.5-1.2-1.7 1.8-2.7 4.9-3.2 7.8m-.8 1.1c-1.5 2.2-3.7 4.9-5.5 7.7 1.9-.7 3.8-1.3 5.8-1.8.3-2 .6-3.9.8-5.9m.8 0c1.5 2.2 3.7 4.9 5.5 7.7-1.9-.7-3.8-1.3-5.8-1.8-.3-2-.6-3.9-.8-5.9m-1.5-1.4c0-1.3 3-1.3 3 0v1.7c0 1.3-3 1.3-3 0z",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    close: "M6 6l12 12M18 6L6 18",
    send: "M12 19V5M5 12l7-7 7 7",
    stop: "M7 7h10v10H7z",
    mic: "M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM19 11a7 7 0 01-14 0M12 18v3",
    clip: "M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9",
    plus: "M12 5v14M5 12h14",
    artifact: "M4 5h16v14H4zM4 9h16M8 5v4",
    folder: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z",
    file: "M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5",
    diff: "M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M9 11.5h6M12 8.5v6M9 17.5h6",
    back: "M15 18l-6-6 6-6",
    clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
    chevron: "M9 6l6 6-6 6",
    down: "M6 9l6 6 6-6",
    up: "M12 19V5M5 12l7-7 7 7",
    eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
    search: "M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3",
    shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
    external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5",
    key: "M15 7a4 4 0 11-3.9 4.9L3 20v-3h3v-3h3l1.1-1.1A4 4 0 0115 7z",
    users: "M16 20v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 11a4 4 0 100-8 4 4 0 000 8zM22 20v-1a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8",
    sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
    chat: "M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z",
    fork: "M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9",
    command: "M9 6a3 3 0 10-3 3h12a3 3 0 10-3-3v12a3 3 0 103-3H6a3 3 0 103 3z",
    sidebar: "M4 4h16v16H4zM9 4v16",
    tiles: "M3 5h12v14H3zM17 5h4v6h-4zM17 13h4v6h-4z",
    grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    pin: "M9 4h6M10 4v6l-3 4h10l-3-4V4M12 14v6",
    star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z",
    palette:
        "M12 3a9 9 0 100 18c1 0 1.5-.8 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 005-5c0-4.4-4-7.8-9-7.8zM7.5 12.5h.01M9.5 8h.01M14.5 8h.01M17 11.5h.01",
    sun: "M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
    moon: "M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z",
    pulse: "M3 12h4l2-6 4 12 2-6h6",
    keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
    swatch: "M4 4h7v16H4zM11 9l6-4 3 5-9 6M11 16h9v4h-9",
    home: "M3 11l9-7 9 7M5 10v10h14V10",
    archive: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
    unarchive: "M3 4h18v4H3zM5 8v12h14V8M12 18v-6M9 15l3-3 3 3",
    unread: "M3 6h18v12H3zM3 7l9 5 9-5M20.5 3.5h.01",
    check: "M5 12l5 5L20 7",
    logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
    globe: "M12 21a9 9 0 100-18 9 9 0 000 18zM3.5 9h17M3.5 15h17M12 3a14 14 0 010 18M12 3a14 14 0 000 18",
    port: "M5 5h14a1 1 0 011 1v8a1 1 0 01-1 1h-3v4H8v-4H5a1 1 0 01-1-1V6a1 1 0 011-1zM8 5v4M12 5v4M16 5v4",
    reload: "M20 12a8 8 0 11-2.3-5.7M20 4v5h-5",
    copy: "M9 9h10a1 1 0 011 1v10a1 1 0 01-1 1H9a1 1 0 01-1-1V10a1 1 0 011-1zM5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1",
    undo: "M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-4",
    phone: "M8 3h8a1 1 0 011 1v16a1 1 0 01-1 1H8a1 1 0 01-1-1V4a1 1 0 011-1zM11 18h2",
    tablet: "M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1zM11 17h2",
    monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
    terminal: "M4 5h16v14H4zM8 10l2 2-2 2M12 14h4",
    fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    // Compact: two rules, and what is between them pressed toward the middle.
    compact: "M4 3h16M4 21h16M12 6v5M9 8l3 3 3-3M12 18v-5M9 16l3-3 3 3",
    // Taking turns: a steering wheel.
    wheel: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM12 10a2 2 0 1 0 0 4 2 2 0 1 0 0-4zM3.3 11.2l6.7.6M20.7 11.2l-6.7.6M12 14v6.9",
};

/** How far each key scrolls a sheet's body, by its height. */
const SCROLL_KEYS = {
    ArrowDown: 0.1,
    ArrowUp: -0.1,
    PageDown: 0.9,
    PageUp: -0.9,
    " ": 0.9,
    End: 1e6,
    Home: -1e6,
};

/**
 * The keys that scroll a page scroll a sheet focused as a whole (as it is when it opens), when its body holds nothing to
 * focus: a sheet only read, such as Keyboard shortcuts. One with controls keeps its keys (the menu's arrows).
 */
function scrollFromKeys(event) {
    const share = SCROLL_KEYS[event.key];
    const body = event.currentTarget.querySelector(":scope > .sheet-body");

    if (
        share === undefined ||
        event.defaultPrevented ||
        event.target !== event.currentTarget ||
        !body ||
        body.querySelector("a[href], button, input, select, textarea, [tabindex]") ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
    ) {
        return;
    }

    event.preventDefault();
    body.scrollTop += (event.shiftKey && event.key === " " ? -1 : 1) * share * body.clientHeight;
}

/** An icon's SVG path, for marks drawn outside Preact (gestures.js); "" for a name that is not one of the icons. */
export const iconPath = (name) =>
    typeof name === "string" && Object.hasOwn(ICONS, name) ? ICONS[name] : "";

/** Text with the letters at `hits` (indexes) marked, as matches of what someone searched for. */
export function Marked({ text, hits }) {
    if (!hits || hits.length === 0) {
        return text;
    }

    const set = new Set(hits);
    const parts = [];
    let run = "";
    let lit = false;

    for (let index = 0; index < text.length; index++) {
        const on = set.has(index);

        if (on !== lit && run !== "") {
            parts.push(lit ? html`<mark>${run}</mark>` : run);
            run = "";
        }

        lit = on;
        run += text[index];
    }

    if (run !== "") {
        parts.push(lit ? html`<mark>${run}</mark>` : run);
    }

    return parts;
}

/** One of the app's icons by `name`, or any 24×24 stroked path as `path` (extensions' own icons). */
export function Icon({ name, path, size = 20, class: className = "", stroke = 2, part }) {
    if (name === "pia" && path === undefined) {
        // The export uses board units. Match the other icons' 24-unit stroke scale,
        // rather than shrinking the board's contour into a subpixel hairline.
        const width = (874.7325 / 24) * stroke;

        return html`<svg
            class=${`icon ${className}`}
            data-part=${part}
            width=${size}
            height=${size}
            viewBox=${PIA_MARK.viewBox}
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            ${PIA_MARK.paths.map(
                (p, index) => html`<path
                transform=${p.transform}
                d=${p.d}
                stroke-width=${width * (index === 6 ? 0.8 : p.width / 24.75)}
            />`,
            )}
        </svg>`;
    }

    return html`<svg
        class=${`icon ${className}`}
        data-part=${part}
        width=${size}
        height=${size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width=${stroke}
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
    >
        <path d=${typeof path === "string" ? path : iconPath(name)} />
    </svg>`;
}

/**
 * The app's loaders, after Omarchy's: a quadrant block that steps around a square like a terminal spinner, and a flat
 * bar that eases toward 70% the way Omarchy's boot screen does while it waits.
 */
export function Spinner({ label = "Working", hidden = false }) {
    // Hidden from screen readers beside words that say the same.
    return hidden
        ? html`<span class="spinner" aria-hidden="true"></span>`
        : html`<span class="spinner" role="img" aria-label=${label}></span>`;
}

/** A spinner with a short line about what is loading, for sheets and panels. */
export function Loader({ label = "Loading" }) {
    return html`<div class="loader" role="status">
        <${Spinner} label=${label} />
        <span>${label}…</span>
    </div>`;
}

/** The full-screen loader: the ribbon logo over Omarchy's boot bar, and what is happening under it. */
export function Boot({ caption = "starting", detail = "", inline = false }) {
    return html`<div
        class=${`boot ${inline ? "inline" : ""}`}
        data-part="boot"
        role="status"
        aria-live="polite"
    >
        <div class="boot-mark" data-part="brand-mark" aria-hidden="true">
            <${Icon} name="pia" size=${64} />
        </div>
        <div class="boot-bar" aria-hidden="true"><span></span></div>
        <div class="boot-caption">${caption}</div>
        ${detail && html`<div class="boot-detail">${detail}</div>`}
    </div>`;
}

/** The element each edge was last published from (`useEdge`): one replacing another is not undone as the old goes. */
const edges = new Map();

/**
 * A ref that keeps `name` (a CSS variable on the page's root) at where its element reaches, `measure(rect)` px, as it
 * or the window resizes; unset while the element is hidden or gone. Pia's window keeps clear of the session's top bar
 * with it (`--topbar-h`).
 */
export function useEdge(name, measure) {
    const [ref] = useState(() => {
        let stop = null;

        const publish = (element) => {
            const root = document.documentElement;

            const update = () => {
                // Another element took the name since (a frame queued before this one went): it says, not this one.
                if (edges.get(name) !== element) {
                    return;
                }

                const rect = element.getBoundingClientRect();

                if (rect.height === 0) {
                    root.style.removeProperty(name);
                } else {
                    root.style.setProperty(name, `${Math.max(0, Math.round(measure(rect)))}px`);
                }
            };

            // Its first measure too, once the page is laid out and before it paints: measured as it mounts, it would lay
            // out the page in the middle of a draw.
            const observer = new ResizeObserver(update);
            // A pane popping in (`popin` scales it) moves the element without resizing it: measured again as an
            // animation around it ends. Not for the others (a row that rose in, a group that unrolled).
            let frame = 0;

            const settled = (event) => {
                if (!(event.target instanceof Node) || !event.target.contains(element)) {
                    return;
                }

                cancelAnimationFrame(frame);
                frame = requestAnimationFrame(update);
            };

            edges.set(name, element);
            observer.observe(element);
            addEventListener("resize", update);
            document.addEventListener("animationend", settled);

            return () => {
                observer.disconnect();
                removeEventListener("resize", update);
                document.removeEventListener("animationend", settled);
                cancelAnimationFrame(frame);

                if (edges.get(name) === element) {
                    edges.delete(name);
                    root.style.removeProperty(name);
                }
            };
        };

        return (element) => {
            stop?.();
            stop = element ? publish(element) : null;
        };
    });

    return ref;
}

/**
 * Say where a scroller has more than it shows: `data-more` is "up", "down", or "both" while it can scroll that way, and
 * gone while everything shows. The stylesheet fades that edge, so a list whose scrollbar is hidden still says it
 * scrolls. It follows scrolling, the scroller's size, and what is added to it or taken away. Returns a ref callback:
 * give it to the scroller as its `ref`.
 */
export function useScrollMore() {
    const [ref] = useState(() => {
        let stop = null;

        const watch = (element) => {
            let frame = 0;

            const update = () => {
                frame = 0;
                const up = element.scrollTop > 1;
                const down = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
                const more = up && down ? "both" : up ? "up" : down ? "down" : null;

                if (more === null) {
                    element.removeAttribute("data-more");
                } else if (element.dataset.more !== more) {
                    element.dataset.more = more;
                }
            };

            const later = () => {
                frame ||= requestAnimationFrame(update);
            };

            const sizes = new ResizeObserver(later);
            const content = new MutationObserver(later);

            sizes.observe(element);
            content.observe(element, { childList: true, subtree: true });
            element.addEventListener("scroll", later, { passive: true });
            later();

            return () => {
                cancelAnimationFrame(frame);
                sizes.disconnect();
                content.disconnect();
                element.removeEventListener("scroll", later);
            };
        };

        return (element) => {
            stop?.();
            stop = element ? watch(element) : null;
        };
    });

    return ref;
}

/**
 * Keep showing a value for `ms` after it goes away (null or undefined), so what it shows can animate out. Returns the
 * value to show and whether it is leaving.
 */
export function usePresence(value, ms = 200) {
    const [kept, setKept] = useState(value ?? null);
    const [leaving, setLeaving] = useState(false);
    const timer = useRef(0);

    useEffect(() => {
        clearTimeout(timer.current);

        if (value !== null && value !== undefined) {
            setKept(value);
            setLeaving(false);
        } else if (kept !== null) {
            if (document.documentElement.dataset.motion === "reduced") {
                setKept(null);

                return;
            }

            setLeaving(true);
            timer.current = setTimeout(() => {
                setKept(null);
                setLeaving(false);
            }, ms);
        }
    }, [value]);
    useEffect(() => () => clearTimeout(timer.current), []);

    return value !== null && value !== undefined
        ? [value, false]
        : [kept, leaving || kept !== null];
}

/**
 * Where a sliding indicator goes: the offset and size of the element matching `selector` inside `ref`. null when there
 * is none, or it is in a folded group. `instant` is true the first time it shows, so it appears in place instead of
 * sliding in from the top. `key` says which element is selected: it is measured again when `key` changes, and when the
 * list resizes or settles, not after every render. Measured after every render, each copy of the list laid the page out
 * early, and Back to the list on a phone froze the longer for it.
 */
export function useSlide(ref, selector, axis = "y", key = undefined) {
    const [box, setBox] = useState(null);
    const hidden = useRef(true);

    const measure = () => {
        const target = ref.current?.querySelector(selector);
        const next =
            target && !target.closest(".closed")
                ? axis === "y"
                    ? { at: target.offsetTop, size: target.offsetHeight }
                    : { at: target.offsetLeft, size: target.offsetWidth }
                : null;

        setBox((box) => (next?.at === box?.at && next?.size === box?.size ? box : next));
    };

    useLayoutEffect(measure, [key]);
    // Rows move without a render while a group folds, or the window resizes: measure again when they settle.
    useEffect(() => {
        const host = ref.current;

        if (!host) {
            return;
        }

        const settle = (event) => event.target !== host && measure();

        host.addEventListener("transitionend", settle);
        const observer =
            typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;

        observer?.observe(host);

        return () => {
            host.removeEventListener("transitionend", settle);
            observer?.disconnect();
        };
    }, [ref.current]);
    const instant = hidden.current;

    useEffect(() => {
        hidden.current = box === null;
    });

    return box === null ? null : { ...box, instant };
}

/** The bar a `useSlide` box draws. */
export function Slide({ box, axis = "y" }) {
    if (!box) {
        return null;
    }

    const style =
        axis === "y"
            ? `transform:translateY(${box.at}px);height:${box.size}px`
            : `transform:translateX(${box.at}px);width:${box.size}px`;

    return html`<span
        class=${`slide-${axis} ${box.instant ? "instant" : ""}`}
        data-part="segment-thumb"
        style=${style}
        aria-hidden="true"
    ></span>`;
}

/**
 * Which side of the screen an element stands on, `left` or `right`, as it is laid out now: a theme may move the sidebar
 * or the drawer to the right, and what is dragged by its edge must follow. Looked at again as the window resizes. `of`
 * gives the element from the ref's.
 */
export function useSide(ref, of = (element) => element) {
    const [side, setSide] = useState("left");
    const look = useRef(null);

    const watched = useRef(null);
    const watcher = useRef(null);

    look.current = () => {
        const element = ref.current && of(ref.current);
        const box = element?.getBoundingClientRect();

        if (box && box.width > 0) {
            setSide(box.left + box.width / 2 > innerWidth / 2 ? "right" : "left");
        }
    };

    // Measured when the browser lays the element out anyway, before the frame is painted: as it comes, shows, or changes
    // size (a ResizeObserver says so). Measured after each draw instead, it laid the whole page out early, and opening a
    // session froze the longer for it on a phone.
    useLayoutEffect(() => {
        const element = ref.current && of(ref.current);

        if (element === watched.current) {
            return;
        }

        watched.current = element;
        watcher.current ??= new ResizeObserver(() => look.current());
        watcher.current.disconnect();

        if (element) {
            watcher.current.observe(element);
        }
    });
    // And when the window changes, which can move it without resizing it.
    useLayoutEffect(() => {
        const again = () => look.current();

        addEventListener("resize", again);

        return () => {
            removeEventListener("resize", again);
            watcher.current?.disconnect();
        };
    }, []);

    return side;
}

/**
 * A rail button's state for themes (`data-state`): `open` while what it opens shows, `busy` while it counts work that
 * goes on; both, or neither (undefined).
 */
export const railState = (open, busy = false) =>
    [open && "open", busy && "busy"].filter(Boolean).join(" ") || undefined;

/** Keys as they are on this device: ⌘ on Apple keyboards, Ctrl elsewhere. */
export const APPLE = /Mac|iPhone|iPad/.test(navigator.platform ?? "");

const MOD = APPLE ? "⌘" : "Ctrl";

/** A keyboard shortcut as key caps: `Keys keys="Mod K"`. */
export function Keys({ keys }) {
    return keys.split(" ").map((key) => html`<kbd>${key === "Mod" ? MOD : key}</kbd>`);
}

/**
 * Something inside failed to render: show nothing there instead of taking the whole app down. A new `reset` value (the
 * sheet opened again) tries again.
 */
export class Boundary extends Component {
    state = { failed: false };

    componentDidCatch(error) {
        console.error(error);
        this.setState({ failed: true });
    }

    componentDidUpdate(previous) {
        if (this.state.failed && previous.reset !== this.props.reset) {
            this.setState({ failed: false });
        }
    }

    render({ children }, { failed }) {
        return failed ? null : children;
    }
}

/**
 * Whether the store changed in none of `keys` between two states. A change to nothing at all is a change:
 * `store.set({})` draws everything again (a media query that changed, say).
 */
function quietFor(keys, before, after) {
    if (before === after) {
        return false;
    }

    let changed = false;

    for (const key in after) {
        if (before[key] !== after[key]) {
            if (keys.has(key)) {
                return false;
            }

            changed = true;
        }
    }

    for (const key in before) {
        if (!(key in after)) {
            return false;
        }
    }

    return changed;
}

const sameProps = (a, b) =>
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.is(a[key], b[key]));

class DrawnFor extends Component {
    shouldComponentUpdate(next) {
        return !(
            next.component === this.props.component &&
            quietFor(next.keys, this.props.state, next.state) &&
            sameProps(this.props.props, next.props)
        );
    }

    render({ component, props }) {
        return h(component, props);
    }
}

/**
 * `component`, drawn again only when the store changes in one of `keys`, its props change, or `store.set({})` asks
 * everything to draw again: for big parts that read little of the store, such as the session list. `keys` must name
 * every key of the store it reads as it draws, and every key the functions it calls read (`prefs()` reads
 * `appearance`, `canSteer()` reads `me`): a key left out shows stale data. What it reads only in an event handler
 * does not count. Its own state draws it again as usual.
 */
export function drawnFor(keys, component) {
    const set = new Set(keys);
    const Wrapped = (props) => h(DrawnFor, { component, props, keys: set, state: store.state });

    Wrapped.displayName = component.name;

    return Wrapped;
}

class Memo extends Component {
    shouldComponentUpdate(next) {
        const { ignored } = next;
        const before = this.props.props;
        const after = next.props;
        const keys = Object.keys(after).filter((key) => !ignored.includes(key));

        return (
            next.component !== this.props.component ||
            Object.keys(before).length !== Object.keys(after).length ||
            keys.some((key) => !Object.is(before[key], after[key]))
        );
    }

    render({ component, props }) {
        return h(component, props);
    }
}

/**
 * `component`, drawn again only when its props change (each compared with `Object.is`) or its own state does. It must
 * read nothing else as it draws, such as `store.state`: what it needs comes as props. `ignored` names props it reads
 * only as it mounts, whose change alone does not draw it again.
 */
export function memo(component, ignored = []) {
    const Wrapped = (props) => h(Memo, { component, props, ignored });

    Wrapped.displayName = component.name;

    return Wrapped;
}

/** Phones: sheets from the bottom edge, which drag back down to close, and menus that a swipe closes. */
export const BOTTOM_SHEETS = matchMedia("(max-width: 699px)");

/**
 * Wide screens, where the sidebar and the home screen's splash show (style.css's 960px). Narrower, the app does not
 * draw them at all: hidden, they cost a phone the list's whole draw again.
 */
export const WIDE = matchMedia("(min-width: 960px)");

/** No pointer that hovers (a touch screen): what only hovering shows, such as a row's buttons, is not drawn. */
export const NO_HOVER = matchMedia("(hover: none)");

// Each changing (a window resized, a phone turned, a mouse plugged in) draws the app again, with or without them: a sheet
// open as the phone turns gets its drag to close, or lets go of it.
for (const query of [WIDE, NO_HOVER, BOTTOM_SHEETS]) {
    query.addEventListener("change", () => store.set({}));
}

/** The sheet host supplies a back action only when another sheet is under this one. */
export const SheetBack = createContext(null);

/**
 * The open sheet's type and whether it is closing (`sheets.js`), which `Sheet` puts on itself for themes: `data-sheet`,
 * and `data-state="closing"`.
 */
export const SheetInfo = createContext(null);

/**
 * A scrim's press: it closes its layer only when it starts on the scrim itself, not on what the scrim holds, and only
 * with the main button (a right click opens the browser's menu, and must not close anything; on a Mac, Ctrl+click is
 * one).
 */
export const scrimPress = (close) => (event) =>
    event.button === 0 &&
    !(APPLE && event.ctrlKey) &&
    event.target === event.currentTarget &&
    close();

/** A bottom sheet on phones, a centered dialog on wide screens. */
export function Sheet({ title, onClose, children, wide = false, actions = null, className = "" }) {
    const ref = useRef(null);
    const onBack = useContext(SheetBack);
    const info = useContext(SheetInfo);

    useDragToClose(ref, { dir: "down", onClose, enabled: BOTTOM_SHEETS.matches });

    // Not the Esc that ends an input method's composing, which belongs to the field.
    useEffect(() => {
        const onKey = (event) =>
            event.key === "Escape" && !event.isComposing && event.keyCode !== 229 && onClose();

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, [onClose]);
    // Keys go to the sheet, not the message box behind it, unless something inside already took focus. Its field marked
    // autofocus takes them where a keyboard is at hand (the browser skips the attribute, the page already having focus);
    // on touch screens the sheet does, so no keyboard pops up over it.
    useEffect(() => {
        const sheet = ref.current;

        if (sheet && !sheet.contains(document.activeElement)) {
            const field = matchMedia("(pointer: coarse)").matches
                ? null
                : sheet.querySelector("[autofocus]");

            (field ?? sheet).focus({ preventScroll: true });
        }
    }, []);

    return html`<div
        class="overlay"
        data-part="scrim"
        data-for="sheet"
        onMouseDown=${scrimPress(onClose)}
    >
        <section
            class=${`sheet ${wide ? "wide" : ""} ${className}`}
            data-part="sheet"
            data-sheet=${info?.type ?? undefined}
            data-size=${wide ? "wide" : undefined}
            data-state=${info?.closing ? "closing" : undefined}
            ref=${ref}
            role="dialog"
            aria-modal="true"
            aria-label=${title}
            tabindex="-1"
            onKeyDown=${scrollFromKeys}
        >
            <header class="sheet-head" data-part="sheet-head">
                <div class="grip" aria-hidden="true"></div>
                ${
                    onBack &&
                    html`<button class="icon-button sheet-back" onClick=${onBack} aria-label="Back">
                        <${Icon} name="back" size=${18} />
                    </button>`
                }
                <h2>${title}</h2>
                ${actions}
                <button class="icon-button" onClick=${onClose} aria-label="Close">
                    <${Icon} name="close" />
                </button>
            </header>
            <div class="sheet-body" data-part="sheet-body">${children}</div>
        </section>
    </div>`;
}

/** What Tab reaches in `box`, in order. */
function tabStops(box) {
    const all = box.querySelectorAll(
        'a[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable="true"]',
    );

    return [...all].filter(
        (each) =>
            each.tabIndex >= 0 &&
            !each.disabled &&
            !each.closest("[inert]") &&
            (each.checkVisibility?.({ visibilityProperty: true, checkVisibilityCSS: true }) ??
                each.getClientRects().length > 0),
    );
}

// Tab stays in the dialog on top (a sheet, a menu, the Files tile or Browser panel over the app), as in a browser's own
// modal dialog: past its last control it goes round to the first, and from outside it goes in.
addEventListener("keydown", (event) => {
    if (
        event.key !== "Tab" ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
    ) {
        return;
    }

    const box = [...document.querySelectorAll('[aria-modal="true"]')]
        .filter((each) => !each.closest("[inert]"))
        .at(-1);

    if (!box) {
        return;
    }

    const active = document.activeElement;

    // Focus in a layer that comes after the dialog and is not one itself (Pia's window, or the drawer, over a covering
    // Files tile or Browser panel) is above it: Tab moves there, as before.
    if (
        active !== null &&
        !box.contains(active) &&
        box.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING
    ) {
        return;
    }

    const stops = tabStops(box);
    const toward = event.shiftKey
        ? Node.DOCUMENT_POSITION_PRECEDING
        : Node.DOCUMENT_POSITION_FOLLOWING;
    const more =
        box.contains(active) &&
        stops.some((each) => each !== active && active.compareDocumentPosition(each) & toward);

    if (!more) {
        event.preventDefault();
        (event.shiftKey ? stops.at(-1) : stops[0])?.focus();
    }
});

/**
 * Where a menu opens from the control `selector` names: above it and aligned with it, or below it for a control near the
 * top of the screen, within what shows of the page (a phone's keyboard can cover it), and as tall as its rows need up to
 * a menu's height. Null, for the middle of the screen, when the control is gone or scrolled away, or has too little
 * room on either side.
 */
export function popAnchor(selector) {
    const rect = document.querySelector(selector)?.getBoundingClientRect();

    if (!rect || rect.width === 0) {
        return null;
    }

    const top = visualViewport?.offsetTop ?? 0;
    const bottom = top + (visualViewport?.height ?? innerHeight);

    // Scrolled away above. One under a phone's keyboard opens from the keyboard's top edge.
    if (rect.bottom < top) {
        return null;
    }

    const width = Math.min(420, innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, innerWidth - width - 8));
    const at = Math.min(rect.top, bottom - 8);
    const above = at - top - 14;

    if (above >= 220) {
        return { left, bottom: innerHeight - at + 6, width, height: Math.min(540, above) };
    }

    const below = bottom - rect.bottom - 14;

    return below >= 220 && rect.bottom <= bottom
        ? { left, top: rect.bottom + 6, width, height: Math.min(540, below), down: true }
        : null;
}

/** A `popAnchor` as a menu's style: nothing for the middle of the screen. */
export const anchorStyle = (anchor) =>
    anchor
        ? `left:${anchor.left}px;${anchor.down ? `top:${anchor.top}px` : `bottom:${anchor.bottom}px`};width:${anchor.width}px;max-height:${anchor.height}px`
        : "";

/** The short name of a model for chips: "Claude Opus 5.5" stays, long ids lose their date suffix. */
export function modelLabel(agent) {
    if (!agent?.model) {
        return "No model";
    }

    return agent.modelName ?? agent.model.modelId.replace(/-\d{8}$/, "");
}

/** An on and off switch, named for screen readers by `label`. */
export function Switch({ on, disabled, label, onChange }) {
    return html`<button
        type="button"
        role="switch"
        aria-checked=${on ? "true" : "false"}
        aria-label=${label}
        class=${`switch ${on ? "on" : ""}`}
        disabled=${disabled}
        onClick=${onChange}
    >
        <span></span>
    </button>`;
}

/** A row in a menu: a label, an optional hint on the right, and what a tap does. */
export function item(label, run, hint) {
    return html`<button class="list-item" onClick=${run}>
        <span>${label}</span>
        ${hint && html`<span class="muted small">${hint}</span>`}
    </button>`;
}

/** Posted JSON laid out for people (the agent gets it compact); anything else as it came. */
export function readable(text) {
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        return text;
    }
}

/** A place's tile: its icon, with a count or a dot, and its label. */
export function PlaceTile({ place }) {
    return html`<button
        type="button"
        class=${`place ${place.on ? "on" : ""}`}
        data-place=${place.id}
        aria-label=${place.count > 0 ? `${place.label}, ${place.count} ${place.counted ?? ""}`.trim() : place.badge ? `${place.label}, ${place.badge}` : place.dot ? `${place.label}, ${place.dotLabel ?? "a page open"}` : place.label}
        aria-pressed=${place.on === undefined ? undefined : place.on ? "true" : "false"}
        onClick=${place.run}
    >
        <span class="place-icon badge-host">
            <${Icon} name=${place.icon} path=${place.iconPath} size=${20} />
            ${place.count > 0 && html`<span class="badge">${place.count}</span>`}
            ${place.badge && html`<span class="badge">${place.badge}</span>`}
            ${place.dot && html`<span class="browser-dot" aria-hidden="true"></span>`}
        </span>
        <span class="place-label">${place.label}</span>
    </button>`;
}
