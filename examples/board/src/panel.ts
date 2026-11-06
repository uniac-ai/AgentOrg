// The board's widget, in a view.
import { uiView } from "@agentorg/interfaces";
import { defineWidget } from "@agentorg/sdk";
import { board } from "board-interfaces";

export default defineWidget({
  slots: { board },
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({
      mount(el) {
        const draw = async () => {
          const { cards } = await ctx.slots.board.call.list({});
          el.replaceChildren(
            ...cards.map((card) => {
              const item = document.createElement("li");
              item.textContent = card.done ? `✓ ${card.title}` : card.title;
              return item;
            }),
          );
        };
        const off = ctx.slots.board.on("changed", draw);
        void draw();
        return () => off();
      },
    });
  },
});
