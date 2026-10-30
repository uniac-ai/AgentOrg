/** Public Actor connections against a real TCP peer that never upgrades to WebSocket. */

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import { type ConnectOptions, connectActor, connectClient } from "../src/actor/index.ts";

for (const [name, connect] of Object.entries({
  connectClient,
  connectActor: (options: ConnectOptions) => connectActor({ ...options, exposed: [] }),
})) {
  test(`${name} rejects when a TCP peer closes before WebSocket upgrade`, async (t) => {
    const credential = "sentinel-credential-before-upgrade";
    const sockets = new Set<Socket>();
    const closed: Promise<void>[] = [];
    let handshakes = 0;
    let credentialSent = false;
    const peer = createServer((socket) => {
      sockets.add(socket);
      closed.push(
        new Promise((resolve) =>
          socket.once("close", () => {
            sockets.delete(socket);
            resolve();
          }),
        ),
      );
      socket.on("error", () => {});
      let request = "";
      socket.on("data", (data) => {
        request += data.toString();
        if (!request.includes("\r\n\r\n")) return;
        if (/^GET \/connection HTTP\/1\.1\r\n/.test(request)) handshakes += 1;
        credentialSent ||= request.includes(credential);
        socket.end();
      });
    });
    peer.listen(0, "127.0.0.1");
    await once(peer, "listening");
    t.after(async () => {
      const stopped = new Promise<void>((resolve, reject) =>
        peer.close((error) => (error ? reject(error) : resolve())),
      );
      for (const socket of sockets) socket.destroy();
      await Promise.all([stopped, ...closed]);
      assert.equal(sockets.size, 0);
    });
    const address = peer.address();
    assert.ok(address && typeof address !== "string");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        connect({
          url: `http://127.0.0.1:${address.port}`,
          actorId: "act_fixture",
          credential,
        }).then(
          async (actor) => {
            await actor.close();
            return { state: "opened" } as const;
          },
          (error: unknown) => ({ state: "rejected", error }) as const,
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `${name} never settled after the TCP peer closed before WebSocket upgrade`,
                ),
              ),
            10_000,
          );
        }),
      ]);
      assert.ok(outcome.state === "rejected");
      assert.ok(outcome.error instanceof Error);
      assert.equal(
        outcome.error.message.includes(credential),
        false,
        "connection errors keep credentials private",
      );
      assert.equal(handshakes, 1, "the initial connection makes one WebSocket handshake attempt");
      assert.equal(credentialSent, false, "credentials wait for an established WebSocket channel");
    } finally {
      clearTimeout(timer);
    }
  });
}
