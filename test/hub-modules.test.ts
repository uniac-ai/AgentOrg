/** A composed Hub module owns its schema, operation and authority without Actor RPC context. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { application } from "../src/domain/application.ts";
import { audit } from "../src/domain/audit.ts";
import { capabilities } from "../src/domain/capabilities.ts";
import { Forbidden } from "../src/domain/errors.ts";
import { toolDefinition } from "../src/domain/model/json-schema.ts";
import { registry } from "../src/domain/registry.ts";
import { bindTool } from "../src/domain/tools.ts";
import { SqliteStore } from "../src/storage/sqlite/index.ts";
import { done, refused } from "./harness.ts";

test("an explicitly composed module binds discovery and dispatch to its own principal policy", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const now = () => "2026-10-30T00:00:00.000Z";
  const actors = registry(store.actors, now);
  const { root } = await actors.createRoot();
  const { actor: worker } = await actors.create(root.id, "worker", "Work");
  const definition = toolDefinition("owned", {
    owned_write: {
      description: "An operation owned by this module.",
      writes: true,
      request: z.strictObject({ value: z.number().int() }),
      response: z.strictObject({ actor: z.string(), value: z.number().int() }),
    },
  });
  let writes = 0;
  const tool = bindTool(definition, {
    owned_write: (actor, request) => {
      if (actor.manager !== null) throw new Forbidden("only the root writes this module");
      writes += 1;
      return { actor: actor.id, value: request.value };
    },
  });
  const hub = application(actors, capabilities([tool]), audit(store.audit, now));
  const invocation = { signal: new AbortController().signal, progress: async () => {} };
  const invoke = (actor: string, name: string, input: Record<string, unknown>) =>
    hub.invoke(actor, name, input, invocation);
  assert.deepEqual(hub.available(worker.id), hub.available(root.id));
  assert.deepEqual(
    hub.available(root.id).map((each) => each.name),
    ["owned"],
  );
  assert.equal(hub.available(root.id)[0]?.interfaces[0]?.call, "owned_write");
  assert.equal(await refused(invoke(root.id, "owned_write", { value: "bad" })), "invalid");
  assert.equal(await refused(invoke(worker.id, "owned_write", { value: 7 })), "forbidden");
  assert.equal(await refused(invoke(root.id, "worker.owned_write", { value: 7 })), "not_found");
  assert.equal(writes, 0);
  assert.deepEqual(await done(invoke(root.id, "owned_write", { value: 7 })), {
    actor: root.id,
    value: 7,
  });
  assert.equal(writes, 1);
  assert.equal(store.database.count("calls", "1"), 0);
  assert.deepEqual(
    store.audit.list(undefined, 10).map((entry) => entry.outcome),
    ["ok", "not_found", "forbidden"],
  );
});
