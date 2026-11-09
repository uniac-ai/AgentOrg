import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeFrame,
  FrameError,
  FrameReader,
  HeaderError,
  MAX_FRAME,
  MAX_UNREAD,
  parseBody,
  parseHeader,
  result,
  type WebSocketLike,
  webSocketChannel,
  wireError,
} from "../src/index.ts";

const streamOf = (...parts: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

test("frames round-trip, split anywhere, and hand over the raw bytes after them", async () => {
  const all = concat(
    encodeFrame({ op: "open", slot: "tty", params: { cols: 80 } }),
    encodeFrame([1, "two"]),
    new Uint8Array([9, 8, 7]),
  );
  for (const cut of [1, 3, 5, 17, all.length - 1]) {
    const reader = new FrameReader(streamOf(all.slice(0, cut), all.slice(cut)));
    assert.deepEqual(await reader.next(), { op: "open", slot: "tty", params: { cols: 80 } });
    assert.deepEqual(await reader.next(), [1, "two"]);
    const rest: number[] = [];
    for await (const part of reader.rest()) rest.push(...part);
    assert.deepEqual(rest, [9, 8, 7]);
    await assert.rejects(reader.next(), /handed over/);
  }
  assert.equal(await new FrameReader(streamOf()).next(), undefined);
});

test("a frame arriving one byte at a time is assembled in linear time", async () => {
  /**
   * The work assembling a frame of `size` characters from one-byte chunks takes, counted rather
   * than timed, so a loaded machine can't change it: each byte a typed array copies, and each
   * element an array operation moves (a shift moves the whole array). Node's own streams use
   * their own copies of these methods, so only the wire's code is counted. What it can't see is a
   * quadratic made without them: copying by spread, `Array.from` or `Buffer.concat`, or a loop
   * that rescans what is queued on each read.
   */
  const work = async (size: number) => {
    const frame = encodeFrame({ text: "y".repeat(size) });
    let moved = 0;
    const array = Array.prototype as unknown as Record<string, unknown>;
    const bytes = Uint8Array.prototype as unknown as Record<string, unknown>;
    type Cost = (self: unknown, args: unknown[], out: unknown) => number;
    const counted: [Record<string, unknown>, string, Cost][] = [
      [array, "shift", (self) => (self as unknown[]).length],
      [array, "splice", (self) => (self as unknown[]).length],
      [array, "slice", (_, __, out) => (out as unknown[]).length],
      [array, "concat", (_, __, out) => (out as unknown[]).length],
      [bytes, "set", (_, args) => (args[0] as ArrayLike<number>).length],
      [bytes, "slice", (_, __, out) => (out as Uint8Array).length],
    ];
    // Restored as they were: Uint8Array's set and slice are inherited, so theirs go again.
    const own = counted.map(([proto, name]) => Object.getOwnPropertyDescriptor(proto, name));
    for (const [proto, name, cost] of counted) {
      const original = proto[name] as (...args: unknown[]) => unknown;
      Object.defineProperty(proto, name, {
        configurable: true,
        writable: true,
        value(this: unknown, ...args: unknown[]) {
          // A shift's or splice's cost is the array before it; a slice's, what it made.
          const before = name === "shift" || name === "splice" ? cost(this, args, undefined) : 0;
          const out = original.apply(this, args);
          moved += before || cost(this, args, out);
          return out;
        },
      });
    }
    try {
      let offset = 0;
      const reader = new FrameReader(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === frame.length) return controller.close();
            controller.enqueue(frame.subarray(offset, offset + 1));
            offset++;
          },
        }),
      );
      assert.equal(((await reader.next()) as { text: string }).text.length, size);
    } finally {
      counted.forEach(([proto, name], i) => {
        const was = own[i];
        if (was) Object.defineProperty(proto, name, was);
        else delete proto[name];
      });
    }
    return moved;
  };
  // Four times the bytes: linear assembly is about four times the work, quadratic about sixteen.
  const small = await work(16 * 1024);
  const large = await work(64 * 1024);
  assert.ok(small >= 16 * 1024, `each byte is copied at least once (${small})`);
  assert.ok(large / small < 8, `16 KiB moved ${small}, 64 KiB moved ${large}`);
  assert.ok(!Object.hasOwn(Uint8Array.prototype, "set"), "the typed arrays are as they were");
});

