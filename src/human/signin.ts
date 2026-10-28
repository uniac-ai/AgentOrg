/**
 * Sign-in to the web app. `agentorg ui` asks the human actor for a one-time link, presenting the
 * root credential; opening the link starts a sign-in session, kept in an HttpOnly, SameSite=Strict
 * cookie. Sessions are signed with a key derived from the root credential, so they outlive a
 * restart of the human actor with nothing stored, and a new credential ends them all. Each session
 * has its own CSRF token, which every write carries.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE = "agentorg_human";
export const LINK_MS = 5 * 60_000;
export const SESSION_MS = 7 * 24 * 60 * 60_000;

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Whether two secrets match, in time that does not depend on where they differ. */
export const matches = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export interface Session {
  csrf_token: string;
  expires_at: string;
}

export class SignIn {
  readonly #key: Buffer;
  readonly #links = new Map<string, number>();
  readonly #now: () => number;

  constructor(credential: string, now: () => number = Date.now) {
    this.#key = createHmac("sha256", credential).update("agentorg human sign-in").digest();
    this.#now = now;
  }

  /** A path that signs a browser in once, within five minutes. */
  link(): { path: string; expires_at: string } {
    for (const [token, expires] of this.#links) {
      if (expires <= this.#now()) this.#links.delete(token);
    }
    const token = randomBytes(32).toString("base64url");
    const expires = this.#now() + LINK_MS;
    this.#links.set(token, expires);
    return { path: `/signin?token=${token}`, expires_at: new Date(expires).toISOString() };
  }

  /** The cookie for a new session, when the link's token is known, unused and current. */
  redeem(token: string): { cookie: string; expires: Date } | undefined {
    const expires = this.#links.get(token);
    this.#links.delete(token);
    if (expires === undefined || expires <= this.#now()) return undefined;
    const until = this.#now() + SESSION_MS;
    const body = `${until}.${randomBytes(16).toString("base64url")}`;
    return { cookie: `${body}.${this.#sign(body)}`, expires: new Date(until) };
  }

  /** The session a cookie carries, when its signature holds and it has not expired. */
  session(cookie: string | undefined): Session | undefined {
    const [until = "", nonce = "", signature = ""] = (cookie ?? "").split(".");
    const body = `${until}.${nonce}`;
    if (!matches(signature, this.#sign(body)) || Number(until) <= this.#now()) return undefined;
    return {
      csrf_token: this.#sign(`csrf.${body}`),
      expires_at: new Date(Number(until)).toISOString(),
    };
  }

  #sign(value: string): string {
    return createHmac("sha256", this.#key).update(value).digest("base64url");
  }
}
