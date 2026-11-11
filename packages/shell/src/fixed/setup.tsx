// What an agent is made of, and the way to delete it: a sheet from the side of its page.
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";
import { api, go, useLoad } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { useBuilding } from "./building.tsx";
import {
  type AgentDetail,
  type AgentEntry,
  getAgent,
  listConnections,
  listSkills,
  type Mcp,
  REFRESH_MS,
  slotFor,
  useAct,
  useEvery,
} from "./data.ts";
import { ConfirmDelete } from "./delete-dialog.tsx";
import { Nothing, Section, TroubleDot, WhereIcon } from "./parts.tsx";
import { partsOf } from "./stack.ts";
import { useAgents } from "./watch.tsx";

/** The picker's value for no model chosen: the provider's default. */
const DEFAULT = "default";

export function Setup({
  agent,
  open,
  onClose,
}: {
  agent: AgentEntry;
  open: boolean;
  onClose(): void;
}) {
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="window top-2 right-2 bottom-2 left-auto flex w-[460px] max-w-[calc(100%-1rem)] translate-x-0 translate-y-0 flex-col gap-0 rounded-2xl bg-background p-0 ring-0 sm:max-w-[460px] data-open:zoom-in-100 data-closed:zoom-out-100 data-open:slide-in-from-right-8 data-closed:slide-out-to-right-8">
          <DialogHeader className="h-14 shrink-0 justify-center px-5">
            <DialogTitle className="text-[17px]">{agent.name}'s setup</DialogTitle>
            <DialogDescription className="sr-only">What {agent.name} is made of</DialogDescription>
          </DialogHeader>
          <Made agent={agent} />
          <div className="flex h-14 shrink-0 items-center border-t px-5">
            <Button
              variant="ghost"
              className="-ml-2.5 text-[var(--bad)]"
              onClick={() => setDeleting(true)}
            >
              Delete {agent.name}…
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDelete
        name={agent.name}
        open={deleting}
        onOpenChange={setDeleting}
        onDelete={() => api.call("agents", "remove", { agent: agent.agent })}
        onDeleted={() => go({ screen: "home" })}
      >
        Its chats and what was created for it go with it. Connections you made and your skills stay.
        This can't be undone.
      </ConfirmDelete>
    </>
  );
}

/** What it's made of, read again while the sheet is open and after each change. */
function Made({ agent: entry }: { agent: AgentEntry }) {
  const id = entry.agent;
  const tick = useEvery(REFRESH_MS);
  const [changed, setChanged] = useState(0);
  const { catalog } = useBuilding();
  // It opens on what the page already read, and a read that fails keeps what the last one said.
  const read = useLoad(() => getAgent(id), ["actors", "bindings"], [id, tick, changed]).value;
  const last = useRef(useAgents().byId.get(id)?.detail);
  if (read) last.current = read;
  const agent = last.current;
  const skills = useLoad(listSkills, [], [changed]).value;
  const connections = useLoad(listConnections, ["actors", "bindings"], [changed]).value;
  const act = useAct();
  if (!agent) return <div className="flex-1" />;

  const change = (method: string, input: Record<string, unknown>) =>
    act.run(
      () => api.call("agents", method, { agent: id, ...input }),
      () => setChanged((was) => was + 1),
    );
  const exposed = new Set(agent.mcp.map((m) => m.connection));
  const offered = (connections ?? []).filter(
    (c) => !c.origin?.madeFor && !exposed.has(c.connection),
  );
  const has = new Set(agent.skills.map((s) => s.name));
  const spare = (skills ?? []).filter((s) => !has.has(s.name));
  const template = catalog.templates.find((t) => t.id === entry.template)?.title;
  return (
    <div className="no-bar flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-5 pb-5">
      {act.failed && (
        <p role="alert" className="text-[13px] text-[var(--bad)]">
          {act.failed}
        </p>
      )}
      <Section title={template ? `Built from ${template}` : "Built from"}>
        <BuiltFrom units={agent.units} />
      </Section>
      <Section title="Model">
        <ModelPicker {...(agent.status.state === "running" ? { agent: id } : {})} />
      </Section>
      <Section
        title="MCPs"
        action={
          <AddMenu
            label="Add an MCP"
            items={offered.map((c) => ({ id: c.connection, name: c.name }))}
            onPick={(connection, name) => {
              const as = slotFor(
                name,
                agent.mcp.map((m) => m.slot),
              );
              change("expose", { connection, ...(as ? { as } : {}) });
            }}
          />
        }
      >
        {agent.mcp.map((mcp) => (
          <McpRow
            key={mcp.slot}
            mcp={mcp}
            agentName={agent.name}
            unit={
              mcp.origin?.madeFor
                ? agent.units.find((u) => u.instance === mcp.instance)?.title
                : undefined
            }
            onRemove={() => change("unexpose", { slot: mcp.slot })}
          />
        ))}
        {agent.mcp.length === 0 && <Nothing>No MCPs</Nothing>}
      </Section>
      <Section
        title="Skills"
        action={
          <AddMenu
            label="Add a skill"
            items={spare.map((s) => ({ id: s.name, name: s.name }))}
            onPick={(skill) => change("expose", { skill })}
          />
        }
      >
        {agent.skills.map((skill) => (
          <div
            key={skill.name}
            className="flex h-10 items-center gap-3 border-t text-sm first:border-t-0"
          >
            <span className="shrink-0 font-medium">{skill.name}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
              {skill.description}
            </span>
          </div>
        ))}
        {agent.skills.length === 0 && <Nothing>No skills</Nothing>}
      </Section>
    </div>
  );
}

