import { ByteQueue } from "./bytes.js";

/** The largest JSON frame: 1 MiB. */
export const MAX_FRAME = 1024 * 1024;

export class FrameError extends Error {
  override readonly name = "FrameError";
}

const encoder = new TextEncoder();

/** A frame: a 4-byte big-endian length, then that many bytes of UTF-8 JSON. */
export function encodeFrame(value: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(value));
  if (body.length > MAX_FRAME)
    throw new FrameError(`A frame of ${body.length} bytes is over 1 MiB.`);
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length);
  frame.set(body, 4);
  return frame;
}

/**
 * Reads frames from a byte stream, and can hand over what follows them untouched.
 */
export class FrameReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #buffer = new ByteQueue();
  #done = false;
  #handedOver = false;

  constructor(readable: ReadableStream<Uint8Array>) {
    this.#reader = readable.getReader();
  }

  async #fill(size: number): Promise<boolean> {
    while (this.#buffer.length < size) {
      if (this.#done) return false;
      const { value, done } = await this.#reader.read();
      if (done) {
        this.#done = true;
        return false;
      }
      this.#buffer.push(value);
    }
    return true;
  }

  /** The next frame's value, or `undefined` when the stream ended cleanly between frames. */
  async next(): Promise<unknown> {
    if (this.#handedOver) throw new FrameError("The rest of the stream was handed over.");
    if (!(await this.#fill(4))) {
      if (this.#buffer.length) throw new FrameError("The stream ended inside a frame's length.");
      return undefined;
    }
    const prefix = this.#buffer.take(4);
    const length = new DataView(prefix.buffer).getUint32(0);
    if (length > MAX_FRAME) throw new FrameError(`A frame of ${length} bytes is over 1 MiB.`);
    if (!(await this.#fill(length))) throw new FrameError("The stream ended inside a frame.");
    const body = this.#buffer.take(length);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new FrameError("A frame isn't UTF-8 JSON.");
    }
  }

  /** The bytes after the frames read so far, as a stream; the reader reads no more frames. */
  rest(): ReadableStream<Uint8Array> {
    this.#handedOver = true;
    let pending: Uint8Array | undefined = this.#buffer.length ? this.#buffer.drain() : undefined;
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          if (pending) {
            controller.enqueue(pending);
            pending = undefined;
            return;
          }
          const { value, done } = await this.#reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel: (reason) => this.#reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
  }

  /** Stop reading. Over a yamux stream that is a reset of both directions. */
  async cancel(reason?: unknown): Promise<void> {
    await this.#reader.cancel(reason);
  }
}
