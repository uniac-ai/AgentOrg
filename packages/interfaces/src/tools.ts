import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";
import { Pictures } from "./picture.js";

const ToolName = z.string().min(1).max(128);
/** A word the caller chooses for a set of calls, unique to it, such as a random id. */
const Group = z.string().min(1).max(128);
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
    /**
     * Run one tool. `output` is its result as text. `group` puts what the call starts in that
     * group, for `stop`; a provider that can't stop what it starts takes no notice of it.
     */
    call: method({
      input: z.object({
        name: ToolName,
        arguments: z.record(z.string(), z.json()),
        group: Group.optional(),
      }),
      output: z.object({
        output: z.string().max(OUTPUT_MAX),
        failed: z.literal(true).optional(),
        /** The pictures the tool gave with its result. */
        images: Pictures.optional(),
      }),
    }),
    /**
     * End what calls made under `group` started and is still running, that of a call still under
     * way included: that call then answers as its work ended. It answers once the provider has
     * begun ending them, without waiting for them to end; one that keeps nothing running, or
     * can't end what it runs, answers at once having ended nothing. The group can be used again
     * after, and asking again is harmless.
     */
    stop: method({ input: z.object({ group: Group }), output: z.object({}) }),
  },
  events: {
    /** The tools changed: `list` again. */
    changed: event(z.object({})),
  },
});
