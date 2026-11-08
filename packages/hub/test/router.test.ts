import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  NotConnected,
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
  /** Slot notices from the Hub, in the order they arrived. */
  const notices: [string, boolean][] = [];
  // Headers are read in the order streams arrive, so notices keep their order.
  let headers = Promise.resolve();
  const session = new Session(await webSocketChannel(socket), {
    client: true,
    onStream: (stream) => {
      const reader = new FrameReader(stream.readable);
      const header = headers.then(() => reader.next());
      headers = header.then(
        () => {},
        () => {},
      );
      void header
        .then((h) => {
          const parsed = parseHeader(h);
          if (parsed.op === "slot") {
            notices.push([parsed.name, parsed.bound]);
            // A notice is the header alone; closing our side lets the stream be forgotten.
            return void stream.writable.close().catch(() => {});
          }
          return serve?.(parsed as Extract<Header, { op: "serve" }>, stream, reader);
        })
        .catch(() => {});
    },
  });
  const admitted = await exchange(session, { op: "hello", ...hello });
  return {
    notices,
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

async function setup(
  t: test.TestContext,
  options: {
    answerTimeoutMs?: number;
    helloTimeoutMs?: number;
    checks?: { size?: number; compileBudgetMs?: number };
  } = {},
) {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-router-")), "home");
  // The Hub's own hello deadline unless a test watches it close a channel: a short one fails
  // every hello in the file on a loaded machine.
  const hub = Hub.open(home, options);
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

test("a splice delivers a provider's whole answer though its channel goes while the consumer still sends", async (t) => {
  const { actor, bind, hub } = await setup(t);
  const size = 384 * 1024; // more than the consumer's window, so some is still in the Hub
  let answered: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    answered = resolve;
  });
  const serve: Serve = async (_, stream) => {
    const writer = stream.writable.getWriter();
    await writer.write(encodeFrame(result({})));
    await writer.write(new Uint8Array(size).fill(1));
    await writer.close();
    answered();
  };
  const p = await actor("provider", { exports: { echo } }, serve);
  const c = await actor("consumer", { slots: { echo } });
  await bind(c.id, "echo", p.id, "echo");

  const stream = c.client.session.open();
  const writer = stream.writable.getWriter();
  await writer.write(encodeFrame({ op: "open", slot: "echo", params: { prefix: "" } }));
  const reader = new FrameReader(stream.readable);
  assert.deepEqual(reply(await reader.next()), { result: {} });
  // The consumer reads no more for now: the answer waits in its window and in the Hub. The
  // provider has said all of it, then its channel goes.
  await done;
  p.client.close();
  for (let waited = 0; hub.connected(p.id) && waited < 3000; waited += 5) await later(5);
  assert.equal(hub.connected(p.id), false);
  // The consumer still sends, more than a window, so this write ends only if the Hub takes it:
  // it can't pass it on, which mustn't cost the consumer the answer.
  await writer.write(new Uint8Array(512 * 1024));
  let got = 0;
  for await (const chunk of reader.rest()) got += chunk.length;
  assert.equal(got, size);
});

test("a splice delivers a consumer's whole upload though its channel goes while the provider still sends", async (t) => {
  const { actor, bind, hub } = await setup(t);
  const size = 384 * 1024; // more than the provider's window, so some is still in the Hub
  let provider: { stream: YamuxStream; reader: FrameReader } | undefined;
  const serve: Serve = async (_, stream, reader) => {
    const writer = stream.writable.getWriter();
    await writer.write(encodeFrame(result({})));
    writer.releaseLock();
    provider = { stream, reader };
  };
  const p = await actor("provider", { exports: { echo } }, serve);
  const c = await actor("consumer", { slots: { echo } });
  await bind(c.id, "echo", p.id, "echo");

  const stream = c.client.session.open();
  const writer = stream.writable.getWriter();
  await writer.write(encodeFrame({ op: "open", slot: "echo", params: { prefix: "" } }));
  assert.deepEqual(reply(await new FrameReader(stream.readable).next()), { result: {} });
  // The consumer says all of it while the provider reads nothing yet, then its channel goes.
  await writer.write(new Uint8Array(size).fill(1));
  await writer.close();
  c.client.close();
  for (let waited = 0; hub.connected(c.id) && waited < 3000; waited += 5) await later(5);
  assert.equal(hub.connected(c.id), false);
  assert.ok(provider);
  // The provider still sends, more than a window, so this write ends only if the Hub takes it:
  // it can't pass it on, which mustn't cost the provider the upload.
  const out = provider.stream.writable.getWriter();
  await out.write(new Uint8Array(512 * 1024));
  out.releaseLock();
  let got = 0;
  for await (const chunk of provider.reader.rest()) got += chunk.length;
  assert.equal(got, size);
});

