import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hubActors, hubExports, hubGrants } from "@agentorg/interfaces";
import {
  defineInterface,
  event,
  method,
  NotConnected,
  OutcomeUnknown,
  Refused,
} from "@agentorg/sdk";
import { type ConnectOptions, connect } from "@agentorg/sdk/client";
import { z } from "zod";
import { HUB, Hub, listen, PERSON } from "../src/index.ts";

const notes = defineInterface({
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
});
const echo = defineInterface({
  name: "echo",
  major: 1,
  kind: "stream",
  protocol: "bytes",
  open: z.object({ prefix: z.string() }),
});
const web = defineInterface({ name: "web", major: 1, kind: "http" });
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 3000) => {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > ms) throw new Error("timed out waiting");
    await later(5);
  }
};
/** Emit until the listener hears it: the Hub opens the provider's side of a subscription a moment after. */
const emitUntilHeard = async (emit: () => void, heard: () => boolean) => {
  for (let i = 0; i < 300 && !heard(); i++) {
    emit();
    await later(10);
  }
  assert.ok(heard(), "the event was never heard");
};

type Options<S, X> = Omit<ConnectOptions<never, never>, "slots" | "exports"> & {
  slots?: S;
  exports?: X;
};

async function setup(t: test.TestContext) {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-client-")), "home");
  const hub = Hub.open(home);
  const server = await listen(hub);
  const open: { close(): void }[] = [];
  t.after(async () => {
    for (const client of open) client.close();
    await server.close();
    hub.close();
    rmSync(join(home, ".."), { recursive: true, force: true });
  });
  // The person keeps the slots it was bootstrapped with: it declares nothing.
  const person = await connect({
    hubUrl: server.url,
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
    slots: { actors: hubActors, grants: hubGrants, exports: hubExports },
    declare: false,
  });
  open.push(person);
  /** A new external Actor's id and credential, made through the person's hub.actors slot. */
  const makeActor = async (
    name: string,
    bindings?: { slot: string; provider: string; export: string }[],
  ) => {
    const made = await person.slots.actors.call.create({ name, ...(bindings ? { bindings } : {}) });
    assert.ok(made.credential, "an external Actor gets a credential");
    return { actorId: made.actorId, credential: made.credential };
  };
  /** Connect as an Actor; closed with the test. */
  const as = async <const S extends Record<string, never> | object, const X extends object>(
    who: { actorId: string; credential: string },
    shape: { slots?: S; exports?: X; declare?: boolean } = {},
  ) => {
    const client = await connect({ hubUrl: server.url, ...who, ...shape } as Options<
      S,
      X
    > as never);
    open.push(client);
    return client;
  };
  const bind = (consumer: string, slot: string, provider: string, exported: string) =>
    person.slots.grants.call.bind({ consumer, slot, provider, export: exported });
  return { hub, url: server.url, person, makeActor, bind, as };
}

test("bind, call, events, unbind and rebind through the client, with onBind and onUnbind", async (t) => {
  const { url, makeActor, bind, person } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  const provider = await connect({ hubUrl: url, ...p, exports: { notes } });
  const consumer = await connect({ hubUrl: url, ...c, slots: { notes } });
  t.after(() => {
    provider.close();
    consumer.close();
  });
  let count = 0;
  provider.exports.notes.implement({ write: async () => ({ n: ++count }) });
  const changes: string[] = [];
  consumer.slots.notes.onBind(() => changes.push("bind"));
  consumer.slots.notes.onUnbind(() => changes.push("unbind"));
  const heard: string[] = [];
  consumer.slots.notes.on("written", (payload) => heard.push(payload.text));
  assert.equal(consumer.slots.notes.bound, false);
  await assert.rejects(consumer.slots.notes.call.write({ text: "x" }), NotConnected);

  assert.deepEqual(await bind(c.actorId, "notes", p.actorId, "notes"), { bound: true });
  await until(() => consumer.slots.notes.bound);
  assert.deepEqual(await consumer.slots.notes.call.write({ text: "one" }), { n: 1 });
  await emitUntilHeard(
    () => provider.exports.notes.emit("written", { text: "first" }),
    () => heard.includes("first"),
  );

  await person.slots.grants.call.unbind({ consumer: c.actorId, slot: "notes" });
  await until(() => !consumer.slots.notes.bound);
  await assert.rejects(consumer.slots.notes.call.write({ text: "x" }), NotConnected);

  // After a rebind the listener hears again: the client subscribed anew.
  await bind(c.actorId, "notes", p.actorId, "notes");
  await until(() => consumer.slots.notes.bound);
  await emitUntilHeard(
    () => provider.exports.notes.emit("written", { text: "second" }),
    () => heard.includes("second"),
  );
  assert.deepEqual(changes, ["bind", "unbind", "bind"]);
});

