/**
 * A fake of auth.openai.com and api.openai.com, in process: a `Request → Response` handler to
 * bind to the model Actor's `web` slot, so no port is opened and nothing reaches OpenAI. It signs
 * real RS256 id_tokens, rotates refresh tokens, streams server-sent events, and can be told to fail
 * in each documented way. Every secret it issues or sees is kept in `secrets`, so tests can check
 * none leaks.
 */
import { createHash, randomUUID } from "node:crypto";

const ISSUER = "https://auth.openai.com";
const API = "https://api.openai.com/v1";
const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

export type Script =
  /** A stream of these events. With `cut` it gives them and then breaks, as a connection reset. */
  | { events: Record<string, unknown>[]; cut?: boolean }
  /**
   * An error reply: its status, the error's code and `message` (OpenAI's own words for it), and
   * the `retry-after` and `retry-after-ms` headers as given.
   */
  | {
      status: number;
      code?: string;
      param?: string;
      message?: string;
      detail?: string;
      retryAfter?: string;
      retryAfterMs?: string;
    }
  /** The request fails at the network. */
  | { unreachable: true };

/** A completed response with the given output items, as the API sends it. */
export const completed = (output: Record<string, unknown>[], usage = { input: 12, output: 3 }) => ({
  type: "response.completed",
  response: { output, usage: { input_tokens: usage.input, output_tokens: usage.output } },
});
export const text = (content: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: content }],
});
export const delta = (piece: string) => ({ type: "response.output_text.delta", delta: piece });
/** A function call the response begins to write, as item `item`. */
export const callAdded = (item: string, callId: string, name: string) => ({
  type: "response.output_item.added",
  item: { type: "function_call", id: item, call_id: callId, name, arguments: "" },
});
/** A piece of the arguments of the function call written as item `item`. */
export const argumentsDelta = (item: string, piece: string) => ({
  type: "response.function_call_arguments.delta",
  item_id: item,
  delta: piece,
});

const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};
/** An RS256 signing key and the JWK that publishes it. */
async function signingKey(kid: string) {
  const pair = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, use: "sig" };
  return { kid, privateKey: pair.privateKey, jwk };
}

type Tamper = "signature" | "nonce" | "issuer" | "audience" | "expired" | "alg-none" | "alg-hs256";

