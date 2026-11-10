// The two terminal surfaces: the agent's commands as they run (`commands@1`), and a shell of your
// own (`pty@1`). xterm.js draws both.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { CheckIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { type LiveState, type LiveTarget, useLive } from "./live-socket.ts";

/** One xterm, fitted to its box, in the page's colours. With `onInput` it takes typing. */
function Xterm({
  label,
  onReady,
  onInput,
  onResize,
}: {
  label: string;
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
      fontSize: 12,
      convertEol: !typing,
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
  return <div ref={box} className="xterm-host min-h-0 flex-1 overflow-hidden px-2 pb-1" />;
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

interface Run {
  id: string;
  cmd: string;
  text: string;
  exit?: number;
}
type CommandEvent =
  | { type: "start"; id: string; cmd: string; workdir?: string }
  | { type: "output"; id: string; stream?: string; text: string }
  | { type: "exit"; id: string; exitCode: number };

function RunMark({ run }: { run: Run }) {
  if (run.exit === undefined)
    return (
      <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
    );
  if (run.exit !== 0) return <XIcon className="size-3 shrink-0 text-[var(--bad)]" />;
  return <CheckIcon className="size-3 shrink-0 text-[var(--ok)]" />;
}

/** `commands@1`: the agent's commands as they run, read-only; any earlier one a pick away. */
export function CommandsView({ target }: { target: LiveTarget }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [picked, setPicked] = useState<string>();
  const term = useRef<Terminal>(undefined);
  const shown = useRef<string>(undefined);
  const live = useLive(target, (data) => {
    if (typeof data !== "string") return;
    const event = JSON.parse(data) as CommandEvent;
    setRuns((was) => {
      if (event.type === "start") return [...was, { id: event.id, cmd: event.cmd, text: "" }];
      return was.map((run) =>
        run.id !== event.id
          ? run
          : event.type === "output"
            ? { ...run, text: run.text + event.text }
            : { ...run, exit: event.exitCode },
      );
    });
    // The one being shown follows as it's written.
    if (event.type === "output" && event.id === shown.current) term.current?.write(event.text);
  });
  const current = runs.find((run) => run.id === picked) ?? runs.at(-1);
  const draw = (t: Terminal, run: Run | undefined) => {
    t.reset();
    shown.current = run?.id;
    if (run) t.write(`\x1b[2m$ ${run.cmd}\x1b[0m\r\n${run.text}`);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: drawn anew when another is shown.
  useEffect(() => {
    if (term.current && shown.current !== current?.id) draw(term.current, current);
  }, [current?.id]);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a pane of the frame, not a form.
    <div role="group" aria-label="Agent's commands" className="flex min-h-0 min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center px-1.5">
        {current && (
          <Select value={current.id} onValueChange={setPicked}>
            <SelectTrigger
              aria-label="Command"
              size="sm"
              className="h-7 min-w-0 flex-1 border-0 bg-transparent font-mono text-xs shadow-none dark:bg-transparent"
            >
              <SelectValue>
                <span className="flex min-w-0 items-center gap-2">
                  <RunMark run={current} />
                  <span className="truncate">{current.cmd}</span>
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {[...runs].reverse().map((run) => (
                <SelectItem key={run.id} value={run.id} className="font-mono text-xs">
                  <span className="flex items-center gap-2">
                    <RunMark run={run} />
                    {run.cmd}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <Xterm
        label="Agent's commands"
        onReady={(t) => {
          term.current = t;
          draw(t, current);
        }}
      />
      <Closed state={live.state} again={live.again} />
    </div>
  );
}

const OUTPUT = 0x30;
const RESIZE = 0x31;
const frameOf = (type: number, text: string) => {
  const body = new TextEncoder().encode(text);
  const frame = new Uint8Array(body.length + 1);
  frame[0] = type;
  frame.set(body, 1);
  return frame;
};

/** `pty@1`: a shell of your own, in the same folder; output and input are one byte, then text. */
export function PtyView({ target, folder }: { target: LiveTarget; folder?: string | undefined }) {
  const term = useRef<Terminal>(undefined);
  const decoder = useRef(new TextDecoder());
  const size = useRef<{ columns: number; rows: number }>(undefined);
  const operate = target.mode === "operate";
  const live = useLive(target, (data) => {
    if (typeof data === "string") return;
    const frame = new Uint8Array(data);
    if (frame[0] === OUTPUT)
      term.current?.write(decoder.current.decode(frame.subarray(1), { stream: true }));
  });
  // Its size goes once it's open, and with every change after.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening.
  useEffect(() => {
    if (live.state.phase === "open" && size.current && operate)
      live.send(frameOf(RESIZE, JSON.stringify(size.current)));
  }, [live.state.phase]);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a pane of the frame, not a form.
    <div role="group" aria-label="Your shell" className="flex min-h-0 min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center px-3 font-mono text-xs text-muted-foreground">
        <span className="truncate">{folder}</span>
      </div>
      <Xterm
        label="Your shell"
        onReady={(t) => {
          term.current = t;
        }}
        {...(operate ? { onInput: (text: string) => live.send(frameOf(OUTPUT, text)) } : {})}
        onResize={(next) => {
          size.current = next;
          if (operate) live.send(frameOf(RESIZE, JSON.stringify(next)));
        }}
      />
      <Closed state={live.state} again={live.again} />
    </div>
  );
}
