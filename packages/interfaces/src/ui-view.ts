import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";

const Size = z.object({ width: z.number().nonnegative(), height: z.number().nonnegative() });

/**
 * `ui.view@1`: a view module's render surface, which a shell imports to place the view.
 *
 * It is the one in-frame interface. The view renders into its own frame's DOM, which no wire
 * message can carry, so the SDK gives its export a handle of its own:
 * `implement({ mount(el, { theme, size }), resize?(size) })`, where `el` is the frame's root
 * element. The frame runtime maps these wire methods onto that handle. No other interface should
 * copy this shape: everything else crosses the wire as schemas.
 */
export const uiView = defineInterface({
  name: "ui.view",
  major: 1,
  kind: "rpc",
  methods: {
    /** Render. `theme` holds design tokens as CSS variables, from `ui.theme@1`. */
    mount: method({
      input: z.object({ theme: z.record(z.string(), z.string()), size: Size }),
      output: z.object({}),
    }),
    resize: method({ input: z.object({ size: Size }), output: z.object({}) }),
    unmount: method({ input: z.object({}), output: z.object({}) }),
  },
});
