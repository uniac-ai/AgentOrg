import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeFrame,
  FrameReader,
  memoryPair,
  Session,
  YamuxError,
  type YamuxStream,
} from "../src/index.ts";
import { FLAG, FRAME, GO_AWAY, INITIAL_WINDOW } from "../src/yamux.ts";

const bytes = (size: number, seed = 1) => new Uint8Array(size).map((_, i) => (i * 7 + seed) & 255);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readAll(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of readable) parts.push(part);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function echo(stream: YamuxStream) {
  await stream.readable.pipeTo(stream.writable).catch(() => {});
}

function pair(onServerStream: (stream: YamuxStream) => void = echo, maxStreams?: number) {
  const [a, b] = memoryPair();
  const client = new Session(a, { client: true, onStream: (s) => void echo(s) });
  const server = new Session(b, { client: false, onStream: onServerStream, maxStreams });
  return { client, server };
}

/** A raw peer: frames written by hand, frames read back as headers. */
function rawPeer(options: {
  client: boolean;
  onStream?: (s: YamuxStream) => void;
  pingTimeoutMs?: number;
}) {
  const [a, b] = memoryPair();
  const session = new Session(a, {
    client: options.client,
    onStream: options.onStream ?? ((s) => void echo(s)),
    pingTimeoutMs: options.pingTimeoutMs,
  });
  const writer = b.writable.getWriter();
  const reader = b.readable.getReader();
  const frame = (type: number, flags: number, id: number, length: number, body?: Uint8Array) => {
    const out = new Uint8Array(12 + (body?.length ?? 0));
    const view = new DataView(out.buffer);
    view.setUint8(1, type);
    view.setUint16(2, flags);
    view.setUint32(4, id);
    view.setUint32(8, length);
    if (body) out.set(body, 12);
    return writer.write(out);
  };
  let buffer = new Uint8Array(0);
  const header = async () => {
    while (buffer.length < 12) {
      const { value, done } = await reader.read();
      if (done) return undefined;
      const joined = new Uint8Array(buffer.length + value.length);
      joined.set(buffer);
      joined.set(value, buffer.length);
      buffer = joined;
    }
    const view = new DataView(buffer.buffer, buffer.byteOffset, 12);
    const out = {
      type: view.getUint8(1),
      flags: view.getUint16(2),
      id: view.getUint32(4),
      length: view.getUint32(8),
    };
    buffer = buffer.subarray(12 + (out.type === FRAME.data ? out.length : 0));
    return out;
  };
  return { session, frame, header, writer };
}

test("streams opened from either side carry bytes both ways", async () => {
  const { client, server } = pair();
  for (const side of [client, server]) {
    const stream = side.open();
    const writer = stream.writable.getWriter();
    await writer.write(new TextEncoder().encode("hello "));
    await writer.write(new TextEncoder().encode("world"));
    await writer.close();
    assert.equal(new TextDecoder().decode(await readAll(stream.readable)), "hello world");
  }
  assert.ok(Number.isFinite(await client.ping()));
});

test("many concurrent streams keep their own bytes", async () => {
  const { client } = pair();
  await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const stream = client.open();
      const payload = bytes(10_000 + i * 97, i);
      const done = readAll(stream.readable);
      const writer = stream.writable.getWriter();
      await writer.write(payload);
      await writer.close();
      assert.deepEqual(await done, payload);
    }),
  );
});

test("a writer waits for window: it sends no more than the reader has room for", async () => {
  let received: YamuxStream | undefined;
  const { client } = pair((stream) => {
    received = stream;
  });
  const stream = client.open();
  const payload = bytes(INITIAL_WINDOW * 3);
  let written = false;
  const writer = stream.writable.getWriter();
  const write = writer.write(payload).then(() => {
    written = true;
  });
  await sleep(50);
  assert.equal(written, false, "the write waits while the reader takes nothing");
  assert.ok(received);
  const read = readAll(received.readable);
  await write;
  await writer.close();
  assert.deepEqual(await read, payload);
});

