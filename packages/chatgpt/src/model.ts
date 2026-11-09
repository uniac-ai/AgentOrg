// The model Actor: Sign in with ChatGPT, and inference on the person's ChatGPT plan.
import { accountLogin, httpEgress, kv, llmSession } from "@agentorg/interfaces";
import { defineActor } from "@agentorg/sdk";
import { serveChatGPT } from "./serve.js";

export default defineActor({
  slots: { web: httpEgress, store: kv },
  exports: { login: accountLogin, session: llmSession },
  start(ctx) {
    serveChatGPT(ctx.exports, {
      fetch: (request) => ctx.slots.web.fetch(request),
      store: ctx.slots.store.call,
      log: ctx.log,
    });
  },
});