test("a reset after one side has finished still reaches the other side", async (t) => {
  const { actor, bind } = await setup(t);
  let ended: unknown;
  const serve: Serve = async (_, stream) => {
    const writer = stream.writable.getWriter();
    await writer.write(encodeFrame(result({})));
    // Streams until the other end goes.
    try {
      for (;;) await writer.write(new Uint8Array(64 * 1024));
    } catch (error) {
      ended = error;
    }
  };
  const p = await actor("provider", { exports: { echo } }, serve);
  const c = await actor("consumer", { slots: { echo } });
  await bind(c.id, "echo", p.id, "echo");
  const stream = c.client.session.open();
  const writer = stream.writable.getWriter();
  await writer.write(encodeFrame({ op: "open", slot: "echo", params: { prefix: "" } }));
  // The consumer has said all it will, then goes: the provider's stream is reset, not drained.
  await writer.close();
  assert.deepEqual(reply(await new FrameReader(stream.readable).next()), { result: {} });
  stream.reset();
  for (let waited = 0; ended === undefined && waited < 3000; waited += 5) await later(5);
  assert.ok(ended instanceof Error, "the provider's writes end");
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
  // The live audit feed carries the request (after whatever was audited before it: calls, the
  // host's status from the Hub's opening probe).
  let entry: { event: { kind: string } } | undefined;
  do entry = (await audited.next()) as { event: { kind: string } } | undefined;
  while (entry && entry.event.kind !== "request");
  assert.equal(entry?.event.kind, "request");
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
  // Short enough to wait out, long enough for this test's own hellos on a loaded machine.
  const { url, actor } = await setup(t, { helloTimeoutMs: 1_000 });
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
  // Too many is refused before any is checked: the first, forged, isn't what the refusal names.
  const many = Object.fromEntries(
    Array.from({ length: 257 }, (_, i) => [`s${i}`, i === 0 ? forged : notes]),
  );
  const greedy = (await actor("greedy", { slots: many })).client.admitted.error;
  assert.equal(greedy?.code, "invalid");
  assert.match(greedy?.message ?? "", /at most 256 interfaces/);
  const { client } = await actor("honest", { exports: { notes } });
  assert.ok("result" in client.admitted);
});

