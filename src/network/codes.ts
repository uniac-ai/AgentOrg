/** The core's listening port by default, and the codes with which it closes a channel. */

export const DEFAULT_CORE_PORT = 8740;

/** A newer channel of the same party replaced this one. */
export const CLOSE_REPLACED = 4000;

/** The party's credential stopped identifying it, as when its actor was closed. */
export const CLOSE_REVOKED = 4001;

/** The core's address for parties: `AGENTORG_URL`, else 127.0.0.1 at `AGENTORG_PORT` or 8740. */
export function coreUrl(): string {
  const port = process.env.AGENTORG_PORT || DEFAULT_CORE_PORT;
  return (process.env.AGENTORG_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
}
