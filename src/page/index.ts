/**
 * The decisions page, mounted at `/`.
 *
 * Routes reach the service layer as `c.var.service` and call it with `{ channel: "page" }` as the
 * caller. User operations, such as answering any open ask as the user, are served only here, to a
 * signed-in page session with its CSRF token. Sign-in starts at `/ui/login?token=...`, whose token
 * comes from the `ui_login_link` operation and is used up by `service.redeemLoginToken`.
 */

import { Hono } from "hono";
import type { AppEnv } from "../http.ts";

export const page = new Hono<AppEnv>();
