import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hubGrants } from "@agentorg/interfaces";
import {
  type DescribedInterface,
  defineInterface,
  describeInterface,
  event,
  hashInterface,
  type InterfaceSchemas,
  method,
  type Refused,
} from "@agentorg/sdk";
import { buildPackage } from "@agentorg/sdk/build";
import {
  type Body,
  encodeFrame,
  eventBody,
  FrameReader,
  type Header,
  input,
  memoryPair,
  parseBody,
  parseHeader,
  result,
  Session,
  webSocketChannel,
  wireError,
  type YamuxStream,
} from "@agentorg/wire";
import { z } from "zod";
import { HUB, Hub, listen, PERSON } from "../src/index.ts";
import { Validators } from "../src/validate.ts";

const notes = describeInterface(
  defineInterface({
    name: "notes",
    major: 1,
    kind: "rpc",
    methods: {
      write: method({
        input: z.object({ text: z.string().min(1) }),
        output: z.object({ n: z.number() }),
      }),
    },
    events: { written: event(z.object({ text: z.string() })) },
  }),
);
const echo = describeInterface(
  defineInterface({
    name: "echo",
    major: 1,
    kind: "stream",
    protocol: "bytes",
    open: z.object({ prefix: z.string() }),
  }),
);
const web = describeInterface(defineInterface({ name: "web", major: 1, kind: "http" }));
const text = new TextEncoder();
async function answerWith(writer: WritableStreamDefaultWriter<Uint8Array>, body: Body) {
  await writer.write(encodeFrame(body));
  await writer.close();
}
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Serve = (
  header: Extract<Header, { op: "serve" }>,
  stream: YamuxStream,
  reader: FrameReader,
) => Promise<void>;

/** Any body, read loosely: tests look at whichever key is there. */
type Reply = {
  result?: unknown;
  event?: unknown;
  error?: { name: string; code?: string; message: string };
};
const reply = (frame: unknown) => parseBody(frame) as Reply;

/** Send one header and maybe one body; read the one body that answers. */
async function exchange(session: Session, header: unknown, body?: Body): Promise<Reply> {
  const stream = session.open();
  const writer = stream.writable.getWriter();
  await writer.write(encodeFrame(header));
  if (body) await writer.write(encodeFrame(body));
  await writer.close();
  return reply(await new FrameReader(stream.readable).next());
}

async function connect(
  url: string,
  hello: { actorId: string; credential: string; declares?: unknown },
  serve?: Serve,
) {
  const socket = new WebSocket(url);
  const session = new Session(await webSocketChannel(socket), {
    client: true,
    onStream: (stream) => {
      const reader = new FrameReader(stream.readable);
      void reader
        .next()
        .then((h) => serve?.(parseHeader(h) as Extract<Header, { op: "serve" }>, stream, reader))
        .catch(() => {});
    },
  });
  const admitted = await exchange(session, { op: "hello", ...hello });
  return {
    session,
    socket,
    admitted,
    call: (slot: string, name: string, value: unknown) =>
      exchange(session, { op: "call", slot, method: name }, input(value)),
    subscribe(slot: string, name: string) {
      const stream = session.open();
      void stream.writable.getWriter().write(encodeFrame({ op: "subscribe", slot, event: name }));
      const reader = new FrameReader(stream.readable);
      return {
        next: async () => {
          const frame = await reader.next();
          return frame === undefined ? undefined : reply(frame);
        },
        reset: () => stream.reset(),
      };
    },
    close: () => session.close(),
  };
}
type Client = Awaited<ReturnType<typeof connect>>;

async function setup(t: test.TestContext, options: { answerTimeoutMs?: number } = {}) {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-router-")), "home");
  const hub = Hub.open(home, { helloTimeoutMs: 300, ...options });
  const server = await listen(hub);
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await server.close();
    hub.close();
    rmSync(join(home, ".."), { recursive: true, force: true });
  });
  const join_ = async (...args: Parameters<typeof connect>) => {
    const client = await connect(...args);
    clients.push(client);
    return client;
  };
  const person = await join_(server.url, {
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
  });
  /** An external Actor made through the person's hub.actors slot, then connected. */
  const actor = async (name: string, declares: unknown, serve?: Serve, bindings?: unknown[]) => {
    const made = (await person.call("actors", "create", {
      name,
      ...(bindings ? { bindings } : {}),
    })) as {
      result: { actorId: string; credential: string };
    };
    const client = await join_(server.url, { ...made.result, declares }, serve);
    return { id: made.result.actorId, client };
  };
  const bind = (consumer: string, slot: string, provider: string, exported: string) =>
    person.call("grants", "bind", { consumer, slot, provider, export: exported });
  return { hub, home, url: server.url, person, actor, bind };
}