test("a provider that restarts: onBind runs again and events resume, with bound unchanged", async (t) => {
  const { url, makeActor, bind } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  const first = await connect({ hubUrl: url, ...p, exports: { notes } });
  const consumer = await connect({ hubUrl: url, ...c, slots: { notes } });
  t.after(() => consumer.close());
  first.exports.notes.implement({ write: async () => ({ n: 1 }) });
  const changes: string[] = [];
  consumer.slots.notes.onBind(() => changes.push("usable"));
  consumer.slots.notes.onUnbind(() => changes.push("unbound"));
  const heard: string[] = [];
  consumer.slots.notes.on("written", (payload) => heard.push(payload.text));
  await bind(c.actorId, "notes", p.actorId, "notes");
  await until(() => consumer.slots.notes.bound);
  await emitUntilHeard(
    () => first.exports.notes.emit("written", { text: "before" }),
    () => heard.includes("before"),
  );

  first.close();
  await first.closed;
  await later(50);
  assert.equal(consumer.slots.notes.bound, true, "a provider going away isn't an unbind");
  await assert.rejects(consumer.slots.notes.call.write({ text: "x" }), NotConnected);

  const back = await connect({ hubUrl: url, ...p, exports: { notes } });
  t.after(() => back.close());
  back.exports.notes.implement({ write: async () => ({ n: 2 }) });
  await until(() => changes.length === 2);
  assert.deepEqual(changes, ["usable", "usable"]);
  assert.deepEqual(await consumer.slots.notes.call.write({ text: "x" }), { n: 2 });
  await emitUntilHeard(
    () => back.exports.notes.emit("written", { text: "after" }),
    () => heard.includes("after"),
  );
});

test("errors come back as the SDK's", async (t) => {
  const { url, makeActor, bind } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  const provider = await connect({ hubUrl: url, ...p, exports: { notes } });
  const consumer = await connect({ hubUrl: url, ...c, slots: { notes } });
  t.after(() => {
    provider.close();
    consumer.close();
  });
  let arrived = () => {};
  const called = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  provider.exports.notes.implement({
    write: async ({ text }) => {
      if (text === "busy") throw new Refused("busy", "not now");
      if (text === "bug") throw new TypeError("it broke");
      if (text === "hang") {
        arrived();
        await new Promise(() => {});
      }
      return { n: 1 };
    },
  });
  await bind(c.actorId, "notes", p.actorId, "notes");
  await until(() => consumer.slots.notes.bound);

  // Checked here, as the Hub would: it never leaves the consumer.
  await assert.rejects(
    consumer.slots.notes.call.write({ text: "" }),
    (e: Refused) => e.code === "invalid",
  );
  await assert.rejects(
    consumer.slots.notes.call.write({ text: "busy" }),
    (e: Refused) => e.code === "busy",
  );
  await assert.rejects(
    consumer.slots.notes.call.write({ text: "bug" }),
    (e: Refused) => e.code === "failed",
    "a handler's own failure is failed, whatever its type",
  );

  // The consumer's own channel lost mid-call: OutcomeUnknown.
  const pending = consumer.slots.notes.call.write({ text: "hang" });
  await called;
  consumer.close();
  await assert.rejects(pending, OutcomeUnknown);
  await consumer.closed;
  assert.equal(consumer.slots.notes.bound, false, "a lost channel leaves nothing bound");
  await assert.rejects(consumer.slots.notes.call.write({ text: "x" }), NotConnected);

  await assert.rejects(
    connect({ hubUrl: url, ...c, credential: "wrong" }),
    (e: Refused) => e.code === "forbidden",
  );
  await assert.rejects(connect({ hubUrl: "ws://127.0.0.1:1", ...c }), NotConnected);
  await assert.rejects(connect({ hubUrl: "not a url", ...c }), NotConnected);
});

