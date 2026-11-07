import { type Frame, runFrame } from "./frame.js";
import { FRAME_BASE } from "./frame-base.js";
import { FRAME_HELLO, type PortLike } from "./frame-protocol.js";
import type { FrameRoot } from "./module.js";

/**
 * The frame document's only script, bundled into one file (`@agentorg/sdk/frame/runtime.js`). It
 * waits for the shell's hello, which brings the frame's one port, from its parent window only, and
 * ignores any later one. The view's bundle is imported from the URL the shell names; the frame's
 * CSP allows only the gateway's `/frames/` path. Before anything else it puts the base stylesheet
 * first in the document's head, so a view's own styles come after it and win.
 */

/** The few browser globals this needs, without the DOM library in the SDK's types. */
interface FrameGlobals {
  parent: unknown;
  document: {
    body: FrameRoot;
    head: { prepend(node: unknown): void };
    documentElement: { style: { setProperty(name: string, value: string): void } };
    createElement(tag: "style"): { textContent: string | null };
  };
  addEventListener(
    type: "message",
    listener: (event: { source: unknown; data: unknown; ports: readonly PortLike[] }) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: (event: { error: unknown; message: string }) => void,
  ): void;
  addEventListener(
    type: "unhandledrejection",
    listener: (event: { reason: unknown }) => void,
  ): void;
}

const self = globalThis as unknown as FrameGlobals;
let frame: Frame | undefined;

const base = self.document.createElement("style");
base.textContent = FRAME_BASE;
self.document.head.prepend(base);

self.addEventListener("message", (event) => {
  const port = event.ports[0];
  if (frame || event.source !== self.parent || event.data !== FRAME_HELLO || !port) return;
  frame = runFrame({
    port,
    root: self.document.body,
    // A computed specifier: the bundler leaves it to the browser.
    load: (src) => import(src),
    theme(tokens) {
      for (const [name, value] of Object.entries(tokens))
        if (name.startsWith("--")) self.document.documentElement.style.setProperty(name, value);
    },
  });
});
// What the view doesn't catch goes to its Actor's log.
self.addEventListener("error", (event) => frame?.failed(event.error ?? event.message));
self.addEventListener("unhandledrejection", (event) => frame?.failed(event.reason));
