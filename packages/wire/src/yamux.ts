/**
 * yamux, as HashiCorp's spec defines it (github.com/hashicorp/yamux/blob/master/spec.md): many
 * streams over one byte channel. Each frame is a 12-byte header (version, type, flags, stream
 * id, length, big-endian), then for data frames that many bytes. Each stream has a receive
 * window, 256 KiB to start; a sender never sends more than the window it was given, and a
 * receiver gives more back only as its reader consumes. That is the backpressure.
 */
import { ByteQueue } from "./bytes.js";

/** A byte stream both ways: what every transport and stream is. */
export interface Duplex {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

const VERSION = 0;
const HEADER = 12;
export const FRAME = { data: 0, windowUpdate: 1, ping: 2, goAway: 3 } as const;
export const FLAG = { syn: 1, ack: 2, fin: 4, rst: 8 } as const;
export const GO_AWAY = { normal: 0, protocolError: 1, internalError: 2 } as const;
/** The window every stream starts with, by the spec. */
export const INITIAL_WINDOW = 256 * 1024;
/** The largest data frame this side sends. */
const MAX_DATA = 64 * 1024;
/**
 * Replies queued before the read loop waits for them. Every frame the read loop makes this side
 * send is a reply: a ping's ack, a stream's ack, the reset of a refused stream. A peer that
 * provokes them and reads nothing is slowed rather than buffered.
 */
const MAX_REPLIES = 64;
/** How long a close waits for queued frames before giving up on the channel. */
const CLOSE_GRACE_MS = 1_000;

/**
 * Why a stream or session failed: `reset` (a stream was reset by either side), `ended` (the
 * session ended, normally or because its channel dropped), `protocol` (a peer broke the spec) or
 * `timeout` (a ping went unanswered).
 */
export class YamuxError extends Error {
  override readonly name = "YamuxError";
  readonly code: "reset" | "ended" | "protocol" | "timeout";
  constructor(code: YamuxError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface SessionOptions {
  /** The side that dialed: its stream ids are odd, the other side's even. */
  client: boolean;
  /** Each stream the other side opens. Without it, they're reset; if it throws, that stream is. */
  onStream?(stream: YamuxStream): void;
  /**
   * Most streams the other side may have open at once; more are reset. Streams this side opens
   * don't count. It is read as each stream
   * arrives, so the owner of this object may change it, as the Hub does once a channel is admitted.
   */
  maxStreams?: number;
  /** How long a ping waits for its answer. */
  pingTimeoutMs?: number;
}

export interface YamuxStream extends Duplex {
  readonly id: number;
  /** Abort both directions at once; the other side sees a reset. */
  reset(): void;
}

function encode(type: number, flags: number, id: number, length: number, body?: Uint8Array) {
  const frame = new Uint8Array(HEADER + (body?.length ?? 0));
  const view = new DataView(frame.buffer);
  view.setUint8(0, VERSION);
  view.setUint8(1, type);
  view.setUint16(2, flags);
  view.setUint32(4, id);
  view.setUint32(8, length);
  if (body) frame.set(body, HEADER);
  return frame;
}

interface StreamState {
  id: number;
  /** What this side may still send before a window update. */
  sendWindow: number;
  /** What the other side may still send. */
  recvWindow: number;
  /** Bytes the reader has taken since the last window update. */
  consumed: number;
  incoming: Uint8Array[];
  remoteClosed: boolean;
  localClosed: boolean;
  /** Set when the stream can't go on; buffered data is still read first unless it was reset. */
  failed?: YamuxError;
  /** Wakes a reader waiting for data, or a writer waiting for window. */
  wake(): void;
  /** Errors the writable, so a writer that is idle still learns of a reset. */
  failWrites?(error: YamuxError): void;
  stream: YamuxStream;
}

/** One yamux session over a byte channel. */
export class Session {
  readonly #options: SessionOptions;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #streams = new Map<number, StreamState>();
  readonly #pings = new Map<number, { resolve(at: number): void; reject(e: Error): void }>();
  #nextId: number;
  #nextPing = 1;
  /** Streams the other side opened that are still open; only these count toward maxStreams. */
  #opened = 0;
  #remoteGoAway = false;
  #ended?: YamuxError;
  #replies = 0;
  #lastReply: Promise<void> = Promise.resolve();
  #writeChain: Promise<void> = Promise.resolve();
  /** Settles when the session ends: `undefined` for a normal close, else the reason. */
  readonly closed: Promise<YamuxError | undefined>;
  #settle!: (reason: YamuxError | undefined) => void;

  constructor(channel: Duplex, options: SessionOptions) {
    this.#options = options;
    this.#nextId = options.client ? 1 : 2;
    this.#writer = channel.writable.getWriter();
    this.#reader = channel.readable.getReader();
    this.closed = new Promise((settle) => {
      this.#settle = settle;
    });
    void this.#readLoop();
  }

  /** Open a stream to the other side. Data may follow at once; the other side may still reset it. */
  open(): YamuxStream {
    if (this.#ended) throw new YamuxError("ended", "The session has ended.");
    if (this.#remoteGoAway) throw new YamuxError("ended", "The other side is going away.");
    if (this.#nextId > 0xffffffff) throw new YamuxError("ended", "Stream ids are exhausted.");
    const id = this.#nextId;
    this.#nextId += 2;
    const state = this.#create(id);
    void this.#send(encode(FRAME.windowUpdate, FLAG.syn, id, 0)).catch(() => {});
    return state.stream;
  }

  /** Round trip to the other side, in milliseconds. */
  ping(): Promise<number> {
    if (this.#ended) return Promise.reject(this.#ended);
    const opaque = this.#nextPing++ >>> 0;
    const start = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pings.delete(opaque);
        reject(new YamuxError("timeout", "The ping went unanswered."));
      }, this.#options.pingTimeoutMs ?? 30_000);
      this.#pings.set(opaque, {
        resolve: (at) => {
          clearTimeout(timer);
          resolve(at - start);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#send(encode(FRAME.ping, FLAG.syn, 0, opaque)).catch(() => {});
    });
  }

  /** Tell the other side no more streams will be accepted, and end the session. */
  close(code: number = GO_AWAY.normal): void {
    if (this.#ended) return;
    void this.#send(encode(FRAME.goAway, 0, 0, code)).catch(() => {});
    this.#end(
      code === GO_AWAY.normal ? undefined : new YamuxError("ended", `Went away with code ${code}.`),
    );
  }

  /** Queue a frame. Frames queued before the session ends are still written, then the channel closes. */
  #send(frame: Uint8Array): Promise<void> {
    if (this.#ended) return Promise.reject(this.#ended);
    const next = this.#writeChain.then(() => this.#writer.write(frame));
    this.#writeChain = next.catch(() => {});
    return next;
  }

  #create(id: number): StreamState {
    let wake: (() => void) | undefined;
    let waiting: Promise<void> | undefined;
    const wait = () => {
      waiting ??= new Promise<void>((resolve) => {
        wake = () => {
          waiting = undefined;
          wake = undefined;
          resolve();
        };
      });
      return waiting;
    };
    const state = {
      id,
      sendWindow: INITIAL_WINDOW,
      recvWindow: INITIAL_WINDOW,
      consumed: 0,
      incoming: [] as Uint8Array[],
      remoteClosed: false,
      localClosed: false,
      wake: () => wake?.(),
    } as StreamState;
    const readable = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          for (;;) {
            const chunk = state.incoming.shift();
            if (chunk) {
              controller.enqueue(chunk);
              this.#consumed(state, chunk.length);
              return;
            }
            if (state.remoteClosed) {
              controller.close();
              this.#settled(state);
              return;
            }
            if (state.failed) {
              controller.error(state.failed);
              return;
            }
            await wait();
          }
        },
        cancel: () => this.#reset(state),
      },
      { highWaterMark: 0 },
    );
    const writable = new WritableStream<Uint8Array>({
      start: (controller) => {
        state.failWrites = (error) => controller.error(error);
      },
      write: async (chunk) => {
        let offset = 0;
        while (offset < chunk.length) {
          if (state.failed) throw state.failed;
          if (state.sendWindow === 0) {
            await wait();
            continue;
          }
          const size = Math.min(state.sendWindow, MAX_DATA, chunk.length - offset);
          state.sendWindow -= size;
          const body = chunk.subarray(offset, offset + size);
          offset += size;
          await this.#send(encode(FRAME.data, 0, state.id, size, body));
        }
      },
      close: async () => {
        if (state.failed) throw state.failed;
        state.localClosed = true;
        await this.#send(encode(FRAME.windowUpdate, FLAG.fin, state.id, 0));
        this.#settled(state);
      },
      abort: () => this.#reset(state),
    });
    state.stream = { id, readable, writable, reset: () => this.#reset(state) };
    this.#streams.set(id, state);
    return state;
  }

  /** The reader took `size` bytes: give the window back once half of it is used. */
  #consumed(state: StreamState, size: number) {
    state.consumed += size;
    if (state.consumed >= INITIAL_WINDOW / 2 && !state.remoteClosed && !state.failed) {
      const delta = state.consumed;
      state.consumed = 0;
      state.recvWindow += delta;
      void this.#send(encode(FRAME.windowUpdate, 0, state.id, delta)).catch(() => {});
    }
  }

