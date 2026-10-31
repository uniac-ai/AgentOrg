/** Loopback WebSocket transport. Identity and protocol establishment belong to its caller. */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { Channel } from "./channel.ts";

export interface Listening {
  url: string;
  drop(): void;
  close(): Promise<void>;
}

export async function listen(options: {
  port: number;
  hostname?: string;
  path: string;
  channel(channel: Channel): void;
}): Promise<Listening> {
  const hostname = options.hostname ?? "127.0.0.1";
  const channels = new Set<Channel>();
  const app = new Hono();
  app.use(options.path, async (c, next) => {
    if (c.req.header("origin") !== undefined) {
      return c.json({ code: "forbidden", message: "requests from web pages are refused" }, 403);
    }
    await next();
  });
  app.get(
    options.path,
    upgradeWebSocket(() => {
      let channel: Channel | undefined;
      return {
        onOpen: (_event, ws) => {
          channel = new Channel({
            send: (text) => ws.send(text),
            close: (code, reason) => ws.close(code, reason),
          });
          channels.add(channel);
          options.channel(channel);
        },
        onMessage: (event) => channel?.receive(String(event.data)),
        onClose: (event) => {
          if (channel) channels.delete(channel);
          channel?.closed(event.code);
        },
      };
    }),
  );
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
  const drop = () => {
    for (const channel of channels) channel.close();
  };
  return {
    url: `http://${hostname}:${port}`,
    drop,
    close: async () => {
      drop();
      for (const socket of websockets.clients) socket.terminate();
      websockets.close();
      const closed = new Promise((resolve) => server.close(resolve));
      if ("closeAllConnections" in server) server.closeAllConnections();
      await closed;
    },
  };
}
