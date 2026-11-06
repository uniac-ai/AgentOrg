import {
  hubActors,
  hubExports,
  hubGrants,
  hubPackages,
  kv,
  layout,
  llmSession,
} from "@agentorg/interfaces";
import { defineActor } from "@agentorg/sdk";

// The assistant's slots as step 5 has them, so New agent's bindings can be made.
export default defineActor({
  slots: {
    model: llmSession,
    store: kv,
    layout,
    packages: hubPackages,
    actors: hubActors,
    grants: hubGrants,
    exports: hubExports,
  },
  start() {},
});
