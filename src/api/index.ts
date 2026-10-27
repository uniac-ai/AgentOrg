/**
 * The HTTP JSON API: one `POST /api/{subject}/{verb}` route per agent and API operation, derived
 * from the contract's operation table. User operations are never served here. The OpenAPI document
 * of these routes is the committed `openapi.json`.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  OPERATION_NAMES,
  OPERATIONS,
  type OperationName,
  subjectAndVerb,
} from "../contract/index.ts";
import { type AppEnv, callerFrom } from "../http.ts";
import { type Caller, Invalid, invalid, OperationError } from "../operations/index.ts";

export const API_OPERATIONS: readonly OperationName[] = OPERATION_NAMES.filter(
  (name) => OPERATIONS[name].kind !== "user",
);

export const ERROR_STATUS: Readonly<Record<string, ContentfulStatusCode>> = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  invalid: 422,
};

export function errorResponse(c: Context, error: OperationError): Response {
  return c.json({ code: error.code, message: error.message }, ERROR_STATUS[error.code] ?? 400);
}

type Untyped = (request: unknown, caller: Caller) => Promise<unknown>;

async function body(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Invalid("the body must be a JSON object");
  }
}

export function apiRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  for (const name of API_OPERATIONS) {
    const [subject, verb] = subjectAndVerb(name);
    router.post(`/${subject}/${verb}`, async (c) => {
      try {
        const parsed = OPERATIONS[name].request.safeParse(await body(c));
        if (!parsed.success) throw invalid(parsed.error.issues);
        const operation = c.var.service[name] as Untyped;
        return c.json(await operation(parsed.data, callerFrom(c, "api")));
      } catch (error) {
        if (error instanceof OperationError) return errorResponse(c, error);
        throw error;
      }
    });
  }
  return router;
}
