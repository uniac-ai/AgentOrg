/**
 * The core's listener: an HTTP server on 127.0.0.1 with two endpoints behind access, at the paths
 * its user names. The request endpoint hands each request, with its party, to the user. The
 * channel endpoint upgrades to a WebSocket and hands over the channel; a party has one channel
 * at a time, and a newer one replaces the older, which is closed with `CLOSE_REPLACED`.
 */

import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { access, type Identities, type NetworkEnv } from "./access.ts";
import { Channel } from "./channel.ts";
import { CLOSE_REPLACED } from "./codes.ts";

export interface Paths {
  request: string;
  channel: string;
}

/** What arrives on the endpoints, for the listener's user. */
export interface Endpoints {
  request(party: string, request: Request): Promise<Response>;
  channel(party: string, channel: Channel): void;
}

export interface Listening {
  url: string;
  /** End every open channel, as a lost network would. */
  drop(): void;
  close(): Promise<void>;
}

export async function listen(options: {
  port: number;
  hostname?: string;
  paths: Paths;
  identities: Identities;
  endpoints: Endpoints;
}): Promise<Listening> {
  const { paths, endpoints } = options;
  const hostname = options.hostname ?? "127.0.0.1";
  const channels = new Map<string, Channel>();
  const app = new Hono<NetworkEnv>();
  const guard = access(options.identities);
  app.use(paths.request, guard);
  app.use(paths.channel, guard);
  app.get(
    paths.channel,
    upgradeWebSocket((c) => {
      const party = c.var.party;
      let channel: Channel | undefined;
      return {
        onOpen: (_event, ws) => {
          const opened = new Channel({
            send: (text) => ws.send(text),
            close: (code, reason) => ws.close(code, reason),
          });
          channel = opened;
          const previous = channels.get(party);
          channels.set(party, opened);
          previous?.close(CLOSE_REPLACED, "replaced by a newer connection");
          endpoints.channel(party, opened);
        },
        onMessage: (event) => channel?.receive(String(event.data)),
        onClose: (event) => {
          if (channel && channels.get(party) === channel) channels.delete(party);
          channel?.closed(event.code);
        },
      };
    }),
  );
  app.all(paths.request, (c) => endpoints.request(c.var.party, c.req.raw));

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
    for (const channel of channels.values()) channel.close();
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
