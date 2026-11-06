import { accountLogin, llmSession } from "@agentorg/interfaces";
import { defineActor } from "@agentorg/sdk";

export default defineActor({
  exports: { login: accountLogin, session: llmSession },
  start() {},
});
