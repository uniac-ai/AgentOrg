/**
 * The web app, built from `web/` into `dist/page`: its own paths all serve `index.html`, whose
 * router picks the view, and its assets are served under `/assets`. Every page response carries a
 * Content-Security-Policy that runs only the app's own scripts and styles.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono, type MiddlewareHandler } from "hono";

/** The built app beside `dist/src`. */
const BUILT = fileURLToPath(new URL("../../../page", import.meta.url));

/** The app's own paths; each serves `index.html`. */
export const APP_PATHS = ["/", "/people/*", "/activity"];

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

async function index(c: Context) {
  const html = await readFile(`${BUILT}/index.html`, "utf8").catch(() => undefined);
  if (html === undefined) return c.text("The web app is not built: run npm run build.", 503);
  return c.html(html, 200, PAGE_HEADERS);
}

let assets: MiddlewareHandler | undefined;

export const web = new Hono();

web.use("/assets/*", async (c, next) => {
  assets ??= serveStatic({ root: BUILT });
  const found = await assets(c, next);
  if (!(found instanceof Response)) return;
  // Built assets have content hashes in their names, so a browser may keep them for good.
  found.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  found.headers.set("X-Content-Type-Options", "nosniff");
  return found;
});

for (const path of APP_PATHS) web.get(path, index);
