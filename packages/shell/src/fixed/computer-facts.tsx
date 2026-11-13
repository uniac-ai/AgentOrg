// What an agent's computer is, in its own words, and how loaded it is when it says: the column
// beside it on its agent's page. It is drawn from the views its capabilities place in the column,
// in their order: a facts view with the meters after it is one part, as the load is that place's
// numbers; the facts after that are one list.
import type { FactRow, Facts } from "@agentorg/interfaces";
import { useEffect, useState } from "react";
import type { z } from "zod";
import { api, useConnection } from "../data.ts";
import { Load } from "./computer-load.tsx";
import type { AgentDetail } from "./data.ts";
import type { LiveTarget } from "./live-socket.ts";

type Row = z.output<typeof FactRow>;
type Held = NonNullable<AgentDetail["capabilities"]>[number];

/** The column's views of these kinds, in the order their capabilities give them. */
const KINDS = ["facts", "meters"];

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

/** One fact: what it is, and its value, a path in mono and a caution in its colour. */
function Fact({ row }: { row: Row }) {
  return (
    <div>
      <dt className="text-[13px] text-muted-foreground">{row.label}</dt>
      <dd
        className={`m-0 truncate ${row.path ? "font-mono text-xs leading-6" : "text-sm"} ${row.caution ? "text-[var(--warn)]" : ""}`}
      >
        {row.value}
      </dd>
    </div>
  );
}

/** A facts view's rows, read as it says. */
function FactsOf({ placed, children }: { placed: Placed; children(rows: Row[]): React.ReactNode }) {
  return <>{children(useRows(placed))}</>;
}

export function ComputerFacts({
  detail,
  reachable,
  load,
}: {
  detail: AgentDetail;
  /** Whether it can be reached: a view only shown then isn't, while it can't. */
  reachable: boolean;
  /** Where its meters are read, while they can be. */
  load?: LiveTarget | undefined;
}) {
  // Facts only shown while it can be reached aren't, while it can't; its meters say nothing then.
  const column = columnOf(detail).filter(
    (one) => reachable || one.view.kind !== "facts" || one.view.when !== "reachable",
  );
  // The first facts view with meters after it heads the column; the rest of its facts follow.
  const at = column.findIndex(
    (one, i) => one.view.kind === "facts" && column[i + 1]?.view.kind === "meters",
  );
  const head = at === -1 ? undefined : column[at];
  const meters = at === -1 ? [] : column.slice(at + 1).filter((one) => one.view.kind === "meters");
  const rest = column.filter((one) => one !== head && one.view.kind === "facts");
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
    </aside>
  );
}
