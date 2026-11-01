/** Hub-owned shared resource claims. */
import { z } from "zod";
import { toolDefinition } from "./json-schema.ts";
import { Id, LIMITS, Text, Timestamp } from "./records.ts";

export const Resource = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.id)
  .describe("A shared resource known to the organization.");
export const Claim = z
  .strictObject({
    resource: Resource,
    holder: Id,
    note: Text,
    until: Timestamp.nullable(),
    claimed_at: Timestamp,
  })
  .meta({ id: "Claim" });
export const ClaimRequest = z.strictObject({
  resource: Resource,
  note: Text,
  until: Timestamp.optional(),
});
export const ReleaseRequest = z.strictObject({ resource: Resource });
export const CLAIMS = toolDefinition("claims", {
  claim: {
    writes: true,
    level: "organization",
    request: ClaimRequest,
    response: Claim,
    description:
      "Claim a shared resource. Claiming another Actor's current resource is refused; claiming your own renews it. A claim ends when released, expired or its holder is closed.",
  },
  release: {
    writes: true,
    level: "organization",
    request: ReleaseRequest,
    response: Claim,
    description: "Release a shared resource you hold; the root may release any.",
  },
});
