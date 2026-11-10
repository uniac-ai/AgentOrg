// The agent page's frames, filled from the same record the chat shows. Each keeps its size: new
// work arrives inside it, at the bottom, and the newest stays in view.
import { LoaderCircleIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.tsx";
import { Count, DiffView } from "./call-row.tsx";
import {
  type Command,
  type Edit,
  failed,
  lastLines,
  type PageStep,
  type Row,
  rowsOf,
  shortUrl,
} from "./calls.ts";
import { ago, type ChatMessage, useChatRecord, useEvery } from "./data.ts";
import { BrowserLive, type OpenSurface, TerminalFrame, VIEWERS } from "./live-frames.tsx";

const seconds = (at: string | undefined, now: number) => {
  if (!at) return "";
  const passed = Math.floor((now - Date.parse(at)) / 1000);
  return passed < 60 ? `${Math.max(passed, 0)} s` : ago(at, now);
};

function Frame({
  title,
  filled,
  className,
  children,
}: {
  title: string;
  filled: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={`flex min-w-0 flex-col overflow-hidden rounded-xl border p-3 ${filled ? "" : "border-dashed"} ${className ?? ""}`}
    >
      <h2 className="shrink-0 text-xs font-normal text-[var(--faint)]">{title}</h2>
      {children}
    </section>
  );
}

/** Scrolls without a bar and rests on its end, so the newest is what you see. */
function Tail({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`no-bar flex min-h-0 flex-1 flex-col-reverse overflow-y-auto ${className ?? ""}`}
    >
      <div className="mb-auto">{children}</div>
    </div>
  );
}

type Open = { command: Command } | { edits: Edit[] } | undefined;
const ROW =
  "block w-full min-w-0 rounded-md px-1.5 py-1 text-left font-mono text-xs hover:bg-[var(--hover)]";

function Finished({ c, tail, onOpen }: { c: Command; tail: boolean; onOpen(): void }) {
  return (
    <button type="button" onClick={onOpen} className={ROW}>
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate">
          <span className="text-[var(--faint)]">$ </span>
          {c.cmd}
        </span>
        {failed(c) && <span className="shrink-0 text-[var(--bad)]">exit {c.exit}</span>}
        {c.stopped && <span className="shrink-0 text-muted-foreground">Stopped</span>}
        {c.state === "refused" && <span className="shrink-0 text-[var(--bad)]">Refused</span>}
        {c.state === "done" && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {c.seconds.toFixed(1)} s
          </span>
        )}
      </span>
      {tail && c.output && (
        <span className="mt-0.5 block whitespace-pre-wrap break-words text-muted-foreground">
          {lastLines(c.output, 4)}
        </span>
      )}
    </button>
  );
}

function Running({ c, now, onOpen }: { c: Command; now: number; onOpen(): void }) {
  return (
    <button type="button" onClick={onOpen} className={ROW}>
      <span className="flex items-center gap-2">
        <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
        <span className="min-w-0 flex-1 truncate">{c.cmd}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          checked {seconds(c.polled ?? c.at, now)} ago
        </span>
      </span>
      {c.output && (
        <span className="mt-0.5 block truncate pl-5 text-muted-foreground">
          {lastLines(c.output, 1)}
        </span>
      )}
    </button>
  );
}

