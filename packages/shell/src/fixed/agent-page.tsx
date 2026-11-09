import { MessageCircleIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";
import { api, go, useLoad } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { useBuilding } from "./building.tsx";
import { useChats } from "./chats.tsx";
import { More, Power, Tip } from "./controls.tsx";
import { ago, useCreatables } from "./data.ts";
import { Nothing, Scroll, StateDot } from "./parts.tsx";
import { chosenNotes, partsOf } from "./stack.ts";
import { useAgents } from "./watch.tsx";

/** Held for what comes later: the frame is real, and nothing in it is invented. */
function Held({ title, className }: { title: string; className?: string }) {
  return (
    <section
      aria-label={title}
      className={`min-h-40 rounded-xl border border-dashed p-3 ${className ?? ""}`}
    >
      <h2 className="text-xs font-normal text-[var(--faint)]">{title}</h2>
    </section>
  );
}

function Fact({ label, value, onClick }: { label: string; value: string; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-w-0 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--hover)]"
    >
      <span className="block text-xs text-muted-foreground">{label}</span>
      <span className="block truncate text-sm">{value}</span>
    </button>
  );
}

/** One agent: what it's for and how it stands, then room for what it will show. */
export function AgentPage({ agent: id }: { agent: string }) {
  const { byId, loaded, list } = useAgents();
  const { chatWith } = useChats();
  const watched = byId.get(id);
  const creatables = useCreatables();
  const { catalog } = useBuilding();
  const [failed, setFailed] = useState<string>();
  const slot = watched?.slot;
  const running = watched?.entry.status.state === "running";
  const models = useLoad(
    () =>
      slot && running
        ? api.call<{ models: { id: string; name: string }[]; current?: string }>(slot, "models")
        : Promise.resolve(undefined),
    [],
    [slot, running],
  ).value;
  if (!watched)
    return (
      <Scroll>
        {loaded && !list.some((a) => a.agent === id) && (
          <Nothing>This agent can't be read right now.</Nothing>
        )}
      </Scroll>
    );
  const { entry, now, detail } = watched;
  const creatable = creatables?.find(
    (c) => c.provider === entry.provider && c.id === entry.creatable,
  );
  const toSettings = () => go({ screen: "agent-settings", agent: id });
  const model = models?.models.find((m) => m.id === models.current)?.name ?? "Default";
  return (
    <Scroll>
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="flex items-start gap-4 tight:flex-col tight:gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[22px] leading-7 font-semibold">{entry.name}</h1>
            <p className="mt-1 text-[15px] text-muted-foreground">
              {entry.purpose ?? creatable?.description}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" onClick={() => chatWith(id)}>
              <MessageCircleIcon />
              Chat
            </Button>
            <Power agent={entry} onFailed={setFailed} />
            <Tip label="Settings">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${entry.name} settings`}
                onClick={toSettings}
              >
                <Settings2Icon />
              </Button>
            </Tip>
            <More agent={entry} />
          </div>
        </div>

        <div className="flex h-6 items-center gap-2.5 text-[14px]">
          <StateDot tone={failed ? "trouble" : now.tone} />
          <span
            className={`min-w-0 flex-1 truncate ${failed || now.tone === "trouble" ? "text-[var(--bad)]" : ""}`}
          >
            {failed ?? now.text}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{ago(now.at)}</span>
        </div>

        {detail?.units.some((u) => u.values) && (
          <div className="-mt-3 flex flex-col text-[13px] text-muted-foreground">
            {detail.units.map((applied) => {
              const form =
                catalog.units.find((u) => u.provider === applied.provider && u.id === applied.unit)
                  ?.form ?? [];
              const parts = partsOf(applied.values, form);
              return (
                parts.length > 0 && (
                  <p key={applied.instance} className="min-w-0">
                    {[
                      `${applied.title}: ${parts.join(", ")}.`,
                      ...chosenNotes(applied.values, form),
                    ].join(" ")}
                  </p>
                )
              );
            })}
          </div>
        )}

        <div className="-mx-2 grid grid-cols-4 gap-1 tight:grid-cols-2">
          <Fact
            label="Made from"
            value={creatable?.title ?? entry.creatable}
            onClick={toSettings}
          />
          <Fact label="Model" value={model} onClick={toSettings} />
          <Fact label="MCPs" value={String(detail?.mcp.length ?? "")} onClick={toSettings} />
          <Fact label="Skills" value={String(detail?.skills.length ?? "")} onClick={toSettings} />
        </div>

        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3 tight:grid-cols-1">
          <Held title="Computer" className="row-span-2 min-h-96 tight:row-span-1 tight:min-h-48" />
          <Held title="Browser" />
          <Held title="Updates" />
        </div>
      </div>
    </Scroll>
  );
}
