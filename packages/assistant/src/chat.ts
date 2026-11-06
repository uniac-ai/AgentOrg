// The assistant's chat, in a view: its messages as they stream, and a composer.
import { chat, uiShell, uiView } from "@agentorg/interfaces";
import { defineWidget, NotConnected, Refused } from "@agentorg/sdk";
import { MANAGE_USAGE, type Notice, noticeOf } from "./notice.js";

interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
}

// The shell's theme tokens, with the dark defaults (layers at 20 and 35).
const STYLE = `
.chat{display:flex;flex-direction:column;height:100%;box-sizing:border-box;padding:12px;gap:8px;
  background:var(--canvas,rgb(20,20,20));color:var(--fg,rgb(230,230,230));font:14px/1.45 system-ui,sans-serif}
.log{flex:1;overflow-y:auto;scrollbar-width:none;display:flex;flex-direction:column;gap:8px}
.msg{white-space:pre-wrap;word-break:break-word;max-width:80ch}
.user{align-self:flex-end;background:var(--surface,rgb(35,35,35));padding:6px 10px;border-radius:10px}
.tool{color:var(--muted,rgb(150,150,150));font-size:12px}
.notice{background:var(--surface,rgb(35,35,35));padding:10px;border-radius:8px;display:flex;flex-direction:column;gap:6px}
.notice[hidden]{display:none}
.notice b{font-weight:600}
.composer{display:flex;gap:8px;align-items:flex-end}
textarea{flex:1;resize:none;min-height:38px;max-height:160px;background:var(--surface,rgb(35,35,35));
  color:inherit;border:0;border-radius:8px;padding:8px;font:inherit;scrollbar-width:none}
.log::-webkit-scrollbar,textarea::-webkit-scrollbar{display:none}
button{background:var(--accent,rgb(230,230,230));color:var(--accent-fg,rgb(20,20,20));border:0;
  border-radius:8px;padding:8px 12px;font:inherit;cursor:pointer}
button.link{background:none;color:var(--muted,rgb(150,150,150));padding:0;text-decoration:underline}
.plan{display:flex;gap:8px;color:var(--muted,rgb(150,150,150));font-size:12px}
`;

/** A failure as the code and message a notice is made from. */
const codeOf = (error: unknown) => ({
  code:
    error instanceof Refused
      ? error.code
      : error instanceof NotConnected
        ? "not_connected"
        : "failed",
  message: error instanceof Error ? error.message : "That didn't work.",
});

