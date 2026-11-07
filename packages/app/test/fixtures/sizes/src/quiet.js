import { uiView } from "@agentorg/interfaces";
import { defineWidget } from "@agentorg/sdk";

/** A view that draws nothing, so it reports no height and keeps the shell's default. */
export default defineWidget({
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({ mount() {} });
  },
});
