/**
 * The client library for actors: connect to the core, expose interfaces with their handlers, and
 * call the interfaces available. `api.ts` is the API; this module assembles it from the network's
 * connector and the protocol binding, which an actor never imports itself.
 */

import { McpActor } from "../bindings/mcp/actor.ts";
import { PATHS, SUBPROTOCOL } from "../bindings/mcp/encoding.ts";
import { Connector } from "../network/index.ts";
import type { Actor, Exposed } from "./api.ts";

export type * from "./api.ts";

export interface ConnectOptions {
  /** The core's address, such as `http://127.0.0.1:8740`. */
  url: string;
  credential: string;
  /** The name this actor gives the core on connecting. */
  name?: string;
  /** The longest pause between attempts to reconnect. */
  maxRetryMs?: number;
}

const connector = (options: ConnectOptions) =>
  new Connector({
    url: options.url,
    credential: options.credential,
    paths: PATHS,
    subprotocol: SUBPROTOCOL,
    ...(options.maxRetryMs === undefined ? {} : { maxRetryMs: options.maxRetryMs }),
  });

async function opened(actor: McpActor): Promise<Actor> {
  try {
    await actor.open();
  } catch (error) {
    await actor.close();
    throw error;
  }
  return actor;
}

/** Connect an actor that exposes `exposed`, reconnecting whenever its connection drops. */
export async function connectActor(
  options: ConnectOptions & { exposed: Exposed[] },
): Promise<Actor> {
  return opened(
    new McpActor(connector(options), options.exposed, options.name ?? "agentorg-actor"),
  );
}

/** Connect a client that only calls, such as the command line. */
export async function connectClient(options: ConnectOptions): Promise<Actor> {
  return opened(new McpActor(connector(options), undefined, options.name ?? "agentorg-client"));
}