test("a half-closed stream still carries the other direction", async () => {
  const { client } = pair(async (stream) => {
    const request = await readAll(stream.readable);
    const writer = stream.writable.getWriter();
    await writer.write(new TextEncoder().encode(`got ${request.length}`));
    await writer.close();
  });
  const stream = client.open();
  const writer = stream.writable.getWriter();
  await writer.write(bytes(1000));
  await writer.close();
  assert.equal(new TextDecoder().decode(await readAll(stream.readable)), "got 1000");
});

test("a reset ends both directions on the other side", async () => {
  let received: YamuxStream | undefined;
  const { client } = pair((stream) => {
    received = stream;
  });
  const stream = client.open();
  await stream.writable.getWriter().write(bytes(10));
  await sleep(10);
  stream.reset();
  assert.ok(received);
  await assert.rejects(readAll(received.readable), (e: YamuxError) => e.code === "reset");
  await assert.rejects(received.writable.getWriter().write(bytes(1)), /reset/);
});

test("a normal close settles closed with nothing; a dropped channel with a reason", async () => {
  const { client, server } = pair(() => {});
  const open = client.open();
  server.close();
  assert.equal(await server.closed, undefined);
  await sleep(10);
  assert.throws(() => client.open(), YamuxError);
  await assert.rejects(readAll(open.readable), YamuxError);

  const [a, b] = memoryPair();
  const dropped = new Session(a, { client: true });
  await b.writable.abort(new Error("gone"));
  assert.equal((await dropped.closed)?.code, "ended");
});

test("incoming streams are reset when nothing takes them, when there are too many, or when the taker throws", async () => {
  const [a, b] = memoryPair();
  const client = new Session(a, { client: true });
  new Session(b, { client: false });
  await assert.rejects(readAll(client.open().readable), /reset/);

  const { client: busy } = pair(() => {}, 2);
  const streams = [busy.open(), busy.open(), busy.open(), busy.open()];
  await sleep(20);
  const outcomes = await Promise.all(
    streams.map((s) =>
      Promise.race([
        readAll(s.readable).then(
          () => "ended",
          () => "reset",
        ),
        sleep(50).then(() => "open"),
      ]),
    ),
  );
  assert.deepEqual(outcomes, ["open", "open", "reset", "reset"]);

  const peer = rawPeer({
    client: true,
    onStream: () => {
      throw new Error("refused");
    },
  });
  await peer.frame(FRAME.windowUpdate, FLAG.syn, 2, 0);
  assert.deepEqual(await peer.header(), {
    type: FRAME.windowUpdate,
    flags: FLAG.ack,
    id: 2,
    length: 0,
  });
  assert.deepEqual(await peer.header(), {
    type: FRAME.windowUpdate,
    flags: FLAG.rst,
    id: 2,
    length: 0,
  });
  const ping = peer.session.ping();
  assert.equal((await peer.header())?.type, FRAME.ping);
  await peer.frame(FRAME.ping, FLAG.ack, 0, 1);
  assert.ok(Number.isFinite(await ping), "the session goes on");
});

test("only streams the other side opened count toward maxStreams", async () => {
  const { client, server } = pair(echo, 1);
  // The server's own streams to the client don't use up the client's one stream.
  const own = [server.open(), server.open()];
  const stream = client.open();
  const writer = stream.writable.getWriter();
  await writer.write(new Uint8Array([7]));
  await writer.close();
  assert.deepEqual([...(await readAll(stream.readable))], [7]);
  for (const s of own) s.reset();
  client.close();
});

test("a reset reaches a writer that is idle: its stream's closed rejects", async () => {
  let held: YamuxStream | undefined;
  const { client } = pair((stream) => {
    held = stream;
  });
  const stream = client.open();
  await stream.writable.getWriter().write(new Uint8Array([1]));
  while (!held) await new Promise((resolve) => setTimeout(resolve, 5));
  const idle = (held as YamuxStream).writable.getWriter();
  stream.reset();
  await assert.rejects(idle.closed, /reset/);
  client.close();
});

