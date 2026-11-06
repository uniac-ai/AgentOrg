import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { runFrame } from "../src/frame.ts";
import { type FrameHandlers, FrameHost } from "../src/frame-host.ts";
import type { PortLike } from "../src/frame-protocol.ts";
import {
  type Context,
  defineActor,
  defineInterface,
  defineWidget,
  event,
  method,
  NotConnected,
  OutcomeUnknown,
  Refused,
} from "../src/index.ts";

const board = defineInterface({
  name: "board",
  major: 1,
  kind: "rpc",
  methods: {
    list: method({ input: z.object({}), output: z.object({ titles: z.array(z.string()) }) }),
    add: method({ input: z.object({ title: z.string().min(1) }), output: z.object({}) }),
  },
  events: { changed: event(z.object({ id: z.string() })) },
});
const Size = z.object({ width: z.number(), height: z.number() });
// ui.view@1 and ui.shell@1 as @agentorg/interfaces defines them.
const uiView = defineInterface({
  name: "ui.view",
  major: 1,
  kind: "rpc",
  methods: {
    mount: method({
      input: z.object({ theme: z.record(z.string(), z.string()), size: Size }),
      output: z.object({}),
    }),
    resize: method({ input: z.object({ size: Size }), output: z.object({}) }),
    unmount: method({ input: z.object({}), output: z.object({}) }),
  },
});
const uiShell = defineInterface({
  name: "ui.shell",
  major: 1,
  kind: "rpc",
  methods: {
    openExternal: method({ input: z.object({ url: z.string() }), output: z.object({}) }),
    signIn: method({ input: z.object({}), output: z.object({}) }),
  },
});

type PanelSlots = Context<
  { board: typeof board; shell: typeof uiShell },
  { view: typeof uiView }
>["slots"];
interface Seen {
  binds: string[];
  unbinds: string[];
  events: unknown[];
  mounts: unknown[];
  resizes: unknown[];
  unmounts: number;
  roots: unknown[];
}

/** A view that records what reaches it, with handles for the test to drive. */
function panel(seen: Seen, hooks: { start?(): Promise<void> } = {}) {
  let slots: PanelSlots | undefined;
  const definition = defineWidget({
    slots: { board, shell: uiShell },
    exports: { view: uiView },
    async start(ctx) {
      await hooks.start?.();
      slots = ctx.slots;
      ctx.slots.board.onBind(() => seen.binds.push("board"));
      ctx.slots.board.onUnbind(() => seen.unbinds.push("board"));
      ctx.slots.shell.onBind(() => seen.binds.push("shell"));
      ctx.slots.board.on("changed", (payload) => void seen.events.push(payload));
      ctx.exports.view.implement({
        mount(el, options) {
          seen.roots.push(el);
          seen.mounts.push(options);
          return () => void seen.unmounts++;
        },
        resize: (size) => void seen.resizes.push(size),
      });
    },
  });
  return {
    definition,
    slots: () => {
      if (!slots) throw new Error("The view hasn't started.");
      return slots;
    },
  };
}

interface Calls {
  calls: { slot: string; method: string; input: unknown }[];
  subscribed: {
    slot: string;
    event: string;
    send(payload: unknown): void;
    end(): void;
    stopped: boolean;
  }[];
  opened: string[];
  signIns: number;
  logs: { level: string; message: string; fields?: Record<string, unknown> }[];
}

