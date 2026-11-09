import { accountLogin, llmSession } from "@agentorg/interfaces";
import type { Log } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { fileStore } from "./file-store.js";
import type { Fetch } from "./oauth.js";
import { serveChatGPT } from "./serve.js";

export interface ChatGPTOptions {
  hubUrl: string;
  /** Its own Actor. It needs no slots: no `storage`, no `net`. */
  actorId: string;
  credential: string;
  /** A private folder of its own, which holds the sign-in. */
  dir: string;
  log?: Log;
  /** How a request leaves, instead of the network. For tests. */
  fetch?: (request: Request, init: RequestInit) => Promise<Response>;
}

export interface ChatGPT {
  /** Stop every response under way and leave the Hub. The sign-in stays. */
  close(): Promise<void>;
}

const quiet: Log = { info() {}, warn() {}, error() {} };

/**
 * Run ChatGPT as a program: an Actor exporting `account.login@1` as `login` and `llm.session@1` as
 * `session`, with its sign-in in its own file and the network directly. It uses the person's plan,
 * never API billing. Only https goes out, and a redirect comes back as it is, never followed with a
 * request's token or form.
 */
export async function startChatGPT(options: ChatGPTOptions): Promise<ChatGPT> {
  const log = options.log ?? quiet;
  const store = fileStore(options.dir, log);
  const send = options.fetch ?? ((request, init) => fetch(request, init));
  const outbound: Fetch = async (request) => {
    if (new URL(request.url).protocol !== "https:")
      throw new Error("Only https addresses are reached.");
    // Given beside the request, not by a copy of it: a copy's link to its signal can be collected,
    // and a cancel would then wait for OpenAI's first byte.
    return send(request, { redirect: "manual" });
  };
  let session: ReturnType<typeof serveChatGPT> | undefined;
  const client = await connect({
    hubUrl: options.hubUrl,
    actorId: options.actorId,
    credential: options.credential,
    exports: { login: accountLogin, session: llmSession },
    log,
    start(ctx) {
      session = serveChatGPT(ctx.exports, { fetch: outbound, store, log });
    },
  });
  return {
    async close() {
      session?.stop();
      client.close();
      await client.closed;
    },
  };
}
