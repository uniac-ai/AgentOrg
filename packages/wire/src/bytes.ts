/** Bytes arriving in chunks, taken in exact sizes; each byte is copied once, however small the chunks. */
export class ByteQueue {
  #chunks: Uint8Array[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(chunk: Uint8Array): void {
    if (!chunk.length) return;
    this.#chunks.push(chunk);
    this.#length += chunk.length;
  }

  /** The first `size` bytes, removed; the caller checks `length` first. */
  take(size: number): Uint8Array {
    const out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const chunk = this.#chunks[0] as Uint8Array;
      const part = Math.min(chunk.length, size - filled);
      out.set(chunk.subarray(0, part), filled);
      filled += part;
      if (part === chunk.length) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(part);
    }
    this.#length -= size;
    return out;
  }

  /** Everything left, removed. */
  drain(): Uint8Array {
    return this.take(this.#length);
  }
}
