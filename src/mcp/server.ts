/**
 * The MCP server: one tool per agent operation, derived from the contract's operation table, served
 * over Streamable HTTP at `/mcp` and over stdio by `agentorg mcp`. API and user operations are not
 * tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { OPERATION_NAMES, OPERATIONS, type OperationName } from "../contract/index.ts";
import { CLIENT_HEADER, CLIENT_SESSION_HEADER } from "../http.ts";
import { type Caller, invalid, OperationError, type Operations } from "../operations/index.ts";
import { VERSION } from "../version.ts";
import { INSTRUCTIONS } from "./instructions.ts";

export const AGENT_OPERATIONS: readonly OperationName[] = OPERATION_NAMES.filter(
  (name) => OPERATIONS[name].kind === "agent",
);

/** How often a waiting ask_wait reports progress, so that clients do not time the call out. */
export const PROGRESS_INTERVAL_MS = 15_000;

type JsonSchema = { [key: string]: unknown };

/** A schema as an object at the top, with the schemas it refers to in `$defs`, as MCP requires. */
function objectSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const {
    $schema,
    $ref,
    $defs = {},
    ...rest
  } = z.toJSONSchema(schema, { io }) as JsonSchema & {
    $ref?: string;
    $defs?: Record<string, JsonSchema>;
  };
  if (typeof $ref !== "string") return rest;
  const id = $ref.split("/").pop() as string;
  const { [id]: top, ...others } = $defs;
  return Object.keys(others).length > 0 ? { ...top, $defs: others } : { ...top };
}

export const TOOLS = AGENT_OPERATIONS.map((name) => ({
  name,
  description: OPERATIONS[name].description,
  inputSchema: objectSchema(OPERATIONS[name].request, "input"),
  outputSchema: objectSchema(OPERATIONS[name].response, "output"),
  annotations: { readOnlyHint: !OPERATIONS[name].writes },
}));

const toolError = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

type Untyped = (request: unknown, caller: Caller) => Promise<unknown>;
type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers | undefined, name: string): string | undefined {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface McpOptions {
  /** The caller when the transport carries no headers, as on stdio. */
  caller?: Caller;
  progressIntervalMs?: number;
}

export function buildServer(operations: Operations, options: McpOptions = {}): Server {
  const interval = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  const server = new Server(
    { name: "agentorg", version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name as OperationName;
    if (!AGENT_OPERATIONS.includes(name)) return toolError(`unknown tool ${request.params.name}`);
    const parsed = OPERATIONS[name].request.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return toolError(`invalid: ${invalid(parsed.error.issues).message}`);
    const headers = extra.requestInfo?.headers as Headers | undefined;
    const caller: Caller = options.caller ?? {
      channel: "mcp",
      client: header(headers, CLIENT_HEADER),
      clientSessionId: header(headers, CLIENT_SESSION_HEADER),
    };
    try {
      let result: unknown;
      if (name === "ask_wait") {
        const progressToken = request.params._meta?.progressToken;
        const report = async (progress: number) => {
          if (progressToken === undefined) return;
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress, message: "waiting for the answer" },
          });
        };
        result = await waitWithProgress(
          operations,
          parsed.data as { ask: string; timeout_seconds: number | null },
          caller,
          interval,
          report,
        );
      } else {
        result = await (operations[name] as Untyped)(parsed.data, caller);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (error) {
      if (error instanceof OperationError) return toolError(`${error.code}: ${error.message}`);
      throw error;
    }
  });
  return server;
}

/** Wait in steps, reporting progress after each step that ends with the ask still open. */
async function waitWithProgress(
  operations: Operations,
  request: { ask: string; timeout_seconds: number | null },
  caller: Caller,
  intervalMs: number,
  report: (progress: number) => Promise<void>,
) {
  const deadline =
    request.timeout_seconds === null ? null : Date.now() + request.timeout_seconds * 1000;
  for (let steps = 1; ; steps++) {
    const step =
      deadline === null ? intervalMs : Math.max(Math.min(intervalMs, deadline - Date.now()), 1);
    const ask = await operations.ask_wait(
      { ask: request.ask, timeout_seconds: step / 1000 },
      caller,
    );
    if (ask.state !== "open" || (deadline !== null && Date.now() >= deadline)) return ask;
    await report(steps);
  }
}

/** Serve one Streamable HTTP request. Each request stands alone, so no MCP session is kept. */
export async function handleMcpRequest(
  operations: Operations,
  request: Request,
  options?: McpOptions,
): Promise<Response> {
  const server = buildServer(operations, options);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(request);
}
