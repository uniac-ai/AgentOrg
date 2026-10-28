/**
 * Calls between actors: their records, their delivery into the called actor, and waits on them.
 *
 * A call is recorded as pending before it is delivered. It goes over the called actor's reverse
 * connection while the actor is online, and again each time the actor comes online while the call
 * is still pending, so delivery is at least once. A tool that declares task support receives the
 * call as an MCP task, which it may finish hours later. The core waits on `tasks/result`, asks
 * again after a reconnect, and delivers the call again when the actor no longer knows the task,
 * as after a restart. A result is checked against the tool's output schema before the call is done.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  type CallToolResult,
  CallToolResultSchema,
  CancelTaskResultSchema,
  CreateTaskResultSchema,
  ErrorCode,
  McpError,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { CALL_META, type Call, type DeliveredCall } from "../protocol/index.ts";
import type { Audit } from "./audit.ts";
import type { Connections } from "./connections.ts";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.ts";
import { type ActorRecord, newId, type Registry } from "./registry.ts";
import { violation } from "./schemas.ts";
import type { Store } from "./store.ts";
import type { Route, Tool } from "./wiring.ts";

export type CallRecord = z.output<typeof Call>;
type Settled = Pick<CallRecord, "state"> & Partial<Pick<CallRecord, "output" | "error">>;

/** How long one wait on a delivered task's result may last: as long as a timer allows. */
const TASK_WAIT_MS = 2 ** 31 - 1;

const takesTasks = (client: Client, tool: Tool | undefined) => {
  const support = tool?.execution?.taskSupport;
  return (
    client.getServerCapabilities()?.tasks?.requests?.tools?.call !== undefined &&
    (support === "optional" || support === "required")
  );
};

const isUnknownTask = (error: unknown) =>
  error instanceof McpError && error.code === ErrorCode.InvalidParams;

const textOf = (result: CallToolResult) =>
  result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");

export class Calls {
  private readonly store: Store;
  private readonly registry: Registry;
  private readonly connections: Connections;
  private readonly audit: Audit;
  private readonly now: () => string;
  /** How long a call into a tool without task support may take. */
  private readonly timeoutMs: number;
  /** The delivery under way for each call, on the connection it uses. */
  private readonly attempts = new Map<string, { client: Client; controller: AbortController }>();
  private readonly waiters = new Map<string, { done: Promise<void>; wake: () => void }>();

  constructor(
    store: Store,
    registry: Registry,
    connections: Connections,
    audit: Audit,
    options: { now: () => string; timeoutMs: number },
  ) {
    this.store = store;
    this.registry = registry;
    this.connections = connections;
    this.audit = audit;
    this.now = options.now;
    this.timeoutMs = options.timeoutMs;
  }

  found(id: string): CallRecord {
    const call = this.store.get("calls", id);
    if (!call) throw new NotFound(`there is no call ${id}`);
    return call;
  }

  /** Record a call along a route and start delivering it. */
  create(
    from: ActorRecord,
    route: Route,
    input: Record<string, unknown>,
    cause: string | null,
  ): CallRecord {
    if (cause !== null && this.store.get("calls", cause)?.to !== from.id) {
      throw new Invalid(`cause ${cause} is not a call into ${from.name}`);
    }
    const call: CallRecord = {
      id: newId("call"),
      from: from.id,
      to: route.to.id,
      tool: route.tool.name,
      input,
      state: "pending",
      output: null,
      error: null,
      cause,
      task: null,
      created_at: this.now(),
      delivered_at: null,
      settled_at: null,
    };
    this.store.insert("calls", call);
    this.audit.record(from.id, "call", call.id, "pending");
    this.launch(call.id);
    return call;
  }

  /** Deliver every call pending on an actor, as when it comes online. */
  redeliver(actor: string): void {
    for (const call of this.store.select("calls", `"to" = ? AND state = 'pending'`, [actor])) {
      this.launch(call.id);
    }
  }

  /** Start a delivery. One that fails unexpectedly leaves the call pending for the next. */
  private launch(id: string): void {
    this.deliver(id).catch(() => {});
  }

  private async deliver(id: string): Promise<void> {
    const call = this.store.get("calls", id);
    const client = call && this.connections.peer(call.to);
    if (call?.state !== "pending" || !client || this.attempts.get(id)?.client === client) return;
    const attempt = { client, controller: new AbortController() };
    this.attempts.set(id, attempt);
    try {
      this.finish(call, await this.exchange(client, call, attempt.controller.signal));
    } catch (error) {
      // A call whose connection ended stays pending until the actor is back.
      const ended =
        (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) ||
        this.connections.peer(call.to) !== client;
      if (!ended && !attempt.controller.signal.aborted) {
        this.settle(call.id, call.to, { state: "failed", error: (error as Error).message });
      }
    } finally {
      if (this.attempts.get(id) === attempt) this.attempts.delete(id);
    }
  }

