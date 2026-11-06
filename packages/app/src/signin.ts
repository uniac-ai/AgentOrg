import { randomBytes, timingSafeEqual } from "node:crypto";

/** How long a sign-in code works. */
const CODE_TTL_MS = 60_000;
/** Codes not yet used; past it, the oldest go, so nothing grows without bound. */
const MAX_CODES = 16;
const SESSIONS_MAX = 256;

const token = () => randomBytes(32).toString("base64url");
const same = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Who may use the gateway: browser tabs with a session, made from a one-time code, and the CLI
 * with the token in the home. A code works once, within 60 s, and travels only in a URL's
 * fragment, which no request carries. A session is a random id the gateway holds in memory, so a
 * restart signs every tab out. It is no cookie, which every port on 127.0.0.1 would receive: the
 * shell keeps it in its origin's own storage and says it in its socket's first message.
 */
export class SignIn {
  readonly cliToken = token();
  readonly #codes = new Map<string, number>();
  readonly #sessions = new Set<string>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** A new one-time code, for `/signin#<code>`. */
  code(): string {
    const code = token();
    this.#codes.set(code, this.#now() + CODE_TTL_MS);
    while (this.#codes.size > MAX_CODES)
      this.#codes.delete(this.#codes.keys().next().value as string);
    return code;
  }

  /** Trade a code for a session: once, within its time; anything else is `undefined`. */
  redeem(code: unknown): string | undefined {
    if (typeof code !== "string") return undefined;
    let found: string | undefined;
    for (const known of this.#codes.keys()) if (same(known, code)) found = known;
    if (!found) return undefined;
    const expires = this.#codes.get(found) as number;
    this.#codes.delete(found);
    if (this.#now() > expires) return undefined;
    const session = token();
    this.#sessions.add(session);
    while (this.#sessions.size > SESSIONS_MAX)
      this.#sessions.delete(this.#sessions.values().next().value as string);
    return session;
  }

  /** Whether a session is live. */
  isSession(session: unknown): boolean {
    if (typeof session !== "string") return false;
    for (const known of this.#sessions) if (same(known, session)) return true;
    return false;
  }

  /** Whether an `Authorization` header carries the CLI's token. */
  isCli(authorization: string | undefined): boolean {
    const match = /^Bearer (\S+)$/.exec(authorization ?? "");
    return !!match && same(match[1] as string, this.cliToken);
  }
}
