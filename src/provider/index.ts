/** The Hub's factory client on an admitted Provider's JSON-RPC connection. */

import { Ajv } from "ajv";
import type { Channel } from "../network/channel.ts";

export interface CreateActorParams {
  actorId: string;
  credential?: string;
  config: Record<string, unknown>;
}

export interface CreateActorResult {
  actorId: string;
}

export interface ProviderDescription {
  configSchema: Record<string, unknown>;
}

/** Provider messages never supply the diagnostic text crossing this boundary. */
export class ProviderError extends Error {
  readonly code: string;
  readonly rpcCode: number;

  constructor(code: string, rpcCode: number, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

type Method = "provider.describe" | "provider.createActor";
type Pending = {
  method: Method;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: ProviderError): void;
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const own = (value: object, key: PropertyKey) => Object.hasOwn(value, key);
const schemaValidator = new Ajv({ strict: false, allErrors: true });
function validSchema(schema: unknown): schema is Record<string, unknown> {
  if (!object(schema) || schema.$async === true) return false;
  try {
    return schemaValidator.validateSchema(schema) === true;
  } catch {
    return false;
  }
}
const CODES = new Set([
  "CREATION_CONFLICT",
  "PROVISIONING_UNKNOWN",
  "PROVISIONING_FAILED",
  "invalid",
  "not_found",
  "forbidden",
  "conflict",
  "unavailable",
  "unauthorized",
  "error",
]);

function unavailable(method: Method): ProviderError {
  return method === "provider.createActor"
    ? new ProviderError(
        "PROVISIONING_UNKNOWN",
        -32000,
        "The Provider's creation outcome is unknown.",
      )
    : new ProviderError("unavailable", -32000, "The Provider did not answer.");
}

function invalidResponse(method: Method): ProviderError {
  return method === "provider.createActor"
    ? new ProviderError(
        "PROVISIONING_UNKNOWN",
        -32603,
        "The Provider's creation outcome is unknown.",
      )
    : new ProviderError("error", -32603, "The Provider returned an invalid response.");
}

function refusal(method: Method, error: Record<string, unknown>): ProviderError {
  const rpcCode = error.code as number;
  const semantic = object(error.data) ? error.data.code : undefined;
  const code =
    typeof semantic === "string" && CODES.has(semantic)
      ? semantic
      : rpcCode === -32602
        ? "invalid"
        : method === "provider.createActor"
          ? "PROVISIONING_UNKNOWN"
          : "error";
  const messages: Record<string, string> = {
    CREATION_CONFLICT: "The creation inputs conflict with the Provider's accepted inputs.",
    PROVISIONING_UNKNOWN: "The Provider's creation outcome is unknown.",
    PROVISIONING_FAILED: "The Provider could not complete creation.",
    invalid: "The Provider rejected the parameters.",
  };
  return new ProviderError(code, rpcCode, messages[code] ?? "The Provider refused the request.");
}

/**
 * Calls the two fixed factory methods. Configuration acceptance belongs to creation orchestration;
 * this client checks the wire contract and never applies configuration defaults.
 */
export class ProviderClient {
  private readonly pending = new Map<string, Pending>();
  private readonly channel: Channel;
  private readonly timeoutMs: number;
  private sequence = 0;
  private ended = false;

  constructor(channel: Channel, options: { timeoutMs?: number } = {}) {
    this.channel = channel;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    channel.listen(
      (text) => this.receive(text),
      () => this.disconnected(),
    );
  }

  async describe(): Promise<ProviderDescription> {
    const result = await this.request("provider.describe", {});
    if (!object(result) || Object.keys(result).length !== 1 || !validSchema(result.configSchema)) {
      throw invalidResponse("provider.describe");
    }
    return { configSchema: result.configSchema };
  }

  async createActor(params: CreateActorParams): Promise<CreateActorResult> {
    if (
      !object(params) ||
      typeof params.actorId !== "string" ||
      params.actorId.length === 0 ||
      !object(params.config) ||
      (own(params, "credential") && typeof params.credential !== "string") ||
      Object.keys(params).some((key) => !["actorId", "credential", "config"].includes(key))
    ) {
      throw new ProviderError("invalid", -32602, "Creation parameters do not match the contract.");
    }
    const actorId = params.actorId;
    const result = await this.request("provider.createActor", params);
    if (!object(result) || Object.keys(result).length !== 1 || result.actorId !== actorId) {
      throw invalidResponse("provider.createActor");
    }
    return { actorId };
  }

  close(): void {
    this.channel.close();
    this.disconnected();
  }

  private request(method: Method, params: object): Promise<unknown> {
    if (this.ended) return Promise.reject(unavailable(method));
    const id = `provider-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(unavailable(method));
      }, this.timeoutMs);
      this.pending.set(id, { method, timer, resolve, reject });
      try {
        this.channel.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(unavailable(method));
      }
    });
  }

  private receive(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.sendError(null, -32700, "Parse error");
      return;
    }
    if (!object(message) || message.jsonrpc !== "2.0") {
      this.sendError(null, -32600, "Invalid Request");
      return;
    }
    if (own(message, "method")) {
      if (typeof message.method !== "string") {
        this.sendError(null, -32600, "Invalid Request");
      } else if (own(message, "id")) {
        if (typeof message.id !== "string" && typeof message.id !== "number") {
          this.sendError(null, -32600, "Invalid Request");
        } else {
          this.sendError(message.id, -32601, "Method not found");
        }
      }
      return;
    }
    if (typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (own(message, "result") && !own(message, "error")) {
      pending.resolve(message.result);
    } else if (
      !own(message, "result") &&
      object(message.error) &&
      typeof message.error.code === "number" &&
      Number.isInteger(message.error.code) &&
      typeof message.error.message === "string"
    ) {
      pending.reject(refusal(pending.method, message.error));
    } else {
      pending.reject(invalidResponse(pending.method));
    }
  }

  private sendError(id: string | number | null, code: number, message: string): void {
    try {
      this.channel.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
    } catch {
      this.disconnected();
    }
  }

  private disconnected(): void {
    this.ended = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(unavailable(pending.method));
    }
    this.pending.clear();
  }
}