test("data that arrived is still read after the channel ends", async () => {
  let received: YamuxStream | undefined;
  const peer = rawPeer({
    client: true,
    onStream: (stream) => {
      received = stream;
    },
  });
  const body = new TextEncoder().encode("hello");
  await peer.frame(FRAME.data, FLAG.syn | FLAG.fin, 2, body.length, body);
  void (async () => {
    while (await peer.header());
  })();
  await peer.writer.close();
  await peer.session.closed;
  await sleep(20);
  assert.ok(received);
  assert.equal(new TextDecoder().decode(await readAll(received.readable)), "hello");
});

test("data past the window, a wrong parity, an unknown type or version is a protocol error", async () => {
  const cases: [string, (p: ReturnType<typeof rawPeer>) => Promise<unknown>][] = [
    [
      "past its window",
      async (p) => {
        await p.frame(FRAME.windowUpdate, FLAG.syn, 2, 0);
        await p.frame(FRAME.data, 0, 2, INITIAL_WINDOW + 1, bytes(INITIAL_WINDOW + 1));
      },
    ],
    ["this side's parity", (p) => p.frame(FRAME.windowUpdate, FLAG.syn, 1, 0)],
    ["Unknown frame type", (p) => p.frame(9, 0, 2, 0)],
    [
      "opened twice",
      async (p) => {
        await p.frame(FRAME.windowUpdate, FLAG.syn, 2, 0);
        await p.frame(FRAME.windowUpdate, FLAG.syn, 2, 0);
      },
    ],
    ["stream 0", (p) => p.frame(FRAME.data, 0, 0, 0)],
  ];
  for (const [message, act] of cases) {
    const peer = rawPeer({ client: true });
    void act(peer).catch(() => {});
    const reason = await peer.session.closed;
    assert.equal(reason?.code, "protocol", message);
    assert.match(String(reason?.message), new RegExp(message), message);
    let sawGoAway = false;
    for (let h = await peer.header(); h; h = await peer.header())
      if (h.type === FRAME.goAway && h.length === GO_AWAY.protocolError) sawGoAway = true;
    assert.ok(sawGoAway, `${message}: the session says why with a go-away`);
  }
});

test("pings are answered with the same opaque value, and an unanswered ping times out", async () => {
  const peer = rawPeer({ client: false, pingTimeoutMs: 100 });
  await peer.frame(FRAME.ping, FLAG.syn, 0, 0xdeadbeef);
  assert.deepEqual(await peer.header(), {
    type: FRAME.ping,
    flags: FLAG.ack,
    id: 0,
    length: 0xdeadbeef,
  });
  await assert.rejects(peer.session.ping(), (e: YamuxError) => e.code === "timeout");
});

test("a peer that floods pings but reads nothing is slowed, not buffered without end", async () => {
  const peer = rawPeer({ client: false });
  const flood = (async () => {
    for (let i = 0; i < 5_000; i++) await peer.frame(FRAME.ping, FLAG.syn, 0, i);
  })();
  const outcome = await Promise.race([flood.then(() => "done"), sleep(300).then(() => "waiting")]);
  assert.equal(outcome, "waiting", "the session stopped reading until its replies drain");
  peer.session.close();
});

test("a peer that floods streams to be refused or reset, reading nothing, is slowed too", async () => {
  for (const flood of ["refused", "reset"] as const) {
    const [peerSide, victimSide] = memoryPair();
    const victim = new Session(victimSide, {
      client: false,
      ...(flood === "reset" ? { onStream: () => {} } : {}),
    });
    const writer = peerSide.writable.getWriter();
    const frame = (flags: number, id: number) => {
      const out = new Uint8Array(12);
      const view = new DataView(out.buffer);
      view.setUint8(1, FRAME.windowUpdate);
      view.setUint16(2, flags);
      view.setUint32(4, id);
      return out;
    };
    const writes = (async () => {
      for (let id = 1; id < 200_000; id += 2) {
        await writer.write(frame(FLAG.syn, id));
        if (flood === "reset") await writer.write(frame(FLAG.rst, id));
      }
    })();
    const outcome = await Promise.race([
      writes.then(() => "all accepted"),
      sleep(300).then(() => "blocked"),
    ]);
    assert.equal(
      outcome,
      "blocked",
      `${flood}: the session stopped reading until its replies drain`,
    );
    victim.close();
  }
});