test("an Actor's record says whether it has a channel now", async (t) => {
  const { url, person } = await setup(t);
  type Shape = { actorId: string; connected: boolean };
  const get = async (actorId: string) =>
    ((await person.call("actors", "get", { actorId })) as { result: Shape }).result.connected;
  const listed = async (actorId: string) =>
    (
      (await person.call("actors", "list", {})) as { result: { actors: Shape[] } }
    ).result.actors.find((a) => a.actorId === actorId)?.connected;
  assert.equal(await listed(PERSON), true);
  assert.equal(await get("hub"), false, "the built-in Actors are the Hub itself: no channel");
  // Each change is told as hub.actors' changed, for the Actor it is about.
  const changes = person.subscribe("actors", "changed");
  const changed = async () => ((await changes.next()) as { event: { actor: string } }).event.actor;
  const made = (await person.call("actors", "create", { name: "later" })) as {
    result: { actorId: string; credential: string };
  };
  const { actorId } = made.result;
  assert.equal(await changed(), actorId, "made");
  assert.equal(await get(actorId), false, "made, not yet said hello");
  assert.equal(await listed(actorId), false);
  const client = await connect(url, made.result);
  assert.equal(await changed(), actorId, "connected");
  assert.equal(await get(actorId), true);
  assert.equal(await listed(actorId), true);
  // A newer channel replaces it: connected all along.
  const newer = await connect(url, made.result);
  assert.equal(await get(actorId), true);
  await client.session.closed;
  assert.equal(await get(actorId), true, "the old channel's end doesn't count");
  assert.deepEqual([await changed(), await changed()], [actorId, actorId], "replaced");
  newer.close();
  assert.equal(await changed(), actorId, "gone");
  assert.equal(await get(actorId), false, "gone again");
  assert.equal(await listed(actorId), false);
  await person.call("actors", "close", { actorId });
  assert.equal(await changed(), actorId, "closed");
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

test("a pipe the Hub made says hello as its Actor, with no credential and no declares", async (t) => {
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
  const pipe = () => {
    const [hubSide, processSide] = memoryPair();
    return {
      handle: hub.accept(hubSide, { actorId }),
      process: new Session(processSide, { client: true }),
    };
  };
  // A pipe's hello must name its own Actor, and may not declare.
  for (const [hello, code] of [
    [{ op: "hello", actorId: made.result.actorId }, "forbidden"],
    [{ op: "hello", actorId, declares: { slots: {} } }, "invalid"],
  ] as const) {
    const wrong = pipe();
    assert.equal((await exchange(wrong.process, hello)).error?.code, code);
    await wrong.handle.closed;
  }
  // A pipe made before its Actor was closed doesn't admit it.
  const doomed = hub.state.createActor(PERSON, { name: "doomed", package: built.hash }).actorId;
  const [doomedHub, doomedProcess] = memoryPair();
  const doomedHandle = hub.accept(doomedHub, { actorId: doomed });
  hub.state.closeActor(PERSON, doomed);
  const closed = await exchange(new Session(doomedProcess, { client: true }), {
    op: "hello",
    actorId: doomed,
  });
  assert.equal(closed.error?.code, "state");
  await doomedHandle.closed;
  const { handle, process: process_ } = pipe();
  assert.equal(hub.connected(actorId), false, "not admitted before its hello");
  // No credential: the pipe is the proof. The answer is the baseline: its own wiring is bound.
  const admitted = await exchange(process_, { op: "hello", actorId });
  assert.deepEqual((admitted.result as { bound: string[] }).bound, ["panel.board"]);
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

test("a call on an unbound slot is audited without a provider, and audit subscribers hear on", async (t) => {
  const { actor, person, hub } = await setup(t);
  const heard = person.subscribe("audit", "appended");
  while (!hub.state.audit(0, 1000).entries.some((e) => e.details.op === "subscribe"))
    await later(5);
  const c = await actor("consumer", { slots: { notes } });
  assert.equal((await c.client.call("notes", "write", { text: "x" })).error?.name, "NotConnected");
  await person.call("actors", "create", { name: "after" });
  type Entry = { kind: string; details: Record<string, unknown> };
  const seen: Entry[] = [];
  for (;;) {
    const next = (await heard.next()) as { event?: Entry } | undefined;
    assert.ok(next?.event, `the subscription goes on: ${JSON.stringify(next)}`);
    seen.push(next.event);
    if (next.event.kind === "actor.create" && next.event.details.name === "after") break;
  }
  // As it is stored: no provider or export, rather than ones without a value.
  const unbound = seen.find((e) => e.details.slot === "notes" && e.details.op === "call");
  assert.deepEqual(unbound?.details, {
    consumer: c.id,
    slot: "notes",
    op: "call",
    method: "write",
    outcome: "not_connected",
  });
});

test("an in-process event goes as JSON: a property left undefined is left out, not refused", async (t) => {
  const { person, hub } = await setup(t);
  const heard = person.subscribe("audit", "appended");
  while (!hub.state.audit(0, 1000).entries.some((e) => e.details.op === "subscribe"))
    await later(5);
  // As a built-in Actor could give it: a detail without a value, then an ordinary one.
  hub.state.auditHub("probe", { kept: 1, missing: undefined });
  hub.state.auditHub("probe", { kept: 2 });
  type Entry = { kind: string; details: Record<string, unknown> };
  const probes: Entry["details"][] = [];
  while (probes.length < 2) {
    const next = (await heard.next()) as { event?: Entry } | undefined;
    assert.ok(next?.event, `the subscription goes on: ${JSON.stringify(next)}`);
    if (next.event.kind === "probe") probes.push(next.event.details);
  }
  assert.deepEqual(probes, [{ kept: 1 }, { kept: 2 }]);
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
  for (let i = 0; i < 2100; i++) await validators.prepare("a", iface(i));
  await validators.check("a", iface(0), { method: "m", side: "input" }, {}, "invalid");
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
    validators.check("a", regex, input, `${"a".repeat(40)}!`, "invalid"),
    (e: Refused) => e.code === "invalid" && /took over/.test(e.message),
  );
  await validators.check("a", regex, input, "aaa", "invalid");
  await assert.rejects(
    validators.check("a", regex, input, "b", "invalid"),
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
    validators.check("a", regex, { method: "run", side: "input" }, "x", "invalid"),
    /can't start/,
  );
  await assert.rejects(validators.prepare("a", regex), /can't start/);
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
    validators.check("a", open, input, deep, "invalid"),
    validators.check("a", open, input, deep, "invalid"),
    validators.check("a", open, input, 1, "invalid"),
  ];
  const outcomes = await Promise.allSettled(checks);
  assert.deepEqual(
    outcomes.map((o) => o.status),
    ["rejected", "rejected", "fulfilled"],
  );
});

test("checks are served in turn by Actor, so one Actor's flood delays only itself", async (t) => {
  const validators = new Validators({ size: 1 });
  t.after(() => validators.close());
  const regex = handMade("regex", { type: "string", pattern: "^(a+)+$" }, { type: "object" });
  const input = { method: "run", side: "input" } as const;
  const slow = `${"a".repeat(40)}!`;
  let pending = 6;
  const flood = Array.from({ length: 6 }, () =>
    validators.check("flooder", regex, input, slow, "invalid").catch(() => {
      pending--;
    }),
  );
  const other = await validators.check("other", regex, input, "aaa", "invalid").then(() => pending);
  assert.ok(other >= 4, `the other Actor waited for ${6 - other} of the flood's checks`);
  await Promise.all(flood);
});

test("another Actor's call waits for the checks already running during a flood, not the queue", async (t) => {
  // One worker, so only taking turns can let the other Actor's checks past the flood: with a
  // second one, flood checks it finishes while the other Actor's checks run would count too, and
  // how many depends on the machine. A wide compile budget, so a freshly respawned worker
  // compiling the other Actor's schemas on a loaded machine isn't refused; the flood's checks
  // still run into the 250 ms check budget.
  const { actor, bind, person } = await setup(t, {
    checks: { size: 1, compileBudgetMs: 10_000 },
  });
  const unique = handMade(
    "unique",
    { type: "object", properties: { items: { type: "array", uniqueItems: true } } },
    { type: "object" },
  );
  const self = await actor(
    "flooder",
    { slots: { unique }, exports: { unique } },
    async (_, stream) => {
      const writer = stream.writable.getWriter();
      await writer.write(encodeFrame(result({})));
      await writer.close();
    },
  );
  await bind(self.id, "unique", self.id, "unique");
  const items = Array.from({ length: 30_000 }, (_, i) => [i]);
  let answered = 0;
  const flood = Array.from({ length: 12 }, () =>
    self.client.call("unique", "run", { items }).then((r) => {
      answered++;
      return r;
    }),
  );
  // Let the flood reach the Hub and queue before the other Actor calls.
  await later(600);
  const before = answered;
  // The flood must still be queued behind the running checks, or this proves nothing.
  assert.ok(12 - before >= 4, `only ${12 - before} flood calls were left to queue`);
  const listed = await person.call("exports", "list", {});
  const during = answered - before;
  assert.ok("result" in listed);
  for (const r of await Promise.all(flood)) assert.equal(r.error?.code, "invalid");
  // Counted, not timed, and bounded by turns alone: each of its two checks waits for the flood
  // check running and at most the one the flood's turn puts ahead of it, so four flood calls
  // finish, five if one that finished at the Hub was still on its way when counted. Served in
  // arrival order, it would wait for every queued flood call.
  assert.ok(during <= 5, `${during} flood calls finished while the other call waited`);
});

test("a slow caller of a shared provider doesn't hold up its other callers", async (t) => {
  // One worker and a wide compile budget, as in the flood test above: turns alone bound the count.
  const { actor, bind } = await setup(t, { checks: { size: 1, compileBudgetMs: 10_000 } });
  const unique = handMade(
    "unique",
    { type: "object" },
    { type: "object", properties: { items: { type: "array", uniqueItems: true } } },
  );
  const items = Array.from({ length: 30_000 }, (_, i) => [i]);
  const provider = await actor("provider", { exports: { unique } }, async (_, stream, reader) => {
    const body = parseBody(await reader.next()) as { input: { small?: boolean } };
    const writer = stream.writable.getWriter();
    await writer.write(encodeFrame(result(body.input.small ? { items: [] } : { items })));
    await writer.close();
  });
  const slow = await actor("slow", { slots: { unique } });
  const quick = await actor("quick", { slots: { unique } });
  await bind(slow.id, "unique", provider.id, "unique");
  await bind(quick.id, "unique", provider.id, "unique");
  let answered = 0;
  const flood = Array.from({ length: 12 }, () =>
    slow.client.call("unique", "run", {}).then((r) => {
      answered++;
      return r;
    }),
  );
  await later(600);
  const before = answered;
  assert.ok(12 - before >= 4, `only ${12 - before} flood calls were left to queue`);
  const reply = await quick.client.call("unique", "run", { small: true });
  const during = answered - before;
  assert.deepEqual(reply, { result: { items: [] } });
  assert.ok(during <= 5, `${during} of the slow caller's calls finished first`);
  for (const r of await Promise.all(flood)) assert.equal(r.error?.code, "bad_output");
});

test("an Actor learns which of its slots are bound: at hello, then by notice on each change", async (t) => {
  const { actor, bind, person } = await setup(t);
  const p = await actor("provider", { exports: { notes } }, notesProvider().serve);
  const c = await actor("consumer", { slots: { notes, echo } });
  assert.deepEqual((c.client.admitted.result as { bound: string[] }).bound, []);
  assert.deepEqual([...(person.admitted.result as { bound: string[] }).bound].sort(), [
    "actors",
    "audit",
    "bindings",
    "exports",
    "grants",
    "packages",
  ]);
  const settle = async (count: number) => {
    for (let waited = 0; c.client.notices.length < count && waited < 3000; waited += 5)
      await later(5);
    await later(50); // and nothing more arrives
  };
  await bind(c.id, "notes", p.id, "notes");
  await person.call("grants", "unbind", { consumer: c.id, slot: "notes" });
  await bind(c.id, "notes", p.id, "notes");
  await settle(3);
  assert.deepEqual(c.client.notices, [
    ["notes", true],
    ["notes", false],
    ["notes", true],
  ]);
  assert.deepEqual(p.client.notices, [], "the provider's slots didn't change");
  // Closing the provider ends its bindings: a notice.
  await person.call("actors", "close", { actorId: p.id });
  await settle(4);
  assert.deepEqual(c.client.notices.at(-1), ["notes", false]);
  // Many changes don't use up the Actor's streams: each notice is closed once read.
  const q = await actor("other-provider", { exports: { notes } }, notesProvider().serve);
  for (let i = 0; i < 520; i++) {
    await bind(c.id, "notes", q.id, "notes");
    await person.call("grants", "unbind", { consumer: c.id, slot: "notes" });
  }
  await settle(1044);
  assert.equal(c.client.notices.length, 1044, "more than a channel's 1024 streams");
  await bind(c.id, "notes", q.id, "notes");
  assert.deepEqual(await c.client.call("notes", "write", { text: "still" }), { result: { n: 1 } });
});

test("a reconnecting Actor's hello carries the slots bound while it was away", async (t) => {
  const { url, person, bind } = await setup(t);
  const made = (await person.call("actors", "create", { name: "away" })) as {
    result: { actorId: string; credential: string };
  };
  const { actorId, credential } = made.result;
  const first = await connect(url, { actorId, credential, declares: { slots: { notes } } });
  const provider = (await person.call("actors", "create", { name: "p" })) as {
    result: { actorId: string; credential: string };
  };
  const p = await connect(url, { ...provider.result, declares: { exports: { notes } } });
  t.after(() => p.close());
  first.close();
  await first.session.closed;
  await bind(actorId, "notes", provider.result.actorId, "notes");
  const again = await connect(url, { actorId, credential });
  t.after(() => again.close());
  assert.deepEqual((again.admitted.result as { bound: string[] }).bound, ["notes"]);
  await later(100);
  assert.deepEqual(again.notices, [], "nothing it missed arrives as a notice");
});

test("an Actor that leaves slot notices open loses its channel at the cap; one that closes them never does", async (t) => {
  const { url, actor, bind, person } = await setup(t);
  const p = await actor("provider", { exports: { notes } }, notesProvider().serve);
  const made = (await person.call("actors", "create", { name: "careless" })) as {
    result: { actorId: string; credential: string };
  };
  const { actorId, credential } = made.result;
  // Takes every stream the Hub opens and never closes one.
  const socket = new WebSocket(url);
  const careless = new Session(await webSocketChannel(socket), {
    client: true,
    maxStreams: 1e9,
    onStream: () => {},
  });
  t.after(() => careless.close());
  const admitted = await exchange(careless, {
    op: "hello",
    actorId,
    credential,
    declares: { slots: { notes } },
  });
  assert.ok("result" in admitted);
  let cycles = 0;
  const lost = careless.closed.then(() => cycles);
  for (; cycles < 100; cycles++) {
    if ((await Promise.race([lost.then(() => true), later(0).then(() => false)])) === true) break;
    await bind(actorId, "notes", p.id, "notes");
    await person.call("grants", "unbind", { consumer: actorId, slot: "notes" });
  }
  const at = await Promise.race([lost, later(2000).then(() => -1)]);
  // (A client that closes its notices is never cut off: see the 1,044-notice test above.)
  assert.ok(
    at > 0 && at <= 40,
    `the careless channel closed after ${at} cycles (cap 1 + 64 notices)`,
  );
});

test("an Actor with many slots keeps its channel when one change unbinds them all at once", async (t) => {
  const { url, actor, bind, person } = await setup(t);
  const p = await actor("provider", { exports: { notes } }, notesProvider().serve);
  const made = (await person.call("actors", "create", { name: "many" })) as {
    result: { actorId: string; credential: string };
  };
  const slots = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`s${i}`, notes]));
  const c = await connect(url, { ...made.result, declares: { slots } });
  t.after(() => c.close());
  for (const slot of Object.keys(slots)) await bind(made.result.actorId, slot, p.id, "notes");
  for (let waited = 0; c.notices.length < 256 && waited < 5000; waited += 5) await later(5);
  // Closing the provider unbinds all 256 slots in one go: 256 notices before any can be closed.
  await person.call("actors", "close", { actorId: p.id });
  for (let waited = 0; c.notices.length < 512 && waited < 5000; waited += 5) await later(5);
  assert.equal(c.notices.length, 512);
  assert.equal(
    await Promise.race([c.session.closed.then(() => "closed"), later(100).then(() => "open")]),
    "open",
  );
});

