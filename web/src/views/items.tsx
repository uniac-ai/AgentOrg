// An actor's open items, a row each: its state as a shape, its title, who holds it, linked for
// drill-down, what it waits on, its summary and its links.

import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, HourglassIcon } from "lucide-react";
import type { ItemRecord, WaitsOnRecord } from "../../../src/clients/web/types.ts";
import type { Member } from "../model/organization.ts";
import { itemState } from "../model/state.ts";
import { SR, StateMark, StateName, StateShape } from "./marks.tsx";
import { Links, type Names, nameOf } from "./messages.tsx";

export interface ItemsModel {
  items: ItemRecord[];
  members: ReadonlyMap<string, Member>;
  names: Names;
  /** The actor whose items they are; its own items need no owner. */
  self: string;
}

/** One thing an item waits on: an actor, linked, or its item; another item here; or text. */
function Blocker({ on, model }: { on: WaitsOnRecord; model: ItemsModel }) {
  if ("text" in on) return <span className="min-w-0">{on.text}</span>;
  if (!("actor" in on)) return <span className="min-w-0 font-medium">{on.item}</span>;
  const member = model.members.get(on.actor);
  const actor = member && member.manager !== null ? member : undefined;
  const name = (
    <>
      {actor ? <StateMark member={actor} /> : null}
      <span className="truncate">
        {nameOf(on.actor, model.names)}
        {on.item ? `: ${on.item}` : null}
      </span>
    </>
  );
  return actor ? (
    <Link
      to="/people/$actorId"
      params={{ actorId: on.actor }}
      className="inline-flex min-w-0 items-center gap-1 hover:underline"
    >
      {name}
    </Link>
  ) : (
    <span className="inline-flex min-w-0 items-center gap-1">{name}</span>
  );
}

function WaitsOn({ waits, model }: { waits: WaitsOnRecord[]; model: ItemsModel }) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-state-waiting">
      <HourglassIcon aria-hidden="true" className="size-3 shrink-0" />
      <SR>Waits on </SR>
      {waits.map((on) => (
        <Blocker key={JSON.stringify(on)} on={on} model={model} />
      ))}
    </p>
  );
}

export function Items(model: ItemsModel) {
  if (model.items.length === 0) return null;
  return (
    <ol aria-label="Items" className="flex flex-col divide-y rounded-lg border bg-card">
      {model.items.map((item) => {
        const owner =
          item.owner && item.owner !== model.self ? model.members.get(item.owner) : undefined;
        return (
          <li key={item.title} className="flex items-start gap-2.5 px-3 py-2.5">
            <StateShape state={itemState(item)} className="mt-1" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex min-w-0 items-start gap-2">
                <span className="min-w-0 flex-1 font-medium">
                  {item.title}
                  <SR>{`, ${item.state}`}</SR>
                </span>
                {owner ? (
                  <Link
                    data-row
                    to="/people/$actorId"
                    params={{ actorId: owner.id }}
                    className="-my-0.5 inline-flex max-w-40 shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <SR>Held by </SR>
                    <StateMark member={owner} />
                    <span className="truncate">{owner.name}</span>
                    <StateName member={owner} />
                    <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  </Link>
                ) : null}
              </div>
              {item.summary ? (
                <p className="text-sm whitespace-pre-wrap text-muted-foreground">{item.summary}</p>
              ) : null}
              {item.waits_on ? <WaitsOn waits={item.waits_on} model={model} /> : null}
              <Links links={item.links ?? []} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
