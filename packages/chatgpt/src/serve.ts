// What ChatGPT is, however it is run: its two exports, on a way out and a place to keep the sign-in.
import type { accountLogin, llmSession } from "@agentorg/interfaces";
import type { Context, Interface, Log } from "@agentorg/sdk";
import { createAccount, type Store } from "./account.js";
import type { Fetch } from "./oauth.js";
import { createSession } from "./responses.js";

type Exports = { login: typeof accountLogin; session: typeof llmSession };

export function serveChatGPT(
  exports: Context<Record<never, Interface>, Exports>["exports"],
  options: {
    fetch: Fetch;
    store: Store;
    log: Log;
    /** How a wait between two tries of a response is spent, and the time. For tests. */
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    now?: () => number;
  },
) {
  const { store, log } = options;
  /** Every request's method, host, status and request id are logged; never its content. */
  const fetch: Fetch = async (request) => {
    const { method } = request;
    const { host } = new URL(request.url);
    const response = await options.fetch(request);
    log.info("request", {
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
    store,
    changed(state) {
      session?.reset();
      exports.login.emit("changed", { state });
    },
  });
  const started = createSession({
    fetch,
    account,
    ...(options.wait ? { wait: options.wait } : {}),
    ...(options.now ? { now: options.now } : {}),
    log,
    // Each consumer's text goes to that consumer alone.
    delta: (caller, requestId, text, call) =>
      exports.session.emit("delta", { requestId, text, ...(call ? { call } : {}) }, { to: caller }),
  });
  session = started;
  exports.login.implement({
    status: () => account.status(),
    start: (input) => account.start(input),
    complete: (input) => account.complete(input),
    logout: () => account.logout(),
  });
  exports.session.implement({
    models: () => started.models(),
    respond: (input, { caller }) => started.respond(input, caller),
    cancel: (input, { caller }) => started.cancel(input, caller),
  });
  return started;
}