export async function fakeOpenAI() {
  let key = await signingKey("k1");
  const stranger = await signingKey("k1");
  const clients = new Map<string, { hostId: string; name: string }>();
  const codes = new Map<
    string,
    { clientId: string; challenge: string; redirectUri: string; nonce: string }
  >();
  const access = new Map<string, { clientId: string; expiresAt: number }>();
  const refresh = new Map<string, { clientId: string; live: boolean }>();
  const secrets = new Set<string>();
  const requests: { method: string; url: string; body: string; status?: number }[] = [];
  const script: Script[] = [];

  const options = {
    email: "person@example.com",
    plan: "plus",
    expiresIn: 3600,
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    /** The next refresh answers with this OAuth error code. */
    refreshError: undefined as string | undefined,
    /** Refreshes wait this long before they rotate the token, so concurrent ones can be seen. */
    refreshDelay: 0,
    /** A refresh's answer takes this long after it rotated the token, as network latency would. */
    refreshLatency: 0,
    /** Requests to the token endpoint fail at the network. */
    offline: false,
    revokeStatus: 200,
    /** The key set answers with this status, once. */
    jwksStatus: 200,
    /** Tamper with the next id_token. */
    tamper: undefined as Tamper | undefined,
    /** Leave the issued client id off a first registration's callback. */
    withholdClientId: false,
    /** Server-sent events go out with CRLF line ends in three-byte chunks, each event's JSON split
     *  over two data lines, ending with [DONE]. */
    chunked: false,
    models: [
      { slug: "gpt-test", display_name: "GPT Test", visibility: "list" },
      { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide" },
    ] as Record<string, unknown>[],
  };
  let refreshes = 0;

  const json = (body: unknown, status = 200, more: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "x-request-id": `req_${randomUUID()}`,
        ...more,
      },
    });

  async function sign(claims: Record<string, unknown>, tamper: Tamper | undefined) {
    const alg = tamper === "alg-none" ? "none" : tamper === "alg-hs256" ? "HS256" : "RS256";
    const head = b64url(JSON.stringify({ alg, kid: key.kid, typ: "JWT" }));
    const body = b64url(JSON.stringify(claims));
    if (alg === "none") return `${head}.${body}.`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      tamper === "signature" ? stranger.privateKey : key.privateKey,
      new TextEncoder().encode(`${head}.${body}`),
    );
    return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
  }

  async function issue(clientId: string, nonce?: string) {
    const accessToken = `at_${randomUUID()}`;
    const refreshToken = `rt_${randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);
    const tamper = options.tamper;
    options.tamper = undefined;
    const idToken = await sign(
      {
        iss: tamper === "issuer" ? "https://auth.example.com" : ISSUER,
        aud: tamper === "audience" ? "oaiapp_someone_else" : clientId,
        sub: "user-1",
        email: options.email,
        "https://api.openai.com/auth": { chatgpt_plan_type: options.plan },
        iat: now,
        exp: tamper === "expired" ? now - 3600 : now + 3600,
        ...(nonce === undefined ? {} : { nonce: tamper === "nonce" ? "other" : nonce }),
      },
      tamper,
    );
    access.set(accessToken, { clientId, expiresAt: Date.now() + options.expiresIn * 1000 });
    refresh.set(refreshToken, { clientId, live: true });
    for (const secret of [accessToken, refreshToken, idToken]) secrets.add(secret);
    return json({
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      token_type: "Bearer",
      expires_in: options.expiresIn,
      scope: options.scope,
    });
  }

  async function token(form: URLSearchParams) {
    if (form.get("resource") !== API) return json({ error: "invalid_target" }, 400);
    const clientId = form.get("client_id") ?? "";
    if (clientId === "dynamic_agent_client" || !clients.has(clientId))
      return json({ error: "invalid_client" }, 401);
    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code") ?? "";
      const grant = codes.get(code);
      codes.delete(code);
      const verifier = form.get("code_verifier") ?? "";
      secrets.add(verifier);
      if (
        !grant ||
        grant.clientId !== clientId ||
        grant.redirectUri !== form.get("redirect_uri") ||
        createHash("sha256").update(verifier).digest("base64url") !== grant.challenge
      )
        return json({ error: "invalid_grant" }, 400);
      return issue(clientId, grant.nonce);
    }
    if (form.get("grant_type") === "refresh_token") {
      refreshes++;
      if (options.refreshDelay) await new Promise((r) => setTimeout(r, options.refreshDelay));
      const failure = options.refreshError;
      options.refreshError = undefined;
      if (failure) return json({ error: failure }, 400);
      const held = refresh.get(form.get("refresh_token") ?? "");
      if (!held || held.clientId !== clientId) return json({ error: "invalid_grant" }, 400);
      if (!held.live) return json({ error: "refresh_token_reused" }, 400);
      held.live = false;
      const issued = await issue(clientId);
      if (options.refreshLatency) await new Promise((r) => setTimeout(r, options.refreshLatency));
      return issued;
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }

  function bearer(request: Request) {
    const held = access.get(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    return held !== undefined && held.expiresAt > Date.now();
  }

  function events(next: Extract<Script, { events: unknown }>): Response {
    const end = options.chunked ? "\r\n" : "\n";
    let text = next.events
      .map((event) => {
        const data = JSON.stringify(event);
        const lines = options.chunked ? data.replace(",", `,${end}data: `) : data;
        return `event: ${event.type}${end}data: ${lines}${end}${end}`;
      })
      .join("");
    if (options.chunked) text += `data: [DONE]${end}${end}`;
    const bytes = new TextEncoder().encode(text);
    const size = options.chunked ? 3 : Math.max(bytes.length, 1);
    // A cut stream gives what it had, and then breaks: an error at once would drop it unread.
    let given = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (given) {
          controller.error(new Error("connection reset"));
          return;
        }
        given = true;
        for (let at = 0; at < bytes.length; at += size)
          controller.enqueue(bytes.slice(at, at + size));
        if (!next.cut) controller.close();
        else if (bytes.length === 0) controller.error(new Error("connection reset"));
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "x-request-id": `req_${randomUUID()}` },
    });
  }

  function respond(): Response {
    const next: Script = script.shift() ?? { events: [completed([text("ok")])] };
    if ("events" in next) return events(next);
    if ("unreachable" in next) throw new TypeError("fetch failed");
    if (next.detail) return json({ detail: next.detail }, next.status);
    return json(
      {
        error: {
          code: next.code ?? null,
          message: next.message ?? null,
          param: next.param ?? null,
        },
      },
      next.status,
      {
        ...(next.retryAfter === undefined ? {} : { "retry-after": next.retryAfter }),
        ...(next.retryAfterMs === undefined ? {} : { "retry-after-ms": next.retryAfterMs }),
      },
    );
  }

  async function route(request: Request, body: string): Promise<Response> {
    const url = new URL(request.url);
    const at = `${url.origin}${url.pathname}`;
    if (at === `${ISSUER}/.well-known/openid-configuration`)
      return json({
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        revocation_endpoint: `${ISSUER}/oauth/revoke`,
      });
    if (at === `${ISSUER}/.well-known/jwks.json`) {
      const status = options.jwksStatus;
      options.jwksStatus = 200;
      return status === 200 ? json({ keys: [key.jwk] }) : json({}, status);
    }
    if (at === `${ISSUER}/api/accounts/oauth/token`) {
      if (options.offline) throw new TypeError("fetch failed");
      return token(new URLSearchParams(body));
    }
    if (at === `${ISSUER}/oauth/revoke`) {
      const held = refresh.get(new URLSearchParams(body).get("token") ?? "");
      if (options.revokeStatus === 200 && held) held.live = false;
      return new Response(null, { status: options.revokeStatus });
    }
    if (!bearer(request)) return json({ error: { code: "invalid_token", message: "fake" } }, 401);
    if (request.method === "GET" && at === `${API}/models`) return json({ models: options.models });
    if (request.method === "POST" && at === `${API}/responses`) return respond();
    return json({ error: { code: "subscription_sharing_route_not_supported" } }, 403);
  }

  return {
    options,
    secrets,
    requests,
    clients,
    get refreshes() {
      return refreshes;
    },
    /** How many refresh tokens OpenAI would still accept. */
    get liveRefreshTokens() {
      return [...refresh.values()].filter((held) => held.live).length;
    },
    /** What the next `/responses` requests answer, in order; a completed "ok" when empty. */
    script(...next: Script[]) {
      script.push(...next);
    },
    /** Invalidate every access token, as a revocation in ChatGPT's settings would. */
    revokeAccess() {
      access.clear();
    },
    /** Sign with a new key from now on, and publish only that one. */
    async rotateKey() {
      key = await signingKey(`k${randomUUID()}`);
    },
    /**
     * The person approving on OpenAI's page: the callback address the browser is sent back to.
     * A first sign-in registers the app and issues its client id.
     */
    async authorize(authorizeUrl: string, decision: "allow" | "deny" = "allow") {
      const url = new URL(authorizeUrl);
      const p = url.searchParams;
      if (`${url.origin}${url.pathname}` !== `${ISSUER}/api/accounts/authorize`)
        throw new Error(`not the authorize endpoint: ${url.origin}${url.pathname}`);
      const redirectUri = p.get("redirect_uri") ?? "";
      const back = new URL(redirectUri);
      if (decision === "deny") {
        back.search = new URLSearchParams({
          error: "access_denied",
          state: p.get("state") ?? "",
        }).toString();
        return back.toString();
      }
      let clientId = p.get("client_id") ?? "";
      const first = clientId === "dynamic_agent_client";
      if (first) {
        clientId = `oaiapp_${randomUUID().replaceAll("-", "")}`;
        clients.set(clientId, {
          hostId: p.get("ext_agent_host_id") ?? "",
          name: p.get("agent_name_hint") ?? "",
        });
      } else if (!clients.has(clientId)) throw new Error("unknown client");
      const code = `code_${randomUUID()}`;
      secrets.add(code);
      codes.set(code, {
        clientId,
        challenge: p.get("code_challenge") ?? "",
        redirectUri,
        nonce: p.get("nonce") ?? "",
      });
      back.search = new URLSearchParams({
        code,
        scope: p.get("scope") ?? "",
        state: p.get("state") ?? "",
        ...(first && !options.withholdClientId ? { client_id: clientId } : {}),
      }).toString();
      return back.toString();
    },
    async handle(request: Request): Promise<Response> {
      const body = request.method === "GET" ? "" : await request.text();
      const seen: (typeof requests)[number] = { method: request.method, url: request.url, body };
      requests.push(seen);
      const response = await route(request, body);
      seen.status = response.status;
      return response;
    },
  };
}
export type FakeOpenAI = Awaited<ReturnType<typeof fakeOpenAI>>;
