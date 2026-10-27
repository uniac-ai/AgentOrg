/** Sign-in to the decisions page: a one-time link that becomes a page session cookie. */

import { z } from "zod";
import { Ref, Timestamp } from "./common.ts";

export const LoginLinkCreate = z.strictObject({}).meta({ id: "LoginLinkCreate" });

export const LoginLink = z
  .strictObject({
    path: Ref.describe("The page path that signs in: /ui/login?token=... It works once."),
    expires_at: Timestamp,
  })
  .meta({ id: "LoginLink" });

export const PageSession = z.strictObject({
  id: z.string(),
  csrf_token: z.string(),
  expires_at: Timestamp,
});
