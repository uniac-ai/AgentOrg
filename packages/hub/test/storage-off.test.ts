import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { kv } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { Hub, listen, PERSON } from "../src/index.ts";

test("with the built-in storage off, storage.db is never made and a call to it is refused", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agentorg-storage-off-"));
  const hub = Hub.open(home, { builtinStorage: false });
  const server = await listen(hub);
  const made = hub.state.createActor(PERSON, {
    name: "Keeps",
    bindings: [{ slot: "store", provider: "storage", export: "kv" }],
  });
  const client = await connect({
    hubUrl: server.url,
    actorId: made.actorId,
    credential: made.credential as string,
    slots: { store: kv },
  });
  t.after(async () => {
    client.close();
    await server.close();
    hub.close();
    rmSync(home, { recursive: true, force: true });
  });
  for (let i = 0; i < 300 && !client.slots.store.bound; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(
    client.slots.store.call.get({ key: "a" }),
    (error: unknown) => error instanceof Refused && error.code === "unavailable",
  );
  assert.equal(existsSync(join(home, "storage.db")), false);
  // Closing an Actor has no store to delete.
  hub.state.closeActor(PERSON, made.actorId);
});
