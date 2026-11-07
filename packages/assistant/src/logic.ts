// The assistant's logic: its chat, its agent loop, and its connections as its tools.
import {
  chat,
  hubActors,
  hubExports,
  hubGrants,
  hubPackages,
  kv,
  layout,
  llmSession,
} from "@agentorg/interfaces";
import { defineActor, describeInterface } from "@agentorg/sdk";
import { createAgent } from "./agent.js";
import { createHistory } from "./history.js";
import { type ToolSlot, toolsOf } from "./tools.js";

/** The slots that become tools; `model` and `store` are the assistant's own. */
const tools = {
  layout,
  packages: hubPackages,
  actors: hubActors,
  grants: hubGrants,
  exports: hubExports,
};

export const INSTRUCTIONS = `You are an assistant in AgentOrg, working for the person who created you.
You act only through your tools, and your tools are exactly the connections the person gave you. If something needs a connection you don't have, say which.
To show the person a widget, place a view module of a running Actor on their dashboard with layout__place; actors__list and actors__get find the Actors.
Keep replies short and plain.`;

export default defineActor({
  slots: { model: llmSession, store: kv, ...tools },
  exports: { chat },
  start(ctx) {
    const history = createHistory(ctx.slots.store.call, ctx.log);
    ctx.slots.store.onBind(() => history.reset());
    ctx.slots.store.onUnbind(() => history.reset());
    const described = (Object.keys(tools) as (keyof typeof tools)[]).map(
      (name) => [name, describeInterface(tools[name])] as const,
    );
    const agent = createAgent({
      instructions: INSTRUCTIONS,
      model: ctx.slots.model,
      history,
      tools: () =>
        toolsOf(
          Object.fromEntries(
            described.map(([name, schemas]) => [
              name,
              { described: schemas, slot: ctx.slots[name] satisfies ToolSlot },
            ]),
          ),
        ),
      chat: {
        message: (message) => ctx.exports.chat.emit("message", message),
        delta: (id, text) => ctx.exports.chat.emit("delta", { id, text }),
        status: (status) => ctx.exports.chat.emit("status", status),
      },
      log: ctx.log,
    });
    ctx.slots.model.on("delta", ({ requestId, text }) => agent.delta(requestId, text));
    ctx.exports.chat.implement({
      send: ({ text }) => agent.send(text),
      history: ({ before, limit }) => history.page(before, limit ?? 50),
      cancel: async () => {
        await agent.cancel();
        return {};
      },
      state: () => agent.state(),
      retry: () => agent.retry(),
    });
  },
});
