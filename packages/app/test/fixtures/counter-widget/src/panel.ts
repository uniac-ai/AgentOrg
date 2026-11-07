// The counter's widget: the number, and a button that adds one.
import { uiView } from "@agentorg/interfaces";
import { defineWidget } from "@agentorg/sdk";
import { counter } from "./interface.ts";

export default defineWidget({
  slots: { counter },
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({
      mount(el) {
        const doc = el.ownerDocument;
        const shown = doc.createElement("p");
        shown.setAttribute("role", "status");
        const add = doc.createElement("button");
        add.textContent = "Add one";
        el.replaceChildren(shown, add);
        const show = (value: number) => {
          shown.textContent = `Count: ${value}`;
        };
        const read = async () => show((await ctx.slots.counter.call.get({})).value);
        add.addEventListener("click", async () =>
          show((await ctx.slots.counter.call.increment({})).value),
        );
        // Read now (the slot is bound before mount), and again whenever it is usable again.
        void read();
        ctx.slots.counter.onBind(read);
      },
    });
  },
});