test("when a provider comes back, its consumers hear their slot is usable again", async (t) => {
  const { url, actor, bind, person } = await setup(t);
  const made = (await person.call("actors", "create", { name: "returning" })) as {
    result: { actorId: string; credential: string };
  };
  const provider = notesProvider();
  const first = await connect(
    url,
    { ...made.result, declares: { exports: { notes } } },
    provider.serve,
  );
  const c = await actor("consumer", { slots: { notes } });
  const self = await actor("self", { slots: { notes }, exports: { notes } });
  await bind(c.id, "notes", made.result.actorId, "notes");
  await bind(self.id, "notes", self.id, "notes");
  const settle = async (count: number) => {
    for (let waited = 0; c.client.notices.length < count && waited < 3000; waited += 5)
      await later(5);
    await later(50);
  };
  await settle(1);
  const sub = c.client.subscribe("notes", "written");
  await provider.waitSubscribed();

  first.close();
  assert.equal((await sub.next())?.error?.name, "NotConnected", "the subscription ends");
  await later(50);
  assert.deepEqual(c.client.notices, [["notes", true]], "going away sends nothing");

  const back = await connect(url, { ...made.result }, provider.serve);
  t.after(() => back.close());
  await settle(2);
  assert.deepEqual(c.client.notices, [
    ["notes", true],
    ["notes", true],
  ]);
  assert.deepEqual(
    self.client.notices,
    [["notes", true]],
    "an Actor's own wiring isn't re-noticed",
  );
  assert.deepEqual(await c.client.call("notes", "write", { text: "again" }), { result: { n: 1 } });

  // A run-time export went with the old channel, its bindings too: no notice when the Actor returns.
  await exchange(back.session, { op: "offer", name: "extra", interface: notes });
  const d = await actor("other-consumer", { slots: { notes } });
  await bind(d.id, "notes", made.result.actorId, "extra");
  for (let waited = 0; d.client.notices.length < 1 && waited < 3000; waited += 5) await later(5);
  back.close();
  for (let waited = 0; d.client.notices.length < 2 && waited < 3000; waited += 5) await later(5);
  assert.deepEqual(d.client.notices, [
    ["notes", true],
    ["notes", false],
  ]);
  const third = await connect(url, { ...made.result }, provider.serve);
  t.after(() => third.close());
  await later(100);
  assert.deepEqual(d.client.notices.length, 2);
});

