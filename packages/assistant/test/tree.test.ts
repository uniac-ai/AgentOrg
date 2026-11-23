import assert from "node:assert/strict";
import test from "node:test";
import type { SettingsRoot } from "@agentorg/interfaces";
import type { z } from "zod";
import { settingsOf } from "../src/tree.ts";

const SELF = "act_executor";

test("the tree of what is mounted on an agent reads as its words, its skills and the plugins this executor holds of it", () => {
  const review = { name: "review", description: "Review a change." };
  const tree: z.input<typeof SettingsRoot>[] = [
    { mounted: "instructions", capability: "instructions", arguments: { text: "Keep the docs." } },
    { mounted: "skills", capability: "skills", arguments: { skills: [review] } },
    { mounted: "control", capability: "control", arguments: {}, provider: SELF },
    { mounted: "memory", capability: "memory", arguments: {}, provider: SELF },
    { mounted: "mnt_1", capability: "github", arguments: { owner: "o" }, provider: SELF },
    { mounted: "mnt_2", capability: "browser", arguments: {}, provider: "act_other" },
  ];
  // Control isn't carried yet; another provider's root is that provider's to hold.
  assert.deepEqual(settingsOf(tree, SELF), {
    instructions: "Keep the docs.",
    skills: [review],
    plugins: [
      { name: "memory", capability: "memory" },
      { name: "github", settings: { owner: "o" }, capability: "github" },
    ],
  });
});