  #forget(state: StreamState) {
    if (this.#streams.get(state.id) === state) {
      this.#streams.delete(state.id);
      if (this.#theirs(state.id)) this.#opened--;
    }
    if (this.#remoteGoAway && !this.#streams.size) this.#end(undefined);
  }

  /** Forget a stream once both sides have finished it. */
  #settled(state: StreamState) {
    if (state.localClosed && state.remoteClosed && !state.incoming.length) this.#forget(state);
  }

  /** The stream can't go on. A reset drops what arrived; otherwise it can still be read. */
  #fail(state: StreamState, error: YamuxError, discard: boolean) {
    state.failed ??= error;
    if (discard) state.incoming.length = 0;
    state.wake();
    // A reset ends writing at once; an ended session leaves a pending write to fail on its own,
    // so a splice still delivers what was read before it.
    if (discard) state.failWrites?.(state.failed);
    this.#forget(state);
  }

  /** Reset a stream; as a reply when the read loop does it, so it counts against the cap. */
  #reset(state: StreamState, reply = false) {
    if (this.#streams.get(state.id) !== state) return;
    const frame = encode(FRAME.windowUpdate, FLAG.rst, state.id, 0);
    if (reply) this.#reply(frame);
    else void this.#send(frame).catch(() => {});
    this.#fail(state, new YamuxError("reset", "The stream was reset."), true);
  }

