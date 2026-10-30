/** Per-request execution outcomes retain no Actor-to-executor binding or retry state. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ExecutionProvider,
  type ExecutionRequest,
  execution,
} from "../src/domain/execution.ts";

const request = (): ExecutionRequest => ({
  actorId: "act_existing",
  providerId: "provider_one",
  credential: "sentinel-private-bootstrap",
  config: { project: "sentinel-private-config" },
});

const provider = (
  createActor: ExecutionProvider["createActor"],
  schema: Record<string, unknown> = { type: "object" },
): ExecutionProvider => ({ describe: async () => ({ configSchema: schema }), createActor });

test("Provider success becomes ready without an Actor connection or another creation call", async () => {
  let arrived!: () => void;
  const invoked = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let finish!: (value: { actorId: string }) => void;
  const held = new Promise<{ actorId: string }>((resolve) => {
    finish = resolve;
  });
  let creates = 0;
  const client = execution(() =>
    provider(async () => {
      creates += 1;
      arrived();
      return held;
    }),
  );
  let settled = false;
  const outcome = client.create(request()).then((value) => {
    settled = true;
    return value;
  });
  await invoked;
  assert.equal(settled, false);
  assert.equal(creates, 1);
  finish({ actorId: "act_existing" });
  assert.deepEqual(await outcome, { providerId: "provider_one", status: "ready" });
  assert.equal(creates, 1);
});

test("each explicit creation may launch another execution for the same Actor", async () => {
  const accepted: unknown[] = [];
  const clients = new Map([
    [
      "provider_one",
      provider(async (input) => {
        accepted.push(input);
        return { actorId: input.actorId };
      }),
    ],
    [
      "provider_two",
      provider(async (input) => {
        accepted.push(input);
        return { actorId: input.actorId };
      }),
    ],
  ]);
  const client = execution((id) => clients.get(id));
  assert.equal((await client.create(request())).status, "ready");
  assert.equal((await client.create(request())).status, "ready");
  assert.equal((await client.create({ ...request(), providerId: "provider_two" })).status, "ready");
  assert.equal(accepted.length, 3);
});

test("schema acceptance preserves supplied configuration and optional bootstrap presence", async () => {
  const supplied: unknown[] = [];
  const schema = {
    type: "object",
    properties: { mode: { type: "string", default: "new-default" } },
    additionalProperties: false,
  };
  const client = execution(() =>
    provider(async (input) => {
      supplied.push(input);
      return { actorId: input.actorId };
    }, schema),
  );
  const config = {};
  await client.create({ ...request(), config });
  await client.create({ actorId: "act_existing", providerId: "provider_one", config });
  assert.deepEqual(supplied, [
    { actorId: "act_existing", credential: "sentinel-private-bootstrap", config: {} },
    { actorId: "act_existing", config: {} },
  ]);
  assert.deepEqual(config, {});
  assert.deepEqual(schema.properties.mode, { type: "string", default: "new-default" });
});

test("unavailable Providers, descriptor errors and invalid configuration fail before launch", async () => {
  let creates = 0;
  const createActor: ExecutionProvider["createActor"] = async ({ actorId }) => {
    creates += 1;
    return { actorId };
  };
  const cases = [
    execution(() => undefined),
    execution(() => {
      throw new Error("sentinel-private-bootstrap");
    }),
    execution(() => ({
      describe: async () => {
        throw new Error("sentinel-private-bootstrap");
      },
      createActor,
    })),
    execution(() => ({
      describe: async () => ({ configSchema: null as unknown as Record<string, unknown> }),
      createActor,
    })),
    execution(() => provider(createActor, { type: "object", required: ["missing"] })),
  ];
  for (const client of cases) {
    const outcome = await client.create(request());
    assert.equal(outcome.status, "failed");
    assert.equal(JSON.stringify(outcome).includes("sentinel-private"), false);
  }
  const client = execution(() => provider(createActor));
  assert.equal(
    (await client.create({ ...request(), config: [] as unknown as Record<string, unknown> }))
      .status,
    "failed",
  );
  assert.equal(creates, 0);
});

test("only a known Provider refusal establishes failed after launch; ambiguous errors stay unknown", async () => {
  const failedCodes = [
    "PROVISIONING_FAILED",
    "invalid",
    "forbidden",
    "not_found",
    "conflict",
    "unavailable",
    "unauthorized",
  ];
  const unknownCodes = ["PROVISIONING_UNKNOWN", "timeout", "error", "sentinel-private-error"];
  for (const code of [...failedCodes, ...unknownCodes]) {
    let creates = 0;
    const client = execution(() =>
      provider(async () => {
        creates += 1;
        throw Object.assign(new Error("sentinel-private-bootstrap sentinel-private-config"), {
          code,
        });
      }),
    );
    const outcome = await client.create(request());
    assert.equal(outcome.status, failedCodes.includes(code) ? "failed" : "unknown");
    assert.equal(outcome.error?.code, failedCodes.includes(code) ? code : "PROVISIONING_UNKNOWN");
    assert.equal(JSON.stringify(outcome).includes("sentinel-private"), false);
    assert.equal(creates, 1);
  }
});

test("malformed success and transport errors report unknown without a replay or private result", async () => {
  for (const createActor of [
    async () => ({ actorId: "another_actor" }),
    async () => ({ actorId: "act_existing", nativeHandle: "sentinel-private-native" }),
    async () => {
      throw new Error("sentinel-private-bootstrap");
    },
  ]) {
    let creates = 0;
    const client = execution(() =>
      provider(async () => {
        creates += 1;
        return createActor();
      }),
    );
    const outcome = await client.create(request());
    assert.equal(outcome.status, "unknown");
    assert.equal(outcome.error?.code, "PROVISIONING_UNKNOWN");
    assert.equal(JSON.stringify(outcome).includes("sentinel-private"), false);
    assert.equal(creates, 1);
  }
});
