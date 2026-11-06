import type { Duplex } from "./yamux.js";

/** Two byte channels joined back to back, for tests and in-process peers. */
export function memoryPair(): [Duplex, Duplex] {
  const a = new TransformStream<Uint8Array, Uint8Array>();
  const b = new TransformStream<Uint8Array, Uint8Array>();
  return [
    { readable: a.readable, writable: b.writable },
    { readable: b.readable, writable: a.writable },
  ];
}

/** The parts of the standard WebSocket API a channel needs; browsers, Node and `ws` all have them. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  /** Bytes queued to send; writes wait while it is high. */
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: { data?: unknown; code?: number; wasClean?: boolean }) => void,
  ): void;
}

const CONNECTING = 0;
const OPEN = 1;
/** Writes wait while this much is queued on the socket. */
const HIGH_WATER = 1024 * 1024;
/**
 * The most received bytes a channel holds unread. A WebSocket can't pause reading, so past this
 * the socket is closed with 1009 rather than buffered: a session moves legitimate data into stream
 * buffers its windows bound, so only a peer flooding a session that has stopped reading gets here.
 */
export const MAX_UNREAD = 4 * 1024 * 1024;

/**
 * A byte channel over a WebSocket, one binary message per write. It resolves once the socket is
 * open. The readable ends when the socket closes cleanly with code 1000, and errors on any other
 * close; closing the writable closes the socket.
 */
export function webSocketChannel(socket: WebSocketLike): Promise<Duplex> {
  if (socket.readyState !== CONNECTING && socket.readyState !== OPEN)
    return Promise.reject(new Error("The WebSocket is closing or closed."));
  socket.binaryType = "arraybuffer";
  let push!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  // A listener must never throw: under `ws` that would be an uncaught exception.
  const finish = (error?: Error) => {
    if (ended) return;
    ended = true;
    try {
      if (error) push.error(error);
      else push.close();
    } catch {
      // The reader is already gone.
    }
  };
  const readable = new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        push = controller;
      },
      cancel: () => {
        ended = true;
        socket.close(1000);
      },
    },
    { highWaterMark: MAX_UNREAD, size: (chunk) => chunk.byteLength },
  );
  const deliver = (chunk: Uint8Array) => {
    push.enqueue(chunk);
    if ((push.desiredSize ?? 0) < 0) {
      finish(new Error(`Over ${MAX_UNREAD} bytes arrived unread.`));
      socket.close(1009, "too much unread");
    }
  };
  socket.addEventListener("message", (event) => {
    if (ended) return;
    const data = event.data;
    try {
      if (data instanceof ArrayBuffer) deliver(new Uint8Array(data));
      else if (ArrayBuffer.isView(data))
        deliver(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      else {
        finish(new Error("A text message on a binary channel."));
        socket.close(1003, "binary only");
      }
    } catch {
      ended = true;
    }
  });
  socket.addEventListener("close", (event) => {
    if (event.code === 1000 || (event.code === undefined && event.wasClean !== false)) finish();
    else finish(new Error(`The WebSocket closed with code ${event.code}.`));
  });
  const writable = new WritableStream<Uint8Array>({
    write: async (chunk) => {
      while (socket.readyState === OPEN && socket.bufferedAmount > HIGH_WATER)
        await new Promise((resolve) => setTimeout(resolve, 5));
      if (socket.readyState !== OPEN) throw new Error("The WebSocket isn't open.");
      socket.send(chunk);
    },
    close: () => socket.close(1000),
    abort: () => socket.close(1011),
  });
  const channel = { readable, writable };
  if (socket.readyState === OPEN) return Promise.resolve(channel);
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(channel));
    socket.addEventListener("error", () => reject(new Error("The WebSocket failed to open.")));
    socket.addEventListener("close", () =>
      reject(new Error("The WebSocket closed before opening.")),
    );
  });
}
