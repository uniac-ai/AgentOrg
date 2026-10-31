/** Administrative Provider enrollment reads only the explicitly configured private file. */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { loadProviders } from "../src/server/config.ts";

function home(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-server-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("an absent enrollment file configures no Providers and creates no files", (t) => {
  const directory = home(t);
  assert.deepEqual(loadProviders(directory), []);
  assert.deepEqual(readdirSync(directory), []);
});

test("a private enrollment file loads existing Provider IDs and credential hashes", (t) => {
  const directory = home(t);
  const identities = [{ providerId: "provider-a", credentialHash: "ab".repeat(32) }];
  writeFileSync(join(directory, "providers.json"), JSON.stringify(identities), { mode: 0o600 });
  assert.deepEqual(loadProviders(directory), identities);
});

test("enrollment rejects malformed, duplicate, unprivate and extra-field configuration without exposing contents", (t) => {
  const directory = home(t);
  const path = join(directory, "providers.json");
  const identity = { providerId: "sentinel-provider-identity", credentialHash: "ab".repeat(32) };
  for (const content of [
    "sentinel-malformed-json",
    JSON.stringify(identity),
    JSON.stringify([null]),
    JSON.stringify([identity, identity]),
    JSON.stringify([{ ...identity, credential: "sentinel-provider-secret" }]),
    JSON.stringify([{ ...identity, credentialHash: "sentinel-invalid-hash" }]),
    JSON.stringify([{ ...identity, providerId: "" }]),
    JSON.stringify([{ providerId: 123, credentialHash: identity.credentialHash }]),
  ]) {
    writeFileSync(path, content, { mode: 0o600 });
    assert.throws(
      () => loadProviders(directory),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /providers.json must be private/);
        assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /sentinel/);
        return true;
      },
    );
  }
  writeFileSync(path, JSON.stringify([identity]), { mode: 0o600 });
  chmodSync(path, 0o644);
  assert.throws(() => loadProviders(directory), /providers.json must be private/);
});