function ComputerFrame({ rows, now }: { rows: readonly Row[]; now: number }) {
  const [open, setOpen] = useState<Open>();
  const commands = rows.filter((r): r is Command => r.kind === "command");
  const done = commands.filter((c) => c.state !== "running");
  const running = commands.filter((c) => c.state === "running");
  const filled = commands.length > 0;
  const show = (command: Command) => () => setOpen({ command });
  return (
    <Frame
      title="Computer"
      filled={filled}
      className="row-span-2 h-[524px] tight:row-span-1 tight:h-[420px]"
    >
      {filled && (
        <>
          <Tail className="-mx-1.5 mt-1">
            {done.map((c) => (
              <Finished key={c.id} c={c} tail={failed(c) || c === done.at(-1)} onOpen={show(c)} />
            ))}
          </Tail>
          {running.length > 0 && (
            <div className="-mx-1.5 mt-1 shrink-0 border-t pt-1">
              {running.map((c) => (
                <Running key={c.id} c={c} now={now} onOpen={show(c)} />
              ))}
            </div>
          )}
        </>
      )}
      <Dialog open={!!open} onOpenChange={(next) => !next && setOpen(undefined)}>
        <DialogContent className="window ring-0 sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate pr-8 font-mono text-sm">
              {open && ("command" in open ? open.command.cmd : open.edits[0]?.path)}
            </DialogTitle>
            <DialogDescription>
              {open && "command" in open && summaryOf(open.command)}
            </DialogDescription>
          </DialogHeader>
          <div className="no-bar max-h-[60vh] overflow-y-auto">
            {open && "command" in open ? (
              <pre className="font-mono text-xs whitespace-pre-wrap break-words">
                {open.command.output}
              </pre>
            ) : (
              open?.edits.map((edit) => <DiffView key={edit.id} edit={edit} />)
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Frame>
  );
}

const summaryOf = (c: Command) =>
  [
    c.workdir && `in ${c.workdir}`,
    c.state === "running"
      ? "Running"
      : c.stopped
        ? "Stopped"
        : c.state === "refused"
          ? "Refused"
          : `Exit ${c.exit}`,
    c.state === "done" && `${c.seconds.toFixed(1)} s`,
  ]
    .filter(Boolean)
    .join(" · ");

function BrowserFrame({ rows }: { rows: readonly Row[] }) {
  const steps = rows.filter((r): r is PageStep => r.kind === "page");
  // A step may have no page section: the address and title stay what they last were.
  const at = steps.findLast((step) => step.url);
  const title = steps.findLast((step) => step.title)?.title;
  return (
    <Frame title="Browser" filled={steps.length > 0} className="h-64">
      {steps.length > 0 && (
        <>
          <div className="mt-1.5 flex h-7 shrink-0 items-center rounded-lg bg-[var(--raised)] px-2.5 font-mono text-xs">
            <span className="min-w-0 truncate">{at?.url && shortUrl(at.url)}</span>
          </div>
          <div className="mt-2 h-5 shrink-0 truncate text-[13px] font-medium">{title}</div>
          <Tail className="mt-1">
            <ol className="flex flex-col gap-0.5 text-[13px] text-muted-foreground">
              {steps.map((step, i) => (
                <li
                  key={step.id}
                  className={`truncate ${i === steps.length - 1 ? "text-foreground" : ""}`}
                >
                  {step.text}
                </li>
              ))}
            </ol>
          </Tail>
        </>
      )}
    </Frame>
  );
}

/** What it changed, as its own list: it outlasts whatever the Computer frame comes to show. */
function FilesFrame({ rows }: { rows: readonly Row[] }) {
  const [open, setOpen] = useState<Edit[]>();
  const edits = rows.filter((r): r is Edit => r.kind === "edit" && r.state === "done");
  const files = [...new Set(edits.map((e) => e.path))].map((path) =>
    edits.filter((e) => e.path === path),
  );
  return (
    <Frame title="Changed files" filled={files.length > 0} className="h-64">
      {files.length > 0 && (
        <ul className="no-bar -mx-1.5 mt-1 min-h-0 flex-1 overflow-y-auto">
          {files.map((group) => {
            const [first] = group as [Edit];
            return (
              <li key={first.path}>
                <button
                  type="button"
                  title={first.path}
                  onClick={() => setOpen(group)}
                  className="flex h-6 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left hover:bg-[var(--hover)]"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{first.path}</span>
                  <Count
                    added={group.reduce((n, e) => n + e.added, 0)}
                    removed={group.reduce((n, e) => n + e.removed, 0)}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog open={!!open} onOpenChange={(next) => !next && setOpen(undefined)}>
        <DialogContent className="window ring-0 sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate pr-8 font-mono text-sm">{open?.[0]?.path}</DialogTitle>
            <DialogDescription className="sr-only">What changed</DialogDescription>
          </DialogHeader>
          <div className="no-bar max-h-[60vh] overflow-y-auto">
            {open?.map((edit) => (
              <DiffView key={edit.id} edit={edit} />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </Frame>
  );
}

/** As much of the record as one read gives. */
const RECORD = 200;

export function Frames({
  agent,
  slot,
  running,
  surfaces = [],
  onWaiting = () => {},
}: {
  agent: string;
  slot?: string;
  running: boolean;
  /** What of its units can be opened live; those the page has a viewer for take a frame's place. */
  surfaces?: OpenSurface[];
  /** Told when the agent waits for you to let go of its browser. */
  onWaiting?(waiting: boolean): void;
}) {
  const { messages } = useChatRecord(slot, running, RECORD);
  const rows = useMemo(() => rowsOf(messages as ChatMessage[]), [messages]);
  useEvery(5000);
  const now = Date.now();
  const terminal = surfaces.filter((s) => VIEWERS[s.protocol]?.frame === "terminal");
  const browser = surfaces.find((s) => VIEWERS[s.protocol]?.frame === "browser");
  const browserFrame = browser ? (
    <BrowserLive
      key={`${browser.instance}/${browser.surface}`}
      agent={agent}
      surface={browser}
      onWaiting={onWaiting}
    />
  ) : (
    <BrowserFrame rows={rows} />
  );
  if (terminal.length === 0 && !browser)
    return (
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3 tight:grid-cols-1">
        <ComputerFrame rows={rows} now={now} />
        <BrowserFrame rows={rows} />
        <FilesFrame rows={rows} />
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      {terminal.length > 0 && <TerminalFrame agent={agent} surfaces={terminal} />}
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3 tight:grid-cols-1">
        {browserFrame}
        <FilesFrame rows={rows} />
      </div>
    </div>
  );
}