  #end(reason: YamuxError | undefined) {
    if (this.#ended) return;
    this.#ended = reason ?? new YamuxError("ended", "The session has ended.");
    for (const state of [...this.#streams.values()]) this.#fail(state, this.#ended, false);
    for (const ping of this.#pings.values()) ping.reject(this.#ended);
    this.#pings.clear();
    // Frames already queued go out first, but a channel nobody reads can't hold the close up.
    const ended = this.#ended;
    const abort = setTimeout(() => void this.#writer.abort(ended).catch(() => {}), CLOSE_GRACE_MS);
    (abort as { unref?: () => void }).unref?.();
    void this.#writeChain
      .then(() => {
        clearTimeout(abort);
        return this.#writer.close();
      })
      .catch(() => {});
    // Stop reading too, so a peer still writing sees the channel end rather than waiting on it.
    void this.#reader.cancel().catch(() => {});
    this.#settle(reason);
  }

  /** A frame the read loop sends in reply, counted until written. */
  #reply(frame: Uint8Array) {
    this.#replies++;
    this.#lastReply = this.#send(frame)
      .catch(() => {})
      .finally(() => {
        this.#replies--;
      });
  }

  #protocolError(message: string) {
    void this.#send(encode(FRAME.goAway, 0, 0, GO_AWAY.protocolError)).catch(() => {});
    this.#end(new YamuxError("protocol", message));
  }

  async #readLoop() {
    const buffer = new ByteQueue();
    const take = async (size: number): Promise<Uint8Array | undefined> => {
      while (buffer.length < size) {
        const { value, done } = await this.#reader.read();
        if (done) return undefined;
        buffer.push(value);
      }
      return buffer.take(size);
    };
    try {
      while (!this.#ended) {
        // A peer that keeps us replying while it reads nothing waits for its replies to drain.
        if (this.#replies > MAX_REPLIES) await this.#lastReply;
        const header = await take(HEADER);
        if (this.#ended) return;
        if (!header) return this.#end(new YamuxError("ended", "The channel ended."));
        const view = new DataView(header.buffer, header.byteOffset, HEADER);
        const version = view.getUint8(0);
        const type = view.getUint8(1);
        const flags = view.getUint16(2);
        const id = view.getUint32(4);
        const length = view.getUint32(8);
        if (version !== VERSION) return this.#protocolError(`Unknown yamux version ${version}.`);
        if (type === FRAME.ping) {
          if (flags & FLAG.syn) this.#reply(encode(FRAME.ping, FLAG.ack, 0, length));
          else if (flags & FLAG.ack) {
            this.#pings.get(length)?.resolve(performance.now());
            this.#pings.delete(length);
          }
          continue;
        }
        if (type === FRAME.goAway) {
          this.#remoteGoAway = true;
          if (length !== GO_AWAY.normal)
            return this.#end(
              new YamuxError("ended", `The other side went away with code ${length}.`),
            );
          if (!this.#streams.size) return this.#end(undefined);
          continue;
        }
        if (type !== FRAME.data && type !== FRAME.windowUpdate)
          return this.#protocolError(`Unknown frame type ${type}.`);
        if (id === 0) return this.#protocolError("A stream frame on stream 0.");
        let state = this.#streams.get(id);
        if (flags & FLAG.syn) {
          if (state) return this.#protocolError(`Stream ${id} was opened twice.`);
          if ((id % 2 === 1) === this.#options.client)
            return this.#protocolError(`Stream ${id} has this side's parity.`);
          state = this.#accept(id);
        }
        if (type === FRAME.data) {
          if (length > (state?.recvWindow ?? INITIAL_WINDOW))
            return this.#protocolError(`Stream ${id} sent past its window.`);
          const body = await take(length);
          if (this.#ended) return;
          if (!body) return this.#end(new YamuxError("ended", "The channel ended mid-frame."));
          if (state && !state.failed && !state.remoteClosed) {
            state.recvWindow -= length;
            if (length) state.incoming.push(body);
          }
        } else if (state) state.sendWindow += length;
        if (!state) continue;
        if (flags & FLAG.rst)
          this.#fail(state, new YamuxError("reset", "The other side reset the stream."), true);
        else if (flags & FLAG.fin) {
          state.remoteClosed = true;
          this.#settled(state);
        }
        state.wake();
      }
    } catch (error) {
      if (this.#ended) return;
      this.#end(
        error instanceof YamuxError
          ? error
          : new YamuxError("ended", error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /** Whether the other side opened this stream: its ids have the other parity. */
  #theirs(id: number) {
    return id % 2 === (this.#options.client ? 0 : 1);
  }

  /** A stream the other side opened: acknowledged and handed over, or reset. */
  #accept(id: number): StreamState | undefined {
    const full = this.#opened >= (this.#options.maxStreams ?? 1024);
    const state = this.#create(id);
    this.#opened++;
    if (!this.#options.onStream || full || this.#remoteGoAway) {
      this.#reset(state, true);
      return undefined;
    }
    this.#reply(encode(FRAME.windowUpdate, FLAG.ack, id, 0));
    try {
      this.#options.onStream(state.stream);
    } catch {
      this.#reset(state, true);
      return undefined;
    }
    return state;
  }
}