/** A notes provider: replies with a count, keeps subscribers so the test can emit. */
function notesProvider(reply: (value: { text: string }) => unknown = () => ({ n: 1 })) {
  const subscribers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  const calls: { caller: string; input: unknown }[] = [];
  /** Calls whose stream the Hub reset before they answered. */
  let resets = 0;
  let hang = false;
  const serve: Serve = async (header, stream, reader) => {
    const writer = stream.writable.getWriter();
    if (header.kind === "subscribe") return void subscribers.add(writer);
    const body = parseBody(await reader.next()) as { input: { text: string } };
    calls.push({ caller: header.caller, input: body.input });
    if (hang)
      return void writer.closed.catch(() => {
        resets++;
      });
    await writer.write(encodeFrame(result(reply(body.input))));
    await writer.close();
  };
  const emit = async (payload: unknown) => {
    for (const writer of subscribers) await writer.write(encodeFrame(eventBody(payload)));
  };
  const waitSubscribed = async () => {
    while (!subscribers.size) await later(5);
  };
  return {
    serve,
    calls,
    resets: () => resets,
    emit,
    waitSubscribed,
    hangCalls: () => {
      hang = true;
    },
  };
}

test("bind, call, events, and an unbind that ends the subscription", async (t) => {
  const { actor, bind, hub, person } = await setup(t);
  const provider = notesProvider();
  const p = await actor("provider", { exports: { notes } }, provider.serve);
  const c = await actor("consumer", { slots: { notes } });
  assert.deepEqual(
    (await c.client.call("notes", "write", { text: "hi" })).error?.name,
    "NotConnected",
  );
  assert.deepEqual(await bind(c.id, "notes", p.id, "notes"), { result: { bound: true } });
  assert.deepEqual(await c.client.call("notes", "write", { text: "hi" }), { result: { n: 1 } });
  assert.deepEqual(
    provider.calls,
    [{ caller: c.id, input: { text: "hi" } }],
    "the provider learns who calls",
  );

  const sub = c.client.subscribe("notes", "written");
  await provider.waitSubscribed();
  await provider.emit({ text: "one" });
  assert.deepEqual(await sub.next(), { event: { text: "one" } });
  assert.deepEqual(await person.call("grants", "unbind", { consumer: c.id, slot: "notes" }), {
    result: {},
  });
  assert.equal((await sub.next())?.error?.name, "NotConnected", "the unbind ends it");
  assert.equal(await sub.next(), undefined);
  const calls = hub.state
    .audit(0, 1000)
    .entries.filter((e) => e.kind === "call" && e.actor === c.id);
  assert.deepEqual(
    calls.map((e) => [e.details.op, e.details.outcome]),
    [
      ["call", "not_connected"],
      ["call", "ok"],
      ["subscribe", "ok"],
    ],
  );
});

test("schemas are enforced both ways: invalid input never reaches the provider, bad output is bad_output", async (t) => {
  const { actor, bind } = await setup(t);
  const provider = notesProvider((value) => (value.text === "bad" ? { n: "many" } : { n: 2 }));
  const p = await actor("provider", { exports: { notes } }, provider.serve);
  const c = await actor("consumer", { slots: { notes } });
  await bind(c.id, "notes", p.id, "notes");
  const refused = await c.client.call("notes", "write", { text: "" });
  assert.equal(refused.error?.code, "invalid");
  assert.equal(provider.calls.length, 0);
  assert.equal((await c.client.call("notes", "nope", {})).error?.code, "invalid");
  assert.equal((await c.client.call("notes", "write", { text: "bad" })).error?.code, "bad_output");

  const sub = c.client.subscribe("notes", "written");
  await provider.waitSubscribed();
  await provider.emit({ text: 7 });
  assert.equal(
    (await sub.next())?.error?.code,
    "bad_output",
    "a broken event ends the subscription",
  );
});

test("a provider that disconnects is NotConnected; one that dies mid-call is OutcomeUnknown", async (t) => {
  const { actor, bind, hub } = await setup(t);
  const provider = notesProvider();
  const p = await actor("provider", { exports: { notes } }, provider.serve);
  const c = await actor("consumer", { slots: { notes } });
  await bind(c.id, "notes", p.id, "notes");
  provider.hangCalls();
  const pending = c.client.call("notes", "write", { text: "lost" });
  while (!provider.calls.length) await later(5);
  p.client.socket.close();
  assert.equal((await pending).error?.name, "OutcomeUnknown");
  while (hub.connected(p.id)) await later(5);
  assert.equal((await c.client.call("notes", "write", { text: "x" })).error?.name, "NotConnected");
});

