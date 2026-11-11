// One tool call in the chat: a line saying what it did, and what it did underneath.
import {
  CheckIcon,
  ChevronRightIcon,
  FilePenLineIcon,
  FileSearchIcon,
  GlobeIcon,
  LoaderCircleIcon,
  MousePointerClickIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { Diff, Hunk, parseDiff } from "react-diff-view";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { type Call, type Edit, failed, lineOfRow, refusalOf, shortUrl } from "./calls.ts";

const ICON = {
  command: TerminalIcon,
  poll: TerminalIcon,
  look: FileSearchIcon,
  edit: FilePenLineIcon,
  page: MousePointerClickIcon,
  find: SearchIcon,
  fetch: GlobeIcon,
  other: WrenchIcon,
} as const;
const PRE =
  "rounded-lg bg-[var(--raised)] px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground";

/** `edit` answers with a plain unified diff; the parser wants a git header above it. */
export function DiffView({ edit }: { edit: Edit }) {
  const body = edit.output
    .split("\n")
    .filter((line) => !line.startsWith("==="))
    .join("\n")
    .trimEnd();
  let hunks: ReturnType<typeof parseDiff>[number]["hunks"] | undefined;
  let type: ReturnType<typeof parseDiff>[number]["type"] = "modify";
  try {
    const [file] = parseDiff(`diff --git a/file b/file\n${body}`, { nearbySequences: "zip" });
    hunks = file?.hunks;
    if (file) type = file.type;
  } catch {
    // Cut short, it isn't a diff any more: its text still says what changed.
  }
  if (!hunks?.length) return <pre className={PRE}>{edit.output}</pre>;
  return (
    <div className="diff-view no-bar overflow-x-auto rounded-lg bg-[var(--raised)] py-1">
      <Diff viewType="unified" diffType={type} hunks={hunks} gutterType="none">
        {(shown) => shown.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
      </Diff>
    </div>
  );
}

export function Count({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      {added > 0 && <span className="text-[var(--ok)]">+{added}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="text-[var(--bad)]">−{removed}</span>}
    </span>
  );
}

function Meta({ row }: { row: Call }) {
  if (row.kind === "other") {
    if (row.state === "done")
      return <CheckIcon className="size-3.5 text-[var(--ok)]" aria-label="done" />;
    if (row.state === "refused")
      return <XIcon className="size-3.5 text-[var(--bad)]" aria-label="refused" />;
    return null;
  }
  if (row.state === "refused")
    return <span className="shrink-0 text-xs text-[var(--bad)]">Refused</span>;
  if (row.kind === "edit") return <Count added={row.added} removed={row.removed} />;
  if (row.kind === "find" && row.state === "done")
    return <span className="shrink-0 text-xs tabular-nums">{row.results.length}</span>;
  if (row.kind !== "command" || row.state === "running") return null;
  return (
    <span className="flex shrink-0 gap-2 text-xs tabular-nums">
      {failed(row) && <span className="text-[var(--bad)]">exit {row.exit}</span>}
      <span>{row.seconds.toFixed(1)} s</span>
    </span>
  );
}

function bodyOf(row: Call): React.ReactNode {
  switch (row.kind) {
    case "command": {
      const text = [row.workdir && `in ${row.workdir}`, row.output].filter(Boolean).join("\n");
      return text ? <pre className={PRE}>{text}</pre> : null;
    }
    case "poll":
      return row.output ? <pre className={PRE}>{row.output}</pre> : null;
    case "look":
      return (
        <ul className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
          {row.calls.map((c) => (
            <li key={`${c.verb}${c.target}`} className="truncate" title={c.target}>
              {c.verb === "Searched"
                ? `${c.target}${c.path ? ` in ${c.path}` : ""}: ${c.output ? c.output.split("\n").length : 0} found`
                : c.target}
            </li>
          ))}
        </ul>
      );
    case "edit":
      if (row.state === "running") return null;
      return row.state === "refused" ? (
        <pre className={PRE}>{row.output}</pre>
      ) : (
        <DiffView edit={row} />
      );
    case "page": {
      const text = [row.url && shortUrl(row.url), row.title, row.snapshot]
        .filter(Boolean)
        .join("\n");
      return text ? <pre className={PRE}>{text}</pre> : null;
    }
    case "find":
      return row.results.length > 0 ? (
        <ul className="flex flex-col gap-1 text-[13px]">
          {row.results.map((r) => (
            <li key={r.url} className="min-w-0">
              <a
                className="block truncate hover:underline"
                href={r.url}
                target="_blank"
                rel="noreferrer"
              >
                {r.title}
              </a>
              <span className="block truncate font-mono text-xs text-muted-foreground">
                {shortUrl(r.url)}
              </span>
            </li>
          ))}
        </ul>
      ) : null;
    case "fetch":
      return row.output ? (
        <pre className={PRE}>{row.state === "refused" ? refusalOf(row.output) : row.output}</pre>
      ) : null;
    case "other": {
      const text = [row.input, row.output && `→ ${row.output}`].filter(Boolean).join("\n");
      return text ? <pre className={PRE}>{text}</pre> : null;
    }
  }
}

export function CallRow({ row }: { row: Call }) {
  const Icon = row.state === "running" ? LoaderCircleIcon : ICON[row.kind];
  const mono = row.kind === "command" || row.kind === "other";
  const body = bodyOf(row);
  const line = (
    <>
      <Icon
        className={`size-3.5 shrink-0 ${row.state === "running" ? "animate-spin motion-reduce:animate-none" : ""}`}
      />
      <span className={`min-w-0 flex-1 truncate ${mono ? "font-mono text-xs" : ""}`}>
        {row.kind === "command" ? row.cmd : lineOfRow(row)}
      </span>
      <Meta row={row} />
    </>
  );
  const shape =
    "flex h-7 w-full items-center gap-2 rounded-lg px-1 text-left text-muted-foreground";
  if (body === null)
    return (
      <div data-call className={`${shape} text-[13px] [[data-call]+&]:-mt-1.5`}>
        {line}
        <span className="size-3.5 shrink-0" />
      </div>
    );
  return (
    <Collapsible data-call className="group/tool rounded-lg text-[13px] [[data-call]+&]:-mt-1.5">
      <CollapsibleTrigger className={`${shape} hover:bg-[var(--hover)] hover:text-foreground`}>
        {line}
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/tool:rotate-90 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 mb-1 ml-5">{body}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