test("oversized, truncated and malformed frames are refused", async () => {
  assert.throws(() => encodeFrame("x".repeat(MAX_FRAME)), FrameError);
  const length = (n: number) => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n);
    return out;
  };
  const read = (...parts: Uint8Array[]) => new FrameReader(streamOf(...parts)).next();
  await assert.rejects(read(length(MAX_FRAME + 1)), /over 1 MiB/);
  await assert.rejects(read(length(10), new Uint8Array(3)), /ended inside a frame/);
  await assert.rejects(read(new Uint8Array(2)), /inside a frame's length/);
  await assert.rejects(read(length(3), new TextEncoder().encode("{x}")), /isn't UTF-8 JSON/);
  await assert.rejects(read(length(2), new Uint8Array([0xc3, 0x28])), /isn't UTF-8 JSON/);
});

test("fuzz: random bytes give frames or a FrameError, nothing else", async () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let round = 0; round < 500; round++) {
    const input = new Uint8Array(random() % 64).map(() => random() & 255);
    if (round % 2 && input.length >= 4) new DataView(input.buffer).setUint32(0, random() % 40);
    const reader = new FrameReader(streamOf(input));
    try {
      while ((await reader.next()) !== undefined);
    } catch (error) {
      assert.ok(error instanceof FrameError, `round ${round}: ${error}`);
    }
  }
});

test("headers and bodies are checked for their shape", () => {
  assert.deepEqual(parseHeader({ op: "call", slot: "store", method: "get", extra: 1 }), {
    op: "call",
    slot: "store",
    method: "get",
  });
  assert.deepEqual(
    parseHeader({
      op: "serve",
      kind: "subscribe",
      export: "board",
      caller: "a1",
      slot: "board",
      event: "changed",
    }),
    {
      op: "serve",
      kind: "subscribe",
      export: "board",
      caller: "a1",
      slot: "board",
      event: "changed",
    },
  );
  assert.throws(
    () => parseHeader({ op: "serve", kind: "call", export: "e", caller: "c", method: "m" }),
    HeaderError,
    "a serve header names the caller's slot",
  );
  assert.equal("credential" in parseHeader({ op: "hello", actorId: "a" }), false, "on a pipe");
  assert.equal(
    parseHeader({ op: "hello", actorId: "a", credential: "c".repeat(2000) }).op,
    "hello",
    "a credential may be long",
  );
  assert.deepEqual(parseHeader({ op: "hello", actorId: "a", credential: "c", replace: false }), {
    op: "hello",
    actorId: "a",
    credential: "c",
    replace: false,
  });
  assert.equal(
    "replace" in parseHeader({ op: "hello", actorId: "a", credential: "c", replace: true }),
    false,
    "only false changes anything",
  );
  assert.deepEqual(parseHeader({ op: "slot", name: "notes", bound: false }), {
    op: "slot",
    name: "notes",
    bound: false,
  });
  const exposure = {
    interface: { id: "quests@1", kind: "rpc", methods: {}, events: {}, hash: "h" },
    provider: { actor: "act_q", export: "logic.quests" },
  };
  assert.deepEqual(
    parseHeader({ op: "slot", name: "quests_quests", bound: true, exposed: exposure }),
    { op: "slot", name: "quests_quests", bound: true, exposed: exposure },
  );
  for (const bad of [
    null,
    [],
    { op: "fly" },
    { op: "slot", name: "notes" },
    { op: "slot", name: "notes", bound: "yes" },
    // Only a bound slot carries its exposure, and all of it.
    { op: "slot", name: "q", bound: false, exposed: exposure },
    { op: "slot", name: "q", bound: true, exposed: null },
    { op: "slot", name: "q", bound: true, exposed: { provider: exposure.provider } },
    { op: "slot", name: "q", bound: true, exposed: { ...exposure, provider: { actor: "a" } } },
    { op: "call", slot: "s" },
    { op: "call", slot: "", method: "m" },
    { op: "open", slot: "tty" },
    { op: "serve", kind: "x", export: "e", caller: "c" },
    { op: "hello", actorId: "a".repeat(300), credential: "c" },
  ])
    assert.throws(() => parseHeader(bad), HeaderError, JSON.stringify(bad));

  // A result shaped like an error is still a result: every body is wrapped.
  const lookalike = { error: { name: "Refused", message: "it's just data" } };
  assert.deepEqual(parseBody(result(lookalike)), { result: lookalike });
  assert.deepEqual(parseBody(wireError("Refused", "no", "invalid")), {
    error: { name: "Refused", message: "no", code: "invalid" },
  });
  for (const bad of [
    lookalike.error,
    { result: 1, event: 2 },
    { error: { name: "Other", message: "no" } },
    { other: 1 },
  ])
    assert.throws(() => parseBody(bad), HeaderError, JSON.stringify(bad));
});