test("a provider that goes mid-subscription ends it with NotConnected", async (t) => {
  const { actor, bind } = await setup(t);
  const provider = notesProvider();
  const p = await actor("provider", { exports: { notes } }, provider.serve);
  const c = await actor("consumer", { slots: { notes } });
  await bind(c.id, "notes", p.id, "notes");
  const sub = c.client.subscribe("notes", "written");
  await provider.waitSubscribed();
  p.client.socket.close();
  assert.equal((await sub.next())?.error?.name, "NotConnected");
});

test("a provider's answer is bounded by the deadline, and a caller that resets cancels it", async (t) => {
  const { actor, bind, hub } = await setup(t, { answerTimeoutMs: 200 });
  const provider = notesProvider();
  const p = await actor("provider", { exports: { notes } }, provider.serve);
  const c = await actor("consumer", { slots: { notes } });
  await bind(c.id, "notes", p.id, "notes");
  provider.hangCalls();
  assert.equal(
    (await c.client.call("notes", "write", { text: "slow" })).error?.name,
    "OutcomeUnknown",
  );

  const stream = c.client.session.open();
  const writer = stream.writable.getWriter();
  await writer.write(encodeFrame({ op: "call", slot: "notes", method: "write" }));
  await writer.write(encodeFrame(input({ text: "gone" })));
  while (provider.calls.length < 2) await later(5);
  stream.reset();
  while (!hub.state.audit(0, 1000).entries.some((e) => e.details.outcome === "cancelled"))
    await later(5);
  while (provider.resets() < 2) await later(5); // the late call's stream and the cancelled one
});

test("a reply that is neither a result nor an error is bad_output", async (t) => {
  const { actor, bind } = await setup(t);
  const p = await actor("provider", { exports: { notes } }, async (_, stream) => {
    const writer = stream.writable.getWriter();
    await writer.write(encodeFrame({ event: { text: "x" } }));
    await writer.close();
  });
  const c = await actor("consumer", { slots: { notes } });
  await bind(c.id, "notes", p.id, "notes");
  assert.equal((await c.client.call("notes", "write", { text: "x" })).error?.code, "bad_output");
});

test("open and http streams are validated, then spliced", async (t) => {
  const { actor, bind } = await setup(t);
  const serve: Serve = async (header, stream, reader) => {
    if (header.kind === "open") {
      const { prefix } = header.params as { prefix: string };
      const writer = stream.writable.getWriter();
      if (prefix === "no") return answerWith(writer, wireError("Refused", "not today", "busy"));
      await writer.write(encodeFrame(result({})));
      await writer.write(text.encode(prefix));
      writer.releaseLock();
      await reader.rest().pipeTo(stream.writable);
    } else if (header.kind === "http") {
      const writer = stream.writable.getWriter();
      await writer.write(encodeFrame(result({})));
      await writer.write(text.encode("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello"));
      await writer.close();
    }
  };
  const p = await actor("provider", { exports: { echo, web } }, serve);
  const c = await actor("consumer", { slots: { echo, web } });
  await bind(c.id, "echo", p.id, "echo");
  await bind(c.id, "web", p.id, "web");

  /** Open a stream, send bytes, and read the answer and then all the bytes that come back. */
  const splice = async (header: unknown, bytes = "") => {
    const stream = c.client.session.open();
    const writer = stream.writable.getWriter();
    await writer.write(encodeFrame(header));
    if (bytes) await writer.write(text.encode(bytes));
    await writer.close();
    const reader = new FrameReader(stream.readable);
    const first = reply(await reader.next());
    if (!("result" in first)) return { first, rest: "" };
    let rest = "";
    for await (const chunk of reader.rest()) rest += new TextDecoder().decode(chunk);
    return { first, rest };
  };
  assert.deepEqual(await splice({ op: "open", slot: "echo", params: { prefix: ">" } }, "ping"), {
    first: { result: {} },
    rest: ">ping",
  });
  const http = await splice({ op: "http", slot: "web" }, "GET / HTTP/1.1\r\nhost: x\r\n\r\n");
  assert.match(http.rest, /200 OK[\s\S]*hello$/);
  const refusals = [
    [{ op: "open", slot: "echo", params: { prefix: 1 } }, "invalid"],
    [{ op: "open", slot: "echo", params: { prefix: "no" } }, "busy"],
    [{ op: "http", slot: "echo" }, "invalid"],
  ] as const;
  for (const [header, code] of refusals)
    assert.equal((await splice(header)).first.error?.code, code, JSON.stringify(header));
  assert.equal(
    (await splice({ op: "open", slot: "none", params: {} })).first.error?.name,
    "NotConnected",
  );
});

