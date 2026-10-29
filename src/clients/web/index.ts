/** Serve the browser app, sign-in and API, connected to the core through the actor library. */

import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { webApp } from "./app.ts";
import { Core } from "./core.ts";
import { SignIn } from "./signin.ts";

export const DEFAULT_PORT = 8741;

export interface WebOptions {
  /** The core's address, such as http://127.0.0.1:8740. */
  coreUrl: string;
  credential: string;
  /** The port to listen on; 0 picks a free one. */
  port: number;
}

export interface WebClient {
  url: string;
  close(): Promise<void>;
}

export async function startWeb(options: WebOptions): Promise<WebClient> {
  const core = new Core(options.coreUrl, options.credential);
  const app = webApp({
    core,
    signIn: new SignIn(options.credential),
    credential: options.credential,
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: options.port }) as Server;
  await Promise.race([
    once(server, "listening"),
    once(server, "error").then(([error]) => Promise.reject(error)),
  ]);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      await core.close();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}
