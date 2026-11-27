import assert from "node:assert/strict";
import test from "node:test";
import { isReference, literals } from "./check-imports.mjs";

/** The references the scanner finds in a source, as `line text`, with `(import)` on specifiers. */
const found = (source) =>
  literals(source)
    .filter(isReference)
    .map(({ line, text, specifier }) => `${line} ${text}${specifier ? " (import)" : ""}`);

test("comments are skipped", () => {
  const source = [
    '// import { Hub } from "@agentorg/hub";',
    '/* "@agentorg/mcp", and over',
    '   two lines: import "./gone.js" */',
    '/** `@agentorg/shell`\'s build */ const name = "@agentorg/manager";',
  ].join("\n");
  assert.deepEqual(found(source), ["4 @agentorg/manager"]);
});

test("a // inside a string doesn't start a comment", () => {
  const source = [
    'const url = "https://example.test/a"; const hub = "@agentorg/hub";',
    `const page = \`http://127.0.0.1:\${port}/\`; // "@agentorg/mcp"`,
    "fetch('//cdn.example.test/x.js'); import('./later.js');",
  ].join("\n");
  assert.deepEqual(found(source), ["1 @agentorg/hub", "3 ./later.js (import)"]);
});

test("a name held in a variable or resolved counts; one inside a sentence doesn't", () => {
  const source = [
    'const name = "@agentorg/hub";',
    "loaded = await import(name);",
    'createRequire(import.meta.url).resolve("@agentorg/shell/package.json");',
    'write("agentorg hub needs @agentorg/hub installed next to @agentorg/sdk.");',
    `throw new Error(\`@agentorg/hub didn't load: \${error}\`);`,
  ].join("\n");
  assert.deepEqual(found(source), ["1 @agentorg/hub", "3 @agentorg/shell/package.json"]);
});

test("relative specifiers of import, export, import() and require() count", () => {
  const source = [
    'import { a } from "./a.js";',
    "import type { B } from '../src/b.ts';",
    'import "./side-effect.js";',
    'export * from "./c.js";',
    "const d = await import(`./d.js`);",
    'const e = require("../e.cjs");',
    'const notes = "./notes.txt";',
    'import { z } from "zod";',
  ].join("\n");
  assert.deepEqual(found(source), [
    "1 ./a.js (import)",
    "2 ../src/b.ts (import)",
    "3 ./side-effect.js (import)",
    "4 ./c.js (import)",
    "5 ./d.js (import)",
    "6 ../e.cjs (import)",
    "8 zod (import)",
  ]);
});

test("a path up into a sibling workspace's folder counts", () => {
  const source = [
    'readFileSync(at("../app/package.json"), "utf8");',
    'json(new URL("../../app/package.json", import.meta.url));',
    'readFileSync(new URL("../dist/index.html", import.meta.url));',
  ].join("\n");
  assert.deepEqual(found(source), ["1 ../app/package.json", "2 ../../app/package.json"]);
});

test("regular expressions, JSX text and code in a template don't throw the reading off", () => {
  const source = [
    "const quote = /[\"'`]/g; const slash = /\\/\\//;",
    'const a = x / 2; const b = "@agentorg/hub";',
    `const t = \`one \${\`two \${"@agentorg/mcp"}\`} three\`;`,
    "const p = <p>Don't stop</p>;",
    'const c = "@agentorg/manager";',
  ].join("\n");
  assert.deepEqual(found(source), ["2 @agentorg/hub", "3 @agentorg/mcp", "5 @agentorg/manager"]);
});
