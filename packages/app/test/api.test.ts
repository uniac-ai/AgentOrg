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
      views: { call: async () => ({}), subscribe: () => () => {}, log() {} },
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

test("a view's log line goes to its Actor's log, unanswered; one that doesn't fit is dropped", () => {
  const sent: unknown[] = [];
  const logged: unknown[][] = [];
  const served = serveSocket(
    { send: (text) => sent.push(JSON.parse(text)), close() {} },
    {
      person: { call: async () => ({}), subscribe: () => () => {} },
      views: {
        call: async () => ({}),
        subscribe: () => () => {},
        log: (...line) => void logged.push(line),
      },
    },
  );
  const view = { actor: "board", module: "panel" };
  served.receive(
    JSON.stringify({ op: "log", view, level: "warn", message: "slow", fields: { ms: 9 } }),
  );
  for (const odd of [
    { op: "log", view, level: "debug", message: "no such level" },
    { op: "log", view, level: "info", message: 7 },
    { op: "log", view: { actor: "board" }, level: "info", message: "no module" },
    { op: "log", level: "info", message: "no view" },
  ])
    served.receive(JSON.stringify(odd));
  assert.deepEqual(logged, [[view, "warn", "slow", { ms: 9 }]]);
  assert.deepEqual(sent, []);
  served.closed();
});
