/**
 * Marks an SDK error class's prototype with its name. Programs may carry their own copy of the SDK,
 * so `instanceof` on these three classes checks this mark rather than
 * the class, and an error made by one copy is the same error to the other. A subclass is checked
 * as usual.
 */
const BRAND = Symbol.for("@agentorg/sdk/error");
const isBranded = (value: unknown, name: ErrorBody["name"]): boolean =>
  typeof value === "object" && value !== null && (value as { [BRAND]?: unknown })[BRAND] === name;
/** `instanceof` for `asked`: the mark for one of the three classes, the usual check for a subclass. */
const instanceOf = (
  asked: unknown,
  base: unknown,
  name: ErrorBody["name"],
  value: unknown,
): boolean =>
  // The name is given, not read from the class: a bundler may rename a class.
  asked === base
    ? isBranded(value, name)
    : Function.prototype[Symbol.hasInstance].call(asked, value);

/** A call on a slot that no export is bound to. */
export class NotConnected extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    // biome-ignore lint/complexity/noThisInStatic: `this` is the class instanceof was asked about, a subclass included.
    return instanceOf(this, NotConnected, "NotConnected", value);
  }
  override readonly name = "NotConnected";
  /** The slot or export that isn't connected. */
  readonly target: string;
  constructor(target: string) {
    super(`${target} is not connected.`);
    this.target = target;
  }
}

/**
 * Why a call was refused: `invalid` (the caller's input broke the schema; nothing ran),
 * `bad_output` (the provider ran and its reply or event broke the contract; read state before
 * retrying), `unimplemented` (no handler yet), or a policy's own code.
 */
export type RefusedCode = "invalid" | "bad_output" | "unimplemented" | (string & {});

/** A call refused by validation or policy, with a stable code. */
export class Refused extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    // biome-ignore lint/complexity/noThisInStatic: `this` is the class instanceof was asked about, a subclass included.
    return instanceOf(this, Refused, "Refused", value);
  }
  override readonly name = "Refused";
  readonly code: RefusedCode;
  constructor(code: RefusedCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The channel dropped mid-call, so whether it took effect is unknown; read state before retrying. */
export class OutcomeUnknown extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    // biome-ignore lint/complexity/noThisInStatic: `this` is the class instanceof was asked about, a subclass included.
    return instanceOf(this, OutcomeUnknown, "OutcomeUnknown", value);
  }
  override readonly name = "OutcomeUnknown";
  constructor(message = "The connection dropped before the call's outcome was known.") {
    super(message);
  }
}

for (const [error, name] of [
  [NotConnected, "NotConnected"],
  [Refused, "Refused"],
  [OutcomeUnknown, "OutcomeUnknown"],
] as const)
  Object.defineProperty(error.prototype, BRAND, { value: name });

/** An error as it crosses a channel or a frame's port: one of the three names, a message, a code. */
export interface ErrorBody {
  name: "NotConnected" | "Refused" | "OutcomeUnknown";
  message: string;
  code?: string;
}

/** Anything thrown, as an error body: a non-SDK error is the other side failing, code `failed`. */
export function errorBodyOf(error: unknown): ErrorBody {
  if (error instanceof Refused)
    return { name: "Refused", message: error.message, code: error.code };
  if (error instanceof NotConnected) return { name: "NotConnected", message: error.message };
  if (error instanceof OutcomeUnknown) return { name: "OutcomeUnknown", message: error.message };
  return {
    name: "Refused",
    message: error instanceof Error ? error.message : String(error),
    code: "failed",
  };
}

/** An error body as the SDK's error: `NotConnected`, `Refused(code)` or `OutcomeUnknown`. */
export function errorFromBody(body: ErrorBody, target: string): Error {
  if (body.name === "NotConnected") return new NotConnected(target);
  if (body.name === "OutcomeUnknown") return new OutcomeUnknown(body.message);
  return new Refused(body.code ?? "refused", body.message);
}
