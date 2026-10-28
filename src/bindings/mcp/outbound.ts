/**
 * The core's side of each actor's channel. The core initializes there as the MCP client, lists
 * the actor's tools as its interfaces, and lists them again on `list_changed`. The client is the
 * actor's link:
 * - a call goes as `tools/call`;
 * - a long-running one goes as an MCP task, whose result the core waits on with `tasks/result`,
 *   fetching it again at once when the actor's `notifications/tasks/status` says it finished;
 * - cancelling is `tasks/cancel`.
 * It tells `Presence` when the actor can be reached and when it no longer can.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  CancelTaskResultSchema,
  CreateTaskResultSchema,
  ErrorCode,
  McpError,
  ResultSchema,
  TaskStatusNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Delivery, InterfaceDescriptor, Outcome } from "../../domain/model/index.ts";
import { type ActorLink, LinkLost, type Presence, UnknownRun } from "../../domain/ports.ts";
import { type Channel, CLOSE_REVOKED } from "../../network/index.ts";
import { VERSION } from "../../version.ts";
import { CALL_META, type DeliveredCall, interfaceOf, outcomeOf } from "./encoding.ts";
import { ChannelTransport } from "./transport.ts";

/** How long one wait on a task's result may last: as long as a timer allows. */
const TASK_WAIT_MS = 2 ** 31 - 1;

/** An MCP error as the domain's: a closed connection loses the link, an unknown task the run. */
function translated(error: unknown, unknownRun = false): unknown {
  if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) {
    return new LinkLost(error.message);
  }
  if (unknownRun && error instanceof McpError && error.code === ErrorCode.InvalidParams) {
    return new UnknownRun(error.message);
  }
  return error;
}

const FINISHED = new Set(["completed", "failed", "cancelled"]);

class McpLink implements ActorLink {
  private readonly client: Client;
  private readonly channel: Channel;
  /** How long a call that is not long-running may take. */
  private readonly timeoutMs: number;
  /** For each run waited on, what to do when the actor says it finished. */
  private readonly finishing = new Map<string, () => void>();

  constructor(client: Client, channel: Channel, timeoutMs: number) {
    this.client = client;
    this.channel = channel;
    this.timeoutMs = timeoutMs;
    client.setNotificationHandler(TaskStatusNotificationSchema, ({ params }) => {
      if (FINISHED.has(params.status)) this.finishing.get(params.taskId)?.();
    });
  }

  async deliver(delivery: Delivery, signal: AbortSignal): Promise<Outcome | { run: string }> {
    const call: DeliveredCall = { id: delivery.call, from: delivery.from, cause: delivery.cause };
    const params = {
      name: delivery.interface,
      arguments: delivery.input,
      _meta: { [CALL_META]: call },
    };
    try {
      if (!delivery.long_running) {
        const result = await this.client.request(
          { method: "tools/call", params },
          CallToolResultSchema,
          { signal, timeout: this.timeoutMs },
        );
        return outcomeOf(result, delivery.interface);
      }
      const answer = await this.client.request(
        { method: "tools/call", params: { ...params, task: {} } },
        ResultSchema,
        { signal },
      );
      // A tool whose task support is optional may still answer at once.
      if (!("task" in answer)) {
        return outcomeOf(CallToolResultSchema.parse(answer), delivery.interface);
      }
      return { run: CreateTaskResultSchema.parse(answer).task.taskId };
    } catch (error) {
      throw translated(error);
    }
  }

  /**
   * The run's outcome. `tasks/result` waits until the run is finished, but the actor looks only
   * every poll interval, so a status notice that it finished asks again at once.
   */
  async outcome(run: string, signal: AbortSignal): Promise<Outcome> {
    const waiting = new AbortController();
    const stop = () => waiting.abort();
    signal.addEventListener("abort", stop, { once: true });
    const ask = () =>
      this.client.request(
        { method: "tasks/result", params: { taskId: run } },
        CallToolResultSchema,
        { signal: waiting.signal, timeout: TASK_WAIT_MS },
      );
    const finished = new Promise<void>((resolve) => this.finishing.set(run, resolve));
    try {
      const result = await Promise.race([ask(), finished.then(ask)]);
      return outcomeOf(result, "the call");
    } catch (error) {
      throw translated(error, true);
    } finally {
      this.finishing.delete(run);
      signal.removeEventListener("abort", stop);
      waiting.abort();
    }
  }

  async cancel(run: string): Promise<void> {
    await this.client.request(
      { method: "tasks/cancel", params: { taskId: run } },
      CancelTaskResultSchema,
    );
  }

  async close(): Promise<void> {
    this.channel.close(CLOSE_REVOKED, "the actor was closed");
  }
}

/**
 * Serve a party's new channel: initialize, list its tools, and tell `presence` it is online
 * through the link, until the channel ends.
 */
export function attach(
  presence: Presence,
  party: string,
  channel: Channel,
  options: { timeoutMs: number; onError?: (party: string, error: Error) => void },
): void {
  const client = new Client({ name: "agentorg-core", version: VERSION });
  const link = new McpLink(client, channel, options.timeoutMs);
  let listed = false;
  const list = async (): Promise<InterfaceDescriptor[]> => {
    const takesTasks = client.getServerCapabilities()?.tasks?.requests?.tools?.call !== undefined;
    const interfaces: InterfaceDescriptor[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor });
      interfaces.push(...page.tools.map((tool) => interfaceOf(tool, takesTasks)));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return interfaces;
  };
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    if (!listed) return;
    const interfaces = await list().catch(() => undefined);
    if (interfaces) presence.changed(party, link, interfaces);
  });
  void (async () => {
    try {
      await client.connect(new ChannelTransport(channel));
      client.onclose = () => presence.offline(party, link);
      const interfaces = await list();
      listed = true;
      presence.online(party, link, interfaces);
    } catch (error) {
      options.onError?.(party, error as Error);
      channel.close();
    }
  })();
}