test("management goes only through the hub's exports, and requests reach their approvers live", async (t) => {
  const { actor, bind, person, hub } = await setup(t);
  const p = await actor("provider", { exports: { notes } }, notesProvider().serve);
  const grants = describeInterface(hubGrants);
  const c = await actor("consumer", { slots: { notes, grants } }, undefined, [
    { slot: "grants", provider: HUB, export: "grants" },
  ]);
  assert.equal(
    (await c.client.call("actors", "list", {})).error?.name,
    "NotConnected",
    "no hub slot, no management",
  );

  const requested = person.subscribe("grants", "requested");
  const decided = person.subscribe("grants", "decided");
  // The consumer holds hub.grants too, but its own request isn't its to decide.
  const own = c.client.subscribe("grants", "requested");
  const audited = person.subscribe("audit", "appended");
  const subscribed = () =>
    hub.state
      .audit(0, 1000)
      .entries.filter((e) => e.actor === PERSON && e.details.op === "subscribe");
  while (subscribed().length < 3) await later(5);
  while (
    !hub.state.audit(0, 1000).entries.some((e) => e.actor === c.id && e.details.op === "subscribe")
  )
    await later(5);
  const wiring = { consumer: c.id, slot: "notes", provider: p.id, export: "notes" };
  const asked = (await c.client.call("grants", "request", { ...wiring, reason: "please" })) as {
    result: { requestId: string };
  };
  const seen = (await requested.next()) as { event: { reason: string; needs: string } };
  assert.deepEqual([seen.event.reason, seen.event.needs], ["please", "export"]);
  // The live audit feed carries the request (after any calls audited before it).
  let entry: { event: { kind: string } };
  do entry = (await audited.next()) as { event: { kind: string } };
  while (entry.event.kind === "call");
  assert.equal(entry.event.kind, "request");
  assert.deepEqual(await bind(c.id, "notes", p.id, "notes"), { result: { bound: true } });
  assert.deepEqual(await decided.next(), {
    event: {
      request: { ...(seen.event as object), requestId: asked.result.requestId },
      status: "approved",
    },
  });
  // The provider offering itself is a request to the consumer, which hears of it.
  const p2 = await actor("offerer", { slots: { grants }, exports: { notes } }, undefined, [
    { slot: "grants", provider: HUB, export: "grants" },
  ]);
  await person.call("grants", "unbind", { consumer: c.id, slot: "notes" });
  const offered = await p2.client.call("grants", "bind", {
    consumer: c.id,
    slot: "notes",
    provider: p2.id,
    export: "notes",
  });
  assert.equal((offered.result as { bound: boolean }).bound, false);
  const heard = (await own.next()) as { event: { requestedBy: string; needs: string } };
  assert.deepEqual([heard.event.requestedBy, heard.event.needs], [p2.id, "slot"], "only the offer");
  const listed = (await person.call("grants", "requests", {})) as {
    result: { requests: unknown[] };
  };
  assert.deepEqual(
    listed.result.requests.map((r) => (r as { needs: string }).needs),
    ["slot"],
    "the first was approved by binding; the offer waits for the consumer",
  );
  const created = await person.call("actors", "create", { name: "" });
  assert.equal(created.error?.code, "invalid", "the hub's inputs are validated like any other");
  const refused = await person.call("actors", "close", { actorId: PERSON });
  assert.equal(refused.error?.code, "forbidden");
});

test("admission: a credential, hello first, nothing else before it, and a deadline", async (t) => {
  const { url, actor } = await setup(t);
  const { id } = await actor("someone", {});
  const wrong = await connect(url, { actorId: id, credential: "wrong" });
  assert.equal(wrong.admitted.error?.code, "forbidden");
  await wrong.session.closed; // the Hub closes the channel

  const socket = new WebSocket(url);
  const session = new Session(await webSocketChannel(socket), { client: true });
  const first = exchange(session, { op: "call", slot: "x", method: "y" }, input({}));
  assert.equal((await first).error?.code, "invalid", "the first stream must be hello");

  const quiet = new Session(await webSocketChannel(new WebSocket(url)), { client: true });
  const silent = quiet.open();
  const second = quiet.open();
  await second.writable
    .getWriter()
    .write(encodeFrame({ op: "hello" }))
    .catch(() => {});
  await assert.rejects(
    new FrameReader(second.readable).next(),
    "a second stream before admission is reset",
  );
  void silent;
  const reason = await quiet.closed;
  assert.ok(reason, "the deadline closes a channel that never says hello");
  socket.close();
});

