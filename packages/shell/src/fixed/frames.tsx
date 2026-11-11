// The frames of an agent's computer on its page: its live surfaces, and beside them what the
// record the chat shows says of its browser and of the files it changed. Each keeps its size.
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.tsx";
import { Count, DiffView } from "./call-row.tsx";
import { type Edit, type PageStep, type Row, rowsOf, shortUrl } from "./calls.ts";
import { type ChatMessage, useChatRecord } from "./data.ts";
import { BrowserLive, type OpenSurface, TerminalFrame, VIEWERS } from "./live-frames.tsx";

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

/** What it changed, as its own list. */
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
  surfaces,
}: {
  agent: string;
  slot?: string;
  running: boolean;
  /** What of its units can be opened live; those the page has a viewer for take a frame's place. */
  surfaces: OpenSurface[];
}) {
  const { messages } = useChatRecord(slot, running, RECORD);
  const rows = useMemo(() => rowsOf(messages as ChatMessage[]), [messages]);
  const terminal = surfaces.filter((s) => VIEWERS[s.protocol]?.frame === "terminal");
  const browser = surfaces.find((s) => VIEWERS[s.protocol]?.frame === "browser");
  const browserFrame = browser ? (
    <BrowserLive key={`${browser.instance}/${browser.surface}`} agent={agent} surface={browser} />
  ) : (
    <BrowserFrame rows={rows} />
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
