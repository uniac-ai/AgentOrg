/** A call on a slot that no export is bound to, or on an export that was withdrawn. */
export class NotConnected extends Error {
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
  override readonly name = "Refused";
  readonly code: RefusedCode;
  constructor(code: RefusedCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The channel dropped mid-call, so whether it took effect is unknown; read state before retrying. */
export class OutcomeUnknown extends Error {
  override readonly name = "OutcomeUnknown";
  constructor(message = "The connection dropped before the call's outcome was known.") {
    super(message);
  }
}
