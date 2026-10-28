/**
 * The typed client of the human actor's API under `/api`. Reads send the session's cookie; writes
 * also carry its CSRF token, which the session bootstrap hands over. The app reaches the core only
 * through it.
 */

import { type ApiErrorBody, CSRF_HEADER } from "../../../src/human/types.ts";

/** A refused or failed request. `status` 0 means the human actor could not be reached. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const isSignedOut = (error: unknown) => error instanceof ApiError && error.status === 401;

let csrfToken = "";

/** Keep the token the session bootstrap returned, for every write that follows. */
export function keepCsrfToken(token: string) {
  csrfToken = token;
}

export const path = (...parts: string[]) => `/${parts.map(encodeURIComponent).join("/")}`;

export async function request<T>(path: string, write?: { body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: write ? "POST" : "GET",
      credentials: "same-origin",
      headers: write ? { "Content-Type": "application/json", [CSRF_HEADER]: csrfToken } : {},
      body: write ? JSON.stringify(write.body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, "unreachable", "agentorg is not reachable");
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      error?.code ?? "error",
      error?.message ?? response.statusText,
    );
  }
  return (await response.json()) as T;
}

/** Call one of the interfaces available to the user and return its value; a refusal throws. */
export const callInterface = <T>(name: string, input: Record<string, unknown>) =>
  request<T>(path("interfaces", name), { body: input });
