/**
 * The ChatGPT sign-in this Actor owns: its registration, its tokens and their refresh. The tokens
 * stay inside, apart from its own store: nothing here returns, emits or logs one.
 */
import type { kv, LoginState } from "@agentorg/interfaces";
import { Refused, type Slot } from "@agentorg/sdk";
import type { z } from "zod";
import { challengeOf, random } from "./encoding.js";
import { type Claims, verifyIdToken } from "./jwt.js";
import {
  AGENT_NAME,
  AUTHORIZE,
  DYNAMIC_CLIENT,
  discover,
  type Fetch,
  type Grant,
  GrantError,
  grant,
  ISSUER,
  type Issuer,
  PLAN_SCOPE,
  RESOURCE,
  revoke,
  SCOPES,
  TERMINAL,
} from "./oauth.js";

type State = z.output<typeof LoginState>;
type Store = Slot<typeof kv>["call"];
/** This host's registration: its own opaque id, and the client id OpenAI issued it. */
interface Registration {
  hostId: string;
  clientId?: string;
}
/** One sign-in, kept as one value: the client it was issued to, its tokens, and who it is. */
interface Credential {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  sub?: string;
  email?: string;
  plan?: string;
  ineligible?: boolean;
}
interface Pending {
  verifier: string;
  nonce: string;
  redirectUri: string;
  /** The redirect as a parsed address, to compare with the callback's. */
  redirect: string;
  clientId: string;
  at: number;
}

/** How long a started sign-in can be completed, how many can wait, and how early to refresh. */
const PENDING_FOR = 10 * 60_000;
const MAX_PENDING = 16;
const REFRESH_BEFORE = 5 * 60_000;

export const notSignedIn = () =>
  new Refused("not_signed_in", "Not signed in to ChatGPT. Continue with ChatGPT to sign in.");
export const notEligible = () =>
  new Refused(
    "ineligible",
    "This ChatGPT account isn't eligible to use its plan in this app. Signing in again won't change that.",
  );
const unreachable = () =>
  new Refused("unavailable", "OpenAI couldn't be reached. Try again later.");
const address = (url: URL) => `${url.origin}${url.pathname}`;

/** Who signed in, from verified id_token claims; the plan claim isn't documented, so optional. */
function identity(claims: Claims) {
  const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return {
    ...(typeof claims.sub === "string" ? { sub: claims.sub } : {}),
    ...(typeof claims.email === "string" ? { email: claims.email.slice(0, 320) } : {}),
    ...(typeof auth?.chatgpt_plan_type === "string"
      ? { plan: auth.chatgpt_plan_type.slice(0, 64) }
      : {}),
  };
}
const tokensOf = ({ accessToken, refreshToken, expiresAt, scopes }: Grant) => ({
  accessToken,
  refreshToken,
  expiresAt,
  scopes,
});

