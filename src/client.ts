/**
 * The service as its clients reach it: its address, and every agent and API operation over its
 * HTTP API.
 *
 * A client finds the service at `AGENTORG_URL`, or on 127.0.0.1 at `AGENTORG_PORT` (default 8740).
 * `remoteOperations` implements the service-layer interface by calling the API, so the CLI and the
 * stdio proxy use the same operations, requests and errors as the service itself. It reads the
 * token on each call, so a client started before the service works once the service is up.
 */

import { API_OPERATIONS } from "./api/index.ts";
import {
  OPERATION_NAMES,
  OPERATIONS,
  type OperationName,
  subjectAndVerb,
} from "./contract/index.ts";
import { readToken } from "./home.ts";
import { CLIENT_HEADER, CLIENT_SESSION_HEADER } from "./http.ts";
import {
  type Caller,
  Conflict,
  Forbidden,
  Invalid,
  NotFound,
  OperationError,
  type Operations,
} from "./operations/index.ts";

export const DEFAULT_PORT = 8740;

export function port(): number {
  return Number(process.env.AGENTORG_PORT || DEFAULT_PORT);
}

export function serviceUrl(): string {
  return (process.env.AGENTORG_URL || `http://127.0.0.1:${port()}`).replace(/\/+$/, "");
}

/** The service did not answer. */
export class Unavailable extends OperationError {
  override readonly code = "unavailable";
}

const ERRORS: Record<string, new (message: string) => OperationError> = {
  not_found: NotFound,
  invalid: Invalid,
  forbidden: Forbidden,
  conflict: Conflict,
};

export interface RemoteOptions {
  url?: string;
  token?: string;
  /** The client kind and client session id every call carries. */
  client?: string | undefined;
  clientSessionId?: string | undefined;
}

type Untyped = (request: unknown, caller: Caller) => Promise<unknown>;

/** The service's agent and API operations, performed over its HTTP API. */
export function remoteOperations(options: RemoteOptions = {}): Operations {
  const url = options.url ?? serviceUrl();
  const notRunning = () =>
    new Unavailable(`agentorg service not running at ${url}; start it with \`agentorg serve\``);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.client) headers[CLIENT_HEADER] = options.client;
  if (options.clientSessionId) headers[CLIENT_SESSION_HEADER] = options.clientSessionId;

  const call =
    (name: OperationName): Untyped =>
    async (request) => {
      const token = options.token ?? readToken();
      if (!token) throw notRunning();
      // A wait holds the request open for its timeout, or until the ask is settled.
      const wait = (request as { timeout_seconds?: number | null }).timeout_seconds;
      const timeoutMs =
        wait === undefined ? 10_000 : wait === null ? undefined : wait * 1000 + 10_000;
      const path = `/api/${subjectAndVerb(name).join("/")}`;
      let response: Response;
      try {
        response = await fetch(`${url}${path}`, {
          method: "POST",
          headers: { ...headers, Authorization: `Bearer ${token}` },
          body: JSON.stringify(request),
          signal: timeoutMs === undefined ? null : AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw notRunning();
      }
      const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      if (response.ok) return OPERATIONS[name].response.parse(body);
      const Refusal = ERRORS[body.code ?? ""];
      if (Refusal) throw new Refusal(body.message ?? "");
      throw new OperationError(`${body.code ?? `HTTP ${response.status}`}: ${body.message ?? ""}`);
    };

  const notServed =
    (name: OperationName): Untyped =>
    async () => {
      throw new OperationError(`${name} is served only to the decisions page`);
    };

  return Object.fromEntries(
    OPERATION_NAMES.map((name) => [
      name,
      API_OPERATIONS.includes(name) ? call(name) : notServed(name),
    ]),
  ) as unknown as Operations;
}
