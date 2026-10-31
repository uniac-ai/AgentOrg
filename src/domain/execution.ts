/** One requested execution through a Provider, independent of organizational Actor lifetime. */

import { validSchema, violation } from "../schema.ts";
import type { Diagnostics } from "./diagnostics.ts";

export interface ExecutionProvider {
  holdCreation(): () => void;
  describe(): Promise<{ configSchema: Record<string, unknown> }>;
  createActor(input: {
    actorId: string;
    credential?: string;
    config: Record<string, unknown>;
  }): Promise<{ actorId: string }>;
}

export interface ExecutionRequest {
  actorId: string;
  credential?: string;
  providerId: string;
  config: Record<string, unknown>;
}

export interface ExecutionResult {
  providerId: string;
  status: "ready" | "failed" | "unknown";
  error?: { code: string; message: string };
}

export interface ExecutionClient {
  create(request: ExecutionRequest): Promise<ExecutionResult>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Combined Provider work fits within the default Actor and external MCP client call budgets. */
const EXECUTION_TIMEOUT_MS = 45_000;

async function within<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Execution deadline expired")),
          Math.max(0, remaining),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Only explicit refusals establish failure after the creation request was sent. */
const refusals = new Set([
  "PROVISIONING_FAILED",
  "invalid",
  "not_found",
  "forbidden",
  "conflict",
  "unavailable",
  "unauthorized",
]);

function failure(
  providerId: string,
  status: "failed" | "unknown",
  code: string,
  message: string,
): ExecutionResult {
  return { providerId, status, error: { code, message } };
}

export function execution(
  lookup: (providerId: string) => ExecutionProvider | undefined,
  observations?: Diagnostics,
): ExecutionClient {
  return {
    async create(request) {
      const { actorId, providerId, config } = request;
      const deadline = Date.now() + EXECUTION_TIMEOUT_MS;
      let provider: ExecutionProvider | undefined;
      let release: (() => void) | undefined;
      let launched = false;
      const result = (id: string, status: "failed" | "unknown", code: string, message: string) => {
        observations?.record({
          code:
            status === "unknown"
              ? "execution_outcome_unknown"
              : code === "unavailable"
                ? "provider_unavailable"
                : "execution_failed",
          stage: "provider_creation",
          outcome: status === "unknown" ? "unknown" : launched ? "refused" : "not_sent",
          actorId,
          ...(provider === undefined ? {} : { providerId: id }),
          operation: "actor_create",
        });
        return failure(id, status, code, message);
      };
      try {
        provider = lookup(providerId);
        release = provider?.holdCreation();
      } catch {
        return result(providerId, "failed", "unavailable", "The Provider is not available.");
      }
      try {
        if (!provider) {
          return result(providerId, "failed", "unavailable", "The Provider is not connected.");
        }
        if (
          !object(config) ||
          (Object.hasOwn(request, "credential") && typeof request.credential !== "string")
        ) {
          return result(
            providerId,
            "failed",
            "invalid",
            "Execution parameters do not match the contract.",
          );
        }
        try {
          const description = await within(provider.describe(), deadline);
          if (!object(description) || !validSchema(description.configSchema)) {
            return result(
              providerId,
              "failed",
              "invalid",
              "The Provider supplied an invalid configuration schema.",
            );
          }
          if (violation(description.configSchema, config) !== undefined) {
            return result(
              providerId,
              "failed",
              "invalid",
              "Execution configuration does not match the Provider's schema.",
            );
          }
        } catch {
          return result(
            providerId,
            "failed",
            "unavailable",
            "The Provider configuration is unavailable.",
          );
        }
        try {
          const supplied = {
            actorId,
            ...(Object.hasOwn(request, "credential")
              ? { credential: request.credential as string }
              : {}),
            config,
          };
          // No launch starts after the shared budget expired during description or validation.
          if (Date.now() >= deadline)
            return result(
              providerId,
              "failed",
              "unavailable",
              "The execution deadline expired before launch.",
            );
          launched = true;
          const created = await within(provider.createActor(supplied), deadline);
          if (
            !object(created) ||
            Object.keys(created).length !== 1 ||
            created.actorId !== actorId
          ) {
            return result(
              providerId,
              "unknown",
              "PROVISIONING_UNKNOWN",
              "The execution creation outcome is unknown.",
            );
          }
          return { providerId, status: "ready" };
        } catch (error: unknown) {
          const code = object(error) ? error.code : undefined;
          return typeof code === "string" && refusals.has(code)
            ? result(
                providerId,
                "failed",
                code,
                "The Provider refused or failed to complete execution creation.",
              )
            : result(
                providerId,
                "unknown",
                "PROVISIONING_UNKNOWN",
                "The execution creation outcome is unknown.",
              );
        }
      } finally {
        release?.();
      }
    },
  };
}