function fakeSocket(readyState = 1) {
  const listeners: Record<string, ((event: Record<string, unknown>) => void)[]> = {};
  const sent: Uint8Array[] = [];
  const socket = {
    binaryType: "blob",
    readyState,
    bufferedAmount: 0,
    send: (data: Uint8Array) => void sent.push(data),
    close: (code = 1000) => {
      for (const fn of listeners.close ?? []) fn({ code, wasClean: code === 1000 });
    },
    addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => {
      listeners[type] = [...(listeners[type] ?? []), fn];
    },
  };
  const emit = (type: string, event: Record<string, unknown>) => {
    for (const fn of listeners[type] ?? []) fn(event);
  };
  return { socket: socket as WebSocketLike, sent, emit };
}

test("a WebSocket channel carries binary messages and ends with the socket", async () => {
  const { socket, sent, emit } = fakeSocket();
  const channel = await webSocketChannel(socket);
  assert.equal(socket.binaryType, "arraybuffer");
  await channel.writable.getWriter().write(new Uint8Array([1, 2]));
  assert.deepEqual(sent, [new Uint8Array([1, 2])]);
  const reader = channel.readable.getReader();
  emit("message", { data: new Uint8Array([3, 4]).buffer });
  assert.deepEqual((await reader.read()).value, new Uint8Array([3, 4]));
  socket.close(1000);
  assert.equal((await reader.read()).done, true);
  emit("message", { data: new Uint8Array([5]).buffer });
});

test("a WebSocket that closes uncleanly errors the channel, and later messages are ignored", async () => {
  const { socket, emit } = fakeSocket();
  const channel = await webSocketChannel(socket);
  const reader = channel.readable.getReader();
  emit("close", { code: 1006, wasClean: false });
  await assert.rejects(reader.read(), /code 1006/);
  assert.doesNotThrow(() => emit("message", { data: new Uint8Array([1]).buffer }));
  const text = fakeSocket();
  const textChannel = await webSocketChannel(text.socket);
  text.emit("message", { data: "hello" });
  await assert.rejects(textChannel.readable.getReader().read(), /text message/);
  assert.doesNotThrow(() => text.emit("message", { data: new Uint8Array([1]).buffer }));
  await assert.rejects(webSocketChannel(fakeSocket(3).socket), /closing or closed/);
});

test("WebSocket writes wait while the socket's send buffer is full", async () => {
  const { socket, sent } = fakeSocket();
  const channel = await webSocketChannel(socket);
  (socket as { bufferedAmount: number }).bufferedAmount = 2 * 1024 * 1024;
  const write = channel.writable.getWriter().write(new Uint8Array([1]));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sent.length, 0);
  (socket as { bufferedAmount: number }).bufferedAmount = 0;
  await write;
  assert.equal(sent.length, 1);
});

test("a WebSocket channel holds at most MAX_UNREAD bytes unread, then closes with 1009", async () => {
  const { socket, emit } = fakeSocket();
  const closed: unknown[] = [];
  const close = socket.close.bind(socket);
  (socket as { close: (code?: number) => void }).close = (code?: number) => {
    closed.push(code);
    close(code);
  };
  const channel = await webSocketChannel(socket);
  const chunk = new Uint8Array(256 * 1024);
  for (let sent = 0; sent <= MAX_UNREAD; sent += chunk.length)
    emit("message", { data: chunk.slice().buffer });
  assert.deepEqual(closed, [1009]);
  const reader = channel.readable.getReader();
  await assert.rejects(
    (async () => {
      for (;;) if ((await reader.read()).done) return;
    })(),
    /unread/,
  );
  assert.doesNotThrow(() => emit("message", { data: chunk.slice().buffer }));
});
