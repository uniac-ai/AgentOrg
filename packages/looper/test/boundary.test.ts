import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// From `dist/test`, where this runs: the package.
const root = join(import.meta.dirname, "../..");

test("the looper depends on nothing of this repository: its source imports its own files, zod and Node", () => {
  const { dependencies } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(dependencies), ["zod"]);

  const src = join(root, "src");
  const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((file) =>
    file.endsWith(".ts"),
  );
  const own = /^\.\/[\w./-]+\.js$/;
  let imports = 0;
  for (const file of files) {
    const source = readFileSync(join(src, file), "utf8");
    // Only static imports, which can be read here: nothing is loaded by a computed name.
    assert.doesNotMatch(source, /\brequire\s*\(|\bimport\s*\(|\bimport\.meta\b/, file);
    // Statements at the start of a line: a prompt's words can say `from "…"` too.
    for (const [, from] of source.matchAll(
      /^(?:(?:import|export|\})[^\n]*?\bfrom|import)\s*["']([^"']+)["']/gm,
    )) {
      imports++;
      assert.ok(
        from === "zod" ||
          from?.startsWith("node:") ||
          (from !== undefined && own.test(from) && !from.includes("..")),
        `${file} imports ${from}: the looper is given what it needs, as its own plain types`,
      );
    }
  }
  assert.ok(imports >= files.length - 1, "the imports are where this looks for them");
});
