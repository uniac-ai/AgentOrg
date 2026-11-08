import { uiView } from "@agentorg/interfaces";
import { defineWidget } from "@agentorg/sdk";

/** A view of `count` lines, each 24 px; a click on it adds one, so its content grows. */
export const lines = (count, label) =>
  defineWidget({
    exports: { view: uiView },
    start(ctx) {
      ctx.exports.view.implement({
        mount(el) {
          const list = el.ownerDocument.createElement("div");
          const add = () => {
            const line = el.ownerDocument.createElement("div");
            line.style.cssText = "height:24px;line-height:24px";
            line.textContent = `${label} ${list.children.length + 1}`;
            list.append(line);
          };
          for (let i = 0; i < count; i++) add();
          list.addEventListener("click", add);
          el.replaceChildren(list);
        },
      });
    },
  });
