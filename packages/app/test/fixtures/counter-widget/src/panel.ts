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
        // A call that fails says so in the widget, rather than leaving it blank.
        const failed = (error: unknown) => {
          shown.textContent = `The counter didn't answer: ${error instanceof Error ? error.message : String(error)}`;
        };
        const read = () => ctx.slots.counter.call.get({}).then(({ value }) => show(value), failed);
        add.addEventListener("click", () => {
          void ctx.slots.counter.call.increment({}).then(({ value }) => show(value), failed);
        });
        // Read now (the slot is bound before mount), and again whenever it is usable again.
        void read();
        const offBind = ctx.slots.counter.onBind(() => void read());
        return () => offBind();
      },
    });
  },
});
