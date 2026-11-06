/** Split model search text into words for loose-name ranking. */

/** One written word: letters and digits, and dots between digits ("gpt5.1"). */
const WRITTEN = /(?:[\p{L}\p{N}]|(?<=\p{N})\.(?=\p{N}))+/gu;

/**
 * The scripts written without spaces between words that Pia reads: Han, Kana and Hangul. Thai, Lao, Khmer, Myanmar and
 * Tibetan write that way too, but their words need a dictionary to tell apart, so they stay one word. Latin letters
 * touch the first three with no space at all ("用gpt-6.1-sol吧"), so where one of them meets another script, two words
 * meet, not one.
 */
const UNSPACED = "\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}";

/** One part of a written word: a run of one of those scripts, a run of other letters, a run of digits, or a version's dot. */
const PART = new RegExp(`[${UNSPACED}]+|[\\p{L}--[${UNSPACED}]]+|\\p{N}+|\\.`, "gv");

/** Whether a part is a run of one of those scripts. */
const UNSPACED_PART = new RegExp(`^[${UNSPACED}]+$`, "u");

/**
 * A text's lowercased words, split at anything not a letter or digit, where letters and digits meet ("GPT-5.1" is
 * gpt 5 1), and where a script written without spaces meets another ("用gpt" is 用 gpt), and how each joins the word
 * before it: "" inside one written word ("4o", "k3"), "." between the digits of a version ("2.5"), and " " for
 * anything else (a space, a dash, the edge of such a script).
 */
function split(text: string): { words: string[]; joins: string[] } {
    const words: string[] = [];
    const joins: string[] = [];

    for (const written of text.toLowerCase().match(WRITTEN) ?? []) {
        let join = " ";
        let unspacedBefore = false;

        for (const part of written.match(PART) ?? []) {
            if (part === ".") {
                join = ".";
            } else {
                const unspaced = UNSPACED_PART.test(part);

                words.push(part);
                joins.push(unspaced || unspacedBefore ? " " : join);
                unspacedBefore = unspaced;
                join = "";
            }
        }
    }

    return { words, joins };
}

/** A text's lowercased words, as `split` gives them. */
export function words(text: string): string[] {
    return split(text).words;
}
