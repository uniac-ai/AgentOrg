// What an agent's computer is, in its own words, how loaded it is when it says, and who is acting
// on it now: the column beside it on its agent's page. It is drawn from the views its capabilities
// place in the column, in their order: a facts view with the meters after it is one part, as the
// load is that place's numbers; the facts after that are one list, and who is in use follows.
import type { FactRow, Facts } from "@agentorg/interfaces";
import { useEffect, useState } from "react";
import type { z } from "zod";
import { api, useConnection } from "../data.ts";
import { type OpenSurface, targetOf, windowsOf } from "./computer.tsx";
import { Load } from "./computer-load.tsx";
import { type AgentDetail, REFRESH_MS } from "./data.ts";
import { type LiveTarget, useLive } from "./live-socket.ts";

type Row = z.output<typeof FactRow>;
type Held = NonNullable<AgentDetail["capabilities"]>[number];

/** The column's views of these kinds, in the order their capabilities give them. */
const KINDS = ["facts", "meters", "presence"];
/** The protocol a computer says who is acting on it in: the whole list, each time it changes. */
const PRESENCE = "presence@1";
interface Acting {
  who: "person" | "agent";
  name?: string;
  capability: string;
}

export const columnOf = (detail: AgentDetail | undefined) =>
  (detail?.capabilities ?? []).flatMap((held) =>
    held.views
      .filter((view) => view.place === "column" && KINDS.includes(view.kind))
      .map((view) => ({ view, held })),
  );
type Placed = ReturnType<typeof columnOf>[number];

/**
 * A facts view's rows: those fixed when it was built, or what its operation answers through the
 * person's own slot, read again when its capability says the view changed. Those it names are
 * the ones it shows. One that can't be read shows none.
 */
function useRows({ view, held }: Placed): Row[] {
  const connection = useConnection();
  const [read, setRead] = useState<Row[]>([]);
  const tools = view.slot ? held.person.operations[view.slot] : undefined;
  const asked = view.operation && tools;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view's own ids say when it changed.
  useEffect(() => {
    if (!asked || connection !== "open") return;
    let live = true;
    const read = () =>
      api
        .call<{ output: string; failed?: true }>(tools, "call", {
          name: view.operation,
          arguments: {},
        })
        .then(
          ({ output, failed }) => {
            if (!live) return;
            const rows = failed ? [] : (JSON.parse(output) as z.output<typeof Facts>).rows;
            setRead(view.rows ? rows.filter((row) => view.rows?.includes(row.label)) : rows);
          },
          () => live && setRead([]),
        );
    void read();
    const stop = api.subscribe(
      held.person.capability,
      "changed",
      (payload) => {
        // Its view changed, or how it stands did: what it can say may be different.
        const changed = (payload as { view?: string }).view;
        if (!changed || changed === view.id) void read();
      },
      { again: read },
    );
    return () => {
      live = false;
      stop();
    };
  }, [asked, tools, view.id, view.operation, held.person.capability, connection]);
  return asked ? read : (view.fixed ?? []);
}

/**
 * One fact: what it is, and its value, a path in mono and a caution in its colour; under it, a
 * quieter note on what to make of it, when it has one.
 */
function Fact({ row }: { row: Row }) {
  return (
    <div>
      <dt className="text-[13px] text-muted-foreground">{row.label}</dt>
      <dd
        className={`m-0 truncate ${row.path ? "font-mono text-xs leading-6" : "text-sm"} ${row.caution ? "text-[var(--warn)]" : ""}`}
      >
        {row.value}
      </dd>
      {row.note && <dd className="m-0 truncate text-xs text-muted-foreground">{row.note}</dd>}
    </div>
  );
}

/**
 * Who acted on each window of the computer in the last few seconds, as its presence surface says:
 * the agent first, other agents, then you. One row for each window with someone, in the dock's
 * order; none, and it says so. Before the surface first says, or while it can't be watched,
 * nothing is shown.
 */
