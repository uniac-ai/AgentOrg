/**
 * The typed client of the web client's API under `/api`: the session bootstrap, and calls into
 * the interfaces available to the user, the root. Every call carries the session's CSRF token, so
 * calls wait for the bootstrap to hand it over. The app reaches the core only through it.
 */

import { type ApiErrorBody, type Builtins, CSRF_HEADER } from "../../../src/clients/web/types.ts";

/** A refused or failed request. `status` 0 means the web client could not be reached. */
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

let keep: (token: string) => void = () => {};
let csrfToken = new Promise<string>((resolve) => {
  keep = resolve;
});

/** Keep the token the session bootstrap returned, for every call that follows. */
export function keepCsrfToken(token: string) {
  keep(token);
  csrfToken = Promise.resolve(token);
}

export async function request<T>(path: string, write?: { body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: write ? "POST" : "GET",
      credentials: "same-origin",
      headers: write ? { "Content-Type": "application/json", [CSRF_HEADER]: await csrfToken } : {},
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

/** Call one of the core's built-ins as the user and return its result; a refusal throws. */
export const call = <N extends keyof Builtins>(name: N, input: Builtins[N]["input"]) =>
  request<Builtins[N]["result"]>(`/interfaces/${encodeURIComponent(name)}`, { body: input });
