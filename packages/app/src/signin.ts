import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** How long a sign-in code works. */
const CODE_TTL_MS = 60_000;
/** Codes not yet used; past it, the oldest go, so nothing grows without bound. */
const MAX_CODES = 16;
const SESSIONS_MAX = 256;

const token = () => randomBytes(32).toString("base64url");
/** What is kept of a session: enough to know it again, and nothing that signs anyone in. */
const hashOf = (session: string) => createHash("sha256").update(session).digest("base64url");
const same = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Where the sessions' hashes outlast the app: read once, when first needed, and written at each sign-in. */
export interface KeptSessions {
  /** What was written last; anything that isn't a list is read as none. */
  read(): unknown;
  write(hashes: string[]): void;
}

/**
 * Who may use the gateway: browser tabs with a session, made from a one-time code, and the CLI
 * with the token in the home. A code works once, within 60 s, and travels only in a URL's
 * fragment, which no request carries. A session is a random id of which the gateway holds only a
 * hash. With `kept`, the hashes outlast the app, so a tab is still signed in when the app starts
 * again; a session ends only when `SESSIONS_MAX` newer ones have been given.
 * It is no cookie, which every port on 127.0.0.1 would receive: the shell keeps it in its origin's
 * own storage and says it in its socket's first message.
 */
export class SignIn {
  readonly cliToken = token();
  readonly #codes = new Map<string, number>();
  /** The hash of each session, the oldest first. */
  readonly #sessions = new Set<string>();
  readonly #now: () => number;
  readonly #kept: KeptSessions | undefined;
  #restored = false;

  constructor(options: { now?: () => number; kept?: KeptSessions } = {}) {
    this.#now = options.now ?? Date.now;
    this.#kept = options.kept;
  }

  /** Take back what was kept, the first time a session is given or asked about. */
  #restore() {
    if (this.#restored) return;
    this.#restored = true;
    const read = this.#kept?.read();
    const hashes = Array.isArray(read) ? read : [];
    for (const hash of hashes.slice(-SESSIONS_MAX))
      if (typeof hash === "string") this.#sessions.add(hash);
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
    this.#restore();
    this.#sessions.add(hashOf(session));
    while (this.#sessions.size > SESSIONS_MAX)
      this.#sessions.delete(this.#sessions.values().next().value as string);
    // Kept before it is given: a session the tab holds is one a restart still knows.
    this.#kept?.write([...this.#sessions]);
    return session;
  }

  /** Whether a session is live. */
  isSession(session: unknown): boolean {
    if (typeof session !== "string") return false;
    this.#restore();
    const hash = hashOf(session);
    for (const known of this.#sessions) if (same(known, hash)) return true;
    return false;
  }

  /** Whether an `Authorization` header carries the CLI's token. */
  isCli(authorization: string | undefined): boolean {
    const match = /^Bearer (\S+)$/.exec(authorization ?? "");
    return !!match && same(match[1] as string, this.cliToken);
  }
}
