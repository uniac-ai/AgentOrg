/**
 * The first frame of every stream says what the stream is for. A consumer's streams name its
 * slot; the Hub, mediating, opens streams toward the provider naming its export and the caller.
 *
 * How each stream ends:
 * - `hello`: the Hub answers with one body (`{result}` or `{error}`) and closes; on an error it
 *   closes the channel too. Without `declares` the Actor keeps what it declared before; with it,
 *   `declares` replaces that. The result is `{actorId, bound}`: the Actor's slots bound now.
 * - `slot`: from the Hub, one of the Actor's slots was bound or unbound after its channel's hello
 *   result was taken. The header is the whole message: the Hub closes its side, and the Actor
 *   closes its side once it has read it (an open notice counts against its streams). Applied in
 *   the order the streams arrive, on top of hello's `bound` (buffered until that result is read),
 *   they give each slot's state. A `bound: true` for a slot already bound means its provider came
 *   back after going away: the slot is usable again, and what was subscribed must be again. A
 *   provider going away sends nothing; calls meanwhile are `NotConnected`.
 * - `offer` and `withdraw`: the channel's own Actor offers an export at run time, or withdraws
 *   one it offered; one body (`{result: {}}` or `{error}`) answers, then the stream closes.
 * - `call`: the caller sends one `{input}` body and closes its side; the answer is one `{result}`
 *   or `{error}` body, then the stream closes.
 * - `subscribe`: `{event}` bodies flow until the subscriber resets the stream, or the provider
 *   side closes it (with an `{error}` body first when it was refused).
 * - `open` and `http`: the answering side sends exactly one body first, `{result: {}}` to accept
 *   or `{error}` to refuse; after an accept, raw bytes flow both ways, each side closing its own
 *   direction, and a reset ends both. The provider answers the Hub, and the Hub forwards that
 *   answer. The opener may send bytes before the answer; they wait.
 * Cancelling a reader of a yamux stream resets it.
 */
export type Header =
  /** Admits an external client's channel; its first stream. The Hub validates `declares`. */
  | { op: "hello"; actorId: string; credential: string; declares?: unknown }
  | { op: "call"; slot: string; method: string }
  | { op: "subscribe"; slot: string; event: string }
  /** Raw bytes in the interface's protocol, after the Hub validates `params`. */
  | { op: "open"; slot: string; params: unknown }
  /** HTTP/1.1 bytes. */
  | { op: "http"; slot: string }
  /** Offer an export at run time, as a described interface; it lasts until withdrawn or disconnect. */
  | { op: "offer"; name: string; interface: unknown }
  | { op: "withdraw"; name: string }
  /** From the Hub to an Actor: one of its slots was bound or unbound. */
  | { op: "slot"; name: string; bound: boolean }
  /** From the Hub to a provider: the same four, naming its export and who is calling. */
  | {
      op: "serve";
      kind: "call" | "subscribe" | "open" | "http";
      export: string;
      caller: string;
      method?: string;
      event?: string;
      params?: unknown;
    };

export type WireErrorName = "NotConnected" | "Refused" | "OutcomeUnknown";
/** How a refusal crosses the wire; the SDK maps it to its error classes. */
export interface WireError {
  error: { name: WireErrorName; code?: string; message: string };
}
/** Every frame after a header is exactly one of these. */
export type Body = { input: unknown } | { result: unknown } | { event: unknown } | WireError;

export class HeaderError extends Error {
  override readonly name = "HeaderError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (record: Record<string, unknown>, key: string, max = 256) => {
  const value = record[key];
  if (typeof value !== "string" || !value || value.length > max)
    throw new HeaderError(`The header's ${key} must be a non-empty string of at most ${max}.`);
  return value;
};

/** A header frame checked for its shape: an unknown op or a missing field is refused. */
export function parseHeader(value: unknown): Header {
  if (!isRecord(value)) throw new HeaderError("A stream's first frame must be a header object.");
  switch (value.op) {
    case "hello":
      return {
        op: "hello",
        actorId: text(value, "actorId"),
        credential: text(value, "credential", 4096),
        ...("declares" in value ? { declares: value.declares } : {}),
      };
    case "call":
      return { op: "call", slot: text(value, "slot"), method: text(value, "method") };
    case "subscribe":
      return { op: "subscribe", slot: text(value, "slot"), event: text(value, "event") };
    case "open":
      if (!("params" in value)) throw new HeaderError("An open header needs params.");
      return { op: "open", slot: text(value, "slot"), params: value.params };
    case "http":
      return { op: "http", slot: text(value, "slot") };
    case "offer":
      if (!isRecord(value.interface)) throw new HeaderError("An offer header needs an interface.");
      return { op: "offer", name: text(value, "name"), interface: value.interface };
    case "withdraw":
      return { op: "withdraw", name: text(value, "name") };
    case "slot":
      if (typeof value.bound !== "boolean") throw new HeaderError("A slot header needs bound.");
      return { op: "slot", name: text(value, "name"), bound: value.bound };
    case "serve": {
      const kind = value.kind;
      if (kind !== "call" && kind !== "subscribe" && kind !== "open" && kind !== "http")
        throw new HeaderError("A serve header's kind must be call, subscribe, open or http.");
      if (kind === "open" && !("params" in value))
        throw new HeaderError("An open serve header needs params.");
      return {
        op: "serve",
        kind,
        export: text(value, "export"),
        caller: text(value, "caller"),
        ...(kind === "call" ? { method: text(value, "method") } : {}),
        ...(kind === "subscribe" ? { event: text(value, "event") } : {}),
        ...(kind === "open" ? { params: value.params } : {}),
      };
    }
    default:
      throw new HeaderError(`Unknown op ${JSON.stringify(value.op)}.`);
  }
}

export const input = (value: unknown): Body => ({ input: value });
export const result = (value: unknown): Body => ({ result: value });
export const eventBody = (value: unknown): Body => ({ event: value });
export const wireError = (name: WireErrorName, message: string, code?: string): WireError => ({
  error: { name, message, ...(code === undefined ? {} : { code }) },
});

const NAMES = new Set<WireErrorName>(["NotConnected", "Refused", "OutcomeUnknown"]);

/** A body frame checked for its shape: exactly one of `input`, `result`, `event` or `error`. */
export function parseBody(value: unknown): Body {
  if (!isRecord(value)) throw new HeaderError("A body frame must be an object.");
  const keys = Object.keys(value);
  if (keys.length !== 1) throw new HeaderError("A body frame has exactly one key.");
  const [key] = keys;
  if (key === "input" || key === "result" || key === "event") return value as Body;
  if (key === "error") {
    const error = value.error;
    if (
      isRecord(error) &&
      NAMES.has(error.name as WireErrorName) &&
      typeof error.message === "string" &&
      (error.code === undefined || typeof error.code === "string")
    )
      return value as unknown as WireError;
    throw new HeaderError("An error body needs a known name and a message.");
  }
  throw new HeaderError(`Unknown body ${JSON.stringify(key)}.`);
}
