/**
 * The domain's vocabulary, which actors may import too: the records, the interface descriptor,
 * the built-ins' schemas, the communication standard's records and requests, and the shapes of a
 * Hub caller's answer.
 */

import { Level } from "@uniac/agentic-workspace/contracts";
import { z } from "zod";
import { Id, Interface } from "./records.ts";

export * from "./builtins.ts";
export * from "./claims.ts";
export * from "./json-schema.ts";
export * from "./records.ts";
export * from "./system.ts";
export * from "./team.ts";
export * from "./workspace.ts";

export { Level };
export type InterfaceDescriptor = z.output<typeof Interface>;

/** A Hub Tool's stable identity, name and callable interfaces. */
export const Tool = z
  .strictObject({
    id: Id,
    name: z.string(),
    interfaces: z.array(
      z.strictObject({
        interface: Interface,
        call: z
          .string()
          .describe("The alias to pass to call, independent of the local interface name."),
        read_only: z.boolean().optional().describe("An interface that only reads."),
        level: Level.optional().describe(
          "The smallest organization level that presents it: report, team or organization. Every Hub interface carries one.",
        ),
      }),
    ),
  })
  .meta({ id: "Tool" });

export type ToolDescriptor = z.output<typeof Tool>;
export type Offer = Omit<ToolDescriptor["interfaces"][number], "call">;

/** A Hub operation's result or domain refusal. */
export type Answer =
  | { state: "done"; value: unknown }
  | { state: "refused"; code: string; message: string };
