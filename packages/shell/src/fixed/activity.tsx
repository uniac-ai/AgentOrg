// What an agent does, in one place: its pieces of work, as a capability's `activity` view says
// them, newest first. A box on the agent's Overview has the latest; the box opens into the layer's
// window with all of it. It is for reading: nothing in it changes anything. Its rows are the rows
// a call had in a chat.
import type { Activity, ActivityPage } from "@agentorg/interfaces";
import { Maximize2Icon, WrenchIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { z } from "zod";
import { api, useConnection } from "../data.ts";
import { Bubble, BubbleContent } from "../ui/bubble.tsx";
import { Button } from "../ui/button.tsx";
import { CallRow } from "./call-row.tsx";
import { type Row, rowsOf } from "./calls.ts";
import { age } from "./chat-parts.tsx";
import { useComputers } from "./computers.tsx";
import { type AgentDetail, type Tone, useEvery } from "./data.ts";
import { Face, tintOf } from "./face.tsx";
import { Nothing, Section, UNREAD } from "./parts.tsx";

type Work = z.output<typeof Activity>["works"][number];
type Entry = Work["entries"][number];
type Page = z.output<typeof ActivityPage>;
type Pieces = z.output<typeof Activity>;

/** How many calls the box holds: the latest of the newest pieces of work, at most so many of each. */
const LATEST = 6;
const EACH = 3;
/** A page of a piece of work's older entries, and how many pages the box and the window read of one. */
const PAGE = 20;
const BOX_PAGES = 5;
const WINDOW_PAGES = 50;
/** How many pages of pieces of work the window reads: six pieces each. */
const PIECE_PAGES = 20;
/** How often how long ago is said again. */
const MINUTE = 60_000;

/**
 * Where an agent's activity is read: the first view of kind `activity` one of its capabilities
 * has, asked through the person's own slots to it.
 */
export function activityOf(detail: AgentDetail | undefined) {
  for (const held of detail?.capabilities ?? [])
    for (const view of held.views) {
      const tools = view.slot && held.person.operations[view.slot];
      if (view.kind === "activity" && view.operation && tools)
        return {
          view: view.id,
          capability: held.person.capability,
          tools,
          operation: view.operation,
        };
    }
  return undefined;
}
type Source = NonNullable<ReturnType<typeof activityOf>>;

/** What the view's operation answers to `input`; one that says it failed is refused. */
async function ask<T>(source: Source, input: Record<string, unknown>): Promise<T> {
  const { output, failed } = await api.call<{ output: string; failed?: true }>(
    source.tools,
    "call",
    { name: source.operation, arguments: input },
  );
  if (failed) throw new Error(output);
  return JSON.parse(output) as T;
}

/**
 * When a piece of work's rows are enough: the box wants its latest calls, each with the command a
 * poll belongs to; the window wants all of it.
 */
type Enough = (rows: readonly Row[]) => boolean;
const boxEnough: Enough = (rows) => {
  const calls = rows.filter((row) => row.kind !== "say");
  return calls.length >= EACH && !calls.slice(-EACH).some((row) => row.kind === "poll");
};
const never: Enough = () => false;

/**
 * An agent's pieces of work, as the view's operation answers them: read when it opens and again
 * each time its capability says the view changed, one read at a time. With `every`, the pieces
 * last active before those it answers first are read too, a page at a time. A piece's older
 * entries are read a page at a time until its rows are `enough`; what was read before is kept, so
 * a change reads its latest entries and no more. Not read, it has none and says so.
 */
function useWorks(source: Source | undefined, enough: Enough, pages: number, every = false) {
  const connection = useConnection();
  const [read, setRead] = useState<{ works?: Work[]; unread?: true }>({});
  const key = source && JSON.stringify(source);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` says when `source` changed.
  useEffect(() => {
    if (!source || connection !== "open") return;
    let live = true;
    let reading = false;
    let again = false;
    /** What was read of each piece of work: its entries in order, and whether older ones remain. */
    const held = new Map<string, { entries: Entry[]; more: boolean }>();
    /** The latest entries joined to what was read before, where they meet. */
    const joined = (work: Work): Work => {
      const had = held.get(work.id);
      const at = had?.entries.findIndex((entry) => entry.id === work.entries[0]?.id) ?? -1;
      return had && at !== -1
        ? { ...work, entries: [...had.entries.slice(0, at), ...work.entries], more: had.more }
        : work;
    };
    const fill = async (latest: Work): Promise<Work> => {
      let work = joined(latest);
      for (let n = 0; work.more && n < pages && !enough(rowsOf(work.entries)); n++) {
        let page: Page;
        try {
          page = await ask<Page>(source, {
            work: work.id,
            ...(work.entries[0] ? { before: work.entries[0].id } : {}),
            limit: PAGE,
          });
        } catch {
          // What was read stays: the rest is read with the next change.
          break;
        }
        const known = new Set(work.entries.map((entry) => entry.id));
        const older = page.entries.filter((entry) => !known.has(entry.id));
        // Where the page meets what was read before, that is known too.
        work = joined({
          ...work,
          entries: [...older, ...work.entries],
          more: page.more && older.length > 0,
        });
      }
      held.set(work.id, { entries: work.entries, more: work.more });
      return work;
    };
    const update = async () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        do {
          again = false;
          let works: Work[];
          let more: boolean | undefined;
          try {
            ({ works, more } = await ask<Pieces>(source, {}));
          } catch {
            if (live) setRead({ unread: true });
            continue;
          }
          if (!live) return;
          // The pieces before the last one listed, page after page.
          for (let n = 0; every && more && n < PIECE_PAGES; n++) {
            const last = works.at(-1);
            if (!last) break;
            let page: Pieces;
            try {
              page = await ask<Pieces>(source, { before: last.id });
            } catch {
              // Those read are drawn: the rest is read with the next change.
              break;
            }
            if (!live) return;
            const known = new Set(works.map((work) => work.id));
            const older = page.works.filter((work) => !known.has(work.id));
            works = [...works, ...older];
            more = page.more && older.length > 0;
          }
          // What is known is drawn at once; what is read next follows.
          setRead({ works: works.map(joined) });
          const filled = await Promise.all(works.map(fill));
          if (live && !again) setRead({ works: filled });
        } while (again && live);
      } finally {
        reading = false;
      }
    };
    void update();
    const stop = api.subscribe(
      source.capability,
      "changed",
      (payload) => {
        if ((payload as { view?: string }).view === source.view) void update();
      },
      { again: update },
    );
    return () => {
      live = false;
      stop();
    };
  }, [key, connection, pages, every]);
  return { ...read, ...(source ? {} : { works: [] }) };
}

/** A call that was going when its work stopped ended there. */
const ended = (row: Row): Row =>
  row.kind === "say" || row.kind === "line" || row.state !== "running"
    ? row
    : row.kind === "command"
      ? { ...row, state: "done", stopped: true }
      : { ...row, state: "done" };

/** A piece of work's entries as rows: a call still going in one that stopped ended there. */
const rowsIn = (work: Work) => {
  const rows = rowsOf(work.entries);
  return work.state === "stopped" ? rows.map(ended) : rows;
};

/** A piece of work: its title, then how it stands (worked on now, or when it last did something), then what it did. */
function Piece({ work, rows }: { work: Work; rows: readonly Row[] }) {
  // How long ago is said again as time goes by.
  useEvery(MINUTE);
  return (
    <section aria-label={work.title} className="min-w-0">
      <div className="flex h-8 items-center gap-2 px-1">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{work.title}</h3>
        {work.state === "working" ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span
              role="img"
              aria-label="Working"
              className="pulse mx-0.5 inline-block size-2 shrink-0 rounded-full bg-[var(--ok)]"
            />
            Working
          </span>
        ) : (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {work.at ? age(work.at) : ""}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((row) =>
          // What it wrote and didn't send to anyone: kept with the work, as it was written.
          row.kind === "say" ? (
            <Bubble key={row.id} variant="ghost" className="w-full px-1">
              <BubbleContent className="prose-chat w-full whitespace-pre-wrap">
                {row.text}
              </BubbleContent>
            </Bubble>
          ) : row.kind === "line" ? (
            // A line of its own, as for calls that never ran: nothing to open.
            <p
              key={row.id}
              data-call
              className="flex h-7 items-center gap-2 px-1 text-[13px] text-muted-foreground [[data-call]+&]:-mt-1.5"
            >
              <WrenchIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{row.text}</span>
            </p>
          ) : (
            <CallRow key={row.id} row={row} />
          ),
        )}
      </div>
    </section>
  );
}

/** On Overview: the latest few calls it made, under the pieces of work they belong to. */
export function ActivityBox({ agent, detail }: { agent: string; detail: AgentDetail }) {
  const { openActivity } = useComputers();
  const { works, unread } = useWorks(activityOf(detail), boxEnough, BOX_PAGES);
  const latest: { work: Work; rows: Row[] }[] = [];
  for (let n = 0, left = LATEST; n < (works?.length ?? 0) && left > 0; n++) {
    const work = works?.[n] as Work;
    const rows = rowsIn(work)
      .filter((row) => row.kind !== "say")
      .slice(-Math.min(EACH, left));
    if (rows.length > 0) latest.push({ work, rows });
    left -= rows.length;
  }
  return (
    <Section
      title="Activity"
      action={
        latest.length > 0 && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Expand"
            onClick={() => openActivity(agent)}
          >
            <Maximize2Icon />
          </Button>
        )
      }
    >
      {unread ? (
        <Nothing>{UNREAD}</Nothing>
      ) : !works ? null : latest.length === 0 ? (
        <Nothing>No activity</Nothing>
      ) : (
        <div className="flex flex-col gap-2 rounded-xl bg-card px-2 py-1.5">
          {latest.map(({ work, rows }) => (
            <Piece key={work.id} work={work} rows={rows} />
          ))}
        </div>
      )}
    </Section>
  );
}

/**
 * All of it, as the layer's window: the frame a computer's window has there, with whose it is and
 * its own Close. Every piece of work with every call in the order it happened, and what was written
 * and not sent, as words between the calls.
 */
export function ActivityWindow({
  agent,
  detail,
}: {
  agent: { id: string; name: string; tone: Tone };
  detail: AgentDetail | undefined;
}) {
  const { close } = useComputers();
  const { works, unread } = useWorks(activityOf(detail), never, WINDOW_PAGES, true);
  return (
    <section
      aria-label={`${agent.name}'s activity`}
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-3xl bg-[var(--canvas)] shadow-2xl phone:rounded-none"
      style={{
        backgroundImage: `linear-gradient(155deg, ${tintOf(agent.id).soft}, transparent 62%)`,
      }}
    >
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 pr-2 pl-4">
        <h3 className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
          <Face agent={agent} size={20} plain />
          <span className="truncate">{agent.name}'s activity</span>
        </h3>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Close ${agent.name}'s activity`}
          onClick={close}
        >
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 px-2.5 pb-2.5">
        <div className="window relative h-full rounded-xl bg-background shadow-lg">
          <div className="no-bar h-full overflow-y-auto px-4 py-3 phone:px-2.5">
            <div className="mx-auto flex max-w-[720px] flex-col gap-5">
              {unread ? (
                <Nothing>{UNREAD}</Nothing>
              ) : !works ? null : works.length === 0 ? (
                <Nothing>No activity</Nothing>
              ) : (
                works.map((work) => <Piece key={work.id} work={work} rows={rowsIn(work)} />)
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
