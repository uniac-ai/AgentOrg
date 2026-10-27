/** A real server over a fresh store, on a free port, for tests that speak HTTP. */

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.ts";
import type { McpOptions } from "../src/mcp/server.ts";
import { StoreService } from "../src/operations/service.ts";
import { Store } from "../src/store/index.ts";

export const TOKEN = "test-token";
export const AUTH = { Authorization: `Bearer ${TOKEN}` };

export async function live(mcp?: McpOptions) {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-live-"));
  const store = new Store(join(directory, "agentorg.db"));
  const service = new StoreService(store, { machine: "laptop" });
  const app = createApp(service, { token: TOKEN, mcp });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { url, service, close };
}
