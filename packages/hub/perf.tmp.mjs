import { buildPackage } from "@agentorg/sdk/build";

const dir = new URL("../assistant", import.meta.url).pathname;
for (let i = 0; i < 2; i++) {
  const t = performance.now();
  await buildPackage(dir, {
    out:
      "/private/tmp/claude-501/-Users-andrewshi-Uniac/522dd560-b02f-4cff-b28c-e7183672c4b6/scratchpad/perf/o" +
      i,
  });
  console.log("assistant build ms", Math.round(performance.now() - t));
}
