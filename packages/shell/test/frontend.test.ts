// The built folder says what it is to the core that serves it: "The frontend contract" in the
// repository's README.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const dist = new URL("../dist/", import.meta.url);
const json = (url: URL) => JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;

test("the built folder says the release it comes with, the CLI's, and the contract it speaks", () => {
  const { version } = json(new URL("../../app/package.json", import.meta.url));
  assert.deepEqual(json(new URL("frontend.json", dist)), { version, contract: 1 });
});

test("the built folder has its index.html, and nothing the core wouldn't serve as what it is", () => {
  const files = readdirSync(dist);
  assert.ok(files.includes("index.html"));
  // The core serves .html, .js, .css and .svg as what they are; frontend.json is read, not fetched.
  assert.deepEqual(
    files.filter((file) => !/\.(html|js|css|svg)$/.test(file)),
    ["frontend.json"],
  );
});
