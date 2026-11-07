import { uiView } from "@agentorg/interfaces";
import { defineWidget } from "@agentorg/sdk";

/** Plain HTML with no classes but one: the base styles draw it, and its own rule outranks them. */
export default defineWidget({
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({
      mount(el) {
        el.innerHTML = `<style>.own { background: rgb(1, 2, 3); }</style>
          <ul><li><input type="checkbox" aria-label="Done"><span>Water the plants</span></li></ul>
          <form><input aria-label="New"><button type="submit">Add</button><button type="button" class="own">Own</button></form>`;
      },
    });
  },
});
