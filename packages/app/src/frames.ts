import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export interface Served {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

/** Where a view module's bundle is: its file, if `module` is a `view` module of that package. */
export type ViewBundle = (hash: string, module: string) => string | undefined;

const HASH = /^sha256-[0-9a-f]{64}$/;
const MODULE = /^[a-z][A-Za-z0-9_]{0,63}$/;

/** The SDK's frame runtime, the one script every frame loads first. */
const runtime = () =>
  readFileSync(createRequire(import.meta.url).resolve("@agentorg/sdk/frame/runtime.js"));

/**
 * A frame's policy, on every `/frames/` response: sandboxed with scripts only, so its origin is
 * opaque however it is loaded, and nothing in it can reach the shell origin's storage, where the
 * session is. Scripts only from the gateway's `/frames/`, nothing fetched, no forms, no frames
 * inside. The origin being opaque, `'self'` would match nothing: the gateway's is named. Styles may
 * be inline, as a view sets its own.
 */
export const frameCsp = (origin: string) =>
  [
    "default-src 'none'",
    `script-src ${origin}/frames/`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origin}`,
    // However it's loaded, top-level included, its origin is opaque: nothing runs as the shell's.
    "sandbox allow-scripts",
  ].join("; ");

/**
 * The frame document: nothing but the runtime, which waits for the shell's port, and the shell's
 * base text, from the theme's tokens once the view is mounted.
 */
const DOCUMENT =
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}body{font:14px/1.45 var(--font, ui-sans-serif, system-ui, sans-serif);color:var(--fg)}</style><script type="module" src="/frames/runtime.js"></script></head><body></body></html>';

/**
 * Serve `/frames/`: the runtime, a view's frame document and its bundle. A frame has an opaque
 * origin, so a module script it loads is a CORS request: scripts carry `Access-Control-Allow-Origin:
 * *`, and no request here reads or needs the session. A bundle is served only for a `view` module,
 * by hash, and never changes.
 */
export function serveFrame(path: string, origin: string, bundle: ViewBundle): Served | undefined {
  const base = {
    "Content-Security-Policy": frameCsp(origin),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  const script = {
    ...base,
    "Content-Type": "text/javascript; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  };
  if (path === "/frames/runtime.js")
    return { status: 200, headers: { ...script, "Cache-Control": "no-cache" }, body: runtime() };
  const match = /^\/frames\/([^/]+)\/([^/]+)\.(html|js)$/.exec(path);
  if (!match) return undefined;
  const [, hash = "", module = "", kind] = match;
  if (!HASH.test(hash) || !MODULE.test(module)) return undefined;
  const file = bundle(hash, module);
  if (!file) return undefined;
  if (kind === "html")
    return {
      status: 200,
      headers: {
        ...base,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
      body: DOCUMENT,
    };
  return {
    status: 200,
    headers: { ...script, "Cache-Control": "public, max-age=31536000, immutable" },
    body: readFileSync(file),
  };
}
