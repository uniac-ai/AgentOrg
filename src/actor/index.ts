/**
 * The client library for actors: connect to the core, expose interfaces with their handlers, call
 * the interfaces available, and present them to whatever fills the position. `api.ts` is the API;
 * this module assembles it from the network's connector and the protocol binding, which an actor
 * never imports itself.
 */

import { McpActor } from "../bindings/mcp/actor.ts";
import { presentToOccupant } from "../bindings/mcp/occupant.ts";
import { Connector } from "../connection/index.ts";
import type { Actor, Exposed, Presented } from "./api.ts";

export type * from "./api.ts";

export interface ConnectOptions {
  /** The core's address, such as `http://127.0.0.1:8740`. */
  url: string;
  actorId: string;
  credential?: string;
  /** The name this actor gives the core on connecting. */
  name?: string;
  /** The longest pause between attempts to reconnect. */
  maxRetryMs?: number;
}

const connector = (options: ConnectOptions) =>
  new Connector({
    url: options.url,
    identity: {
      actorId: options.actorId,
      ...(options.credential === undefined ? {} : { credential: options.credential }),
    },
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

/**
 * Present an actor's offers to the session that fills its position, over this process's stdin and
 * stdout, as an agent session starts it.
 */
export function presentOverStdio(presented: Presented): Promise<{ close(): Promise<void> }> {
  return presentToOccupant(presented);
}
