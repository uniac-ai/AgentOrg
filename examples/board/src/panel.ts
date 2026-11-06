// The board's widget, in a view: its cards, how many are done, and a way to add one.
import { uiView } from "@agentorg/interfaces";
import { defineWidget } from "@agentorg/sdk";
import { board } from "board-interfaces";

/** The view's look, from the shell's theme tokens. */
const STYLE = `
.meter{display:flex;gap:3px;margin:2px 0 10px}
.meter i{height:4px;flex:1;border-radius:2px;background:var(--raised)}
.meter i.on{background:var(--ok)}
.cards{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.card{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;background:var(--raised)}
.card.done span:last-child{color:var(--faint);text-decoration:line-through}
.check{width:16px;height:16px;border-radius:5px;border:1.5px solid var(--faint);display:grid;place-items:center;font-size:10px;font-weight:700;flex:none;box-sizing:border-box}
.card.done .check{background:var(--ok);border-color:var(--ok);color:white}
.add{display:flex;margin-top:8px}
.add input{flex:1;height:34px;border-radius:9px;border:0;background:var(--raised);color:inherit;font:inherit;padding:0 10px;outline:0}
.add input:focus{box-shadow:0 0 0 1.5px var(--ring)}
.note{color:var(--muted);font-size:12.5px;margin:6px 0 0}
`;

export default defineWidget({
  slots: { board },
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({
      mount(el) {
        const doc = el.ownerDocument;
        const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "") => {
          const node = doc.createElement(tag);
          if (className) node.className = className;
          return node;
        };
        const style = make("style");
        style.textContent = STYLE;
        const meter = make("div", "meter");
        meter.setAttribute("role", "img");
        const list = make("ul", "cards");
        // No form: a frame sandboxed without allow-forms submits none, so Enter adds the card.
        const add = make("div", "add");
        const input = make("input");
        input.setAttribute("aria-label", "New card");
        input.placeholder = "Add a card";
        input.maxLength = 200;
        add.append(input);
        const note = make("p", "note");
        note.setAttribute("role", "status");
        el.replaceChildren(style, meter, list, add, note);

        const draw = async () => {
          try {
            const { cards } = await ctx.slots.board.call.list({});
            const done = cards.filter((card) => card.done).length;
            meter.setAttribute("aria-label", `${done} of ${cards.length} done`);
            meter.replaceChildren(...cards.map((card) => make("i", card.done ? "on" : "")));
            list.replaceChildren(
              ...cards.map((card) => {
                const item = make("li", card.done ? "card done" : "card");
                const check = make("span", "check");
                check.textContent = card.done ? "✓" : "";
                const title = make("span");
                title.textContent = card.title;
                item.append(check, title);
                return item;
              }),
            );
            note.textContent = "";
          } catch {
            note.textContent = "The board isn't answering.";
          }
        };
        input.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          const title = input.value.trim();
          if (!title) return;
          ctx.slots.board.call.add({ title }).then(
            () => {
              input.value = "";
              input.focus();
            },
            () => {
              note.textContent = "That card wasn't added. Try again.";
            },
          );
        });
        const off = ctx.slots.board.on("changed", () => void draw());
        // Bound again, or its logic back after a restart: read the cards again.
        const offBind = ctx.slots.board.onBind(() => void draw());
        void draw();
        return () => {
          off();
          offBind();
        };
      },
    });
  },
});
