/** The OpenAPI document of the API routes, built from the contract's Zod schemas. */

import { z } from "zod";
import { ErrorBody, OPERATIONS, subjectAndVerb, summaryOf } from "../contract/index.ts";
import { VERSION } from "../version.ts";
import { API_OPERATIONS, ERROR_STATUS } from "./index.ts";

type Schema = Record<string, unknown>;
const ref = (id: string) => ({ $ref: `#/components/schemas/${id}` });

function idOf(schema: z.ZodType): string {
  const id = z.globalRegistry.get(schema)?.id;
  if (!id) throw new Error("every request and response schema needs an id");
  return id;
}

/** The ids each schema refers to, so that only schemas the API uses become components. */
function references(schema: unknown, found: Set<string>): Set<string> {
  if (Array.isArray(schema)) for (const item of schema) references(item, found);
  else if (schema && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema)) {
      if (key === "$ref" && typeof value === "string") found.add(value.split("/").pop() ?? "");
      else references(value, found);
    }
  }
  return found;
}

export function openapiDocument(): Schema {
  // Requests are described as clients send them, so fields with defaults are optional; records
  // as the service returns them.
  const uri = (id: string) => `#/components/schemas/${id}`;
  const asSent = z.toJSONSchema(z.globalRegistry, { io: "input", uri }).schemas;
  const asReturned = z.toJSONSchema(z.globalRegistry, { io: "output", uri }).schemas;
  const requests = new Set(API_OPERATIONS.map((name) => idOf(OPERATIONS[name].request)));

  const paths: Record<string, Schema> = {};
  const wanted = new Set([idOf(ErrorBody)]);
  for (const name of API_OPERATIONS) {
    const spec = OPERATIONS[name];
    const [subject, verb] = subjectAndVerb(name);
    const [request, response] = [idOf(spec.request), idOf(spec.response)];
    wanted.add(request).add(response);
    const errors = Object.fromEntries(
      Object.entries(ERROR_STATUS).map(([code, status]) => [
        status,
        { description: code, content: { "application/json": { schema: ref("ErrorBody") } } },
      ]),
    );
    paths[`/api/${subject}/${verb}`] = {
      post: {
        operationId: name,
        tags: [subject],
        summary: summaryOf(name),
        description: spec.description.split("\n\n").slice(1).join("\n\n") || undefined,
        requestBody: { required: true, content: { "application/json": { schema: ref(request) } } },
        responses: {
          200: {
            description: "The result.",
            content: { "application/json": { schema: ref(response) } },
          },
          ...errors,
        },
      },
    };
  }

  const schemas: Record<string, Schema> = {};
  const pending = [...wanted];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (schemas[id]) continue;
    const { $schema, $id, ...schema } = (requests.has(id) ? asSent : asReturned)[id] as Schema;
    schemas[id] = schema;
    pending.push(...references(schema, new Set()));
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "agentorg",
      version: VERSION,
      summary: "The record of agents, their sessions, asks to managers, and messages up.",
    },
    paths,
    components: {
      schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))),
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
    security: [{ bearer: [] }],
  };
}
