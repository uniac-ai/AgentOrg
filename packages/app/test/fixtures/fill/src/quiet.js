import { uiView } from "@agentorg/interfaces";
import { defineWidget } from "@agentorg/sdk";

/** A view that draws nothing: its frame fills its placement all the same. */
export default defineWidget({
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({ mount() {} });
  },
});