test("a declared interface whose hash doesn't match its schemas is refused at hello", async (t) => {
  const { actor } = await setup(t);
  const forged = { ...notes, hash: echo.hash };
  const forger = await actor("forger", { exports: { notes: forged } });
  assert.equal(forger.client.admitted.error?.code, "invalid");
  const noMethods = await actor("odd", {
    slots: { x: { id: "x@1", kind: "rpc", hash: "sha256-0" } },
  });
  assert.equal(noMethods.client.admitted.error?.code, "invalid");
  const many = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`s${i}`, notes]));
  assert.equal((await actor("greedy", { slots: many })).client.admitted.error?.code, "invalid");
  const { client } = await actor("honest", { exports: { notes } });
  assert.ok("result" in client.admitted);
});

test("an Actor offers and withdraws exports on its own channel", async (t) => {
  const { actor, bind, person } = await setup(t);
  const provider = notesProvider();
  const p = await actor("provider", {}, provider.serve);
  const c = await actor("consumer", { slots: { notes } });
  const changed = person.subscribe("exports", "changed");
  assert.deepEqual(
    await exchange(p.client.session, { op: "offer", name: "extra", interface: notes }),
    {
      result: {},
    },
  );
  assert.deepEqual(await changed.next(), { event: { actor: p.id } });
  const listed = (await person.call("exports", "list", { actor: p.id })) as {
    result: { exports: { export: string; dynamic: boolean }[] };
  };
  assert.deepEqual(
    listed.result.exports.map((e) => [e.export, e.dynamic]),
    [["extra", true]],
  );
  await bind(c.id, "notes", p.id, "extra");
  assert.deepEqual(await c.client.call("notes", "write", { text: "hi" }), { result: { n: 1 } });
  const forged = { ...notes, hash: echo.hash };
  const refused = await exchange(p.client.session, { op: "offer", name: "bad", interface: forged });
  assert.equal(refused.error?.code, "invalid");
  assert.deepEqual(await exchange(p.client.session, { op: "withdraw", name: "extra" }), {
    result: {},
  });
  assert.equal((await c.client.call("notes", "write", { text: "hi" })).error?.name, "NotConnected");
});

test("a newer channel for an Actor replaces the older one", async (t) => {
  const { url, actor, person, hub } = await setup(t);
  const made = (await person.call("actors", "create", { name: "twice" })) as {
    result: { actorId: string; credential: string };
  };
  const first = await connect(url, made.result);
  const second = await connect(url, made.result);
  t.after(() => second.close());
  await first.session.closed;
  assert.ok(hub.connected(made.result.actorId));
  void actor;
});