test("a hello over a WebSocket needs its credential, and a serve names the caller's slot", async (t) => {
  const { url, actor, bind } = await setup(t);
  const made = await actor("someone", {});
  const bare = new Session(await webSocketChannel(new WebSocket(url)), { client: true });
  const refused = await exchange(bare, { op: "hello", actorId: made.id });
  assert.equal(refused.error?.code, "forbidden");
  await bare.closed;

  const seen: string[] = [];
  const p = await actor("provider", { exports: { notes } }, async (header, stream, reader) => {
    seen.push(`${header.caller}.${header.slot}`);
    await notesProvider().serve(header, stream, reader);
  });
  const c = await actor("consumer", { slots: { mine: notes } });
  await bind(c.id, "mine", p.id, "notes");
  assert.ok("result" in (await c.client.call("mine", "write", { text: "x" })));
  assert.deepEqual(seen, [`${c.id}.mine`]);
});

test("an Actor's logs are read newest last, across the rotated file, and its record counts restarts", async (t) => {
  const { hub, person, home } = await setup(t);
  const made = (await person.call("actors", "create", { name: "logged" })) as {
    result: { actorId: string };
  };
  const { actorId } = made.result;
  const line = (n: number) =>
    JSON.stringify({ level: "info", message: `line ${n}`, at: new Date(n).toISOString() });
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(join(home, "logs", `${actorId}.log.1`), `${[1, 2, 3].map(line).join("\n")}\n`);
  // Lines that aren't entries don't count against the limit, and odd fields are dropped.
  const odd = JSON.stringify({ level: "loud", message: "odd", at: "x", data: [1], extra: 1 });
  writeFileSync(
    join(home, "logs", `${actorId}.log`),
    `${[4, 5].map(line).join("\n")}\n${"not json\n".repeat(10)}${odd}\npartial`,
  );
  const logs = (await person.call("actors", "logs", { actorId, limit: 4 })) as {
    result: { lines: { message: string }[] };
  };
  assert.deepEqual(
    logs.result.lines.map((l) => l.message),
    ["line 3", "line 4", "line 5", "odd"],
  );
  assert.deepEqual(logs.result.lines.at(-1), { level: "info", message: "odd", at: "x" });
  assert.equal(
    (await person.call("actors", "logs", { actorId: "act_nobody" })).error?.code,
    "unknown",
  );
  const got = (await person.call("actors", "get", { actorId })) as { result: { restarts: number } };
  assert.equal(got.result.restarts, 0);
  void hub;
});

