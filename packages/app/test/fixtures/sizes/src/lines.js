import { uiView } from "@agentorg/interfaces";
import { defineWidget } from "@agentorg/sdk";

/** A view of `count` lines, each 24 px; a click on it adds one, so its height changes. */
export const lines = (count, label) =>
  defineWidget({
    exports: { view: uiView },
    start(ctx) {
      ctx.exports.view.implement({
        mount(el) {
          const list = el.ownerDocument.createElement("ol");
          list.style.cssText = "margin:0;padding:0 0 0 28px;line-height:24px";
          const add = () => {
            const item = el.ownerDocument.createElement("li");
            item.textContent = `${label} ${list.children.length + 1}`;
            list.append(item);
          };
          for (let i = 0; i < count; i++) add();
          list.addEventListener("click", add);
          el.replaceChildren(list);
        },
      });
    },
  });
