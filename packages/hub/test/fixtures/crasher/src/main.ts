// A test package whose start fails.
import { defineActor } from "@agentorg/sdk";

export default defineActor({
  start() {
    throw new Error("bad start");
  },
});
