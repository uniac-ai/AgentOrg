import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";

const ToolName = z.string().min(1).max(128);
/** The most a call's output carries: what a model's function output can take. */
const OUTPUT_MAX = 200_000;

/** One tool: `inputSchema` is the JSON Schema of its arguments, as its server states it. */
export const ToolEntry = z.object({
  name: ToolName,
  description: z.string().max(16_384).optional(),
  inputSchema: z.record(z.string(), z.json()),
});

/**
 * `tools@1`: a set of tools whose names and arguments are known only at run time. It is one fixed
 * contract however the tools change, so a binding to it holds while they do: the Hub checks a
 * call's envelope, and whoever runs the tool checks its arguments.
 *
 * A call is refused `unknown` when no tool has that name and `not_connected` when what runs the
 * tools can't be reached now. A tool that ran and failed isn't a refusal: it answers with
 * `failed`, and its `output` says why, for the caller's model to read.
 *
 * A provider fits what it has to these limits: it leaves out a tool whose name is too long or that
 * won't fit one frame, cuts a long description, and cuts an output, saying that it did.
 */
export const tools = defineInterface({
  name: "tools",
  major: 1,
  kind: "rpc",
  methods: {
    list: method({ input: z.object({}), output: z.object({ tools: z.array(ToolEntry) }) }),
    /** Run one tool. `output` is its result as text. */
    call: method({
      input: z.object({ name: ToolName, arguments: z.record(z.string(), z.json()) }),
      output: z.object({
        output: z.string().max(OUTPUT_MAX),
        failed: z.literal(true).optional(),
      }),
    }),
  },
  events: {
    /** The tools changed: `list` again. */
    changed: event(z.object({})),
  },
});
