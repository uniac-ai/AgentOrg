// An agent's Overview, assembled from sections: what it does, what it was built from in one line,
// and who changed it through control.
import type { agents } from "@agentorg/interfaces";
import type { z } from "zod";
import { api, useLoad } from "../data.ts";
import { ActivityBox } from "./activity.tsx";
import { useBuilding } from "./building.tsx";
import { age } from "./chat-parts.tsx";
import { type AgentDetail, type AgentEntry, REFRESH_MS, useEvery } from "./data.ts";
import { Nothing, Section, UNREAD } from "./parts.tsx";
import { useAgents } from "./watch.tsx";

type Change = z.output<typeof agents.methods.activity.output>["entries"][number];

/** Who asks as the person, in the control log. */
const PERSON = "person";
/** A page of the control log, and how many pages are read for one agent. */
const PAGE = 200;
const PAGES = 10;

/** What a change of the control log did to the agent, as a verb; none for one that isn't shown. */
function verbOf(tool: string) {
  if (tool === "agent_create" || tool.startsWith("create_")) return "create";
  if (tool === "agent_start") return "start";
  if (tool === "agent_stop") return "stop";
  return undefined;
}

export function Overview({ entry, detail }: { entry: AgentEntry; detail: AgentDetail }) {
  const { catalog, catalogRead } = useBuilding();
  // Until the catalog is read a template has no title to say; one that has gone says its id.
  const titleOf = (template: string) =>
    catalog.templates.find((t) => t.id === template)?.title ?? (catalogRead.loaded ? template : "");
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-7">
      <ActivityBox agent={entry.agent} detail={detail} />
      <Section title="Built from">
        <div className="flex h-10 items-center gap-3 text-sm">
          <span className="shrink-0 font-medium">
            {entry.template ? titleOf(entry.template) : "Empty"}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
            {detail.units.map((unit) => unit.title).join(", ") || "Just the base"}
          </span>
        </div>
      </Section>
      <Changes agent={entry.agent} titleOf={titleOf} />
    </div>
  );
}

/** Who made, started or stopped it through control, newest first, and what was refused. */
function Changes({ agent, titleOf }: { agent: string; titleOf(template: string): string }) {
  const tick = useEvery(REFRESH_MS);
  const { list } = useAgents();
  // The log has what the agent did too, newest first: it is read back a page at a time, so its own
  // calls don't push out the changes to it.
  const read = useLoad(
    async () => {
      const entries: Change[] = [];
      let before: number | undefined;
      for (let n = 0; n < PAGES; n++) {
        const page = await api.call<{ entries: Change[]; more: boolean }>("agents", "activity", {
          agent,
          limit: PAGE,
          ...(before === undefined ? {} : { before }),
        });
        entries.push(...page.entries);
        before = page.entries.at(-1)?.seq;
        if (!page.more || before === undefined) break;
      }
      return { entries };
    },
    ["actors"],
    [agent, tick],
  );
  const shown = (read.value?.entries ?? []).flatMap((change) => {
    const verb = verbOf(change.tool);
    return change.target === agent && verb ? [{ change, verb }] : [];
  });
  const who = (caller: string) =>
    caller === PERSON ? "You" : (list.find((one) => one.agent === caller)?.name ?? "An agent");
  const did = (change: Change, verb: string) => {
    if (change.outcome === "refused") return `tried to ${verb} it: ${change.reason ?? "refused"}`;
    if (verb === "create")
      return change.tool.startsWith("create_")
        ? `created it from ${titleOf(change.tool.slice("create_".length))}`
        : "created it";
    return `${verb === "start" ? "started" : "stopped"} it`;
  };
  return (
    <Section title="Changed through control">
      {read.error ? (
        <Nothing>{UNREAD}</Nothing>
      ) : !read.loaded ? null : shown.length === 0 ? (
        <Nothing>No changes</Nothing>
      ) : (
        shown.map(({ change, verb }) => (
          <div
            key={change.seq}
            className="flex h-10 items-center gap-3 border-t text-sm first:border-t-0"
          >
            <span className="shrink-0 font-medium">{who(change.caller)}</span>
            <span
              className={`min-w-0 flex-1 truncate text-[13px] ${change.outcome === "refused" ? "text-[var(--bad)]" : "text-muted-foreground"}`}
            >
              {did(change, verb)}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {age(change.at)}
            </span>
          </div>
        ))
      )}
    </Section>
  );
}
