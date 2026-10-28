/**
 * The human actor, `agentorg human`: the user's side of the organization. To the core it is the
 * root actor, connected through the actor library (`core.ts`). To the user it serves the web app,
 * its sign-in and its API on 127.0.0.1 (`app.ts`, `signin.ts`): the root's available interfaces,
 * listed and called as the core offers them. It keeps nothing durable: sign-in sessions are signed
 * with a key derived from the root credential.
 */

import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { humanApp } from "./app.ts";
import { Core } from "./core.ts";
import { SignIn } from "./signin.ts";

export const DEFAULT_PORT = 8741;

export interface HumanOptions {
  /** The core's address, such as http://127.0.0.1:8740. */
  coreUrl: string;
  credential: string;
  /** The port to listen on; 0 picks a free one. */
  port: number;
}

export interface Human {
  url: string;
  close(): Promise<void>;
}

export async function startHuman(options: HumanOptions): Promise<Human> {
  const core = new Core(options.coreUrl, options.credential);
  const app = humanApp({
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
