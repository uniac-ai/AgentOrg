// The built stylesheet: what no component's test would notice until a page looked wrong.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../dist/app.css", import.meta.url), "utf8");

/** Each top-level statement's prelude: what comes before its first `{`, or a `;` statement. */
function topLevel(text: string): string[] {
  const preludes: string[] = [];
  let depth = 0;
  let start = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{") {
      if (depth++ === 0) preludes.push(text.slice(start, i).trim());
    } else if (char === "}") {
      if (--depth === 0) start = i + 1;
    } else if (char === ";" && depth === 0) {
      preludes.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return preludes.filter(Boolean);
}

const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

test("the older pages' styles sit below the components", () => {
  // Compiled, the order is that of each layer's first appearance.
  const order = topLevel(bare).flatMap((prelude) =>
    prelude.startsWith("@layer ") ? prelude.slice(7).split(/,\s*/) : [],
  );
  const first = (name: string) => order.indexOf(name);
  for (const name of ["base", "legacy", "components", "utilities"])
    assert.notEqual(first(name), -1, name);
  assert.ok(first("base") < first("legacy"));
  assert.ok(first("legacy") < first("components"));
  assert.ok(first("components") < first("utilities"));
});

test("no style rule is outside a layer, where it would outrank every utility", () => {
  const loose = topLevel(bare).filter(
    (prelude) => !/^@(layer|property|keyframes)/.test(prelude) && !prelude.includes(".kit-"),
  );
  assert.deepEqual(loose, []);
});

test("the components' classes and state variants are compiled", () => {
  assert.match(css, /\.bg-popover\b/);
  assert.match(css, /\[data-state=("?)open\1\]/);
});

test("the tokens the components map onto exist in both themes", () => {
  assert.match(css, /--surface:/);
  assert.match(css, /--line-strong:/);
  assert.match(css, /\[data-theme="?light"?\]/);
});