/** The stack it came from, as it was filled in: each unit with its answers in words. */
function BuiltFrom({ units }: { units: AgentDetail["units"] }) {
  const { catalog } = useBuilding();
  if (units.length === 0) return <Nothing>Just the base</Nothing>;
  return (
    <ol className="flex flex-col gap-1.5">
      {units.map((applied) => {
        const form =
          catalog.units.find((u) => u.provider === applied.provider && u.id === applied.unit)
            ?.form ?? [];
        return (
          <li key={applied.instance} className="rounded-xl bg-card px-3 py-2.5 text-sm">
            <div className="font-medium">{applied.title}</div>
            {partsOf(applied.values, form).map((line) => (
              <div key={line} className="truncate text-[13px] text-muted-foreground">
                {line}
              </div>
            ))}
          </li>
        );
      })}
    </ol>
  );
}

function AddMenu({
  label,
  items,
  onPick,
}: {
  label: string;
  items: { id: string; name: string }[];
  onPick(id: string, name: string): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label}>
          <PlusIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {items.map((item) => (
          <DropdownMenuItem key={item.id} onSelect={() => onPick(item.id, item.name)}>
            {item.name}
          </DropdownMenuItem>
        ))}
        {items.length === 0 && <DropdownMenuItem disabled>Nothing else to add</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A connection it has: its slot, where it is, and what it offers. */
function McpRow({
  mcp,
  agentName,
  unit,
  onRemove,
}: {
  mcp: Mcp;
  agentName: string;
  /** The unit that made it for this agent, if one did. */
  unit?: string | undefined;
  onRemove(): void;
}) {
  const { origin, status } = mcp;
  return (
    <Collapsible className="group/mcp border-t first:border-t-0">
      <div className="grid min-h-11 grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_24px] items-center gap-x-3 text-sm">
        <span className="flex min-w-0 items-center gap-2 font-medium">
          <span className="truncate">{mcp.slot}</span>
          {status.state === "down" && <TroubleDot />}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
          {origin && <WhereIcon kind={origin.kind} />}
          <span className="truncate font-mono text-xs">{unit ?? origin?.target}</span>
        </span>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`${mcp.slot} tools`}>
            <ChevronRightIcon className="transition-transform group-data-[state=open]/mcp:rotate-90 motion-reduce:transition-none" />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="flex flex-wrap items-center gap-1.5 pb-3">
          {status.tools.map((tool) => (
            <code
              key={tool.name}
              className="rounded-md bg-[var(--raised)] px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
            >
              {tool.name}
            </code>
          ))}
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto text-muted-foreground"
            onClick={onRemove}
          >
            Remove from {agentName}
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The agent's model, as its provider says it: there only while the agent runs. */
function ModelPicker({ agent }: { agent?: string }) {
  const [changed, setChanged] = useState(0);
  const act = useAct();
  const models = useLoad(
    () =>
      agent
        ? api.call<{ models: { id: string; name: string }[]; current?: string }>(
            "agents",
            "models",
            { agent },
          )
        : Promise.resolve(undefined),
    [],
    [agent, changed],
  ).value;
  return (
    <>
      <Select
        disabled={!models || act.busy}
        value={models ? (models.current ?? DEFAULT) : DEFAULT}
        onValueChange={(model) =>
          act.run(
            () =>
              api.call("agents", "setModel", { agent, ...(model === DEFAULT ? {} : { model }) }),
            () => setChanged((was) => was + 1),
          )
        }
      >
        <SelectTrigger aria-label="Model" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT}>Default</SelectItem>
          {models?.models.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              {model.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {act.failed && (
        <p role="alert" className="mt-1 text-[13px] text-[var(--bad)]">
          {act.failed}
        </p>
      )}
    </>
  );
}
