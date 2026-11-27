import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import test from "node:test";

/**
 * The package's sets, each a folder of `src/`, and what each may import besides itself. Every set
 * takes `base/`; management takes provider and exposure; provider takes exposure; `base/` takes no
 * set. `index.ts` at the root takes everything, and no set takes it.
 */
const MAY: Record<string, readonly string[]> = {
  base: [],
  management: ["base", "provider", "exposure"],
  provider: ["base", "exposure"],
  exposure: ["base"],
  joining: ["base"],
  page: ["base"],
};

// The sources, read beside the test's own: the compiled test runs from dist/test.
const src = new URL("../../src/", import.meta.url);
/** The set of a path under `src/`: its first folder, `root` for a file directly in `src/`. */
const setOf = (path: string): string => (path.includes("/") ? (path.split("/")[0] ?? "") : "root");
/** The specifier of a relative import or re-export: `from "./x"`, `import "./x"`, `import("./x")`. */
const RELATIVE = /\bfrom\s*["'](\.[^"']*)["']|\bimport\s*\(?\s*["'](\.[^"']*)["']/g;

test("src/ holds index.ts and the six sets, and nothing else", () => {
  const stray = readdirSync(src, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory()
        ? !(entry.name in MAY)
        : entry.name.endsWith(".ts") && entry.name !== "index.ts",
    )
    .map((entry) => `src/${entry.name}`);
  assert.deepEqual(stray, [], `In no set: ${stray.join(", ")}. Put it in one of the six.`);
});

test("each set imports only what the rules allow", () => {
  const files = readdirSync(src, { recursive: true, encoding: "utf8" })
    .map((path) => path.split(sep).join("/"))
    .filter((path) => path.endsWith(".ts") && path !== "index.ts");
  const broken: string[] = [];
  for (const file of files) {
    const from = setOf(file);
    const text = readFileSync(new URL(file, src), "utf8");
    for (const match of text.matchAll(RELATIVE)) {
      const specifier = match[1] ?? match[2] ?? "";
      const target = new URL(specifier, new URL(file, src)).href;
      const to = target.startsWith(src.href) ? setOf(target.slice(src.href.length)) : "outside";
      if (to === from || MAY[from]?.includes(to)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      broken.push(`src/${file}:${line} (${from}) imports ${specifier} (${to})`);
    }
  }
  assert.deepEqual(broken, [], `Imports the rules don't allow:\n${broken.join("\n")}`);
});