export function createAccount(options: {
  fetch: Fetch;
  store: Store;
  changed(state: State): void;
  now?: () => number;
}) {
  const { fetch, store, changed } = options;
  const now = options.now ?? Date.now;
  const pending = new Map<string, Pending>();
  let issuer: Promise<Issuer> | undefined;
  let refreshing: Promise<Credential> | undefined;
  /** Bumped by every sign-in and sign-out, so a refresh that lands after one is dropped. */
  let generation = 0;

  const issuerOf = () => {
    issuer ??= discover(fetch).catch((error: unknown) => {
      issuer = undefined;
      throw error;
    });
    return issuer;
  };
  /** Verify an id_token; on a key the issuer no longer has, read its keys once more. */
  const verify = async (token: string, expect: { audience: string; nonce?: string }) => {
    const check = async () =>
      verifyIdToken(token, (await issuerOf()).keys, { issuer: ISSUER, ...expect, now: now() });
    try {
      return await check();
    } catch (error) {
      if (!(error instanceof Error && error.message === "no matching signing key")) throw error;
      issuer = undefined;
      return check();
    }
  };
  const read = async <T>(key: string) => (await store.get({ key })).value as T | undefined;
  const write = (key: string, value: Registration | Credential) =>
    store.set({ key, value: value as unknown as z.core.util.JSONType });
  const credential = () => read<Credential>("credential");
  const registration = async (): Promise<Registration> => {
    const kept = await read<Registration>("registration");
    if (kept) return kept;
    const fresh = { hostId: `urn:uuid:${crypto.randomUUID()}` };
    await write("registration", fresh);
    return fresh;
  };
  const stateOf = (held: Credential | undefined): State =>
    !held ? "signed_out" : held.ineligible ? "ineligible" : "signed_in";
  const accountOf = (held: Credential) => ({
    ...(held.email === undefined ? {} : { email: held.email }),
    ...(held.plan === undefined ? {} : { plan: held.plan }),
  });
  const clear = async () => {
    generation++;
    await store.delete({ key: "credential" });
    changed("signed_out");
  };
  /** Revoke tokens that won't be kept, as well as we can; nothing waits for it. */
  const discard = (clientId: string, refreshToken: string) =>
    void issuerOf()
      .then((found) => revoke(fetch, found, clientId, refreshToken))
      .catch(() => false);

  /** Refresh the tokens, one refresh at a time; the refresh token rotates each time. */
  const refresh = (): Promise<Credential> => {
    refreshing ??= (async () => {
      const started = generation;
      try {
        const held = await credential();
        if (!held) throw notSignedIn();
        const next = await grant(
          fetch,
          {
            grant_type: "refresh_token",
            client_id: held.clientId,
            refresh_token: held.refreshToken,
          },
          now(),
        );
        let kept: Credential = { ...held, ...tokensOf(next) };
        if (next.idToken) {
          const claims = await verify(next.idToken, { audience: held.clientId }).catch(
            () => undefined,
          );
          if (claims) kept = { ...kept, ...identity(claims) };
        }
        // Signed out or in again meanwhile: these tokens belong to nothing now.
        if (started !== generation) {
          discard(held.clientId, next.refreshToken);
          throw notSignedIn();
        }
        await write("credential", kept);
        return kept;
      } catch (error) {
        if (error instanceof GrantError) {
          if (!TERMINAL.has(error.code))
            throw new Refused("failed", `OpenAI refused to refresh the sign-in (${error.code}).`);
          if (started === generation) await clear();
          throw notSignedIn();
        }
        if (error instanceof Refused) throw error;
        throw unreachable();
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  };

  return {
    async status() {
      const held = await credential();
      return held ? { state: stateOf(held), account: accountOf(held) } : { state: stateOf(held) };
    },

    async start({ redirectUri }: { redirectUri: string }) {
      const { hostId, clientId = DYNAMIC_CLIENT } = await registration();
      for (const [state, attempt] of pending)
        if (now() - attempt.at > PENDING_FOR || pending.size >= MAX_PENDING) pending.delete(state);
      const verifier = random(48);
      const state = random();
      const nonce = random();
      const redirect = address(new URL(redirectUri));
      pending.set(state, { verifier, nonce, redirectUri, redirect, clientId, at: now() });
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: SCOPES,
        resource: RESOURCE,
        code_challenge: await challengeOf(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
        ext_agent_host_id: hostId,
        ...(clientId === DYNAMIC_CLIENT ? { agent_name_hint: AGENT_NAME } : {}),
      }).toString();
      return { authorizeUrl: url.toString() };
    },

    async complete({ callbackUrl }: { callbackUrl: string }) {
      let url: URL;
      try {
        url = new URL(callbackUrl);
      } catch {
        throw new Refused("invalid", "callbackUrl isn't an address.");
      }
      const params = url.searchParams;
      const state = params.get("state");
      const attempt = state === null ? undefined : pending.get(state);
      if (state === null || !attempt || now() - attempt.at > PENDING_FOR)
        throw new Refused(
          "expired",
          "This sign-in wasn't started here, or it expired. Start again.",
        );
      if (address(url) !== attempt.redirect)
        throw new Refused("invalid", "The callback isn't the address this sign-in redirects to.");
      pending.delete(state);
      const error = params.get("error");
      if (error === "access_denied") throw new Refused("denied", "Sign-in was declined.");
      if (error !== null) throw new Refused("failed", "OpenAI returned an error to the sign-in.");
      const code = params.get("code");
      if (!code) throw new Refused("failed", "The callback carries no code.");
      const issued = params.get("client_id");
      let clientId = attempt.clientId;
      if (clientId === DYNAMIC_CLIENT) {
        if (!issued || issued === DYNAMIC_CLIENT)
          throw new Refused(
            "failed",
            "OpenAI didn't issue a client id; registration isn't complete.",
          );
        clientId = issued;
      } else if (issued !== null && issued !== clientId)
        throw new Refused("failed", "The callback names another client, so it was refused.");
      let granted: Grant;
      try {
        granted = await grant(
          fetch,
          {
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            code_verifier: attempt.verifier,
            redirect_uri: attempt.redirectUri,
          },
          now(),
        );
      } catch (error) {
        if (error instanceof GrantError)
          throw new Refused("failed", `OpenAI refused the sign-in (${error.code}). Start again.`);
        throw unreachable();
      }
      if (!granted.scopes.includes(PLAN_SCOPE)) {
        discard(clientId, granted.refreshToken);
        throw new Refused("failed", "The sign-in wasn't granted ChatGPT plan usage.");
      }
      try {
        await issuerOf();
      } catch {
        discard(clientId, granted.refreshToken);
        throw unreachable();
      }
      let claims: Claims;
      try {
        if (!granted.idToken) throw new Error("no id_token");
        claims = await verify(granted.idToken, { audience: clientId, nonce: attempt.nonce });
      } catch {
        discard(clientId, granted.refreshToken);
        throw new Refused("failed", "OpenAI's identity token didn't verify.");
      }
      // A refresh still running belongs to the sign-in this one replaces, which is revoked.
      await refreshing?.catch(() => {});
      generation++;
      const replaced = await credential();
      if (replaced) discard(replaced.clientId, replaced.refreshToken);
      const held: Credential = { clientId, ...tokensOf(granted), ...identity(claims) };
      await write("registration", { ...(await registration()), clientId });
      await write("credential", held);
      changed("signed_in");
      return { account: accountOf(held) };
    },

    async logout() {
      // A refresh still running would write its tokens back after the sign-out.
      await refreshing?.catch(() => {});
      const held = await credential();
      if (!held) return { revoked: true };
      await clear();
      const revoked = await issuerOf().then(
        (found) => revoke(fetch, found, held.clientId, held.refreshToken),
        () => false,
      );
      return { revoked };
    },

    /** A usable access token, refreshed when it's near expiry or when `stale`. */
    async token(stale = false): Promise<string> {
      const held = await credential();
      if (!held) throw notSignedIn();
      if (held.ineligible) throw notEligible();
      if (!stale && held.expiresAt - REFRESH_BEFORE > now()) return held.accessToken;
      return (await refresh()).accessToken;
    },

    /** OpenAI said the account isn't eligible: say so until the next sign-in. */
    async ineligible() {
      const held = await credential();
      if (!held || held.ineligible) return;
      await write("credential", { ...held, ineligible: true });
      changed("ineligible");
    },
  };
}
export type Account = ReturnType<typeof createAccount>;
