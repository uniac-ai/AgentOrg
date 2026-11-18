// The app's version is the release's: the one `@agentorg/cli` carries, which every release sets, so
// that the app and the core installed together say the same number.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const json = (url) => JSON.parse(readFileSync(url, "utf8"));

test("the app takes its version from the release's package, the CLI's", () => {
  const configUrl = new URL("../src-tauri/tauri.conf.json", import.meta.url);
  const config = json(configUrl);
  const from = json(new URL(config.version, configUrl));
  assert.equal(from.name, "@agentorg/cli");
  assert.match(from.version, /^\d+\.\d+\.\d+$/);
});
