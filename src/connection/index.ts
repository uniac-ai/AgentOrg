/** Identity admission on a JSON-RPC socket, before its fixed Actor or Provider purpose starts. */
import { z } from "zod";
import { Channel, CLOSE_REVOKED } from "../network/index.ts";

export const CONNECTION_PATH = "/connection";
const Fields = { credential: z.string().min(1).optional() };
export const IdentitySchema = z.union([
  z.strictObject({ actorId: z.string().min(1), ...Fields }),
  z.strictObject({ providerId: z.string().min(1), ...Fields }),
]);
export type Identity = z.output<typeof IdentitySchema>;
export type Principal = { actorId: string } | { providerId: string };
export interface Admission {
  admit(identity: Identity): Promise<boolean>;
}
export interface Connection {
  connectionId: string;
  principal: Principal;
  channel: Channel;
}

const reply = (channel: Channel, id: unknown, code: number, semantic: string) =>
  channel.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message: semantic, data: { code: semantic } },
    }),
  );
const applicationChannel = (channel: Channel) =>
  new Channel({
    send: (text) => channel.send(text),
    close: (code, reason) => channel.close(code, reason),
  });

/** Admit one immutable preexisting identity. Later connect requests cannot rebind it. */
export function accept(
  channel: Channel,
  admission: Admission,
  opened: (connection: Connection) => void,
): void {
  const application = applicationChannel(channel);
  let admitted = false;
  let admitting = false;
  let ended = false;
  const timer = setTimeout(() => channel.close(CLOSE_REVOKED, "admission expired"), 10_000);
  timer.unref();
  channel.listen(
    (text) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(text);
      } catch {
        reply(channel, null, -32700, "parse_error");
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        reply(channel, null, -32600, "invalid_request");
        return;
      }
      if (admitted && message.method !== "connection.connect") {
        application.receive(text);
        return;
      }
      const id =
        typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
      if (message.jsonrpc !== "2.0" || id === null) {
        reply(channel, id, -32600, "invalid_request");
        return;
      }
      if (admitted || admitting) {
        reply(channel, id, -32600, "identity_fixed");
        return;
      }
      if (message.method !== "connection.connect") {
        reply(channel, id, -32000, "unauthorized");
        return;
      }
      const identity = IdentitySchema.safeParse(message.params);
      if (!identity.success) {
        reply(channel, id, -32602, "invalid_params");
        return;
      }
      admitting = true;
      void admission
        .admit(identity.data)
        .then((allowed) => {
          if (ended) return;
          if (!allowed) {
            reply(channel, id, -32000, "unauthorized");
            channel.close(CLOSE_REVOKED, "admission refused");
            return;
          }
          admitted = true;
          clearTimeout(timer);
          const connectionId = crypto.randomUUID();
          const principal =
            "actorId" in identity.data
              ? { actorId: identity.data.actorId }
              : { providerId: identity.data.providerId };
          channel.send(JSON.stringify({ jsonrpc: "2.0", id, result: { connectionId } }));
          opened({ connectionId, principal, channel: application });
        })
        .catch(() => {
          if (!ended) {
            reply(channel, id, -32603, "admission_failed");
            channel.close();
          }
        });
    },
    (code) => {
      ended = true;
      clearTimeout(timer);
      application.closed(code);
    },
  );
}

/** Actor/Provider side: complete admission, preserving subsequent frames for its protocol. */
export async function establish(channel: Channel, identity: Identity): Promise<Connection> {
  const parsed = IdentitySchema.parse(identity);
  const application = applicationChannel(channel);
  const connectionId = await new Promise<string>((resolve, reject) => {
    let admitted = false;
    const timer = setTimeout(() => {
      reject(new Error("Hub admission timed out"));
      channel.close();
    }, 10_000);
    channel.listen(
      (text) => {
        if (admitted) {
          application.receive(text);
          return;
        }
        try {
          const response = JSON.parse(text);
          if (response.jsonrpc !== "2.0" || response.id !== "connection") throw new Error();
          if (typeof response.result?.connectionId !== "string") throw new Error();
          admitted = true;
          clearTimeout(timer);
          resolve(response.result.connectionId);
        } catch {
          clearTimeout(timer);
          reject(new Error("Hub refused connection admission"));
          channel.close();
        }
      },
      (code) => {
        clearTimeout(timer);
        application.closed(code);
        if (!admitted) reject(new Error("Hub closed connection admission"));
      },
    );
    channel.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "connection",
        method: "connection.connect",
        params: parsed,
      }),
    );
  });
  const principal =
    "actorId" in parsed ? { actorId: parsed.actorId } : { providerId: parsed.providerId };
  return { connectionId, principal, channel: application };
}

export { Connector } from "./connector.ts";
