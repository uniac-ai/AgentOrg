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

test("the tab's icon is AgentOrg's, a PNG at each size the page names", () => {
  const page = readFileSync(new URL("index.html", dist), "utf8");
  const icons = [
    ...page.matchAll(/<link rel="icon" type="image\/png" sizes="(\d+)x\1" href="\/([^"]+)"/g),
  ];
  assert.deepEqual(
    icons.map(([, size, file]) => [size, file]),
    [
      ["16", "icon-16.png"],
      ["32", "icon-32.png"],
    ],
  );
  for (const [, size, file] of icons) {
    const png = readFileSync(new URL(file ?? "", dist));
    // A PNG's signature, then its header: width and height, 4 bytes each, from byte 16.
    assert.equal(png.subarray(1, 4).toString("latin1"), "PNG", file);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [Number(size), Number(size)]);
  }
});

test("the built folder has its index.html, and nothing the core wouldn't serve as what it is", () => {
  const files = readdirSync(dist);
  assert.ok(files.includes("index.html"));
  // The core serves .html, .js, .css, .svg and .png as what they are; frontend.json is read, and
  // THIRD_PARTY_LICENSES.txt kept for whoever has the folder: neither is fetched.
  assert.deepEqual(files.filter((file) => !/\.(html|js|css|svg|png)$/.test(file)).sort(), [
    "THIRD_PARTY_LICENSES.txt",
    "frontend.json",
  ]);
});
