// What agents did through AgentOrg control that concerns this one: each call that changed something,
// and each refusal, newest first. Only what management keeps: never a message or a secret.
import type { agents } from "@agentorg/interfaces";
import type { z } from "zod";
import { api, useLoad } from "../data.ts";
import { ago, REFRESH_MS, useEvery } from "./data.ts";
import { useAgents } from "./watch.tsx";

type Entry = z.output<typeof agents.methods.activity.output>["entries"][number];

export function ActivityLog({ agent }: { agent: string }) {
  const tick = useEvery(REFRESH_MS);
  const { list } = useAgents();
  const entries =
    useLoad(
      () =>
        api
          .call<{ entries: Entry[] }>("agents", "activity", { agent, limit: 50 })
          .then((r) => r.entries),
      ["actors"],
      [agent, tick],
    ).value ?? [];
  if (entries.length === 0) return null;
  const nameOf = (id?: string) => (id && list.find((a) => a.agent === id)?.name) || id;
  return (
    <section aria-label="Control" className="flex min-w-0 flex-col rounded-xl border p-3">
      <h2 className="text-xs font-normal text-[var(--faint)]">Control</h2>
      <ol className="no-bar mt-1 max-h-56 overflow-y-auto">
        {entries.map((entry) => (
          <li key={entry.seq} className="flex min-h-7 items-baseline gap-2 py-0.5 text-[13px]">
            <span className="min-w-0 flex-1">
              {entry.caller !== agent && (
                <span className="text-muted-foreground">{nameOf(entry.caller)} </span>
              )}
              <span className="font-mono text-xs">{entry.tool}</span>
              {entry.target && (
                <span className="text-muted-foreground"> {nameOf(entry.target)}</span>
              )}
              {entry.outcome === "refused" && (
                <span className="block text-xs text-[var(--bad)]">{entry.reason ?? "Refused"}</span>
              )}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-[var(--faint)]">
              {ago(entry.at)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
