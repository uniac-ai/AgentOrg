// Interop with an independent yamux: @chainsafe/libp2p-yamux, over a real byte pipe, both ways.
import assert from "node:assert/strict";
import test from "node:test";
import { yamux } from "@chainsafe/libp2p-yamux";
import { multiaddrConnectionPair } from "@libp2p/utils";
import { type Duplex, Session, type YamuxStream } from "../src/index.ts";

type Libp2pStream = {
  send(data: Uint8Array): boolean;
  onDrain(): Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array | { subarray(): Uint8Array }>;
};

const chunk = (value: Uint8Array | { subarray(): Uint8Array }) =>
  value instanceof Uint8Array ? value : value.subarray();

/** One end of libp2p's connection pair as our byte channel. */
function asDuplex(conn: Libp2pStream): Duplex {
  const iterator = conn[Symbol.asyncIterator]();
  return {
    readable: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(chunk(value));
      },
    }),
    writable: new WritableStream<Uint8Array>({
      async write(data) {
        if (!conn.send(data)) await conn.onDrain();
      },
      close: () => conn.close(),
    }),
  };
}

async function readAll(source: AsyncIterable<Uint8Array | { subarray(): Uint8Array }>) {
  const parts: Uint8Array[] = [];
  for await (const part of source) parts.push(chunk(part));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
const bytes = (size: number, seed = 3) => new Uint8Array(size).map((_, i) => (i * 13 + seed) & 255);

async function libp2pEcho(stream: Libp2pStream) {
  for await (const part of stream) if (!stream.send(chunk(part))) await stream.onDrain();
  await stream.close();
}
async function ourEcho(stream: YamuxStream) {
  await stream.readable.pipeTo(stream.writable).catch(() => {});
}

/** Our session on one end, libp2p's muxer on the other; `ours` says which side dialed. */
function bridge(ours: "client" | "server") {
  // libp2p's muxer takes its side from its connection's direction: outbound dials.
  const [outbound, inbound] = multiaddrConnectionPair();
  const [mine, theirs] = ours === "client" ? [outbound, inbound] : [inbound, outbound];
  const muxer = yamux()().createStreamMuxer(theirs as never) as unknown as {
    createStream(): Promise<Libp2pStream>;
    addEventListener(type: "stream", fn: (event: { detail: Libp2pStream }) => void): void;
    close(): Promise<void>;
  };
  muxer.addEventListener("stream", (event) => void libp2pEcho(event.detail));
  const session = new Session(asDuplex(mine as unknown as Libp2pStream), {
    client: ours === "client",
    onStream: (stream) => void ourEcho(stream),
  });
  return { muxer, session };
}

for (const ours of ["client", "server"] as const)
  test(`our yamux and libp2p's interoperate with ours as the ${ours}`, {
    timeout: 60_000,
  }, async () => {
    const { muxer, session } = bridge(ours);

    // We open; libp2p echoes. Many streams at once, and one transfer far past the window.
    await Promise.all(
      [
        ...Array.from({ length: 40 }, (_, i) => bytes(5_000 + i * 131, i)),
        bytes(4 * 1024 * 1024),
      ].map(async (payload) => {
        const stream = await session.open();
        const read = readAll(stream.readable as unknown as AsyncIterable<Uint8Array>);
        const writer = stream.writable.getWriter();
        await writer.write(payload);
        await writer.close();
        assert.deepEqual(await read, payload);
      }),
    );

    // libp2p opens; we echo, including a large transfer it has to send within our window.
    await Promise.all(
      [bytes(1_000, 9), bytes(3 * 1024 * 1024, 11)].map(async (payload) => {
        const stream = await muxer.createStream();
        const read = readAll(stream);
        for (let offset = 0; offset < payload.length; offset += 64 * 1024)
          if (!stream.send(payload.subarray(offset, offset + 64 * 1024))) await stream.onDrain();
        await stream.close();
        assert.deepEqual(await read, payload);
      }),
    );

    // Half-close: our side finishes writing, then still reads libp2p's whole reply.
    const stream = await session.open();
    const writer = stream.writable.getWriter();
    await writer.write(new TextEncoder().encode("ping"));
    await writer.close();
    assert.equal(
      new TextDecoder().decode(
        await readAll(stream.readable as unknown as AsyncIterable<Uint8Array>),
      ),
      "ping",
    );
    assert.ok(Number.isFinite(await session.ping()));
    // Whichever side goes away first, the other's session ends.
    if (ours === "client") {
      session.close();
      await muxer.close().catch(() => {});
    } else {
      await muxer.close().catch(() => {});
      const ended = await Promise.race([
        session.closed.then(() => "ended"),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 5_000)),
      ]);
      assert.equal(ended, "ended");
    }
  });