test("run-time exports: offered in order, withdrawn with their bindings and subscriptions, or refused", async (t) => {
  const { url, makeActor, bind, person, as, hub } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  const provider = await connect({ hubUrl: url, ...p });
  const consumer = await connect({ hubUrl: url, ...c, slots: { notes } });
  t.after(() => {
    provider.close();
    consumer.close();
  });
  const listed = async () => (await person.slots.exports.call.list({ actor: p.actorId })).exports;
  // Withdrawn and offered again at once: the Hub sees them in order, and ends with it offered.
  provider.exports.add("extra", notes).withdraw();
  const extra = provider.exports.add("extra", notes);
  extra.implement({ write: async () => ({ n: 7 }) });
  // All three reached the Hub, in order: offer, withdraw, offer.
  const changes = () =>
    hub.state
      .audit(0, 1000)
      .entries.filter((e) => e.actor === p.actorId && e.kind.startsWith("export."))
      .map((e) => e.kind);
  await until(() => changes().length === 3);
  assert.deepEqual(changes(), ["export.offer", "export.withdraw", "export.offer"]);
  assert.deepEqual(
    (await listed()).map((e) => [e.export, e.dynamic]),
    [["extra", true]],
  );
  await bind(c.actorId, "notes", p.actorId, "extra");
  await until(() => consumer.slots.notes.bound);
  assert.deepEqual(await consumer.slots.notes.call.write({ text: "hi" }), { n: 7 });
  const heard: string[] = [];
  let ended = false;
  consumer.slots.notes.onUnbind(() => {
    ended = true;
  });
  consumer.slots.notes.on("written", (payload) => heard.push(payload.text));
  await emitUntilHeard(
    () => extra.emit("written", { text: "live" }),
    () => heard.length > 0,
  );
  extra.withdraw();
  await until(() => ended && !consumer.slots.notes.bound);
  await assert.rejects(consumer.slots.notes.call.write({ text: "hi" }), NotConnected);
  assert.deepEqual(await listed(), []);

  // An offer the Hub refuses is withdrawn here too. This Actor declared `notes` on an earlier
  // channel; connecting again without declaring keeps it, so offering the name again conflicts.
  const r = await makeActor("redeclared");
  const earlier = await connect({ hubUrl: url, ...r, exports: { notes } });
  earlier.close();
  await earlier.closed;
  const again = await as(r, { declare: false });
  const clash = again.exports.add("notes", notes);
  await until(() => {
    try {
      clash.emit("written", { text: "x" });
      return false;
    } catch (error) {
      return error instanceof NotConnected;
    }
  });
});