test("a channel the Hub made is admitted by its actorId, for live package Actors only", async (t) => {
  const { hub, person } = await setup(t);
  const made = (await person.call("actors", "create", { name: "outside" })) as {
    result: { actorId: string };
  };
  const [ours] = memoryPair();
  assert.throws(() => hub.accept(ours, { actorId: made.result.actorId }), /package Actor/);
  assert.throws(() => hub.accept(ours, { actorId: "act_nobody" }), /No Actor/);
  const board = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "examples",
    "board",
  );
  const out = mkdtempSync(join(tmpdir(), "board-for-router-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const built = await buildPackage(board, { out });
  hub.state.addPackage(PERSON, built.file);
  const { actorId } = hub.state.createActor(PERSON, { name: "board", package: built.hash });
  const [hubSide, processSide] = memoryPair();
  const handle = hub.accept(hubSide, { actorId });
  const process_ = new Session(processSide, { client: true });
  assert.ok(hub.connected(actorId));
  // Its own wiring: the panel's slot reaches the logic's export, and it has no provider channel
  // other than itself, so a call is forwarded back to it.
  const call = exchange(process_, { op: "subscribe", slot: "nope", event: "x" });
  assert.equal((await call).error?.name, "NotConnected");
  handle.close();
  await handle.closed;
  assert.equal(hub.connected(actorId), false);
});

test("splices end with their binding, and a closed Actor's channel goes", async (t) => {
  const { actor, bind, person, hub } = await setup(t);
  const serve: Serve = async (_, stream, reader) => {
    const writer = stream.writable.getWriter();
    await writer.write(encodeFrame(result({})));
    writer.releaseLock();
    await reader
      .rest()
      .pipeTo(stream.writable)
      .catch(() => {});
  };
  const p = await actor("provider", { exports: { echo } }, serve);
  const c = await actor("consumer", { slots: { echo } });
  await bind(c.id, "echo", p.id, "echo");
  const stream = c.client.session.open();
  const writer = stream.writable.getWriter();
  await writer.write(encodeFrame({ op: "open", slot: "echo", params: { prefix: "" } }));
  const reader = new FrameReader(stream.readable);
  assert.deepEqual(reply(await reader.next()), { result: {} });
  await person.call("grants", "unbind", { consumer: c.id, slot: "echo" });
  await assert.rejects(
    (async () => {
      for await (const _ of reader.rest());
    })(),
    /reset/,
  );
  await person.call("actors", "close", { actorId: c.id });
  await c.client.session.closed;
  assert.equal(hub.connected(c.id), false);
});

test("a subscriber that stops reading is cut off, not buffered for", async (t) => {
  const { person, hub } = await setup(t);
  const sub = person.subscribe("audit", "appended");
  while (!hub.state.audit(0, 1000).entries.some((e) => e.details.op === "subscribe"))
    await later(5);
  const wiring = { consumer: PERSON, slot: "x".repeat(200) };
  for (let i = 0; i < 20_000; i++)
    hub.state.auditCall(PERSON, wiring, { op: "call", method: "m".repeat(50), outcome: "ok" });
  await assert.rejects(
    (async () => {
      while (await sub.next());
    })(),
    /reset/,
  );
});

test("$id in one Actor's schemas doesn't clash with another's; malformed frames are invalid", async (t) => {
  const { actor, bind } = await setup(t);
  const withId = (minimum: number) => {
    const iface = describeInterface(
      defineInterface({
        name: "counted",
        major: 1,
        kind: "rpc",
        methods: {
          add: method({ input: z.object({ n: z.number().min(minimum) }), output: z.object({}) }),
        },
      }),
    );
    const methods = {
      add: {
        input: {
          ...(iface as unknown as { methods: { add: { input: object } } }).methods.add.input,
          $id: "https://x.example/shared",
        },
        output: {},
      },
    };
    const schemas = { id: iface.id, kind: "rpc" as const, methods, events: {} };
    return { ...schemas, hash: hashInterface(schemas) };
  };
  const a = await actor("a", { slots: { counted: withId(1) } });
  const b = await actor("b", { slots: { counted: withId(2) } });
  assert.ok("result" in a.client.admitted);
  assert.ok("result" in b.client.admitted, "the same $id with other schemas is still admitted");

  const p = await actor("provider", { exports: { notes } }, notesProvider().serve);
  const c = await actor("consumer", { slots: { notes } });
  await bind(c.id, "notes", p.id, "notes");
  const stream = c.client.session.open();
  const writer = stream.writable.getWriter();
  await writer.write(encodeFrame({ op: "call", slot: "notes", method: "write" }));
  await writer.write(new Uint8Array([0, 0, 0, 3, 123, 120, 125])); // "{x}"
  await writer.close();
  assert.equal(reply(await new FrameReader(stream.readable).next()).error?.code, "invalid");
});

test("a reply too large for a frame is refused as too_large, not left hanging", async (t) => {
  const { person, hub } = await setup(t);
  for (let i = 0; i < 9000; i++)
    hub.state.createActor(PERSON, { name: `actor-${"n".repeat(100)}-${i}` });
  const listed = await person.call("actors", "list", {});
  assert.equal(listed.error?.code, "too_large");
});

test("an open the provider refuses, or whose binding goes while it decides, leaves nothing open", async (t) => {
  const { actor, bind, person } = await setup(t);
  let decide = () => {};
  const served: FrameReader[] = [];
  const p = await actor("provider", { exports: { echo } }, async (header, stream, reader) => {
    served.push(reader);
    const writer = stream.writable.getWriter();
    if ((header.params as { prefix: string }).prefix === "wait")
      await new Promise<void>((resolve) => {
        decide = resolve;
      });
    await writer.write(encodeFrame(wireError("Refused", "no", "busy")));
    await writer.close().catch(() => {});
  });
  const c = await actor("consumer", { slots: { echo } });
  await bind(c.id, "echo", p.id, "echo");
  const open = async (prefix: string) => {
    const stream = c.client.session.open();
    const writer = stream.writable.getWriter();
    await writer.write(encodeFrame({ op: "open", slot: "echo", params: { prefix } }));
    await writer.write(text.encode("early bytes"));
    await writer.close();
    const frame = await new FrameReader(stream.readable).next().catch(() => undefined);
    // A reset reads as no answer at all.
    return frame === undefined
      ? ({ error: { name: "reset", message: "" } } as Reply)
      : reply(frame);
  };
  assert.equal((await open("x")).error?.code, "busy");
  await assert.rejects(
    served[0]?.next() as Promise<unknown>,
    "the Hub ends its stream to the provider",
  );
  // Refused opens with bytes the Hub never reads don't use up the channel's streams.
  for (let i = 0; i < 300; i++) assert.equal((await open("x")).error?.code, "busy");

  const pending = open("wait");
  while (served.length < 302) await later(5);
  await person.call("grants", "unbind", { consumer: c.id, slot: "echo" });
  decide();
  assert.match(String((await pending).error?.name), /NotConnected|reset/);
});

test("a splice delivers everything when the provider's channel ends after it finishes", async (t) => {
  const { actor, bind } = await setup(t);
  const payload = "z".repeat(400 * 1024);
  let provider: Client | undefined;
  const p = await actor("provider", { exports: { echo } }, async (_, stream) => {
    const writer = stream.writable.getWriter();
    await writer.write(encodeFrame(result({})));
    await writer.write(text.encode(payload));
    await writer.close();
    provider?.close();
  });
  provider = p.client;
  const c = await actor("consumer", { slots: { echo } });
  await bind(c.id, "echo", p.id, "echo");
  const stream = c.client.session.open();
  await stream.writable
    .getWriter()
    .write(encodeFrame({ op: "open", slot: "echo", params: { prefix: "" } }));
  await later(100); // the provider is done and gone before the opener reads anything
  const reader = new FrameReader(stream.readable);
  assert.deepEqual(reply(await reader.next()), { result: {} });
  let got = 0;
  for await (const chunk of reader.rest()) got += chunk.length;
  assert.equal(got, payload.length);
});

test("the compiled cache forgets the oldest interfaces, boolean schemas included", async (t) => {
  // One worker, so its cache (4096 parts) really overflows.
  const validators = new Validators({ size: 1 });
  const iface = (i: number) =>
    ({
      id: `n${i}@1`,
      kind: "rpc",
      methods: { m: { input: i === 0 ? true : { type: "object" }, output: {} } },
      events: {},
      hash: `sha256-${String(i).padStart(64, "0")}`,
    }) as unknown as DescribedInterface;
  t.after(() => validators.close());
  for (let i = 0; i < 2100; i++) await validators.prepare(iface(i));
  await validators.check(iface(0), { method: "m", side: "input" }, {}, "invalid");
});

/** A described interface built by hand, for schemas zod doesn't write. */
function handMade(name: string, input: object, output: object): DescribedInterface {
  const schemas = {
    id: `${name}@1`,
    kind: "rpc" as const,
    methods: { run: { input, output } },
    events: {},
  };
  return { ...schemas, hash: hashInterface(schemas as InterfaceSchemas) } as DescribedInterface;
}

test("slow schema checks are refused within the budget, off the router's thread", async (t) => {
  const { actor, bind, person } = await setup(t);
  const regex = handMade(
    "regex",
    { type: "object", properties: { text: { type: "string", pattern: "^(a+)+$" } } },
    { type: "object" },
  );
  const unique = handMade(
    "unique",
    { type: "object" },
    { type: "object", properties: { items: { type: "array", uniqueItems: true } } },
  );
  const items = Array.from({ length: 30_000 }, (_, i) => [i]);
  let served = 0;
  const p = await actor(
    "provider",
    { exports: { regex, unique, notes } },
    async (header, stream, reader) => {
      await reader.next();
      served++;
      const writer = stream.writable.getWriter();
      await writer.write(encodeFrame(result(header.export === "unique" ? { items } : { n: 1 })));
      await writer.close();
    },
  );
  const c = await actor("consumer", { slots: { regex, unique, notes } });
  for (const slot of ["regex", "unique", "notes"]) await bind(c.id, slot, p.id, slot);

  const timed = async <T>(work: Promise<T>) => {
    const started = performance.now();
    return { value: await work, ms: performance.now() - started };
  };
  // A catastrophic regex on the input: refused as invalid, and the provider never runs.
  let settled = false;
  const stuck = timed(c.client.call("regex", "run", { text: `${"a".repeat(40)}!` })).finally(() => {
    settled = true;
  });
  // Meanwhile the router stays responsive: a ping, and another Actor's call, both answered while
  // the stuck check is still running.
  await c.client.session.ping();
  const other = await person.call("actors", "list", {});
  assert.ok("result" in other);
  assert.equal(settled, false, "the ping and the other call came back first");
  const refused = await stuck;
  assert.equal(refused.value.error?.code, "invalid");
  assert.match(String(refused.value.error?.message), /took over 250 ms/);
  assert.ok(refused.ms < 1500, `refused after ${refused.ms} ms`);
  assert.equal(served, 0);

  // A quadratic uniqueItems on the output: refused as bad_output after the provider ran.
  const quadratic = await timed(c.client.call("unique", "run", {}));
  assert.equal(quadratic.value.error?.code, "bad_output");
  assert.match(String(quadratic.value.error?.message), /took over 250 ms/);
  assert.ok(quadratic.ms < 1500, `refused after ${quadratic.ms} ms`);
  assert.equal(served, 1);

  // The replaced workers serve the next calls.
  assert.deepEqual(await c.client.call("notes", "write", { text: "after" }), { result: { n: 1 } });
  assert.deepEqual(await c.client.call("regex", "run", { text: "aaa" }), { result: { n: 1 } });
});

test("a check over the budget replaces its worker, and the replacement serves the next check", async (t) => {
  const validators = new Validators({ size: 1 });
  t.after(() => validators.close());
  const regex = handMade("regex", { type: "string", pattern: "^(a+)+$" }, { type: "object" });
  const input = { method: "run", side: "input" } as const;
  await assert.rejects(
    validators.check(regex, input, `${"a".repeat(40)}!`, "invalid"),
    (e: Refused) => e.code === "invalid" && /took over/.test(e.message),
  );
  await validators.check(regex, input, "aaa", "invalid");
  await assert.rejects(
    validators.check(regex, input, "b", "invalid"),
    (e: Refused) => e.code === "invalid",
  );
});

test("a pool whose workers can't start fails every check with the reason, without respawning", async () => {
  const validators = new Validators({
    size: 1,
    workerUrl: new URL("./missing-worker.js", import.meta.url),
  });
  const regex = handMade("regex", { type: "string" }, { type: "object" });
  await assert.rejects(
    validators.check(regex, { method: "run", side: "input" }, "x", "invalid"),
    /can't start/,
  );
  await assert.rejects(validators.prepare(regex), /can't start/);
});

test("a value too deep to hand to a worker is refused, and the Hub carries on", async (t) => {
  const { person } = await setup(t);
  const depth = 400_000;
  const body = `{"input":{"d":${"[".repeat(depth)}${"]".repeat(depth)}}}`;
  const frame = (json: string) => {
    const bytes = new TextEncoder().encode(json);
    const out = new Uint8Array(4 + bytes.length);
    new DataView(out.buffer).setUint32(0, bytes.length);
    out.set(bytes, 4);
    return out;
  };
  const deep = async () => {
    const stream = person.session.open();
    const writer = stream.writable.getWriter();
    await writer.write(encodeFrame({ op: "call", slot: "actors", method: "list" }));
    await writer.write(frame(body));
    await writer.close();
    return reply(await new FrameReader(stream.readable).next());
  };
  const answers = await Promise.all(Array.from({ length: 6 }, deep));
  for (const answer of answers) assert.equal(answer.error?.code, "invalid");
  assert.ok("result" in (await person.call("actors", "list", {})));
});

test("jobs that can't be handed to a worker don't strand the ones queued behind them", async (t) => {
  const validators = new Validators({ size: 1 });
  t.after(() => validators.close());
  const open = handMade("open", {}, { type: "object" });
  const input = { method: "run", side: "input" } as const;
  let deep: unknown = 0;
  for (let i = 0; i < 400_000; i++) deep = [deep];
  // Queued together before the worker is ready: each failed hand-off must free it for the next.
  const checks = [
    validators.check(open, input, deep, "invalid"),
    validators.check(open, input, deep, "invalid"),
    validators.check(open, input, 1, "invalid"),
  ];
  const outcomes = await Promise.allSettled(checks);
  assert.deepEqual(
    outcomes.map((o) => o.status),
    ["rejected", "rejected", "fulfilled"],
  );
});
