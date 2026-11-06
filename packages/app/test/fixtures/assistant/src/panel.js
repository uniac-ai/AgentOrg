import { uiView } from "@agentorg/interfaces";
import { defineWidget } from "@agentorg/sdk";

export default defineWidget({
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({
      mount(el) {
        el.textContent = "panel";
      },
    });
  },
});