export default defineWidget({
  slots: { chat, shell: uiShell },
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({
      mount(root, { theme }) {
        const doc = root.ownerDocument;
        const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) => {
          const node = doc.createElement(tag);
          if (className) node.className = className;
          return node;
        };
        /** The record, in order; a row per message, and the text still streaming by id. */
        let messages: Message[] = [];
        const rows = new Map<string, HTMLElement>();
        const streaming = new Map<string, string>();
        let busy = false;
        let notice: Notice | undefined;
        /** Whether older messages remain before the first one shown. */
        let hasEarlier = false;

        const style = make("style");
        style.textContent = STYLE;
        const frame = make("div", "chat");
        for (const [name, value] of Object.entries(theme)) frame.style.setProperty(name, value);
        const log = make("div", "log");
        log.setAttribute("role", "log");
        log.setAttribute("aria-label", "Conversation");
        const box = make("div", "notice");
        box.setAttribute("role", "alert");
        box.hidden = true;
        const input = make("textarea");
        input.setAttribute("aria-label", "Message");
        input.rows = 1;
        const send = make("button");
        send.textContent = "Send";
        const plan = make("div", "plan");
        const using = make("span");
        using.textContent = "Using ChatGPT plan";
        const manage = make("button", "link");
        manage.textContent = "Manage usage";
        plan.append(using, manage);
        const earlier = make("button", "link");
        earlier.textContent = "Earlier messages";
        const composer = make("div", "composer");
        composer.append(input, send);
        frame.append(log, box, composer, plan);
        root.replaceChildren(style, frame);

        /** Change the log, keeping it at the bottom only if it was there. */
        const changing = (change: () => void) => {
          const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
          change();
          if (atBottom) log.scrollTop = log.scrollHeight;
        };
        const rowFor = (id: string, role: Message["role"], text: string) => {
          let row = rows.get(id);
          if (!row) {
            row = make("div");
            rows.set(id, row);
            log.append(row);
          }
          row.className = `msg ${role}`;
          row.textContent = text;
          return row;
        };
        const redraw = () =>
          changing(() => {
            rows.clear();
            log.replaceChildren();
            if (hasEarlier) log.append(earlier);
            for (const message of messages) rowFor(message.id, message.role, message.text);
            for (const [id, text] of streaming) rowFor(id, "assistant", text);
          });
        const show = (next: Notice | undefined) => {
          notice = next;
          box.hidden = notice === undefined;
          box.replaceChildren();
          if (!notice) return;
          if (notice.title) {
            const title = make("b");
            title.textContent = notice.title;
            box.append(title);
          }
          const text = make("span");
          text.textContent = notice.text;
          box.append(text);
          const action = notice.action;
          const lastUser = messages.findLast((m) => m.role === "user");
          if (action && (action.run !== "retry" || lastUser)) {
            const button = make("button");
            button.textContent = action.label;
            button.addEventListener("click", () => run(action.run));
            box.append(button);
          }
        };
        const failed = (error: unknown) => show(noticeOf(codeOf(error)));
        const setBusy = (next: boolean) => {
          busy = next;
          send.textContent = busy ? "Stop" : "Send";
        };
        const run = (action: NonNullable<Notice["action"]>["run"]) => {
          if (action === "manage")
            ctx.slots.shell.call.openExternal({ url: MANAGE_USAGE }).catch(failed);
          else if (action === "signIn") ctx.slots.shell.call.signIn({}).catch(failed);
          else {
            // Retry is the person's last message, sent again.
            const lastUser = messages.findLast((m) => m.role === "user");
            if (lastUser) void submit(lastUser.text);
          }
        };
        async function submit(text: string) {
          show(undefined);
          try {
            await ctx.slots.chat.call.send({ text });
          } catch (error) {
            if (!input.value) input.value = text;
            failed(error);
          }
        }
        /** The record, read again whenever the chat becomes usable; it outranks what streamed. */
        const load = () => {
          // Only what arrives while the page is read is newer than it: everything before is
          // in the page, or older than it.
          const since = messages.length;
          return ctx.slots.chat.call
            .history({ limit: 100 })
            .then(({ messages: page, more }) => {
              const known = new Set(page.map((m) => m.id));
              messages = [...page, ...messages.slice(since).filter((m) => !known.has(m.id))];
              hasEarlier = more;
              redraw();
            })
            .catch(failed);
        };
        /** The page before the oldest message shown. */
        const loadEarlier = () => {
          const oldest = messages[0];
          if (!oldest) return;
          ctx.slots.chat.call
            .history({ before: oldest.id, limit: 100 })
            .then(({ messages: page, more }) => {
              const known = new Set(messages.map((m) => m.id));
              messages = [...page.filter((m) => !known.has(m.id)), ...messages];
              hasEarlier = more;
              redraw();
            })
            .catch(failed);
        };

        send.addEventListener("click", () => {
          if (busy) {
            ctx.slots.chat.call.cancel({}).catch(failed);
            return;
          }
          const text = input.value;
          if (!/\S/.test(text)) return;
          input.value = "";
          void submit(text);
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            // While a turn runs, Enter does nothing: Stop is a deliberate click.
            if (!busy) send.click();
          }
        });
        manage.addEventListener("click", () => run("manage"));
        earlier.addEventListener("click", () => loadEarlier());

        const off = [
          ctx.slots.chat.on("message", (message) => {
            streaming.delete(message.id);
            if (!messages.some((m) => m.id === message.id)) messages.push(message);
            changing(() => rowFor(message.id, message.role, message.text));
          }),
          ctx.slots.chat.on("delta", ({ id, text }) => {
            if (messages.some((m) => m.id === id)) return;
            const sofar = (streaming.get(id) ?? "") + text;
            streaming.set(id, sofar);
            changing(() => rowFor(id, "assistant", sofar));
          }),
          ctx.slots.chat.on("status", (status) => {
            setBusy(status.state === "thinking" || status.state === "tool");
            if (status.state === "thinking") show(undefined);
            if (status.state === "idle" || status.state === "error") {
              // A reply cut off by a cancel or an error never settles: it goes.
              for (const id of streaming.keys()) {
                rows.get(id)?.remove();
                rows.delete(id);
              }
              streaming.clear();
            }
            if (status.state === "error" && status.detail) show(noticeOf(status.detail));
          }),
          ctx.slots.chat.onBind(() => void load()),
        ];
        if (ctx.slots.chat.bound) void load();
        return () => {
          for (const stop of off) stop();
        };
      },
    });
  },
});
