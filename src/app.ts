/**
 * The app factory: one Hono app serving the API, MCP, the OpenAPI document and the decisions page.
 */

import { Hono } from "hono";
import { agentAccess } from "./access.ts";
import { apiRouter } from "./api/index.ts";
import { openapiDocument } from "./api/openapi.ts";
import type { AppEnv } from "./http.ts";
import { handleMcpRequest, type McpOptions } from "./mcp/server.ts";
import type { Service } from "./operations/index.ts";
import { page } from "./page/index.ts";

/** Build the app over a service layer. `token` is the bearer token agents present. */
export function createApp(
  service: Service,
  options: { token: string; mcp?: McpOptions },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const document = openapiDocument();
  app.use(async (c, next) => {
    c.set("service", service);
    await next();
  });
  const access = agentAccess(options.token);
  for (const path of ["/api", "/api/*", "/mcp", "/mcp/*"]) app.use(path, access);
  app.route("/api", apiRouter());
  app.all("/mcp", (c) => handleMcpRequest(service, c.req.raw, options.mcp));
  app.get("/openapi.json", (c) => c.json(document));
  app.route("/", page);
  return app;
}
