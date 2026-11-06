import assert from "node:assert/strict";
import test from "node:test";
import { serveSocket } from "../src/index.ts";

test("a socket has 64 calls in flight at most; past it, a call is refused busy", async () => {
  const sent: { id?: number; result?: unknown; error?: { code?: string } }[] = [];
  const release: (() => void)[] = [];
  const served = serveSocket(
    { send: (text) => sent.push(JSON.parse(text)), close() {} },
    {
      person: {
        // Calls that wait until the test lets them answer.
        call: () => new Promise((done) => release.push(() => done({}))),
        subscribe: () => () => {},
      },
      views: { call: async () => ({}), subscribe: () => () => {} },
    },
  );
  for (let id = 1; id <= 66; id++)
    served.receive(JSON.stringify({ id, op: "call", slot: "actors", method: "list", input: {} }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    sent.map((reply) => [reply.id, reply.error?.code]),
    [
      [65, "busy"],
      [66, "busy"],
    ],
  );
  // One answered, one more fits.
  release.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  served.receive(JSON.stringify({ id: 67, op: "call", slot: "actors", method: "list", input: {} }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.at(-1), { id: 1, result: {} });
  assert.equal(
    sent.some((reply) => reply.id === 67),
    false,
  );
  for (const done of release) done();
  served.closed();
});
