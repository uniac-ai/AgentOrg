// How a refusal's own words are set into a sentence of the shell's.

/** Words that start a sentence and are lower case inside one. A name keeps its capital. */
const STARTS = new Set(
  "a an it its the this that there these those they no not nothing none you your one some".split(
    " ",
  ),
);
/**
 * Words set after a colon inside a sentence: its first word lower case if it is one that only
 * starts a sentence, a name keeping its capital, and no full stop of its own.
 */
export const within = (words: string) => {
  const trimmed = words.trim().replace(/[.!]+$/, "");
  const first = /^[A-Za-z]+/.exec(trimmed)?.[0] ?? "";
  return STARTS.has(first.toLowerCase())
    ? first.toLowerCase() + trimmed.slice(first.length)
    : trimmed;
};

/** A refusal's words as the end of a sentence: "It couldn't be started: " and then this. */
export const clause = (words: string) => `${within(words)}.`;
