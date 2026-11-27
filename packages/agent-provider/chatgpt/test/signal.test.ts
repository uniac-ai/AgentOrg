import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** The provider's source, beside its built tests in `dist/test`, or its own tests in `test`. */
const here = dirname(fileURLToPath(import.meta.url));
const source = [join(here, "..", "..", "src"), join(here, "..", "src")].find((dir) =>
  existsSync(join(dir, "responses.ts")),
) as string;

/** What each `new Request(…)` in `text` is given: what is between its parentheses. */
function requestsIn(text: string): string[] {
  const found: string[] = [];
  for (
    let at = text.indexOf("new Request(");
    at !== -1;
    at = text.indexOf("new Request(", at + 1)
  ) {
    let depth = 0;
    let end = at + "new Request".length;
    do {
      if (text[end] === "(") depth++;
      else if (text[end] === ")") depth--;
      end++;
    } while (depth > 0 && end < text.length);
    found.push(text.slice(at, end));
  }
  return found;
}

test("no request is made with a signal: a signal goes to fetch beside the request, since a collected Request loses its aborts", () => {
  const files = readdirSync(source).filter((name) => name.endsWith(".ts"));
  assert.ok(files.includes("responses.ts"));
  for (const name of files)
    for (const made of requestsIn(readFileSync(join(source, name), "utf8")))
      assert.doesNotMatch(made, /\bsignal\b/, `${name}: ${made.split("\n")[0]}`);
  // What it looks for, it finds: a request made with a signal, across lines.
  const [made] = requestsIn('const r = new Request(url, {\n  method: "POST",\n  signal,\n});');
  assert.match(made ?? "", /\bsignal\b/);
});
