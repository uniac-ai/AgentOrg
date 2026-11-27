import { z } from "zod";

/** A way a provider makes connections, such as `url` or `command`. */
export const ConnectionKind = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(64);
/** The parameters of a connection, fitting its kind's `params` schema. */
export const ConnectionParams = z.record(z.string(), z.json());
