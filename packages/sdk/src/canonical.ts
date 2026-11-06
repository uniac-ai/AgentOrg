import { createHash } from "node:crypto";

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

/** `sha256-<hex>` of bytes or text, the form of every hash in a package, files included. */
export function sha256(data: string | Uint8Array): string {
  return `sha256-${createHash("sha256").update(data).digest("hex")}`;
}

/** `sha256-<hex>` of a value's canonical JSON. */
export function hashOf(value: unknown): string {
  return sha256(canonicalJson(value));
}
