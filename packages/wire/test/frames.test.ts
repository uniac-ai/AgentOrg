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
  const frame = encodeFrame({ text: "y".repeat(64 * 1024) });
  const started = performance.now();
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
  assert.equal(((await reader.next()) as { text: string }).text.length, 64 * 1024);
  assert.ok(performance.now() - started < 5_000, `${performance.now() - started} ms`);
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
      event: "changed",
    }),
    { op: "serve", kind: "subscribe", export: "board", caller: "a1", event: "changed" },
  );
  assert.equal(
    parseHeader({ op: "hello", actorId: "a", credential: "c".repeat(2000) }).op,
    "hello",
    "a credential may be long",
  );
  assert.deepEqual(parseHeader({ op: "offer", name: "extra", interface: { id: "x@1" } }), {
    op: "offer",
    name: "extra",
    interface: { id: "x@1" },
  });
  assert.deepEqual(parseHeader({ op: "withdraw", name: "extra" }), {
    op: "withdraw",
    name: "extra",
  });
  for (const bad of [
    null,
    [],
    { op: "fly" },
    { op: "offer", name: "x" },
    { op: "withdraw" },
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
