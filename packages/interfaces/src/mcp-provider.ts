import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { Id } from "./hub.js";

/** A way a provider makes connections, such as `url` or `command`. */
export const ConnectionKind = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(64);
/** `connecting` before its first success, `connected`, or `down` and being tried again. */
export const ConnectionState = z.enum(["connecting", "connected", "down"]);
/** A connection's tools, for people to read; a provider cuts a long description to fit. */
export const ConnectionTool = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(512).optional(),
});
/** How a connection stands now: `detail` says why it is down, and never holds a secret. */
export const ConnectionStatus = z.object({
  state: ConnectionState,
  detail: z.string().max(2000).optional(),
  tools: z.array(ConnectionTool),
});
/** The parameters of a connection, fitting its kind's `params` schema. */
export const ConnectionParams = z.record(z.string(), z.json());
/**
 * What a server needs and shouldn't be seen, by name, such as a bearer token. Write-only: the values
 * cross once, in `create`, and go only to the provider's own private file.
 */
export const ConnectionSecrets = z.record(
  z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .max(256),
  z.string().min(1).max(16_384),
);
/** What a connection attaches to or runs, for people to read: never a secret. */
export const ConnectionTarget = z.string().min(1).max(4096);

/**
 * `mcp.provider@1`: a program that makes connections to MCP servers. Each connection joins the
 * Hub as its own Actor, whose id is `connection`, exporting `tools@1` as `tools`. MCP itself stays
 * behind this interface.
 *
 * A secret a server needs is given once, in `create`'s `secrets`, and stays with the provider: its
 * value is never in `params`, `target`, `detail`, or anything else read back. `status` and `remove` are refused `unknown` for a connection the
 * provider doesn't hold.
 */
export const mcpProvider = defineInterface({
  name: "mcp.provider",
  major: 1,
  kind: "rpc",
  methods: {
    /** The kinds it offers; `params` and `secrets` are the JSON Schemas of what each one takes. */
    kinds: method({
      input: z.object({}),
      output: z.object({
        kinds: z.array(
          z.object({
            kind: ConnectionKind,
            title: z.string().min(1).max(128),
            params: z.record(z.string(), z.json()),
            secrets: z.record(z.string(), z.json()),
          }),
        ),
      }),
    }),
    /**
     * Make a connection and its Actor, named `name`. It returns once the Actor has joined the Hub,
     * whether or not the server has answered yet; `status` says how it stands. Refused `invalid`
     * when `kind` isn't offered or `params` or `secrets` don't fit it.
     */
    create: method({
      input: z.object({
        kind: ConnectionKind,
        params: ConnectionParams,
        secrets: ConnectionSecrets.optional(),
        name: z.string().min(1).max(128),
      }),
      output: z.object({ connection: Id, target: ConnectionTarget }),
    }),
    status: method({ input: z.object({ connection: Id }), output: ConnectionStatus }),
    /** End the connection and close its Actor, which removes what was bound to it. */
    remove: method({ input: z.object({ connection: Id }), output: z.object({}) }),
  },
});
