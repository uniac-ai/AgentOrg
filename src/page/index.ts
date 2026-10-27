/**
 * The decisions page, mounted at `/`: a web app built from `web/` into `dist/page`, its JSON
 * routes under `/ui/api`, and its sign-in.
 *
 * Sign-in starts at `/ui/login?token=...`, whose one-time token comes from the `ui_login_link`
 * operation. Redeeming it starts a page session, kept in an HttpOnly, SameSite=Strict cookie. The
 * app's own paths all serve its `index.html`; the router in the app picks the view. Every page
 * response carries a Content-Security-Policy that runs only the app's own scripts and styles.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { AppEnv } from "../http.ts";
import { OperationError } from "../operations/index.ts";
import { COOKIE, pageApi } from "./api.ts";

/** The built app, two levels above the compiled `dist/src/page`. */
const BUILT = fileURLToPath(new URL("../../page", import.meta.url));

/** The app's own paths; each serves `index.html`, and the app's router picks the view. */
export const APP_PATHS = ["/", "/asks/*", "/people/*", "/activity", "/inbox", "/inbox/*"];

export const PAGE_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

async function app(c: Context<AppEnv>) {
  const index = await readFile(`${BUILT}/index.html`, "utf8").catch(() => undefined);
  if (index === undefined) return c.text("The page is not built: run npm run build.", 503);
  return c.html(index, 200, PAGE_HEADERS);
}

let assets: MiddlewareHandler | undefined;

export const page = new Hono<AppEnv>();

page.route("/ui/api", pageApi());

page.get("/ui/login", async (c) => {
  try {
    const session = await c.var.service.redeemLoginToken(c.req.query("token") ?? "");
    setCookie(c, COOKIE, session.id, {
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
      expires: new Date(session.expires_at),
    });
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    // A used or expired link opens the app signed out, which says how to sign in.
  }
  return c.redirect("/", 303);
});

page.use("/assets/*", async (c, next) => {
  assets ??= serveStatic({ root: BUILT });
  const found = await assets(c, next);
  if (!(found instanceof Response)) return;
  // Built assets have content hashes in their names, so a browser may keep them for good.
  found.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  found.headers.set("X-Content-Type-Options", "nosniff");
  return found;
});

for (const path of APP_PATHS) page.get(path, app);
