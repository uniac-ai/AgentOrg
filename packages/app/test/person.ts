// The person through `/api`, as `agentorg call` reaches the running app.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import type { App } from "../src/index.ts";

type Reply = {
  id?: number;
  sub?: number;
  result?: unknown;
  error?: { code?: string };
  payload?: unknown;
};

export function personOf(app: App, home: string) {
  const socket = new WebSocket(`${app.url.replace("http", "ws")}/api`, {
    headers: { Authorization: `Bearer ${readFileSync(join(home, "cli-token"), "utf8").trim()}` },
  });
  const opened = new Promise((done) => socket.once("open", done));
  let id = 0;
  const waiting = new Map<number, (reply: Reply) => void>();
  const heard: Reply[] = [];
  socket.on("message", (data) => {
    const reply = JSON.parse(String(data)) as Reply;
    if (reply.sub !== undefined) heard.push(reply);
    else if (reply.id !== undefined) waiting.get(reply.id)?.(reply);
  });
  return {
    heard,
    close: async () => {
      await opened;
      socket.close();
    },
    async subscribe(slot: string, event: string) {
      await opened;
      socket.send(JSON.stringify({ sub: ++id, op: "subscribe", slot, event }));
      return id;
    },
    async call<T = Record<string, never>>(
      slot: string,
      method: string,
      input: unknown = {},
    ): Promise<T> {
      await opened;
      const reply = await new Promise<Reply>((done) => {
        waiting.set(++id, done);
        socket.send(JSON.stringify({ id, op: "call", slot, method, input }));
      });
      if (reply.error)
        throw Object.assign(new Error(JSON.stringify(reply.error)), { code: reply.error.code });
      return reply.result as T;
    },
  };
}
export type Person = ReturnType<typeof personOf>;
