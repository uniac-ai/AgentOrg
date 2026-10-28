/**
 * An actor's available tools on `/mcp`, and what calling one does. A built-in runs at once. A tool
 * of another actor becomes a routed call: its input is checked against that tool's input schema,
 * the call is recorded and delivered, and the caller waits for a bounded time, with progress, for
 * its result. A call still pending then returns `{call, state: "pending"}`, as does a call into a
 * one-way tool at once, and the caller reads it later with `call_result`.
 */

import type { CallToolRequest, CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  BUILTIN_NAMES,
  BUILTINS,
  type BuiltinName,
  CALL_META,
  CAUSE_META,
  type CallReceipt,
  objectSchema,
} from "../protocol/index.ts";
import type { Audit } from "./audit.ts";
import type { builtins } from "./builtins.ts";
import type { CallRecord, Calls } from "./calls.ts";
import { Invalid, invalid, NotFound, Refusal } from "./errors.ts";
import type { CallContext, Surface } from "./mcp.ts";
import type { ActorRecord, Registry } from "./registry.ts";
import { isOneWay, routedOutputSchema, violation } from "./schemas.ts";
import { route, routes } from "./wiring.ts";

export interface Timing {
  /** How long a routed call waits for its result before it returns pending. */
  waitMs: number;
  /** How often a waiting call reports progress. */
  stepMs: number;
}

const BUILTIN_TOOLS: Record<BuiltinName, Tool> = Object.fromEntries(
  BUILTIN_NAMES.map((name) => [
    name,
    {
      name,
      description: BUILTINS[name].description,
      inputSchema: objectSchema(BUILTINS[name].request, "input") as Tool["inputSchema"],
      outputSchema: objectSchema(BUILTINS[name].response, "output") as Tool["outputSchema"],
      annotations: { readOnlyHint: !BUILTINS[name].writes },
    },
  ]),
) as Record<BuiltinName, Tool>;

const isBuiltin = (name: string): name is BuiltinName => Object.hasOwn(BUILTINS, name);

type Untyped = (actor: ActorRecord, request: unknown, waiting: unknown) => Promise<unknown>;

export class AvailableTools implements Surface {
  private readonly registry: Registry;
  private readonly calls: Calls;
  private readonly handlers: ReturnType<typeof builtins>;
  private readonly audit: Audit;
  private readonly timing: Timing;

  constructor(
    registry: Registry,
    calls: Calls,
    handlers: ReturnType<typeof builtins>,
    audit: Audit,
    timing: Timing,
  ) {
    this.registry = registry;
    this.calls = calls;
    this.handlers = handlers;
    this.audit = audit;
    this.timing = timing;
  }

  tools(actorId: string): Tool[] {
    const actor = this.registry.found(actorId);
    const own = BUILTIN_NAMES.filter((name) => !BUILTINS[name].rootOnly || actor.manager === null);
    const routed = routes(this.registry, actor).map(({ name, tool }) => {
      // The core answers routed calls itself, with a bounded wait, so it offers no tasks.
      const { execution: _, outputSchema, ...rest } = tool;
      const routedOutput = outputSchema && routedOutputSchema(outputSchema);
      return { ...rest, name, ...(routedOutput ? { outputSchema: routedOutput } : {}) } as Tool;
    });
    return [...own.map((name) => BUILTIN_TOOLS[name]), ...routed];
  }

  async call(
    actorId: string,
    params: CallToolRequest["params"],
    context: CallContext,
  ): Promise<CallToolResult> {
    const actor = this.registry.found(actorId);
    try {
      return isBuiltin(params.name)
        ? await this.builtin(actor, params.name, params.arguments ?? {}, context)
        : await this.routed(actor, params, context);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return {
        content: [{ type: "text", text: `${error.code}: ${error.message}` }],
        isError: true,
      };
    }
  }

  private async builtin(
    actor: ActorRecord,
    name: BuiltinName,
    args: Record<string, unknown>,
    context: CallContext,
  ): Promise<CallToolResult> {
    const spec = BUILTINS[name];
    if (spec.rootOnly && actor.manager !== null) throw new NotFound(`there is no tool ${name}`);
    const parsed = spec.request.safeParse(args);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const waiting = {
      stepMs: this.timing.stepMs,
      signal: context.signal,
      progress: () => context.progress("waiting"),
    };
    let result: Record<string, unknown>;
    try {
      const handler = this.handlers[name] as Untyped;
      result = (await handler(actor, parsed.data, waiting)) as Record<string, unknown>;
    } catch (error) {
      if (spec.writes && error instanceof Refusal) {
        const target = (args.actor ?? args.call ?? null) as string | null;
        this.audit.record(actor.id, name, target, error.code);
      }
      throw error;
    }
    if (spec.writes) {
      const target = (result.id ?? (result.actor as { id?: string } | undefined)?.id) as string;
      this.audit.record(actor.id, name, target, "ok");
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  }

  private async routed(
    actor: ActorRecord,
    params: CallToolRequest["params"],
    context: CallContext,
  ): Promise<CallToolResult> {
    const found = route(this.registry, actor, params.name);
    const refuse = (refusal: Refusal) => {
      this.audit.record(actor.id, "call", null, refusal.code);
      return refusal;
    };
    if (!found) throw refuse(new NotFound(`there is no tool ${params.name}`));
    const input = params.arguments ?? {};
    const problem = violation(found.tool.inputSchema, input);
    if (problem !== undefined) {
      throw refuse(
        new Invalid(`the input does not match the input schema of ${params.name}: ${problem}`),
      );
    }
    const cause = params._meta?.[CAUSE_META] ?? null;
    if (cause !== null && typeof cause !== "string") {
      throw refuse(new Invalid(`${CAUSE_META} must be the id of a call`));
    }
    const call = this.calls.create(actor, found, input, cause);
    const waitMs = isOneWay(found.tool.outputSchema) ? 0 : this.timing.waitMs;
    const settled = await this.calls.wait(call.id, waitMs, {
      stepMs: this.timing.stepMs,
      signal: context.signal,
      progress: () => context.progress(`waiting for ${params.name}`),
    });
    return resultOf(settled);
  }
}

/** A routed call's result for its caller: the called actor's own result once done. */
function resultOf(call: CallRecord): CallToolResult {
  const receipt: CallReceipt = { id: call.id, state: call.state };
  const _meta = { [CALL_META]: receipt };
  if (call.state === "done") return { ...(call.output as CallToolResult), _meta };
  if (call.state === "pending") {
    return {
      content: [
        { type: "text", text: `call ${call.id} is pending; read it later with call_result` },
      ],
      structuredContent: { call: call.id, state: "pending" },
      _meta,
    };
  }
  const text = call.state === "failed" ? `failed: ${call.error}` : `call ${call.id} was withdrawn`;
  return { content: [{ type: "text", text }], isError: true, _meta };
}
