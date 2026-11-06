import { createHash } from "node:crypto";

/**
 * JSON with object keys sorted and no whitespace, so equal values always have the same text.
 * Every hash in a package is taken over this form.
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
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError(`A ${typeof value} has no JSON form.`);
}

/** `sha256-<hex>` of bytes or text. */
export function sha256(data: string | Uint8Array): string {
  return `sha256-${createHash("sha256").update(data).digest("hex")}`;
}

/** `sha256-<hex>` of a value's canonical JSON. */
export function hashOf(value: unknown): string {
  return sha256(canonicalJson(value));
}