test("closing doesn't hang on a channel nobody reads", async () => {
  const [a] = memoryPair();
  const session = new Session(a, { client: true });
  const stream = session.open();
  const write = stream.writable.getWriter().write(bytes(INITIAL_WINDOW));
  session.close();
  assert.equal(await session.closed, undefined);
  const settled = await Promise.race([
    write.then(
      () => "written",
      () => "failed",
    ),
    sleep(2_000).then(() => "hung"),
  ]);
  assert.equal(settled, "failed");
});

test("after the other side goes away, the session ends when its last stream finishes", async () => {
  let received: YamuxStream | undefined;
  const peer = rawPeer({
    client: true,
    onStream: (stream) => {
      received = stream;
    },
  });
  void (async () => {
    while (await peer.header());
  })();
  await peer.frame(FRAME.windowUpdate, FLAG.syn, 2, 0);
  await peer.frame(FRAME.goAway, 0, 0, GO_AWAY.normal);
  await peer.frame(FRAME.windowUpdate, FLAG.fin, 2, 0);
  await sleep(10);
  assert.ok(received);
  await readAll(received.readable);
  await received.writable.close();
  const reason = await Promise.race([
    peer.session.closed,
    sleep(1_000).then(() => "hung" as const),
  ]);
  assert.equal(reason, undefined);
});

test("a header frame then raw bytes splice between two sessions, as the Hub will", async () => {
  // consumer ⇄ hub (two sessions) ⇄ provider
  const [c1, h1] = memoryPair();
  const [h2, p2] = memoryPair();
  const consumer = new Session(c1, { client: true });
  const header = { op: "serve", kind: "open", export: "tty", caller: "c", params: {} };
  new Session(p2, {
    client: false,
    onStream: async (stream) => {
      const reader = new FrameReader(stream.readable);
      assert.deepEqual(await reader.next(), header);
      await reader.rest().pipeTo(stream.writable);
    },
  });
  const upstream = new Session(h2, { client: true });
  new Session(h1, {
    client: false,
    onStream: async (stream) => {
      const reader = new FrameReader(stream.readable);
      await reader.next();
      const toProvider = upstream.open();
      const writer = toProvider.writable.getWriter();
      await writer.write(encodeFrame(header));
      writer.releaseLock();
      void reader
        .rest()
        .pipeTo(toProvider.writable)
        .catch(() => {});
      void toProvider.readable.pipeTo(stream.writable).catch(() => {});
    },
  });
  const stream = consumer.open();
  const writer = stream.writable.getWriter();
  await writer.write(encodeFrame({ op: "open", slot: "tty", params: {} }));
  const big = bytes(300_000, 5);
  const back = readAll(stream.readable);
  await writer.write(big);
  await writer.close();
  assert.deepEqual(await back, big, "bytes and the end both pass through");
});

test("a frame larger than a yamux data frame reads whole off a stream", async () => {
  const { client } = pair();
  const stream = client.open();
  const value = { text: "x".repeat(200_000) };
  const reader = new FrameReader(stream.readable);
  const writer = stream.writable.getWriter();
  await writer.write(encodeFrame(value));
  await writer.close();
  assert.deepEqual(await reader.next(), value);
});

test("fuzz: random and malformed input ends the session cleanly, never hangs or throws", async () => {
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let round = 0; round < 300; round++) {
    const [a, b] = memoryPair();
    const session = new Session(a, { client: round % 2 === 0, onStream: (s) => void echo(s) });
    const writer = b.writable.getWriter();
    void (async () => {
      for await (const _ of b.readable);
    })().catch(() => {});
    const size = random() % 200;
    const input = new Uint8Array(size).map(() => random() & 255);
    // Some rounds start with a well-formed header, so the parser goes past the first check.
    if (round % 3 === 0 && size >= 12) input[0] = 0;
    await writer.write(input).catch(() => {});
    await writer.close().catch(() => {});
    const reason = await Promise.race([session.closed, sleep(2_000).then(() => "hung")]);
    assert.notEqual(reason, "hung", `round ${round}`);
  }
});
