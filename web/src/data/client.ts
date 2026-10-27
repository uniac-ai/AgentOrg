/**
 * The typed client of the page's JSON routes under `/ui/api`. Reads send the page session's
 * cookie; writes also carry its CSRF token, which the session bootstrap hands over.
 */

import { CSRF_HEADER, type PageError } from "../../../src/page/types.ts";

/** A refused or failed request. `status` 0 means the service could not be reached. */
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

export async function request<T>(path: string, write?: { body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/ui/api${path}`, {
      method: write ? "POST" : "GET",
      credentials: "same-origin",
      headers: write ? { "Content-Type": "application/json", [CSRF_HEADER]: csrfToken } : {},
      body: write ? JSON.stringify(write.body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, "unreachable", "agentorg is not reachable");
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as PageError | null;
    throw new ApiError(
      response.status,
      error?.code ?? "error",
      error?.message ?? response.statusText,
    );
  }
  return (await response.json()) as T;
}
