// The model Actor: Sign in with ChatGPT, and inference on the person's ChatGPT plan.
import { accountLogin, httpEgress, kv, llmSession } from "@agentorg/interfaces";
import { defineActor } from "@agentorg/sdk";
import { createAccount } from "./account.js";
import { createSession } from "./responses.js";

export default defineActor({
  slots: { web: httpEgress, store: kv },
  exports: { login: accountLogin, session: llmSession },
  start(ctx) {
    /** Every request goes out through the `web` slot; its method, host, status and request id are logged. */
    const fetch = async (request: Request) => {
      const { method } = request;
      const { host } = new URL(request.url);
      const response = await ctx.slots.web.fetch(request);
      ctx.log.info("request", {
        method,
        host,
        status: response.status,
        requestId: response.headers.get("x-request-id") ?? undefined,
      });
      return response;
    };
    let session: ReturnType<typeof createSession> | undefined;
    const account = createAccount({
      fetch,
      store: ctx.slots.store.call,
      changed(state) {
        session?.reset();
        ctx.exports.login.emit("changed", { state });
      },
    });
    session = createSession({
      fetch,
      account,
      // Each consumer's text goes to that consumer alone.
      delta: (caller, requestId, text) =>
        ctx.exports.session.emit("delta", { requestId, text }, { to: caller }),
    });
    ctx.exports.login.implement({
      status: () => account.status(),
      start: (input) => account.start(input),
      complete: (input) => account.complete(input),
      logout: () => account.logout(),
    });
    ctx.exports.session.implement({
      models: () => session.models(),
      respond: (input, { caller }) => session.respond(input, caller),
      cancel: (input, { caller }) => session.cancel(input, caller),
    });
  },
});
