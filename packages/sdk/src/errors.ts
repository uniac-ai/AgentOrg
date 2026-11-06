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

/** A call refused by validation or policy, with a stable code. */
export class Refused extends Error {
  override readonly name = "Refused";
  readonly code: string;
  constructor(code: string, message: string) {
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
