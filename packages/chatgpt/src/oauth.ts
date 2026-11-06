/** OpenAI's Sign in with ChatGPT endpoints and grants, for plan usage by an open-source app. */
import type { Jwk } from "./jwt.js";

export const ISSUER = "https://auth.openai.com";
export const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
export const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
/** The audience of the tokens: the Responses API. */
export const RESOURCE = "https://api.openai.com/v1";
/** The scope that lets the tokens draw on the person's ChatGPT plan. */
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
/** The client id of a first sign-in; OpenAI then issues this app's own `oaiapp_…` id. */
export const DYNAMIC_CLIENT = "dynamic_agent_client";
export const AGENT_NAME = "AgentOrg";

export type Fetch = (request: Request) => Promise<Response>;

/** What a grant gives. `expiresAt` is in milliseconds. */
export interface Grant {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number;
  scopes: string[];
}

/** A word from a server, fit to show: at most 64 characters of letters, digits and `_.-[]`. */
export const word = (value: unknown) =>
  typeof value === "string" ? value.replace(/[^A-Za-z0-9_.[\]-]/g, "").slice(0, 64) : "";

/** The token endpoint refused a grant, with OAuth's error code. */
export class GrantError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(`The token endpoint refused the grant (${status} ${code}).`);
    this.code = code;
    this.status = status;
  }
}

/** Refresh errors after which the refresh token can't be used again. */
export const TERMINAL = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const form = (url: string, params: Record<string, string>) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params),
  });

/** An authorization-code or refresh-token grant, at the token endpoint. */
export async function grant(
  fetch: Fetch,
  params: Record<string, string>,
  now: number,
): Promise<Grant> {
  const response = await fetch(form(TOKEN, { ...params, resource: RESOURCE }));
  const body = await json(response);
  if (!response.ok) throw new GrantError(word(body.error) || "error", response.status);
  const { access_token, refresh_token, id_token, expires_in, scope } = body;
  if (typeof access_token !== "string" || typeof refresh_token !== "string")
    throw new GrantError("invalid_response", response.status);
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    ...(typeof id_token === "string" ? { idToken: id_token } : {}),
    expiresAt: now + (typeof expires_in === "number" ? expires_in : 3600) * 1000,
    scopes: typeof scope === "string" ? scope.split(" ").filter(Boolean) : [],
  };
}

/** The issuer's signing keys and revocation endpoint, from its OpenID configuration. */
export interface Issuer {
  keys: Jwk[];
  revocation?: string;
}

/** Read the issuer's configuration and keys; anything short of a usable key set throws. */
export async function discover(fetch: Fetch): Promise<Issuer> {
  const found = await fetch(new Request(DISCOVERY));
  const config = await json(found);
  if (!found.ok || config.issuer !== ISSUER || typeof config.jwks_uri !== "string")
    throw new Error("unexpected OpenID configuration");
  const fetched = await fetch(new Request(config.jwks_uri));
  const jwks = await json(fetched);
  const keys = Array.isArray(jwks.keys) ? (jwks.keys as Jwk[]) : [];
  if (!fetched.ok || keys.length === 0) throw new Error("no signing keys");
  return {
    keys,
    ...(typeof config.revocation_endpoint === "string"
      ? { revocation: config.revocation_endpoint }
      : {}),
  };
}

/** Revoke a refresh token: true when the issuer confirmed it. Retried on 5xx and network errors. */
export async function revoke(
  fetch: Fetch,
  issuer: Issuer,
  clientId: string,
  refreshToken: string,
): Promise<boolean> {
  if (!issuer.revocation) return false;
  const params = { token: refreshToken, token_type_hint: "refresh_token", client_id: clientId };
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(form(issuer.revocation, params));
      await response.body?.cancel();
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch {
      // A network failure: try again while the token is still in hand.
    }
    if (attempt === 2) return false;
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
}
