// What the terminal viewers share: one xterm, and what a closed surface says.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { useTheme } from "../data.ts";
import { Button } from "../ui/button.tsx";
import type { LiveState } from "./live-socket.ts";

/**
 * One xterm, fitted to its box, in the page's colours. With `onInput` it takes typing. Whether it
 * does, and `convertEol`, are read once as it is made: give it a new `key` to change either.
 */
export function Xterm({
  label,
  convertEol,
  onReady,
  onInput,
  onResize,
}: {
  label: string;
  /**
   * A line feed alone starts a new line, as what isn't on a terminal device writes them. Left out,
   * it is so unless the xterm takes typing.
   */
  convertEol?: boolean;
  onReady(term: Terminal): void;
  onInput?: (data: string) => void;
  onResize?: (size: { columns: number; rows: number }) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  const handlers = useRef({ onReady, onInput, onResize });
  handlers.current = { onReady, onInput, onResize };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new theme draws it again in its colours.
  useEffect(() => {
    if (!box.current) return;
    const style = getComputedStyle(document.documentElement);
    const color = (name: string) => style.getPropertyValue(name).trim();
    const typing = !!handlers.current.onInput;
    const term = new Terminal({
      disableStdin: !typing,
      cursorBlink: typing,
      cursorInactiveStyle: "none",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.3,
      convertEol: convertEol ?? !typing,
      theme: {
        background: color("--surface"),
        foreground: color("--fg"),
        cursor: typing ? color("--fg") : color("--surface"),
        selectionBackground: color("--selected"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current);
    const fitted = () => {
      try {
        fit.fit();
      } catch {
        // Not laid out yet.
      }
    };
    const watched = new ResizeObserver(fitted);
    watched.observe(box.current);
    fitted();
    term.textarea?.setAttribute("aria-label", label);
    const input = term.onData((data) => handlers.current.onInput?.(data));
    const resized = term.onResize(({ cols, rows }) =>
      handlers.current.onResize?.({ columns: cols, rows }),
    );
    handlers.current.onResize?.({ columns: term.cols, rows: term.rows });
    handlers.current.onReady(term);
    return () => {
      input.dispose();
      resized.dispose();
      watched.disconnect();
      term.dispose();
    };
  }, [theme, label]);
  return <div ref={box} className="xterm-host min-h-0 flex-1 overflow-hidden px-3 pb-2" />;
}

/** What a closed surface says, with a way to open it again. */
export function Closed({ state, again }: { state: LiveState; again(): void }) {
  if (state.phase !== "closed") return null;
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground">
      <span className="min-w-0 truncate">{state.reason}</span>
      <Button size="xs" variant="secondary" onClick={again}>
        Open again
      </Button>
    </div>
  );
}
