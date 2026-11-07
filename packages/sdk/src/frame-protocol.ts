import type { ErrorBody } from "./errors.js";
import type { Interface } from "./interface.js";

/**
 * The messages between a shell and a view's sandboxed frame, over the one `MessagePort` the shell
 * hands the frame. The frame has no network and no shell state: everything it reaches goes
 * through these. The shell is trusted by the frame; the frame is not trusted by the shell, so
 * `FrameHost` checks every message it gets.
 */

/** What the shell posts to the frame's window, with the port, to start. */
export const FRAME_HELLO = "frame/1";

/** From the shell to the frame. */
export type ToFrame =
  /** Import the view's bundle, run its `start`, then answer. `slots` says which are bound now. */
  | {
      op: "load";
      id: number;
      src: string;
      self: { actorId: string; module: string };
      slots: Record<string, boolean>;
    }
  /** A slot became bound or unbound; `bound` again for a bound slot means its provider came back. */
  | { op: "slot"; name: string; bound: boolean }
  | {
      op: "mount";
      id: number;
      theme: Record<string, string>;
      size: { width: number; height: number };
    }
  | { op: "resize"; id: number; size: { width: number; height: number } }
  | { op: "unmount"; id: number }
  /** An event of a subscription the frame opened. */
  | { op: "event"; sub: number; payload: unknown }
  /** A subscription ended from the shell's side: an unbind, or its provider gone. */
  | { op: "end"; sub: number }
  /** The answer to one of the frame's requests. */
  | { op: "reply"; id: number; result: unknown }
  | { op: "reply"; id: number; error: ErrorBody };

/** From the frame to the shell. */
export type FromFrame =
  /** A call on one of the view's slots, run as the view's Actor. */
  | { op: "call"; id: number; slot: string; method: string; input: unknown }
  | { op: "subscribe"; sub: number; slot: string; event: string }
  | { op: "unsubscribe"; sub: number }
  /** A call on `ui.shell@1`, which the shell itself serves, with no binding. */
  | { op: "shell"; id: number; method: string; input: unknown }
  /** A line for the view's Actor's log: the view's own, or an error it didn't catch. */
  | {
      op: "log";
      level: "info" | "warn" | "error";
      message: string;
      fields?: Record<string, unknown>;
    }
  /**
   * The mounted view's content height in CSS pixels, each time it changes: the frame runtime's
   * own, not `ui.view@1`'s. The shell may size the frame to it.
   */
  | { op: "size"; height: number }
  /** The answer to one of the shell's requests. */
  | { op: "reply"; id: number; result: unknown }
  | { op: "reply"; id: number; error: ErrorBody };

/** A port both sides speak on: the browser's `MessagePort`, or Node's in tests. */
export interface PortLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

/**
 * Whether an interface is `ui.shell@1`: the shell's own in-frame interface, the mirror of
 * `ui.view@1`. The frame runtime binds a slot of it to the shell itself, so it is always bound and
 * no binding in the Hub ever names it.
 */
export function isShellInterface(iface: Interface): boolean {
  return iface.kind === "rpc" && iface.name === "ui.shell" && iface.major === 1;
}