test("a stream export accepts an open, refuses one it can't take, and an http export with no handler refuses", async (t) => {
  const { url, makeActor, bind } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  const provider = await connect({ hubUrl: url, ...p, exports: { echo, web } });
  const consumer = await connect({ hubUrl: url, ...c, slots: { echo, web } });
  t.after(() => {
    provider.close();
    consumer.close();
  });
  await bind(c.actorId, "echo", p.actorId, "echo");
  await bind(c.actorId, "web", p.actorId, "web");
  await until(() => consumer.slots.echo.bound && consumer.slots.web.bound);
  // No accept handler yet: the provider refuses before any bytes.
  await assert.rejects(
    consumer.slots.echo.open({ prefix: ">" }),
    (e: Refused) => e.code === "unimplemented",
  );
  provider.exports.echo.accept(async ({ prefix }, stream) => {
    const writer = stream.writable.getWriter();
    await writer.write(new TextEncoder().encode(prefix));
    writer.releaseLock();
    await stream.readable.pipeTo(stream.writable);
  });
  const stream = await consumer.slots.echo.open({ prefix: ">" });
  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode("ping"));
  await writer.close();
  let text = "";
  for await (const chunk of stream.readable) text += new TextDecoder().decode(chunk);
  assert.equal(text, ">ping");
  await assert.rejects(
    consumer.slots.echo.open({ prefix: 1 as unknown as string }),
    (e: Refused) => e.code === "invalid",
  );
  await assert.rejects(
    consumer.slots.web.fetch(new Request("http://x/")),
    (e: Refused) => e.code === "unimplemented",
  );
});

test("a requester learns its outcome from decided, and from mine after a reconnect", async (t) => {
  const { url, makeActor, bind, hub } = await setup(t);
  const p = await makeActor("provider");
  const grants = { slot: "grants", provider: HUB, export: "grants" };
  const c = await makeActor("consumer", [grants]);
  const provider = await connect({ hubUrl: url, ...p, exports: { notes } });
  const consumer = await connect({ hubUrl: url, ...c, slots: { notes, grants: hubGrants } });
  t.after(() => provider.close());
  provider.exports.notes.implement({ write: async () => ({ n: 1 }) });
  await until(() => consumer.slots.grants.bound);
  const decided: string[] = [];
  consumer.slots.grants.on("decided", ({ status }) => decided.push(status));
  const wiring = { consumer: c.actorId, slot: "notes", provider: p.actorId, export: "notes" };
  await until(() =>
    hub.state
      .audit(0, 1000)
      .entries.some((e) => e.actor === c.actorId && e.details.op === "subscribe"),
  );
  const asked = await consumer.slots.grants.call.bind(wiring);
  if (asked.bound) assert.fail("the consumer alone holds only the slot side");
  await bind(c.actorId, "notes", p.actorId, "notes");
  await until(() => consumer.slots.notes.bound && decided.length === 1);
  assert.deepEqual(decided, ["approved"]);
  assert.deepEqual(await consumer.slots.notes.call.write({ text: "ok" }), { n: 1 });

  consumer.close();
  await consumer.closed;
  const again = await connect({ hubUrl: url, ...c, slots: { notes, grants: hubGrants } });
  t.after(() => again.close());
  const mine = await again.slots.grants.call.mine({});
  assert.deepEqual(
    mine.requests.map((r) => [r.requestId, r.status]),
    [[asked.requestId, "approved"]],
  );
  assert.equal(again.slots.notes.bound, true, "hello's snapshot");
});

test("an Actor that declares nothing keeps what it declared before", async (t) => {
  const { url, makeActor, bind } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  const provider = await connect({ hubUrl: url, ...p, exports: { notes } });
  t.after(() => provider.close());
  provider.exports.notes.implement({ write: async () => ({ n: 3 }) });
  const first = await connect({ hubUrl: url, ...c, slots: { notes } });
  first.close();
  await first.closed;
  await bind(c.actorId, "notes", p.actorId, "notes");
  const later_ = await connect({ hubUrl: url, ...c, slots: { notes }, declare: false });
  t.after(() => later_.close());
  assert.equal(later_.slots.notes.bound, true);
  assert.deepEqual(await later_.slots.notes.call.write({ text: "kept" }), { n: 3 });
});

