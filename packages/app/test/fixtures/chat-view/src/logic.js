import { chat } from "@agentorg/interfaces";
import { defineActor, Refused } from "@agentorg/sdk";

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * A scripted chat@1: it records and echoes what it's sent. "slow …" takes a second to record the
 * message, as a loaded machine might; "refuse …" is refused.
 */
export default defineActor({
  exports: { chat },
  start(ctx) {
    const record = [];
    let n = 0;
    const add = (role, text) => {
      const message = {
        id: String(++n).padStart(4, "0"),
        role,
        text,
        at: new Date().toISOString(),
      };
      record.push(message);
      ctx.exports.chat.emit("message", message);
      return message;
    };
    ctx.exports.chat.implement({
      history: () => ({ messages: record.slice(-100), more: false }),
      state: () => ({ state: "idle" }),
      cancel: () => ({}),
      retry: () => ({ messageId: record.at(-1)?.id ?? "0" }),
      send: async ({ text }) => {
        if (text.startsWith("refuse")) throw new Refused("busy", "A turn is running.");
        if (text.startsWith("slow")) await wait(1000);
        const { id } = add("user", text);
        ctx.exports.chat.emit("status", { state: "thinking" });
        add("assistant", `Echo: ${text}`);
        ctx.exports.chat.emit("status", { state: "idle" });
        return { messageId: id };
      },
    });
  },
});
