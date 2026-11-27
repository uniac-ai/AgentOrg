import { z } from "zod";

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
