/** An Actor's MCP client for the Tools explicitly exposed by the Hub. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Actor, CallOptions } from "../../actor/api.ts";
import type { Connector } from "../../connection/index.ts";
import type { Answer, ToolDescriptor } from "../../domain/model/index.ts";
import { VERSION } from "../../version.ts";
import { answerOfResult, catalogOf } from "./encoding.ts";
import { mcpTransport } from "./transport.ts";

export class McpActor implements Actor {
  private readonly connector: Connector;
  private readonly client: Client;
  constructor(connector: Connector, name: string) {
    this.connector = connector;
    this.client = new Client(
      { name, version: VERSION },
      {
        // Each current validator owns its compiler/cache; replaced catalogs can be collected.
        jsonSchemaValidator: {
          getValidator: (schema) => new AjvJsonSchemaValidator().getValidator(schema),
        },
      },
    );
  }
  get ended(): number | undefined {
    return this.connector.ended;
  }
  async open(): Promise<void> {
    await this.connector.connect((channel) => this.client.connect(mcpTransport(channel)));
  }
  async available(): Promise<ToolDescriptor[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor === undefined ? {} : { cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return catalogOf(tools);
  }
  async call(
    name: string,
    input: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<Answer> {
    const result = await this.client.callTool({ name, arguments: input }, undefined, {
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      ...(options.progress
        ? {
            onprogress: (progress: { message?: string }) =>
              options.progress?.(progress.message ?? ""),
          }
        : {}),
    });
    return answerOfResult(result as CallToolResult);
  }
  async close(): Promise<void> {
    await Promise.allSettled([this.client.close(), this.connector.close()]);
  }
}