function InUse({
  agent,
  target,
  windows,
}: {
  agent: { id: string; name: string };
  target: LiveTarget;
  windows: ReturnType<typeof windowsOf>;
}) {
  const [acting, setActing] = useState<Acting[]>();
  const live = useLive(
    target,
    (data) => {
      if (typeof data !== "string") return;
      const frame = JSON.parse(data) as { type?: string; acting?: Acting[] };
      if (frame.type === "presence" && Array.isArray(frame.acting)) setActing(frame.acting);
    },
    () => setActing(undefined),
  );
  // A socket that closed is opened again, as often as what has no event is read again.
  const closed = live.state.phase === "closed";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `again` is this socket's own.
  useEffect(() => {
    if (!closed) return;
    const timer = setTimeout(live.again, REFRESH_MS);
    return () => clearTimeout(timer);
  }, [closed]);
  if (live.state.phase !== "open" || !acting) return null;
  const rows = windows.flatMap((window) => {
    const here = acting.filter((one) => one.capability === window.kind);
    const agents = [
      ...new Set(here.flatMap((one) => (one.who === "agent" && one.name ? [one.name] : []))),
    ].sort((a, b) => Number(b === agent.name) - Number(a === agent.name));
    const who = [...agents, ...(here.some((one) => one.who === "person") ? ["You"] : [])];
    return who.length > 0 ? [{ title: window.title, who }] : [];
  });
  return (
    <section aria-label="In use" className="flex flex-col gap-1.5">
      <div className="text-[13px] text-muted-foreground">In use</div>
      {rows.length > 0 ? (
        rows.map((row) => (
          <div key={row.title} className="flex min-w-0 gap-2 text-sm">
            <span className="w-16 shrink-0 text-muted-foreground">{row.title}</span>
            <span className="min-w-0">{row.who.join(", ")}</span>
          </div>
        ))
      ) : (
        <div className="text-sm">No one, in the last few seconds</div>
      )}
    </section>
  );
}

/** A facts view's rows, read as it says. */
function FactsOf({ placed, children }: { placed: Placed; children(rows: Row[]): React.ReactNode }) {
  return <>{children(useRows(placed))}</>;
}

export function ComputerFacts({
  agent,
  detail,
  surfaces,
  reachable,
  load,
}: {
  agent: { id: string; name: string };
  detail: AgentDetail;
  /** What its units can show live now: its windows, and who is acting on them. */
  surfaces: readonly OpenSurface[];
  /** Whether it can be reached: a view only shown then isn't, while it can't. */
  reachable: boolean;
  /** Where its meters are read, while they can be. */
  load?: LiveTarget | undefined;
}) {
  // Views only shown while it can be reached aren't, while it can't; its meters say nothing then.
  const column = columnOf(detail).filter(
    (one) => reachable || one.view.kind === "meters" || one.view.when !== "reachable",
  );
  // The first facts view with meters after it heads the column; the rest of its facts follow.
  const at = column.findIndex(
    (one, i) => one.view.kind === "facts" && column[i + 1]?.view.kind === "meters",
  );
  const head = at === -1 ? undefined : column[at];
  const meters = at === -1 ? [] : column.slice(at + 1).filter((one) => one.view.kind === "meters");
  const rest = column.filter((one) => one !== head && one.view.kind === "facts");
  // Who is in use, watched on its surface while the computer lists it.
  const presence = column.flatMap(({ view }) => {
    const surface =
      view.kind === "presence"
        ? surfaces.find(
            (s) => s.surface === view.surface && s.protocol === PRESENCE && !s.unavailable,
          )
        : undefined;
    return surface
      ? [{ id: view.id, target: targetOf(agent.id, { ...surface, operate: false }) }]
      : [];
  });
  return (
    <aside aria-label="About this computer" className="flex min-w-0 flex-col gap-5">
      {head && (
        <FactsOf placed={head}>
          {(rows) => (
            <section
              aria-label={rows[0]?.value ?? head.held.title}
              className="flex flex-col gap-3.5"
            >
              {rows.map((row) => (
                <div key={row.label}>
                  <div className="text-[13px] text-muted-foreground">{row.label}</div>
                  <div className="truncate text-sm">{row.value}</div>
                  {row.note && (
                    <div className="truncate text-xs text-muted-foreground">{row.note}</div>
                  )}
                </div>
              ))}
              {meters.length > 0 && load && <Load target={load} />}
            </section>
          )}
        </FactsOf>
      )}
      <dl className="flex flex-col gap-3">
        {rest.map((placed) => (
          <FactsOf key={`${placed.held.id} ${placed.view.id}`} placed={placed}>
            {(rows) => rows.map((row) => <Fact key={row.label} row={row} />)}
          </FactsOf>
        ))}
      </dl>
      {presence.map(({ id, target }) => (
        <InUse key={id} agent={agent} target={target} windows={windowsOf(surfaces)} />
      ))}
    </aside>
  );
}