function handlers(calls: Calls, call?: FrameHandlers["call"]): FrameHandlers {
  return {
    call:
      call ??
      (async (slot, method, input) => {
        calls.calls.push({ slot, method, input });
        return method === "list" ? { titles: ["one"] } : {};
      }),
    subscribe(slot, event, send, end) {
      const entry = { slot, event, send, end, stopped: false };
      calls.subscribed.push(entry);
      return () => {
        entry.stopped = true;
      };
    },
    shell: {
      openExternal: (url) => void calls.opened.push(url),
      signIn: () => void calls.signIns++,
    },
    log: (level, message, fields) =>
      void calls.logs.push({ level, message, ...(fields ? { fields } : {}) }),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A frame and its host over a real MessageChannel, with a view to load. */
function setup(
  options: {
    definition?: unknown;
    call?: FrameHandlers["call"];
    start?(): Promise<void>;
    /** Holds the bundle's import until it settles. */
    importing?: Promise<void>;
    shell?: Partial<FrameHandlers["shell"]>;
  } = {},
) {
  const seen: Seen = {
    binds: [],
    unbinds: [],
    events: [],
    mounts: [],
    resizes: [],
    unmounts: 0,
    roots: [],
  };
  const view = panel(seen, options);
  const calls: Calls = { calls: [], subscribed: [], opened: [], signIns: 0, logs: [] };
  const channel = new MessageChannel();
  const root = { frameRoot: true };
  const themes: Record<string, string>[] = [];
  const frame = runFrame({
    port: channel.port2 as unknown as PortLike,
    root,
    load: async (src) => {
      await options.importing;
      if (src !== "/frames/sha256-x/panel.js") throw new Error(`no ${src}`);
      return { default: options.definition ?? view.definition };
    },
    theme: (tokens) => void themes.push(tokens),
  });
  const host = new FrameHost(channel.port1 as unknown as PortLike, handlers(calls, options.call));
  const load = (slots: Record<string, boolean> = { board: true }) =>
    host.load({ src: "/frames/sha256-x/panel.js", actorId: "act_board", module: "panel", slots });
  const close = () => {
    host.close();
    frame.close();
  };
  return { seen, view, calls, host, frame, load, root, themes, close };
}

test("a view starts before its slots bind, so onBind runs for each; ui.shell@1 is bound with no binding", async (t) => {
  const s = setup();
  t.after(s.close);
  await s.load({ board: true });
  assert.deepEqual(s.seen.binds.sort(), ["board", "shell"]);
  assert.equal(s.view.slots().board.bound, true);
});

test("a slot notice that comes while start runs waits for it", async (t) => {
  let release = () => {};
  const s = setup({ start: () => new Promise<void>((resolve) => (release = resolve)) });
  t.after(s.close);
  const loaded = s.load({ board: false });
  await tick();
  s.host.slot("board", true);
  await tick();
  assert.deepEqual(s.seen.binds, []);
  release();
  await loaded;
  await tick();
  assert.deepEqual(s.seen.binds.sort(), ["board", "shell"]);
});

test("calls go through the port and come back checked; refusals keep their kind", async (t) => {
  let refuse: Error | undefined;
  const s = setup({
    call: async (_slot, method) => {
      if (refuse) throw refuse;
      return method === "list" ? { titles: ["one"] } : { unexpected: true };
    },
  });
  t.after(s.close);
  await s.load();
  const { board: slot } = s.view.slots();
  assert.deepEqual(await slot.call.list({}), { titles: ["one"] });
  // The view's own runtime checks input before anything crosses the port.
  await assert.rejects(
    slot.call.add({ title: "" }),
    (e: unknown) => e instanceof Refused && e.code === "invalid",
  );
  refuse = new Refused("quota", "Too many cards.");
  await assert.rejects(
    slot.call.list({}),
    (e: unknown) => e instanceof Refused && e.code === "quota",
  );
  refuse = new NotConnected("board");
  await assert.rejects(slot.call.list({}), NotConnected);
  refuse = new OutcomeUnknown("The provider went away.");
  await assert.rejects(slot.call.list({}), OutcomeUnknown);
  refuse = new Error("boom");
  await assert.rejects(
    slot.call.list({}),
    (e: unknown) => e instanceof Refused && e.code === "failed",
  );
});

test("events subscribe once the slot is usable, and come back when its provider does", async (t) => {
  const s = setup();
  t.after(s.close);
  await s.load({ board: true });
  await tick();
  assert.equal(s.calls.subscribed.length, 1);
  const [first] = s.calls.subscribed;
  assert.deepEqual([first?.slot, first?.event], ["board", "changed"]);
  first?.send({ id: "c1" });
  first?.send({ wrong: true });
  await tick();
  assert.deepEqual(s.seen.events, [{ id: "c1" }]);
  // The shell ends it (the provider went away); the interest stays.
  first?.end();
  await tick();
  s.host.slot("board", true);
  await tick();
  assert.equal(s.calls.subscribed.length, 2);
  assert.deepEqual(s.seen.binds.filter((b) => b === "board").length, 2);
});

test("an unbound slot refuses calls and runs onUnbind; bound again, it runs onBind", async (t) => {
  const s = setup();
  t.after(s.close);
  await s.load({ board: true });
  await tick();
  s.host.slot("board", false);
  await tick();
  assert.deepEqual(s.seen.unbinds, ["board"]);
  await assert.rejects(s.view.slots().board.call.list({}), NotConnected);
  s.host.slot("board", true);
  await tick();
  assert.deepEqual(await s.view.slots().board.call.list({}), { titles: ["one"] });
  assert.equal(s.seen.binds.filter((b) => b === "board").length, 2);
});

test("ui.shell@1: https opens, anything else is refused, and signIn reaches the shell", async (t) => {
  const s = setup();
  t.after(s.close);
  await s.load({ board: false });
  const { shell } = s.view.slots();
  await shell.call.openExternal({ url: "https://chatgpt.com/settings/usage" });
  assert.deepEqual(s.calls.opened, ["https://chatgpt.com/settings/usage"]);
  for (const url of [
    "http://example.com/",
    "javascript:alert(1)",
    "not a url",
    "file:///etc/passwd",
  ])
    await assert.rejects(
      shell.call.openExternal({ url }),
      (e: unknown) => e instanceof Refused && e.code === "invalid",
      url,
    );
  assert.equal(s.calls.opened.length, 1);
  await shell.call.signIn({});
  assert.equal(s.calls.signIns, 1);
});

test("mount, resize and unmount reach the view's handle, with the theme set on the frame", async (t) => {
  const s = setup();
  t.after(s.close);
  await s.load();
  const theme = { "--canvas": "rgb(20 20 20)", "--surface": "rgb(35 35 35)" };
  await s.host.mount(theme, { width: 340, height: 200 });
  assert.deepEqual(s.themes, [theme]);
  assert.deepEqual(s.seen.mounts, [{ theme, size: { width: 340, height: 200 } }]);
  assert.equal(s.seen.roots[0], s.root);
  await s.host.resize({ width: 300, height: 180 });
  assert.deepEqual(s.seen.resizes, [{ width: 300, height: 180 }]);
  await assert.rejects(
    s.host.mount(theme, { width: 1, height: 1 }),
    (e: unknown) => e instanceof Refused && e.code === "state",
  );
  await s.host.unmount();
  assert.equal(s.seen.unmounts, 1);
  await assert.rejects(
    s.host.resize({ width: 1, height: 1 }),
    (e: unknown) => e instanceof Refused && e.code === "state",
  );
  // A bad size is the view's runtime refusing it.
  await s.host.mount(theme, { width: 1, height: 1 });
  await assert.rejects(
    s.host.resize({ width: "wide" } as never),
    (e: unknown) => e instanceof Refused && e.code === "invalid",
  );
});

test("a frame loads one view, and only a view module", async (t) => {
  const s = setup();
  t.after(s.close);
  await s.load();
  await assert.rejects(s.load(), (e: unknown) => e instanceof Refused && e.code === "state");
  const actor = setup({ definition: defineActor({ start() {} }) });
  t.after(actor.close);
  await assert.rejects(actor.load(), (e: unknown) => e instanceof Refused && e.code === "invalid");
  const nothing = setup({ definition: { not: "a module" } });
  t.after(nothing.close);
  await assert.rejects(
    nothing.load(),
    (e: unknown) => e instanceof Refused && e.code === "invalid",
  );
});

test("what a view logs or doesn't catch reaches its Actor's log, cut to size", async (t) => {
  const s = setup();
  t.after(s.close);
  await s.load();
  s.frame.failed(new Error("render failed"));
  s.frame.failed("x".repeat(10_000));
  await tick();
  assert.equal(s.calls.logs[0]?.level, "error");
  assert.equal(s.calls.logs[0]?.message, "render failed");
  assert.match(String(s.calls.logs[0]?.fields?.stack), /render failed/);
  assert.equal(s.calls.logs[1]?.message.length, 4096);
});

test("the host drops what doesn't fit and refuses what it can't serve", async (t) => {
  const calls: Calls = { calls: [], subscribed: [], opened: [], signIns: 0, logs: [] };
  const channel = new MessageChannel();
  t.after(() => channel.port1.close());
  new FrameHost(channel.port1 as unknown as PortLike, handlers(calls));
  const replies: unknown[] = [];
  (channel.port2 as unknown as PortLike).onmessage = (event) => void replies.push(event.data);
  for (const message of [
    "hello",
    null,
    { op: "call", id: "1", slot: "board", method: "list" },
    { op: "subscribe", sub: -1, slot: "board", event: "changed" },
    { op: "log", level: "debug", message: "x" },
    { op: "reply", id: 99, result: {} },
    { op: "nope" },
  ])
    channel.port2.postMessage(message);
  channel.port2.postMessage({ op: "call", id: 1, slot: { name: "board" }, method: "list" });
  channel.port2.postMessage({ op: "shell", id: 2, method: "eval", input: {} });
  await tick();
  assert.deepEqual(calls.calls, []);
  assert.deepEqual(calls.subscribed, []);
  assert.deepEqual(calls.logs, []);
  assert.deepEqual(
    replies.map((r) => (r as { id: number; error: { code: string } }).error.code),
    ["invalid", "invalid"],
  );
});

test("closing ends subscriptions and fails what waits", async (t) => {
  const s = setup();
  t.after(() => s.frame.close());
  await s.load();
  await tick();
  const pending = s.host.mount({}, { width: 1, height: 1 });
  s.host.close();
  await assert.rejects(pending, OutcomeUnknown);
  assert.equal(s.calls.subscribed[0]?.stopped, true);
  await assert.rejects(s.host.unmount(), OutcomeUnknown);
});

test("a slot notice that comes while the bundle imports isn't lost", async (t) => {
  let imported = () => {};
  const s = setup({ importing: new Promise<void>((resolve) => (imported = resolve)) });
  t.after(s.close);
  const loaded = s.load({ board: false });
  await tick();
  s.host.slot("board", true);
  await tick();
  imported();
  await loaded;
  await tick();
  assert.equal(s.view.slots().board.bound, true);
  assert.equal(s.seen.binds.filter((b) => b === "board").length, 1);
});

test("an unbind stops the shell's subscription, and a rebind opens one anew", async (t) => {
  const s = setup();
  t.after(s.close);
  await s.load({ board: true });
  await tick();
  s.host.slot("board", false);
  await tick();
  assert.equal(s.calls.subscribed[0]?.stopped, true);
  s.host.slot("board", true);
  await tick();
  assert.deepEqual(
    s.calls.subscribed.map((entry) => entry.stopped),
    [true, false],
  );
});

test("a provider back while subscribed: the old subscription stops before the new one", async (t) => {
  const s = setup();
  t.after(s.close);
  await s.load({ board: true });
  await tick();
  s.host.slot("board", true);
  await tick();
  assert.deepEqual(
    s.calls.subscribed.map((entry) => entry.stopped),
    [true, false],
  );
});

test("a start that throws leaves nothing loaded, so the frame can load again", async (t) => {
  let fail = true;
  const s = setup({
    start: async () => {
      if (fail) throw new Error("start failed");
    },
  });
  t.after(s.close);
  await assert.rejects(s.load(), (e: unknown) => e instanceof Refused && e.code === "failed");
  await assert.rejects(
    s.host.mount({}, { width: 1, height: 1 }),
    (e: unknown) => e instanceof Refused && e.code === "state",
  );
  fail = false;
  await s.load({ board: true });
  await tick();
  assert.equal(s.view.slots().board.bound, true);
});

/** A raw frame, as a hostile view would be: its own end of the host's port. */
function rawFrame(t: test.TestContext, shell: Partial<FrameHandlers["shell"]> = {}) {
  const calls: Calls = { calls: [], subscribed: [], opened: [], signIns: 0, logs: [] };
  const channel = new MessageChannel();
  const base = handlers(calls);
  const host = new FrameHost(channel.port1 as unknown as PortLike, {
    ...base,
    shell: { ...base.shell, ...shell },
  });
  const port = channel.port2 as unknown as PortLike;
  const replies: Record<string, unknown>[] = [];
  port.onmessage = (event) => void replies.push(event.data as Record<string, unknown>);
  t.after(() => host.close());
  return { calls, post: (message: unknown) => port.postMessage(message), replies };
}

test("a frame gets one subscription per slot and event, up to a cap", async (t) => {
  const raw = rawFrame(t);
  for (let sub = 1; sub <= 3; sub++)
    raw.post({ op: "subscribe", sub, slot: "board", event: "changed" });
  for (let sub = 10; sub < 100; sub++)
    raw.post({ op: "subscribe", sub, slot: `s${sub}`, event: "changed" });
  await tick();
  assert.equal(raw.calls.subscribed.filter((entry) => entry.slot === "board").length, 1);
  assert.equal(raw.calls.subscribed.length, 64);
  const ended = raw.replies.filter((reply) => reply.op === "end").map((reply) => reply.sub);
  assert.deepEqual(ended.slice(0, 2), [2, 3]);
  // Unsubscribed, the same slot and event can be subscribed again.
  raw.post({ op: "unsubscribe", sub: 1 });
  raw.post({ op: "subscribe", sub: 200, slot: "board", event: "changed" });
  await tick();
  assert.equal(raw.calls.subscribed[0]?.stopped, true);
  assert.equal(raw.calls.subscribed.at(-1)?.slot, "board");
});

test("a frame's log lines are cut, their fields rebuilt, and a flood dropped", async (t) => {
  const raw = rawFrame(t);
  const fields = JSON.parse(
    '{"__proto__": {"polluted": true}, "big": "' +
      "x".repeat(5000) +
      '", "n": 1, "deep": {"a": [1, 2]}}',
  );
  raw.post({ op: "log", level: "info", message: "hello", fields });
  await tick();
  const [line] = raw.calls.logs;
  assert.equal(Object.getPrototypeOf(line?.fields), Object.prototype);
  assert.equal((line?.fields as Record<string, unknown> | undefined)?.polluted, undefined);
  assert.equal(String(line?.fields?.big).length, 1024);
  assert.deepEqual([line?.fields?.n, line?.fields?.deep], [1, '{"a":[1,2]}']);
  for (let i = 0; i < 200; i++) raw.post({ op: "log", level: "error", message: `line ${i}` });
  await tick();
  assert.equal(raw.calls.logs.length, 51);
  assert.match(String(raw.calls.logs.at(-1)?.message), /logged too much/);
});

test("ui.shell@1 takes one call at a time per method", async (t) => {
  let release = () => {};
  const raw = rawFrame(t, {
    signIn: () => new Promise<void>((resolve) => (release = resolve)),
  });
  raw.post({ op: "shell", id: 1, method: "signIn", input: {} });
  raw.post({ op: "shell", id: 2, method: "signIn", input: {} });
  await tick();
  assert.deepEqual(
    raw.replies.map((reply) => [reply.id, (reply.error as { code?: string })?.code]),
    [[2, "busy"]],
  );
  release();
  await tick();
  raw.post({ op: "shell", id: 3, method: "signIn", input: {} });
  await tick();
  assert.equal(raw.replies.find((reply) => reply.id === 1)?.op, "reply");
  release();
  await tick();
  assert.ok(raw.replies.some((reply) => reply.id === 3 && "result" in reply));
});

test("a frame has 64 calls in flight at most; past it, a call is refused busy", async (t) => {
  const calls: Calls = { calls: [], subscribed: [], opened: [], signIns: 0, logs: [] };
  const release: (() => void)[] = [];
  const channel = new MessageChannel();
  const host = new FrameHost(channel.port1 as unknown as PortLike, {
    ...handlers(calls),
    call: () => new Promise((done) => release.push(() => done({}))),
  });
  t.after(() => host.close());
  const port = channel.port2 as unknown as PortLike;
  const replies: { id: number; error?: { code?: string } }[] = [];
  port.onmessage = (event) => void replies.push(event.data as { id: number });
  for (let id = 1; id <= 66; id++)
    port.postMessage({ op: "call", id, slot: "board", method: "list", input: {} });
  await tick();
  assert.deepEqual(
    replies.map((reply) => [reply.id, reply.error?.code]),
    [
      [65, "busy"],
      [66, "busy"],
    ],
  );
  // One answered, one more fits: it waits, unrefused.
  release.shift()?.();
  await tick();
  port.postMessage({ op: "call", id: 67, slot: "board", method: "list", input: {} });
  await tick();
  assert.deepEqual(replies.at(-1), { op: "reply", id: 1, result: {} });
  assert.equal(
    replies.some((reply) => reply.id === 67),
    false,
  );
  for (const done of release) done();
});
