/** One requested execution through a Provider, independent of organizational Actor lifetime. */

import { validSchema, violation } from "../schema.ts";

export interface ExecutionProvider {
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

function result(
  providerId: string,
  status: "failed" | "unknown",
  code: string,
  message: string,
): ExecutionResult {
  return { providerId, status, error: { code, message } };
}

export function execution(
  lookup: (providerId: string) => ExecutionProvider | undefined,
): ExecutionClient {
  return {
    async create(request) {
      const { actorId, providerId, config } = request;
      let provider: ExecutionProvider | undefined;
      try {
        provider = lookup(providerId);
      } catch {
        return result(providerId, "failed", "unavailable", "The Provider is not available.");
      }
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
        const description = await provider.describe();
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
        const created = await provider.createActor(supplied);
        if (!object(created) || Object.keys(created).length !== 1 || created.actorId !== actorId) {
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
    },
  };
}
