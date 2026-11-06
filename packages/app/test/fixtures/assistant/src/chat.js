import { chat, uiShell, uiView } from "@agentorg/interfaces";
import { defineWidget } from "@agentorg/sdk";

/** A chat view that shows what the shell gave it: its theme, its size, and its slot's answer. */
export default defineWidget({
  slots: { chat, shell: uiShell },
  exports: { view: uiView },
  start(ctx) {
    let show = () => {};
    ctx.exports.view.implement({
      mount(el, { theme, size }) {
        let outcome = "";
        show = (next) => {
          el.textContent = `chat ${theme["--canvas"]} ${next.width}x${next.height} ${outcome}`;
        };
        show(size);
        ctx.slots.chat.call.history({}).then(
          () => {
            outcome = "answered";
            show(size);
          },
          (error) => {
            outcome = error.name;
            show(size);
          },
        );
        ctx.log.info("mounted", { canvas: theme["--canvas"] });
      },
      resize: (size) => show(size),
    });
  },
});
