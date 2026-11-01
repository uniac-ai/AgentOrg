/** Isolated actual SDK catalog path; instrument only the provider's public method. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";

assert.equal(typeof global.gc, "function", "run this isolated fixture with --expose-gc");
const entry = pathToFileURL(resolve(process.argv[2]));
const requireSdk = createRequire(entry);
// Resolve the installed package's documented import condition, including nested SDK installs.
function mcpExport(name) {
  let path = dirname(requireSdk.resolve(`@modelcontextprotocol/sdk/${name}`));
  while (path !== dirname(path)) {
    const file = join(path, "package.json");
    const pkg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    if (pkg.name === "@modelcontextprotocol/sdk") {
      const exported = pkg.exports[`./${name}`] ?? pkg.exports["./*"];
      return import(pathToFileURL(join(path, exported.import.replace("*", name))).href);
    }
    path = dirname(path);
  }
  throw new Error("public MCP package export not found");
}
const { AjvJsonSchemaValidator } = await mcpExport("validation/ajv");
const { Server } = await mcpExport("server");
const { ListToolsRequestSchema, CallToolRequestSchema } = await mcpExport("types.js");
const { WebSocketServer } = requireSdk("ws");
const { connectClient } = await import(entry.href);
const schemas = [],
  providers = [],
  validators = [];
const seenSchemas = new WeakSet(),
  seenProviders = new WeakSet();
let duplicateSchemaIdentity = false;
const original = AjvJsonSchemaValidator.prototype.getValidator;
AjvJsonSchemaValidator.prototype.getValidator = function (schema) {
  duplicateSchemaIdentity ||= seenSchemas.has(schema);
  seenSchemas.add(schema);
  schemas.push(new WeakRef(schema));
  if (!seenProviders.has(this)) {
    seenProviders.add(this);
    providers.push(new WeakRef(this));
  }
  const validator = original.call(this, schema);
  validators.push(new WeakRef(validator));
  return validator;
};
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const port = server.address().port;
assert.ok(![60805, 54292, 8787, 58509, 54289, 54290].includes(port));
const sessions = new Set();
let actor, failure, proof;
let admissions = 0,
  initialized = 0,
  listResponses = 0,
  pagination = false,
  removed = false;
let kind = "string",
  withId = false,
  invalidOutput = false,
  refusal = false;
const valueSchema = () => ({
  ...(withId ? { $id: "urn:fixture:value" } : {}),
  type: "object",
  properties: { value: { type: kind } },
  required: ["value"],
  additionalProperties: false,
});
const tool = (name, outputSchema) => ({
  name,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema,
  annotations: { readOnlyHint: true },
  _meta: {
    "agentorg/tool": {
      id: "hub:fixture",
      name: "fixture",
      interface: name,
      one_way: false,
      long_running: false,
    },
  },
});
const tools = () => [
  ...(!removed ? [tool("observe_value", valueSchema())] : []),
  tool("observe_email", {
    type: "object",
    properties: { email: { type: "string", format: "email" } },
    required: ["email"],
    additionalProperties: false,
  }),
  tool("observe_ref", {
    type: "object",
    $defs: { count: { type: "integer", minimum: 1 } },
    properties: { count: { $ref: "#/$defs/count" } },
    required: ["count"],
    additionalProperties: false,
  }),
];
server.on("connection", (socket) => {
  let admitted = false,
    transport;
  const early = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data));
    if (!admitted) {
      assert.equal(frame.method, "connection.connect");
      assert.equal(frame.params.actorId, "fixture");
      assert.equal(frame.params.credential, "OWNED_FIXTURE_CREDENTIAL");
      admitted = true;
      admissions++;
      const mcp = new Server(
        { name: "owned-catalog", version: "1" },
        { capabilities: { tools: {} } },
      );
      sessions.add(mcp);
      mcp.oninitialized = () => initialized++;
      mcp.setRequestHandler(ListToolsRequestSchema, async (request) => {
        listResponses++;
        const current = tools();
        if (!pagination) return { tools: current };
        return request.params?.cursor
          ? { tools: current.slice(1) }
          : { tools: current.slice(0, 1), nextCursor: "owned-next" };
      });
      mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        if (removed && name === "observe_value")
          return {
            content: [{ type: "text", text: "not_found: Removed fixture interface" }],
            isError: true,
          };
        if (refusal)
          return {
            content: [{ type: "text", text: "forbidden: Owned fixture refusal" }],
            isError: true,
          };
        const value =
          name === "observe_value"
            ? {
                value: invalidOutput
                  ? []
                  : kind === "string"
                    ? "kept"
                    : kind === "number"
                      ? 7
                      : true,
              }
            : name === "observe_email"
              ? { email: invalidOutput ? "invalid" : "fixture@example.invalid" }
              : { count: invalidOutput ? 0 : 1 };
        return {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        };
      });
      transport = {
        async start() {
          for (const item of early.splice(0)) transport.onmessage?.(item);
        },
        async send(message) {
          socket.send(JSON.stringify(message));
        },
        async close() {
          socket.close();
        },
      };
      socket.on("close", () => transport.onclose?.());
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: { connectionId: crypto.randomUUID() },
        }),
      );
      void mcp.connect(transport).catch(() => socket.close());
    } else if (transport.onmessage) transport.onmessage(frame);
    else early.push(frame);
  });
});
const alive = (refs) => refs.reduce((sum, ref) => sum + Number(ref.deref() !== undefined), 0);
const collect = async () => {
  for (let i = 0; i < 8; i++) {
    await immediate();
    global.gc();
  }
  await immediate();
};
const done = async (pending) => {
  const answer = await pending;
  assert.equal(answer.state, "done");
  return answer.value;
};
const samples = [];
try {
  actor = await connectClient({
    url: `http://127.0.0.1:${port}`,
    actorId: "fixture",
    credential: "OWNED_FIXTURE_CREDENTIAL",
    maxRetryMs: 50,
  });
  const expected = JSON.stringify(await actor.available());
  for (let listing = 1; listing <= 120; listing++) {
    assert.equal(JSON.stringify(await actor.available()), expected);
    if ([30, 60, 120].includes(listing)) {
      await collect();
      samples.push({
        listings: listing + 1,
        validatorRequests: schemas.length,
        liveSchemas: alive(schemas),
        liveProviders: alive(providers),
        liveReturnedValidators: alive(validators),
        heapUsed: process.memoryUsage().heapUsed,
      });
    }
  }
  const bounded = samples.every((sample) => sample.liveSchemas <= 6 && sample.liveProviders <= 6);
  proof = {
    ok: false,
    node: process.version,
    samples,
    bounded,
    freshParsedSchemas: !duplicateSchemaIdentity,
    measurement:
      "WeakRefs observe only public provider inputs/owners/returned validators; heapUsed is process-wide after explicit GC, not RSS or incident attribution.",
    listings: listResponses,
    actualOrdinarySdk: true,
    ownedServer: { pid: process.pid, port },
    ownedListenerClosed: false,
  };
  assert.equal(duplicateSchemaIdentity, false);
  assert.equal(
    bounded,
    true,
    "replaced schema/compiler owners must be collectible; old shared provider retains every fresh schema",
  );
  withId = true;
  await actor.available();
  assert.deepEqual(await done(actor.call("observe_value")), { value: "kept" });
  kind = "number";
  await actor.available();
  assert.deepEqual(await done(actor.call("observe_value")), { value: 7 });
  for (const name of ["observe_value", "observe_email", "observe_ref"]) {
    invalidOutput = true;
    await assert.rejects(actor.call(name), /output schema/);
    invalidOutput = false;
    await done(actor.call(name));
  }
  refusal = true;
  assert.deepEqual(await actor.call("observe_value"), {
    state: "refused",
    code: "forbidden",
    message: "Owned fixture refusal",
  });
  refusal = false;
  removed = true;
  assert.equal((await actor.available()).flatMap((group) => group.interfaces).length, 2);
  assert.equal((await actor.call("observe_value")).code, "not_found");
  removed = false;
  pagination = true;
  assert.equal((await actor.available()).flatMap((group) => group.interfaces).length, 3);
  pagination = false;
  const previous = initialized;
  kind = "boolean";
  for (const socket of server.clients) socket.close(1000, "owned reconnect");
  const deadline = Date.now() + 10000;
  while (initialized <= previous) {
    assert.ok(Date.now() < deadline, "ordinary SDK reconnect must initialize");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await actor.available();
  assert.deepEqual(await done(actor.call("observe_value")), { value: true });
  invalidOutput = true;
  await assert.rejects(actor.call("observe_value"), /output schema/);
  invalidOutput = false;
  assert.equal(actor.ended, undefined);
  proof = {
    ...proof,
    ok: true,
    changedSameIdSchema: true,
    invalidOutputsRejected: true,
    officialFormatsAndLocalRefs: true,
    refusalPreserved: true,
    removedInterfaceRefused: true,
    paginatedDiscovery: true,
    reconnectFreshSchema: true,
    admissions,
    sourceOrDependencyPrivateFieldsInspected: false,
    realActorNativeModelInputs: 0,
  };
} catch (error) {
  failure = error;
  proof ??= { ok: false, node: process.version, samples, bounded: false, actualOrdinarySdk: true };
} finally {
  AjvJsonSchemaValidator.prototype.getValidator = original;
  await actor?.close();
  await Promise.allSettled([...sessions].map((session) => session.close()));
  await Promise.all(
    [...server.clients].map(
      (socket) =>
        new Promise((resolve) => {
          socket.once("close", resolve);
          socket.terminate();
        }),
    ),
  );
  await new Promise((resolve) => server.close(resolve));
  assert.equal(server.clients.size, 0);
  assert.equal(server.address(), null);
  proof.ownedListenerClosed = true;
  if (process.env.PROOF_OUTPUT)
    writeFileSync(process.env.PROOF_OUTPUT, `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof));
}
if (failure) throw failure;
