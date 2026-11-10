// A live surface over the gateway's `/live`: same origin, the tab's session said first as on
// `/api`, then the surface's own frames both ways. No ticket or token ever reaches the page.
import { useEffect, useRef, useState } from "react";

const SESSION = "agentorg.session";
/** The gateway's close codes: the session is gone, or the surface didn't open. */
const SIGN_IN_AGAIN = 4401;

export interface LiveTarget {
  agent: string;
  instance: string;
  surface: string;
  mode: "watch" | "operate";
}

export type LiveState =
  | { phase: "opening" }
  | { phase: "open" }
  | { phase: "closed"; reason: string };

const reasonOf = (event: CloseEvent) => {
  if (event.code === SIGN_IN_AGAIN) return "Sign in again to see it.";
  return event.reason || "It closed.";
};

/**
 * One socket to one surface while `target` is set. `onFrame` gets each frame after the surface
 * opens: text as a string, binary as an ArrayBuffer. `again` opens it anew after it closed.
 */
export function useLive(
  target: LiveTarget | undefined,
  onFrame: (data: string | ArrayBuffer) => void,
) {
  const [state, setState] = useState<LiveState>({ phase: "opening" });
  const [attempt, setAttempt] = useState(0);
  const socket = useRef<WebSocket>(undefined);
  const frames = useRef(onFrame);
  frames.current = onFrame;
  const key = target ? `${target.agent}/${target.instance}/${target.surface}/${target.mode}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: the target is its key.
  useEffect(() => {
    if (!target) return;
    setState({ phase: "opening" });
    const query = new URLSearchParams({ ...target });
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/live?${query}`);
    ws.binaryType = "arraybuffer";
    socket.current = ws;
    let open = false;
    ws.onopen = () =>
      ws.send(JSON.stringify({ op: "hello", session: localStorage.getItem(SESSION) }));
    ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (!open) {
        if (typeof event.data === "string" && JSON.parse(event.data).op === "live") {
          open = true;
          setState({ phase: "open" });
        }
        return;
      }
      frames.current(event.data);
    };
    ws.onclose = (event) => {
      if (socket.current === ws) setState({ phase: "closed", reason: reasonOf(event) });
    };
    return () => {
      socket.current = undefined;
      ws.close();
    };
  }, [key, attempt]);
  return {
    state,
    send(data: string | Uint8Array<ArrayBuffer>) {
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(data);
    },
    again: () => setAttempt((n) => n + 1),
  };
}
