// What an agent is made of, and the way to delete it: a sheet from the side of its page.
import { ChevronRightIcon, CpuIcon, MoreHorizontalIcon, PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { api, go, useLoad } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { UnitForm } from "./build.tsx";
import { useBuilding } from "./building.tsx";
import { shortUrl } from "./calls.ts";
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
import {
  answersOf,
  type CatalogUnit,
  isComplete,
  type Secrets,
  unitInput,
  type Values,
} from "./stack.ts";
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
  /** The unit being added, or changed with what it was built from. */
  const [editing, setEditing] = useState<{
    unit: CatalogUnit;
    values: Values;
    applied?: Applied;
  }>();
  if (!agent) return <div className="flex-1" />;

  const change = (method: string, input: Record<string, unknown>) =>
    act.run(
      () => api.call("agents", method, { agent: id, ...input }),
      () => setChanged((was) => was + 1),
    );
  // A unit changed is taken out and put back as answered now. Refused, what it was built from
  // goes back, all but its secrets, and the page says why.
  const rebuild = (applied: Applied, unit: CatalogUnit, values: Values, secrets: Secrets) =>
    act.run(async () => {
      try {
        await api.call("agents", "removeUnit", { agent: id, instance: applied.instance });
        try {
          await api.call("agents", "addUnit", {
            agent: id,
            unit: unitInput(unit, values, secrets),
          });
        } catch (refused) {
          await api
            .call("agents", "addUnit", { agent: id, unit: unitInput(unit, applied.values) })
            .catch(() => {});
          throw refused;
        }
      } finally {
        setChanged((was) => was + 1);
      }
    });
  const exposed = new Set(agent.mcp.map((m) => m.connection));
  const offered = (connections ?? []).filter(
    (c) => !c.origin?.madeFor && !exposed.has(c.connection),
  );
  const has = new Set(agent.skills.map((s) => s.name));
  const spare = (skills ?? []).filter((s) => !has.has(s.name));
  const template = catalog.templates.find((t) => t.id === entry.template)?.title;
  // What can be added: any unit, but one an agent holds at most once only while it has none.
  const addable = catalog.units.filter(
    (unit) =>
      !unit.once || !agent.units.some((a) => a.provider === unit.provider && a.unit === unit.id),
  );
  return (
    <div className="no-bar flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-5 pb-5">
      {act.failed && (
        <p role="alert" className="text-[13px] text-[var(--bad)]">
          {act.failed}
        </p>
      )}
      <Section
        title={template ? `Built from ${template}` : "Built from"}
        action={
          <AddMenu
            label="Add a unit"
            items={addable.map((unit) => ({ id: keyOf(unit), name: unit.title }))}
            onPick={(key) => {
              const unit = addable.find((one) => keyOf(one) === key);
              if (unit) setEditing({ unit, values: {} });
            }}
          />
        }
      >
        <BuiltFrom
          units={agent.units}
          nameOf={(id) => connections?.find((c) => c.connection === id)?.name}
          onChange={(applied, unit) => setEditing({ unit, values: applied.values, applied })}
          onRemove={(applied) => change("removeUnit", { instance: applied.instance })}
        />
      </Section>
      {editing && (
        <UnitDialog
          key={editing.applied?.instance ?? keyOf(editing.unit)}
          agentName={agent.name}
          unit={editing.unit}
          values={editing.values}
          onClose={() => setEditing(undefined)}
          onSave={(values, secrets) => {
            const { applied, unit } = editing;
            setEditing(undefined);
            if (applied) rebuild(applied, unit, values, secrets);
            else change("addUnit", { unit: unitInput(unit, values, secrets) });
          }}
        />
      )}
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
            more={{ words: "Connect a new MCP…", screen: "mcps" }}
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
            more={{ words: "Add a new skill…", screen: "skills" }}
          />
        }
      >
        {agent.skills.map((skill) => (
          <div
            key={skill.name}
            className="group/row flex h-10 items-center gap-3 border-t text-sm first:border-t-0"
          >
            <span className="shrink-0 font-medium">{skill.name}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
              {skill.description}
            </span>
            {/* One a unit gave goes with that unit; one given to it apart from its units is taken
                off here, shown when the row is pointed at as Delete is on Settings' rows. */}
            {!skill.instance && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${skill.name} from ${agent.name}`}
                className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                onClick={() => change("unexpose", { skill: skill.name })}
              >
                <XIcon />
              </Button>
            )}
          </div>
        ))}
        {agent.skills.length === 0 && <Nothing>No skills</Nothing>}
      </Section>
    </div>
  );
}

type Applied = AgentDetail["units"][number];
const keyOf = (unit: CatalogUnit) => `${unit.provider} ${unit.id}`;

/**
 * The stack it came from, as it was filled in: each unit with its questions and their answers,
 * and its "…" to change or remove it. One whose provider isn't offering it now can only be removed.
 */
function BuiltFrom({
  units,
  nameOf,
  onChange,
  onRemove,
}: {
  units: Applied[];
  nameOf(connection: string): string | undefined;
  onChange(applied: Applied, unit: CatalogUnit): void;
  onRemove(applied: Applied): void;
}) {
  const { catalog } = useBuilding();
  if (units.length === 0) return <Nothing>Just the base</Nothing>;
  return (
    <ol className="flex flex-col gap-1.5">
      {units.map((applied) => {
        const unit = catalog.units.find(
          (u) => u.provider === applied.provider && u.id === applied.unit,
        );
        return (
          <li key={applied.instance} className="rounded-xl bg-card px-3 py-2.5 text-sm">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 font-medium">{applied.title}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label={`${applied.title} options`}>
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/* The dialog opens once the menu has closed, so the keyboard goes to it. */}
                  <DropdownMenuItem
                    disabled={!unit}
                    onSelect={() => unit && setTimeout(() => onChange(applied, unit), 0)}
                  >
                    Change…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onRemove(applied)}>Remove</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {answersOf(applied.values, unit?.form ?? [], nameOf).map((line) => (
              <div key={line.id} className="flex min-w-0 gap-1.5 text-[13px]">
                <span className="shrink-0 text-muted-foreground">{line.question}</span>
                <span className={`truncate ${line.path ? "font-mono text-xs leading-5" : ""}`}>
                  {line.answer}
                </span>
              </div>
            ))}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One unit's form in a window of its own, as Create draws it: empty to add one, or with what a
 * unit was built from to change it. A secret is asked again, as it is never read back.
 */
function UnitDialog({
  agentName,
  unit,
  values: given,
  onClose,
  onSave,
}: {
  agentName: string;
  unit: CatalogUnit;
  values: Values;
  onClose(): void;
  onSave(values: Values, secrets: Secrets): void;
}) {
  const [values, setValues] = useState<Values>(given);
  const [secrets, setSecrets] = useState<Secrets>({});
  const title = `${agentName}'s ${unit.title.toLowerCase()}`;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="window ring-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">What {title} is</DialogDescription>
        </DialogHeader>
        <div className="no-bar flex max-h-[60vh] flex-col overflow-y-auto rounded-xl bg-card">
          <div className="flex h-10 shrink-0 items-center gap-1.5 px-3">
            <CpuIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{unit.title}</span>
          </div>
          <div className="flex flex-col gap-3 px-3 pb-3">
            <UnitForm
              unit={unit}
              id="setup-unit"
              agentName={agentName}
              values={values}
              secrets={secrets}
              onValue={(field, value) => setValues((was) => ({ ...was, [field]: value }))}
              onSecret={(field, value) => setSecrets((was) => ({ ...was, [field]: value }))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!isComplete(unit, values, secrets)}
            onClick={() => onSave(values, secrets)}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What can be added and, where there is one, last the way to one that isn't made yet: it is made
 * in Settings.
 */
function AddMenu({
  label,
  items,
  onPick,
  more,
}: {
  label: string;
  items: { id: string; name: string }[];
  onPick(id: string, name: string): void;
  more?: { words: string; screen: "mcps" | "skills" };
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
        {more && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => go({ screen: more.screen })}>
              {more.words}
            </DropdownMenuItem>
          </>
        )}
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
          {/* An address is said without its scheme. */}
          <span className="truncate font-mono text-xs">
            {unit ?? (origin?.kind === "url" ? shortUrl(origin.target) : origin?.target)}
          </span>
        </span>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`${mcp.slot} tools`}>
            <ChevronRightIcon className="transition-transform group-data-[state=open]/mcp:rotate-90 motion-reduce:transition-none" />
          </Button>
        </CollapsibleTrigger>
      </div>
      {/* Down, it says why under its name. */}
      {status.state === "down" && status.detail && (
        <div className="-mt-1 pb-2.5 text-[13px] text-[var(--bad)]">{`${status.detail.charAt(0).toUpperCase()}${status.detail.slice(1)}`}</div>
      )}
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