  private async exchange(
    client: Client,
    call: CallRecord,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const asTask = takesTasks(client, this.toolOf(call));
    if (call.task !== null && asTask) {
      try {
        return await this.taskResult(client, call.task, signal);
      } catch (error) {
        if (!isUnknownTask(error)) throw error;
      }
    }
    const delivered: DeliveredCall = { id: call.id, from: call.from, cause: call.cause };
    const params = { name: call.tool, arguments: call.input, _meta: { [CALL_META]: delivered } };
    this.store.run("UPDATE calls SET delivered_at = ?, task = NULL WHERE id = ?", [
      this.now(),
      call.id,
    ]);
    if (!asTask) {
      return client.request({ method: "tools/call", params }, CallToolResultSchema, {
        signal,
        timeout: this.timeoutMs,
      });
    }
    const answer = await client.request(
      { method: "tools/call", params: { ...params, task: {} } },
      ResultSchema,
      { signal },
    );
    // A tool whose task support is optional may still answer at once.
    if (!("task" in answer)) return CallToolResultSchema.parse(answer);
    const { task } = CreateTaskResultSchema.parse(answer);
    this.store.run("UPDATE calls SET task = ? WHERE id = ?", [task.taskId, call.id]);
    return this.taskResult(client, task.taskId, signal);
  }

  /** The result of a task, once the actor finishes it: `tasks/result` waits until then. */
  private taskResult(client: Client, taskId: string, signal: AbortSignal) {
    return client.request({ method: "tasks/result", params: { taskId } }, CallToolResultSchema, {
      signal,
      timeout: TASK_WAIT_MS,
    });
  }

  private toolOf(call: CallRecord): Tool | undefined {
    const tools = (this.registry.get(call.to)?.tools ?? []) as Tool[];
    return tools.find((tool) => tool.name === call.tool);
  }

  /** Settle a call with the actor's result, checked against the tool's output schema. */
  private finish(call: CallRecord, result: CallToolResult): void {
    if (result.isError) {
      this.settle(call.id, call.to, {
        state: "failed",
        error: textOf(result) || `${call.tool} returned an error`,
      });
      return;
    }
    const schema = this.toolOf(call)?.outputSchema as object | undefined;
    const problem =
      schema === undefined
        ? undefined
        : result.structuredContent === undefined
          ? "it has no structured content"
          : violation(schema, result.structuredContent);
    if (problem !== undefined) {
      this.settle(call.id, call.to, {
        state: "failed",
        error: `the output does not match the output schema of ${call.tool}: ${problem}`,
      });
      return;
    }
    const { _meta, ...output } = result;
    this.settle(call.id, call.to, { state: "done", output });
  }

  /** Move a pending call to its end, once; a later result for it is dropped. */
  private settle(id: string, actor: string, settled: Settled): boolean {
    const changed = this.store.run(
      "UPDATE calls SET state = ?, output = ?, error = ?, settled_at = ? WHERE id = ? AND state = 'pending'",
      [
        settled.state,
        settled.output ? JSON.stringify(settled.output) : null,
        settled.error ?? null,
        this.now(),
        id,
      ],
    );
    if (changed === 0) return false;
    this.audit.record(actor, "call", id, settled.state);
    this.waiters.get(id)?.wake();
    this.waiters.delete(id);
    return true;
  }

  /**
   * The call once it settles or `ms` pass, whichever is first, calling `progress` after each step
   * of `stepMs` it is still pending. The caller going away ends the wait, not the call.
   */
  async wait(
    id: string,
    ms: number,
    options: { stepMs: number; progress?: () => Promise<void>; signal?: AbortSignal },
  ): Promise<CallRecord> {
    const deadline = Date.now() + ms;
    for (;;) {
      const left = deadline - Date.now();
      const call = this.found(id);
      if (call.state !== "pending" || left <= 0 || options.signal?.aborted) return call;
      let waiter = this.waiters.get(id);
      if (!waiter) {
        let wake = () => {};
        const done = new Promise<void>((resolve) => {
          wake = resolve;
        });
        waiter = { done, wake };
        this.waiters.set(id, waiter);
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        waiter.done,
        new Promise((resolve) => {
          timer = setTimeout(resolve, Math.min(options.stepMs, left));
        }),
      ]);
      clearTimeout(timer);
      if (this.found(id).state === "pending" && Date.now() < deadline) await options.progress?.();
    }
  }

  /** The caller withdraws its pending call; a task the actor runs for it is cancelled. */
  withdraw(actor: ActorRecord, id: string): CallRecord {
    const call = this.found(id);
    if (call.from !== actor.id) throw new Forbidden(`only its caller withdraws call ${id}`);
    if (call.state !== "pending") throw new Conflict(`call ${id} is already ${call.state}`);
    this.settle(id, actor.id, { state: "withdrawn" });
    this.stop(call);
    return this.found(id);
  }

  /** End a closed actor's pending calls: those it made are withdrawn, those into it fail. */
  endFor(actor: ActorRecord, closer: string): CallRecord[] {
    const own = this.store.select("calls", `"from" = ? AND state = 'pending'`, [actor.id]);
    const into = this.store.select("calls", `"to" = ? AND state = 'pending'`, [actor.id]);
    for (const call of own) {
      this.settle(call.id, closer, { state: "withdrawn" });
      this.stop(call);
    }
    for (const call of into) {
      this.settle(call.id, closer, { state: "failed", error: `${actor.name} was closed` });
      this.stop(call);
    }
    return [...own, ...into].map((call) => this.found(call.id));
  }

  private stop(call: CallRecord): void {
    const client = this.connections.peer(call.to);
    if (call.task !== null && client) {
      void client
        .request({ method: "tasks/cancel", params: { taskId: call.task } }, CancelTaskResultSchema)
        .catch(() => {});
    }
    this.attempts.get(call.id)?.controller.abort();
  }
}
