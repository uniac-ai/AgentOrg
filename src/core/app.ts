/**
 * The core's HTTP server: `/mcp` and the `/mcp/reverse` WebSocket, both behind actor access, on
 * 127.0.0.1 by default.
 */

import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { MCP_PATH, REVERSE_PATH, type WebSocketTransport } from "../protocol/index.ts";
import { actorAccess, type CoreEnv } from "./access.ts";
import type { Connections } from "./connections.ts";
import { handleMcp, type Surface } from "./mcp.ts";

export function createApp(connections: Connections, surface: Surface): Hono<CoreEnv> {
  const app = new Hono<CoreEnv>();
  const access = actorAccess(connections);
  app.use(MCP_PATH, access);
  app.use(`${MCP_PATH}/*`, access);
  app.get(
    REVERSE_PATH,
    upgradeWebSocket((c) => {
      let transport: WebSocketTransport | undefined;
      return {
        onOpen: (_event, ws) => {
          transport = connections.accept(c.var.actor, {
            send: (text) => ws.send(text),
            close: (code, reason) => ws.close(code, reason),
          });
        },
        onMessage: (event) => transport?.receive(String(event.data)),
        onClose: (event) => transport?.closed(event.code),
      };
    }),
  );
  app.all(MCP_PATH, (c) => handleMcp(surface, c.var.actor, c.req.raw));
  return app;
}

export interface Listening {
  url: string;
  close(): Promise<void>;
}

/** Serve the app on `hostname` and `port` (0 for a free one) until `close`. */
export async function listen(
  app: Hono<CoreEnv>,
  options: { port: number; hostname?: string },
): Promise<Listening> {
  const hostname = options.hostname ?? "127.0.0.1";
  const websockets = new WebSocketServer({ noServer: true });
  const server = serve({
    fetch: app.fetch,
    hostname,
    port: options.port,
    websocket: { server: websockets },
  });
  await Promise.race([
    once(server, "listening"),
    once(server, "error").then(([error]) => Promise.reject(error)),
  ]);
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${hostname}:${port}`,
    close: async () => {
      for (const socket of websockets.clients) socket.terminate();
      websockets.close();
      const closed = new Promise((resolve) => server.close(resolve));
      if ("closeAllConnections" in server) server.closeAllConnections();
      await closed;
    },
  };
}
