/** A call on a slot that no export is bound to. */
export class NotConnected extends Error {
  override readonly name = "NotConnected";
  readonly slot: string;
  constructor(slot: string) {
    super(`Slot ${slot} is not connected.`);
    this.slot = slot;
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