test("sizes and async handlers fail where they belong", async (t) => {
  const { url, makeActor, bind } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  const logs: string[] = [];
  const log = { info() {}, warn() {}, error: (message: string) => void logs.push(message) };
  const provider = await connect({ hubUrl: url, ...p, exports: { notes }, log });
  const consumer = await connect({ hubUrl: url, ...c, slots: { notes }, log });
  t.after(() => {
    provider.close();
    consumer.close();
  });
  provider.exports.notes.implement({ write: async () => ({ n: 1 }) });
  // An async onBind that rejects is logged, not left unhandled.
  consumer.slots.notes.onBind(async () => {
    throw new Error("async trouble");
  });
  const heard: string[] = [];
  consumer.slots.notes.on("written", (payload) => heard.push(payload.text.slice(0, 5)));
  await bind(c.actorId, "notes", p.actorId, "notes");
  await until(() => consumer.slots.notes.bound && logs.includes("A slot handler threw."));
  // An input too large to send never ran anywhere: invalid.
  await assert.rejects(
    consumer.slots.notes.call.write({ text: "x".repeat(1_100_000) }),
    (e: Refused) => e.code === "invalid",
  );
  // An event too large to send doesn't throw at the emitter, and the next one still goes out.
  await emitUntilHeard(
    () => provider.exports.notes.emit("written", { text: "small" }),
    () => heard.includes("small"),
  );
  assert.doesNotThrow(() =>
    provider.exports.notes.emit("written", { text: "y".repeat(1_100_000) }),
  );
  await until(() => logs.includes("An event was too large to send."));
});

test("implement in start, use slots from onBind: a returning provider is ready before it is used", async (t) => {
  const { url, makeActor, bind } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  let generation = 0;
  const start = async (ctx: { exports: { notes: { implement(h: object): void } } }) => {
    const mine = ++generation;
    await later(30); // a slow start: the Hub mustn't reach the export before this ends
    ctx.exports.notes.implement({ write: async () => ({ n: mine }) });
  };
  const results: (number | string)[] = [];
  let duringStart: string | undefined;
  const consumer = await connect({
    hubUrl: url,
    ...c,
    slots: { notes },
    start(ctx) {
      duringStart = `${ctx.slots.notes.bound}`;
      ctx.slots.notes.onBind(() => {
        ctx.slots.notes.call.write({ text: "now" }).then(
          (r) => results.push(r.n),
          (e: Error) => results.push(e.name),
        );
      });
    },
  });
  t.after(() => consumer.close());
  assert.equal(duringStart, "false", "every slot reads unbound during start");
  let provider = await connect({ hubUrl: url, ...p, exports: { notes }, start });
  await bind(c.actorId, "notes", p.actorId, "notes");
  await until(() => results.length === 1);
  for (let restart = 2; restart <= 5; restart++) {
    provider.close();
    await provider.closed;
    provider = await connect({ hubUrl: url, ...p, exports: { notes }, start });
    await until(() => results.length === restart);
  }
  t.after(() => provider.close());
  assert.deepEqual(results, [1, 2, 3, 4, 5], "every call from onBind succeeded");
});

