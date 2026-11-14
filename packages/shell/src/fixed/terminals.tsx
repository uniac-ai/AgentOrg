// `terminal@1`: every terminal of the computer on one socket, a tab each, whoever opened it. A
// terminal is a command the agent started or a shell a person opened; where the surface can be
// operated, the plus opens a shell and any running terminal takes typing.
import type { Terminal } from "@xterm/xterm";
import { LoaderCircleIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button.tsx";
import type { ViewerProps } from "./computer.tsx";
import { REFRESH_MS } from "./data.ts";
import { useLive } from "./live-socket.ts";
import { Closed, Xterm } from "./xterm.tsx";

interface Term {
  id: string;
  cmd: string;
  workdir: string;
  /** On a terminal device, as a shell is. A command isn't: it echoes nothing and has no size. */
  tty: boolean;
  /** The end of what it wrote. */
  text: string;
  exit?: number;
}
type Event =
  | {
      type: "start";
      id: string;
      by: "agent" | "person";
      cmd: string;
      workdir: string;
      tty: boolean;
    }
  | { type: "output"; id: string; text: string }
  | { type: "exit"; id: string; exitCode: number }
  | { type: "refused"; message: string };

/** As much of a terminal's writing as is kept to draw it again. */
const KEPT = 262_144;
/** The most one `input` carries. A larger message would close the socket, and every tab with it. */
const PIECE = 10_000;
const pieces = (text: string) => {
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    let end = Math.min(at + PIECE, text.length);
    // Never between the two halves of one character.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
};

/** A drop this soon after the last is not opened again by itself: the person is told instead. */
const SETTLED_MS = 5000;

export function TerminalsView({ target, corner }: ViewerProps) {
  const operate = target.mode === "operate";
  const [terms] = useState(() => new Map<string, Term>());
  const [, setDrawn] = useState(0);
  /** Which socket's terminals these are: a new one's are drawn anew. */
  const [socket, setSocket] = useState(0);
  const [picked, setPicked] = useState<string>();
  const [refused, setRefused] = useState<string>();
  const [gaveUp, setGaveUp] = useState(false);
  const xterm = useRef<Terminal>(undefined);
  const tabs = useRef<HTMLDivElement>(null);
  const size = useRef({ columns: 80, rows: 24 });
  /** The terminal the xterm is showing. */
  const showing = useRef<string>(undefined);
  /** The xterm is still drawing what was kept: what it says back then is its answer, not typing. */
  const drawing = useRef(false);
  /** You pressed the plus, so the next shell a person opens is yours and comes to the front. */
  const opening = useRef(false);

  /** The line being typed into a command, which is its own until Enter. */
  const line = useRef("");
  const reopened = useRef(0);
  const live = useLive(
    target,
    (data) => {
      if (typeof data !== "string") return;
      const event = JSON.parse(data) as Event;
      if (event.type === "refused") {
        opening.current = false;
        setRefused(event.message);
        return;
      }
      if (event.type === "start") {
        const { id, cmd, workdir, tty } = event;
        terms.set(id, { id, cmd, workdir, tty, text: "" });
        if (opening.current && event.by === "person") {
          opening.current = false;
          setPicked(id);
        }
      } else {
        const term = terms.get(event.id);
        if (!term) return;
        if (event.type === "output") {
          // A command that left something running can still write after its exit.
          term.text = (term.text + event.text).slice(-KEPT);
          if (event.id === showing.current) xterm.current?.write(event.text);
          return;
        }
        term.exit = event.exitCode;
      }
      setDrawn((n) => n + 1);
    },
    () => {
      // A new socket is sent every terminal again, so what the last one said goes, and what is
      // drawn of it with it. The tab in front is kept by its id.
      terms.clear();
      showing.current = undefined;
      opening.current = false;
      setSocket((n) => n + 1);
    },
  );
  const phase = live.state.phase;
  // A socket the service dropped, as it does one that has fallen far behind a flood of output, is
  // opened again at once, unless the last one was dropped as soon as it opened: that one waits for
  // you. One that was ended on purpose, or never opened, says why, and is opened again every few
  // seconds as its files and its meters are, so terminals come back by themselves when the
  // service does, as after a restart.
  const dropped = live.state.phase === "closed" && live.state.dropped;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once for each drop.
  useEffect(() => {
    if (!dropped) return;
    if (Date.now() - reopened.current < SETTLED_MS) return setGaveUp(true);
    reopened.current = Date.now();
    live.again();
  }, [dropped]);
  const closed = phase === "closed";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `again` is this socket's own.
  useEffect(() => {
    if (!closed || dropped || gaveUp) return;
    const timer = setTimeout(live.again, REFRESH_MS);
    return () => clearTimeout(timer);
  }, [closed, dropped, gaveUp]);

  const all = [...terms.values()];
  // In front: the one you picked here, else the newest.
  const shown = terms.get(picked ?? "") ?? all.at(-1);
  const typing = operate && phase === "open" && !!shown && shown.exit === undefined;
  // The tab in front is in view in its row, which scrolls sideways with no bar.
  // biome-ignore lint/correctness/useExhaustiveDependencies: when another comes to the front.
  useEffect(() => {
    const row = tabs.current;
    const tab = row?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row || !tab) return;
    const [left, right] = [
      tab.offsetLeft - row.offsetLeft,
      tab.offsetLeft - row.offsetLeft + tab.offsetWidth,
    ];
    if (left < row.scrollLeft) row.scrollLeft = left;
    else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth;
  }, [shown?.id]);
  /** Something you did: what was refused before is no longer about it. */
  const send = (input: Record<string, unknown>) => {
    setRefused(undefined);
    live.send(JSON.stringify(input));
  };
  const typed = (term: Term, data: string) => {
    if (drawing.current) return;
    if (term.tty) {
      for (const text of pieces(data)) send({ type: "input", id: term.id, text });
      return;
    }
    // A command is on pipes: nothing echoes, so the line is edited and shown here, Enter is a
    // line feed, and Ctrl-C and Ctrl-D go at once. A key that moves a cursor has nothing to move.
    if (data.startsWith("\x1b")) return;
    for (const key of data) {
      if (key === "\r" || key === "\n") {
        for (const text of pieces(`${line.current}\n`)) send({ type: "input", id: term.id, text });
        term.text = `${term.text}${line.current}\n`.slice(-KEPT);
        line.current = "";
        xterm.current?.write("\n");
      } else if (key === "\x7f") {
        if (!line.current) continue;
        line.current = [...line.current].slice(0, -1).join("");
        xterm.current?.write("\b \b");
      } else if (key === "\x03" || key === "\x04") {
        send({ type: "input", id: term.id, text: key });
        // An interrupt leaves the line behind, as a terminal shows it.
        if (key === "\x03") {
          term.text = `${term.text}${line.current}^C\n`.slice(-KEPT);
          line.current = "";
          xterm.current?.write("^C\n");
        }
      } else if (key >= " ") {
        line.current += key;
        xterm.current?.write(key);
      }
    }
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col text-[15px] leading-[1.5]">
      {/* The first row: its tabs, with the plus beside them. */}
      <div className="flex h-11 shrink-0 items-center gap-1 pr-1.5 pl-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <div
            ref={tabs}
            role="tablist"
            aria-label="Terminals"
            className="no-bar flex min-w-0 gap-1 overflow-x-auto"
          >
            {all.map((term) => (
              <button
                key={term.id}
                type="button"
                role="tab"
                aria-selected={term.id === shown?.id}
                onClick={() => {
                  setRefused(undefined);
                  setPicked(term.id);
                }}
                className={`h-8 min-w-0 shrink truncate rounded-lg px-3 text-[13px] ${term.id === shown?.id ? "bg-[var(--selected)] font-medium text-foreground" : "text-muted-foreground hover:bg-[var(--hover)]"} flex max-w-44 shrink-0 items-center gap-2 font-mono text-xs`}
              >
                {/* A command that hasn't ended is running. A shell at its prompt can't be told from
                    one that's busy, so it says nothing. */}
                {!term.tty && term.exit === undefined && (
                  <LoaderCircleIcon
                    role="img"
                    aria-label="Running"
                    className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
                  />
                )}
                <span className="truncate">{term.cmd}</span>
              </button>
            ))}
          </div>
          {operate && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New terminal"
              onClick={() => {
                if (phase === "open") {
                  opening.current = true;
                  send({ type: "open", ...size.current });
                  return;
                }
                // On a view that has closed it does what Open again does, and nothing more.
                if (phase === "closed") {
                  setRefused(undefined);
                  setGaveUp(false);
                  live.again();
                }
              }}
            >
              <PlusIcon />
            </Button>
          )}
        </div>
        {corner}
      </div>
      {/* The second row: where it is. */}
      <div className="flex h-10 shrink-0 items-center gap-0.5 px-2">
        {/* biome-ignore lint/a11y/useSemanticElements: one value with its name, not a set of fields. */}
        <span
          role="group"
          aria-label="Folder"
          className="flex h-8 min-w-0 flex-1 items-center truncate rounded-full bg-[var(--raised)] px-3.5 font-mono text-xs text-muted-foreground outline-none"
        >
          {shown?.workdir}
        </span>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Xterm
          // Another terminal, another socket's, or one that stopped taking typing, is drawn anew
          // from what's kept.
          key={`${socket}/${shown?.id}/${typing}`}
          label={shown ? `Terminal, ${shown.cmd}` : "Terminal"}
          convertEol={!shown?.tty}
          onReady={(screen) => {
            xterm.current = screen;
            showing.current = shown?.id;
            line.current = "";
            if (!shown) return;
            // A command's first line is its folder and itself, as a prompt would have shown them.
            const first = shown.tty
              ? ""
              : `\x1b[32m${shown.workdir.split("/").at(-1)}\x1b[0m $ ${shown.cmd}\n`;
            drawing.current = true;
            screen.write(`${first}${shown.text}`, () => {
              if (xterm.current === screen) drawing.current = false;
            });
          }}
          {...(typing ? { onInput: (data: string) => typed(shown, data) } : {})}
          onResize={(next) => {
            size.current = next;
            if (!typing || !shown.tty) return;
            // A shell's size is the last anyone gave it: the one looking at it now. Not at once: a
            // new socket says a shell is there before it says the shell has ended.
            const { id } = shown;
            setTimeout(() => {
              if (xterm.current?.cols === next.columns && terms.get(id)?.exit === undefined)
                live.send(JSON.stringify({ type: "resize", id, ...next }));
            }, 150);
          }}
        />
        {refused && (
          <p
            role="alert"
            title={refused}
            className="absolute inset-x-2 bottom-2 truncate rounded-lg bg-[var(--raised)] px-3 py-1.5 text-[13px] text-[var(--bad)] shadow-lg"
          >
            {refused}
          </p>
        )}
      </div>
      {(!dropped || gaveUp) && (
        <Closed
          state={live.state}
          again={() => {
            setGaveUp(false);
            live.again();
          }}
        />
      )}
    </div>
  );
}