test("a view module's calls and events run as its Actor, through the package's own wiring", async (t) => {
  const { hub, person } = await setup(t);
  const board = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "examples",
    "board",
  );
  const out = mkdtempSync(join(tmpdir(), "board-for-views-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const built = await buildPackage(board, { out });
  hub.state.addPackage(PERSON, built.file);
  const { actorId } = hub.state.createActor(PERSON, { name: "board", package: built.hash });
  const got = (await person.call("actors", "get", { actorId })) as { result: { views: string[] } };
  assert.deepEqual(got.result.views, ["panel"]);
  const listed = (await person.call("actors", "list", {})) as {
    result: { actors: { actorId: string; views?: string[] }[] };
  };
  assert.deepEqual(listed.result.actors.find((a) => a.actorId === actorId)?.views, ["panel"]);
  // Not running yet: its views can't call.
  await assert.rejects(
    hub.viewCall(actorId, "panel", "board", "list", {}),
    (e: Refused) => e.code === "state",
  );
  hub.state.start(PERSON, actorId);

  // Its process, played by the test: serves logic.board over a pipe.
  const subscribers: WritableStreamDefaultWriter<Uint8Array>[] = [];
  const [hubSide, processSide] = memoryPair();
  hub.accept(hubSide, { actorId });
  const process_ = new Session(processSide, {
    client: true,
    onStream: (stream) => {
      const reader = new FrameReader(stream.readable);
      void reader.next().then(async (h) => {
        const header = parseHeader(h);
        if (header.op !== "serve") return void stream.writable.close().catch(() => {});
        const writer = stream.writable.getWriter();
        if (header.kind === "subscribe") return void subscribers.push(writer);
        await reader.next();
        await writer.write(
          encodeFrame(result({ cards: [{ id: "1", title: `for ${header.caller}`, done: false }] })),
        );
        await writer.close();
      });
    },
  });
  t.after(() => process_.close());
  await exchange(process_, { op: "hello", actorId });

  assert.deepEqual(await hub.viewCall(actorId, "panel", "board", "list", {}), {
    cards: [{ id: "1", title: `for ${actorId}`, done: false }],
  });
  await assert.rejects(
    hub.viewCall(actorId, "panel", "board", "add", { title: "" }),
    (e: Refused) => e.code === "invalid",
  );
  await assert.rejects(
    hub.viewCall(actorId, "logic", "store", "get", { key: "x" }),
    (e: Refused) => e.code === "forbidden",
  );
  await assert.rejects(
    hub.viewCall(PERSON, "panel", "board", "list", {}),
    (e: Refused) => e.code === "forbidden",
  );
  const audited = hub.state
    .audit(0, 1000)
    .entries.filter(
      (e) => e.kind === "call" && e.actor === actorId && e.details.slot === "panel.board",
    );
  assert.deepEqual(
    audited.map((e) => e.details.outcome),
    ["refused", "ok", "invalid"],
  );
  const refusedViews = hub.state
    .audit(0, 1000)
    .entries.filter(
      (e) => e.kind === "call" && e.actor === actorId && e.details.slot === "logic.store",
    );
  assert.equal(refusedViews.length, 1, "a refused non-view module is audited too");
  assert.throws(
    () => hub.viewSubscribe(actorId, "panel", "board", "nope", () => {}),
    (e: Refused) => e.code === "invalid",
    "refused at the start: thrown",
  );

  const heard: unknown[] = [];
  let ended: unknown = "open";
  const stop = hub.viewSubscribe(
    actorId,
    "panel",
    "board",
    "changed",
    (payload) => {
      heard.push(payload);
    },
    (error) => {
      ended = error;
    },
  );
  for (let waited = 0; !subscribers.length && waited < 3000; waited += 5) await later(5);
  await subscribers[0]?.write(encodeFrame(eventBody({ id: "2" })));
  for (let waited = 0; !heard.length && waited < 3000; waited += 5) await later(5);
  assert.deepEqual(heard, [{ id: "2" }]);
  // A second subscriber whose onEnd throws doesn't keep the first from hearing the unbind.
  const stopRude = hub.viewSubscribe(
    actorId,
    "panel",
    "board",
    "changed",
    () => {},
    () => {
      throw new Error("rude");
    },
  );
  for (let waited = 0; subscribers.length < 2 && waited < 3000; waited += 5) await later(5);
  // Unbinding its slot ends the subscription with NotConnected.
  hub.state.unbind(PERSON, actorId, "panel.board");
  for (let waited = 0; ended === "open" && waited < 3000; waited += 5) await later(5);
  assert.ok(ended instanceof NotConnected);
  stop();
  stop();
  stopRude();
});

test("a view module's slot changes reach its listeners: bound now, unbound, and usable again", async (t) => {
  const { hub, url, person, bind } = await setup(t);
  const board = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "examples",
    "board",
  );
  const out = mkdtempSync(join(tmpdir(), "board-for-view-slots-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const built = await buildPackage(board, { out });
  hub.state.addPackage(PERSON, built.file);
  const { actorId } = hub.state.createActor(PERSON, { name: "board", package: built.hash });
  assert.throws(
    () => hub.viewSlots(actorId, "logic", () => {}),
    (e: Refused) => e.code === "forbidden",
    "a host module isn't a view",
  );
  assert.throws(
    () => hub.viewSlots(PERSON, "panel", () => {}),
    (e: Refused) => e.code === "forbidden",
  );

  // One that throws, listening first, doesn't keep the others from hearing.
  const stopRude = hub.viewSlots(actorId, "panel", () => {
    throw new Error("rude");
  });
  // Not running yet: its package's own wiring is bound, and the listener hears it at once.
  const heard: [string, boolean][] = [];
  const stop = hub.viewSlots(actorId, "panel", (slot, bound) => {
    heard.push([slot, bound]);
  });
  assert.deepEqual(heard, [["board", true]]);

  // Its own process connects, the provider of panel.board: usable again.
  hub.state.start(PERSON, actorId);
  const processOf = async () => {
    const [hubSide, processSide] = memoryPair();
    hub.accept(hubSide, { actorId });
    const session = new Session(processSide, { client: true, onStream: () => {} });
    t.after(() => session.close());
    await exchange(session, { op: "hello", actorId });
  };
  await processOf();
  assert.deepEqual(heard, [
    ["board", true],
    ["board", true],
  ]);

  // Unbound, then bound to another Actor offering the same interface, which connects later.
  heard.length = 0;
  hub.state.unbind(PERSON, actorId, "panel.board");
  assert.deepEqual(heard, [["board", false]]);
  heard.length = 0;
  const iface = hub.state.declaration(actorId, "export", "logic.board")?.iface;
  assert.ok(iface);
  const made = (await person.call("actors", "create", { name: "other board" })) as {
    result: { actorId: string; credential: string };
  };
  const other = made.result.actorId;
  const first = await connect(url, { ...made.result, declares: { exports: { board: iface } } });
  first.close();
  await first.session.closed;
  for (let waited = 0; hub.connected(other) && waited < 3000; waited += 5) await later(5);
  const bound = (await bind(actorId, "panel.board", other, "board")) as { error?: unknown };
  assert.equal(bound.error, undefined);
  assert.deepEqual(heard, [["board", true]]);
  // The provider comes back after the view's listener started: usable again.
  const again = await connect(url, made.result);
  t.after(() => again.close());
  assert.deepEqual(heard, [
    ["board", true],
    ["board", true],
  ]);
  // The view's own Actor comes back (its views call only while it runs): usable again too, though
  // another Actor provides the slot.
  heard.length = 0;
  await processOf();
  assert.deepEqual(heard, [["board", true]]);
  // A listener stopped by another during a change doesn't hear that change.
  heard.length = 0;
  let stopLate = () => {};
  const stopEarly = hub.viewSlots(actorId, "panel", () => stopLate());
  const late: [string, boolean][] = [];
  stopLate = hub.viewSlots(actorId, "panel", (slot, bound) => {
    late.push([slot, bound]);
  });
  late.length = 0;
  hub.state.unbind(PERSON, actorId, "panel.board");
  assert.deepEqual(late, []);
  assert.deepEqual(heard, [["board", false]]);
  stopEarly();
  await bind(actorId, "panel.board", other, "board");
  heard.length = 0;
  stop();
  stopRude();
  hub.state.unbind(PERSON, actorId, "panel.board");
  assert.deepEqual(heard, [], "a stopped listener hears nothing");
});

test("a provider's own error code reaches the subscriber as an error, whatever it is", async (t) => {
  const { actor, bind } = await setup(t);
  const p = await actor("provider", { exports: { notes } }, async (_, stream) => {
    const writer = stream.writable.getWriter();
    await writer.write(encodeFrame(wireError("Refused", "too many", "slow")));
    await writer.close();
  });
  const c = await actor("consumer", { slots: { notes } });
  await bind(c.id, "notes", p.id, "notes");
  const sub = c.client.subscribe("notes", "written");
  const first = await sub.next();
  assert.equal(first?.error?.code, "slow", "an error frame, not a reset");
});

test("compiling has its own budget: a slow first compile passes, a slow check is still refused", async (t) => {
  const workerUrl = new URL("./slow-worker.js", import.meta.url);
  const iface = (marker: string) =>
    ({
      id: `${marker}@1`,
      kind: "rpc",
      methods: { run: { input: { type: "object" }, output: { type: "object" } } },
      events: {},
      hash: `sha256-${marker}`,
    }) as unknown as DescribedInterface;
  const input = { method: "run", side: "input" } as const;
  const roomy = new Validators({ size: 1, workerUrl, budgetMs: 250, compileBudgetMs: 2000 });
  t.after(() => roomy.close());
  await roomy.check("a", iface("slowcompile"), input, {}, "invalid");
  await assert.rejects(
    roomy.check("a", iface("slowcheck"), input, {}, "invalid"),
    (e: Refused) => e.code === "invalid" && /check took over 250 ms/.test(e.message),
  );
  const tight = new Validators({ size: 1, workerUrl, budgetMs: 250, compileBudgetMs: 300 });
  t.after(() => tight.close());
  await assert.rejects(
    tight.check("a", iface("slowcompile"), input, {}, "bad_output"),
    (e: Refused) => e.code === "bad_output" && /to compile/.test(e.message),
  );
});

test("compiling never runs an Actor's patternProperties regex against its property names", async (t) => {
  // The regex against that name backtracks for far longer than the budget, which would refuse the
  // compile; a compile that never runs it is accepted however loaded the machine is.
  const validators = new Validators({ size: 1, compileBudgetMs: 10_000 });
  t.after(() => validators.close());
  const hostile = handMade(
    "matching",
    {
      type: "object",
      properties: { [`${"a".repeat(40)}!`]: { type: "string" } },
      patternProperties: { "^(a+)+$": { type: "string" } },
    },
    { type: "object" },
  );
  await validators.prepare("a", hostile);
});

test("a view module's log lines go to its Actor's log, bounded, and the file rotates", async (t) => {
  const { hub, home, person } = await setup(t);
  const board = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "examples",
    "board",
  );
  const out = mkdtempSync(join(tmpdir(), "board-for-logs-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const built = await buildPackage(board, { out });
  hub.state.addPackage(PERSON, built.file);
  const { actorId } = hub.state.createActor(PERSON, { name: "board", package: built.hash });
  const logs = async (limit = 10) =>
    (
      (await person.call("actors", "logs", { actorId, limit })) as {
        result: {
          lines: {
            level: string;
            message: string;
            data?: Record<string, unknown>;
            module?: string;
          }[];
        };
      }
    ).result.lines;

  // Not running is fine: a view may log while its Actor is stopped.
  hub.viewLog(actorId, "panel", { level: "warn", message: "drawn", data: { cards: 2 } });
  const [first] = await logs();
  assert.deepEqual(
    { ...first, at: undefined },
    { level: "warn", message: "drawn", data: { cards: 2 }, module: "panel", at: undefined },
  );
  assert.equal(statSync(join(home, "logs", `${actorId}.log`)).mode & 0o777, 0o600);

  // Whatever the gateway passes, the Hub bounds it, and nothing it passes makes viewLog throw.
  let toJSONCalls = 0;
  const hostile = JSON.parse('{"__proto__": "kept"}') as Record<string, unknown>;
  Object.assign(hostile, {
    long: "y".repeat(2000),
    nested: { deep: true },
    big: 1n,
    sneaky: { toJSON: () => (toJSONCalls++ ? "Q".repeat(3 << 20) : undefined) },
  });
  Object.defineProperty(hostile, "getter", {
    enumerable: true,
    get() {
      throw new Error("no");
    },
  });
  for (let i = 0; i < 20; i++) hostile[`k${i}`] = i;
  hub.viewLog(actorId, "panel", {
    level: "loud",
    message: Object.create(null) as string,
    data: hostile,
  });
  const [bounded] = await logs(1);
  assert.equal(bounded?.level, "info");
  assert.equal(bounded?.message, "[unprintable]");
  assert.equal(Object.keys(bounded?.data ?? {}).length, 16);
  assert.deepEqual(
    { ...bounded?.data, long: String(bounded?.data?.long).length },
    {
      ["__proto__"]: "kept",
      long: 1024,
      nested: '{"deep":true}',
      big: "[unreadable]",
      sneaky: "undefined",
      getter: "[unreadable]",
      ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i])),
    },
  );
  assert.equal(toJSONCalls, 1, "a value is turned into JSON once, when it is bounded");
  hub.viewLog(actorId, "panel", { level: "info", message: "x".repeat(5000) });
  assert.equal((await logs(1))[0]?.message.length, 4096);
  const trap = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("no keys");
      },
    },
  );
  hub.viewLog(actorId, "panel", { level: "error", message: "trapped", data: trap });
  assert.deepEqual(
    { ...(await logs(1))[0], at: undefined },
    { level: "error", message: "trapped", module: "panel", at: undefined },
  );

  // Only a view module of a package Actor logs this way.
  assert.throws(
    () => hub.viewLog(actorId, "logic", { level: "info", message: "no" }),
    (e: Refused) => e.code === "forbidden",
  );
  assert.throws(
    () => hub.viewLog(PERSON, "panel", { level: "info", message: "no" }),
    (e: Refused) => e.code === "forbidden",
  );

  // Past 1 MiB the file is rotated once: two files at most, the newest lines still read, and
  // a second rotation replaces the first.
  for (let i = 0; i < 600; i++)
    hub.viewLog(actorId, "panel", { level: "info", message: `line ${i} ${"z".repeat(4000)}` });
  const file = join(home, "logs", `${actorId}.log`);
  assert.ok(statSync(file).size <= 1024 * 1024);
  assert.ok(statSync(`${file}.1`).size <= 1024 * 1024);
  assert.equal(statSync(join(home, "logs")).mode & 0o777, 0o700);
  assert.ok(
    !readFileSync(`${file}.1`, "utf8").includes('"drawn"'),
    "the first file's lines went with the second rotation",
  );
  const newest = await logs(2);
  assert.deepEqual(
    newest.map((line) => line.message.split(" ").slice(0, 2).join(" ")),
    ["line 598", "line 599"],
  );
});
