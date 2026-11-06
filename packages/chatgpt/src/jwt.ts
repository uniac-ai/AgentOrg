import type { webcrypto } from "node:crypto";
import { fromBase64url } from "./encoding.js";

export type Claims = Record<string, unknown>;
export type Jwk = webcrypto.JsonWebKey & { kid?: string };

function part(text: string | undefined): Claims {
  if (!text) throw new Error("malformed token");
  const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(text)));
  if (typeof value !== "object" || value === null) throw new Error("malformed token");
  return value as Claims;
}

/**
 * An id_token's claims, once its RS256 signature checks against one of the issuer's keys and its
 * issuer, audience, expiry and (when given) nonce are right. Anything else throws.
 */
export async function verifyIdToken(
  token: string,
  keys: Jwk[],
  expect: { issuer: string; audience: string; nonce?: string; now: number },
): Promise<Claims> {
  const [header, payload, signature] = token.split(".");
  const head = part(header);
  if (head.alg !== "RS256") throw new Error("unexpected signing algorithm");
  const jwk = keys.find(
    (key) => key.kty === "RSA" && (head.kid === undefined || key.kid === head.kid),
  );
  if (!jwk || signature === undefined) throw new Error("no matching signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${header}.${payload}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64url(signature), signed)))
    throw new Error("bad signature");
  const claims = part(payload);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== expect.issuer) throw new Error("unexpected issuer");
  if (!audience.includes(expect.audience)) throw new Error("unexpected audience");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < expect.now - 60_000)
    throw new Error("expired");
  if (expect.nonce !== undefined && claims.nonce !== expect.nonce)
    throw new Error("unexpected nonce");
  return claims;
}
