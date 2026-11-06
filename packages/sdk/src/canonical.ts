/**
 * JSON with object keys sorted and no whitespace, so equal values always have the same text; every
 * hash in a package is taken over this form. It follows RFC 8785 (JCS): keys in UTF-16 code-unit
 * order and numbers as JavaScript writes them. Only plain JSON values are accepted: a `Date`, `Map`
 * or other class instance is refused rather than flattened.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${value} has no JSON form.`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
      throw new TypeError(`A ${proto?.constructor?.name ?? "class"} instance has no JSON form.`);
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError(`A ${typeof value} has no JSON form.`);
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * `sha256-<hex>` of bytes or text, the form of every hash in a package, files included. It is
 * plain JavaScript (FIPS 180-4), so the SDK runs and bundles the same in a host, a view and a build.
 */
export function sha256(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(length);
  message.set(bytes);
  message[bytes.length] = 0x80;
  const view = new DataView(message.buffer);
  view.setUint32(length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(length - 4, (bytes.length * 8) >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const t1 =
        ((hh as number) +
          (rotr(e as number, 6) ^ rotr(e as number, 11) ^ rotr(e as number, 25)) +
          (((e as number) & (f as number)) ^ (~(e as number) & (g as number))) +
          (K[i] as number) +
          (w[i] as number)) >>>
        0;
      const t2 =
        ((rotr(a as number, 2) ^ rotr(a as number, 13) ^ rotr(a as number, 22)) +
          (((a as number) & (b as number)) ^
            ((a as number) & (c as number)) ^
            ((b as number) & (c as number)))) >>>
        0;
      hh = g;
      g = f;
      f = e;
      e = ((d as number) + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = ((h[i] as number) + (next[i] as number)) >>> 0;
  }
  return `sha256-${[...h].map((x) => x.toString(16).padStart(8, "0")).join("")}`;
}

/** `sha256-<hex>` of a value's canonical JSON. */
export function hashOf(value: unknown): string {
  return sha256(canonicalJson(value));
}
