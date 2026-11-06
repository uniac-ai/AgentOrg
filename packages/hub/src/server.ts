import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { MAX_UNREAD, type WebSocketLike, webSocketChannel } from "@agentorg/wire";
import { WebSocketServer } from "ws";
import type { Hub } from "./router.js";

export interface Listener {
  /** Where clients connect, `ws://host:port`. */
  url: string;
  close(): Promise<void>;
}

/**
 * Serve a Hub over WebSocket: one channel per connection, binary messages only. It listens on the
 * loopback address unless told otherwise.
 */
export async function listen(
  hub: Hub,
  options: { host?: string; port?: number } = {},
): Promise<Listener> {
  const host = options.host ?? "127.0.0.1";
  const server = new WebSocketServer({ host, port: options.port ?? 0, maxPayload: MAX_UNREAD });
  server.on("connection", (socket) => {
    // ws's overloaded listener types are narrower than the standard ones it implements.
    webSocketChannel(socket as unknown as WebSocketLike).then(
      (channel) => hub.accept(channel),
      () => socket.terminate(),
    );
  });
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://${host.includes(":") ? `[${host}]` : host}:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of server.clients) socket.terminate();
        server.close(() => resolve());
      }),
  };
}
