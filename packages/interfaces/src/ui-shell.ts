import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";

/**
 * `ui.shell@1`: what the shell offers a view in its frame, the mirror of `ui.view@1`. A view's
 * sandbox can't open a tab or start a sign-in, so it asks the shell, whose frame runtime serves
 * this slot.
 */
export const uiShell = defineInterface({
  name: "ui.shell",
  major: 1,
  kind: "rpc",
  methods: {
    /** Open an `https:` address in a browser tab, outside the frame. */
    openExternal: method({
      input: z.object({
        url: z
          .string()
          .max(2048)
          .regex(/^https:\/\/\S+$/),
      }),
      output: z.object({}),
    }),
    /** Start the person's sign-in to the model's account, as the shell's own button does. */
    signIn: method({ input: z.object({}), output: z.object({}) }),
  },
});