test("http: fetch from a slot reaches serve on the export, both ways, one request per stream", async (t) => {
  const { url, makeActor, bind } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  const provider = await connect({
    hubUrl: url,
    ...p,
    exports: { web },
    start(ctx) {
      ctx.exports.web.serve(async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/boom") throw new Error("it broke");
        if (path === "/empty") return new Response(null, { status: 204 });
        if (path === "/big") return new Response("z".repeat(1024 * 1024));
        const headers = new Headers({ "x-seen": request.headers.get("x-asked") ?? "" });
        headers.append("set-cookie", "a=1");
        headers.append("set-cookie", "b=2");
        const body = request.method === "POST" ? await request.text() : "";
        return new Response(`${request.method} ${path}${new URL(request.url).search} ${body}`, {
          status: 201,
          headers,
        });
      });
    },
  });
  const consumer = await connect({ hubUrl: url, ...c, slots: { web } });
  t.after(() => {
    provider.close();
    consumer.close();
  });
  await bind(c.actorId, "web", p.actorId, "web");
  await until(() => consumer.slots.web.bound);

  const got = await consumer.slots.web.fetch(
    new Request("http://web/hello?x=1", { headers: { "x-asked": "yes" } }),
  );
  assert.equal(got.status, 201);
  assert.equal(await got.text(), "GET /hello?x=1 ");
  assert.equal(got.headers.get("x-seen"), "yes");
  assert.deepEqual(got.headers.getSetCookie(), ["a=1", "b=2"]);

  const posted = await consumer.slots.web.fetch(
    new Request("http://web/echo", { method: "POST", body: "payload".repeat(10_000) }),
  );
  assert.equal(await posted.text(), `POST /echo ${"payload".repeat(10_000)}`);
  assert.equal(
    (await (await consumer.slots.web.fetch(new Request("http://web/big"))).text()).length,
    1024 * 1024,
  );
  const empty = await consumer.slots.web.fetch(new Request("http://web/empty"));
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), "");
  const failed = await consumer.slots.web.fetch(new Request("http://web/boom"));
  assert.equal(failed.status, 500);
  assert.match(await failed.text(), /it broke/);
  // Several at once, each on its own stream.
  const many = await Promise.all(
    Array.from({ length: 8 }, (_, i) => consumer.slots.web.fetch(new Request(`http://web/n${i}`))),
  );
  assert.deepEqual(
    await Promise.all(many.map((r) => r.text())),
    Array.from({ length: 8 }, (_, i) => `GET /n${i} `),
  );
});

test("http: paced bodies, unread uploads, broken bodies, aborts and hop-by-hop headers", async (t) => {
  const { url, makeActor, bind } = await setup(t);
  const p = await makeActor("provider");
  const c = await makeActor("consumer");
  let pulled = 0;
  const seenHeaders: string[] = [];
  const provider = await connect({
    hubUrl: url,
    ...p,
    exports: { web },
    start(ctx) {
      ctx.exports.web.serve(async (request) => {
        const path = new URL(request.url).pathname;
        request.headers.forEach((_, name) => {
          seenHeaders.push(name);
        });
        if (path === "/endless")
          return new Response(
            new ReadableStream({
              pull(controller) {
                pulled += 65536;
                controller.enqueue(new Uint8Array(65536));
              },
            }),
          );
        if (path === "/broken")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("partial"));
                controller.error(new Error("source died"));
              },
            }),
          );
        if (path === "/never") return new Promise<Response>(() => {});
        return new Response("ignored");
      });
    },
  });
  const consumer = await connect({ hubUrl: url, ...c, slots: { web } });
  t.after(() => {
    provider.close();
    consumer.close();
  });
  await bind(c.actorId, "web", p.actorId, "web");
  await until(() => consumer.slots.web.bound);

  // An endless body read by no one is paced, not buffered without end.
  const endless = await consumer.slots.web.fetch(new Request("http://web/endless"));
  await later(300);
  assert.ok(pulled < 16 * 1024 * 1024, `the provider pulled ${pulled} bytes nobody read`);
  await endless.body?.cancel();

  // An upload the handler never reads: the response still arrives, and the request settles.
  const unread = await consumer.slots.web.fetch(
    new Request("http://web/ignore", { method: "POST", body: "x".repeat(10 * 1024 * 1024) }),
  );
  assert.equal(await unread.text(), "ignored");

  // A body that fails after the headers fails on the consumer's side (the stream is reset, so at
  // the fetch or at the read), rather than looking complete.
  await assert.rejects(
    (async () => (await consumer.slots.web.fetch(new Request("http://web/broken"))).text())(),
  );

  // An abort ends a request the provider never answers.
  await assert.rejects(
    consumer.slots.web.fetch(new Request("http://web/never", { signal: AbortSignal.timeout(200) })),
    (e: Error) => e.name === "TimeoutError",
  );

  // Hop-by-hop headers stay with their hop.
  await (
    await consumer.slots.web.fetch(new Request("http://web/h", { method: "POST", body: "b" }))
  ).text();
  assert.ok(!seenHeaders.includes("connection") && !seenHeaders.includes("transfer-encoding"));
});
