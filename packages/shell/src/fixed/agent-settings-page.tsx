import { ChevronRightIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { api, go, type Route, useLoad } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import {
  type AgentDetail,
  ago,
  type ChatMessage,
  getAgent,
  lineOf,
  listConnections,
  listMcpProviders,
  listSkills,
  type Mcp,
  type McpProvider,
  REFRESH_MS,
  slotFor,
  useAct,
  useChatRecord,
  useChatSlots,
  useEvery,
} from "./data.ts";
import { Jump, Nothing, Scroll, Section, StateDot, WhereIcon } from "./parts.tsx";

/** How many of the latest messages the page shows as its activity. */
const ACTIVITY = 20;
/** The picker's value for no model chosen: the provider's default. */
const DEFAULT = "default";

/** What one agent is made of: reached from its page. */
export function AgentSettingsPage({ agent: id }: { agent: string }) {
  const tick = useEvery(REFRESH_MS);
  const [changed, setChanged] = useState(0);
  const refresh = () => setChanged((was) => was + 1);
  const detail = useLoad(() => getAgent(id), ["actors", "bindings"], [id, tick, changed]);
  const skills = useLoad(listSkills, [], [changed]).value;
  const connections = useLoad(listConnections, ["actors", "bindings"], [changed]).value;
  const providers = useLoad(listMcpProviders, ["actors"]).value;
  const agentProviders = useLoad(
    () =>
      api
        .call<{ providers: { provider: string; name: string }[] }>("agents", "providers")
        .then((reply) => reply.providers),
    ["actors"],
  ).value;
  const slot = useChatSlots().get(id);
  const agent = detail.value;
  const running = agent?.status.state === "running";
  const record = useChatRecord(slot, running, ACTIVITY);
  const act = useAct();

  if (!agent)
    return (
      <Scroll>{detail.loaded && <Nothing>This agent can't be read right now.</Nothing>}</Scroll>
    );

  const change = (method: string, input: Record<string, unknown>) =>
    act.run(() => api.call("agents", method, { agent: id, ...input }), refresh);
  const exposed = new Set(agent.mcp.map((m) => m.connection));
  const offered = (connections ?? []).filter(
    (c) => !c.origin?.madeFor && !exposed.has(c.connection),
  );
  const has = new Set(agent.skills.map((s) => s.name));
  const spare = (skills ?? []).filter((s) => !has.has(s.name));

  return (
    <Scroll>
      <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)_260px] gap-x-10 gap-y-6 tight:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-7">
          {act.failed && (
            <p role="alert" className="text-[13px] text-[var(--bad)]">
              {act.failed}
            </p>
          )}
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
                more={{ label: "Connect a new MCP…", to: { screen: "mcps", adding: true } }}
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
                providers={providers ?? []}
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
                more={{ label: "Add a new skill…", to: { screen: "skills", adding: true } }}
              />
            }
          >
            {agent.skills.map((skill) => (
              <div
                key={skill.name}
                className="group/skill flex h-11 items-center gap-3 border-t first:border-t-0"
              >
                <span className="shrink-0 font-medium">
                  <Jump to={{ screen: "skills", focus: skill.name }}>
                    <span className="text-[14px] font-medium">{skill.name}</span>
                  </Jump>
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground tight:hidden">
                  {skill.description}
                </span>
                <span className="shrink-0 text-[13px] text-muted-foreground">
                  {givenBy(agent.units, skill)}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${skill.name}`}
                  className="ml-auto opacity-0 group-hover/skill:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                  onClick={() => change("unexpose", { skill: skill.name })}
                >
                  <XIcon />
                </Button>
              </div>
            ))}
            {agent.skills.length === 0 && <Nothing>No skills</Nothing>}
          </Section>
        </div>

        <aside className="flex min-w-0 flex-col gap-7">
          <Section title="Model">
            <ModelPicker slot={running ? slot : undefined} />
            <p className="mt-1.5 truncate text-[13px] text-muted-foreground">
              {agent.creatable} from{" "}
              <Jump to={{ screen: "settings", tab: "providers" }}>
                {agentProviders?.find((p) => p.provider === agent.provider)?.name ?? agent.provider}
              </Jump>
            </p>
          </Section>
          <Section title="Activity">
            <Activity messages={record.messages} />
          </Section>
        </aside>
      </div>
    </Scroll>
  );
}

function AddMenu({
  label,
  items,
  onPick,
  more,
}: {
  label: string;
  items: { id: string; name: string }[];
  onPick(id: string, name: string): void;
  more: { label: string; to: Route };
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
        {items.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => go(more.to)}>{more.label}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The unit that came with a skill; none for a unit that only exposes the skill it was told to. */
function givenBy(units: AgentDetail["units"], skill: AgentDetail["skills"][number]) {
  const unit = units.find((u) => u.instance === skill.instance);
  return unit && !Object.values(unit.values).includes(skill.name) ? unit.title : undefined;
}

/** Where a connection is, how it got there, and what it offers. */
function McpRow({
  mcp,
  agentName,
  unit,
  providers,
  onRemove,
}: {
  mcp: Mcp;
  agentName: string;
  unit?: string;
  providers: McpProvider[];
  onRemove(): void;
}) {
  const { origin, status } = mcp;
  const provider = providers.find((p) => p.provider === origin?.provider)?.name;
  return (
    <Collapsible className="group/mcp border-t first:border-t-0">
      <div className="grid min-h-11 grid-cols-[minmax(0,0.6fr)_minmax(0,1.3fr)_minmax(0,1.2fr)_24px] items-center gap-x-3 tight:grid-cols-[minmax(0,1fr)_24px] tight:py-2">
        <span className="flex min-w-0 items-center gap-2 font-medium">
          <span className="truncate">{mcp.slot}</span>
          {status.state === "down" && <StateDot tone="trouble" />}
          {status.state === "connecting" && <StateDot tone="starting" />}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground tight:col-span-2 tight:row-start-2">
          {origin && <WhereIcon kind={origin.kind} />}
          <span className="truncate font-mono text-xs">{origin?.target}</span>
        </span>
        <span className="min-w-0 truncate text-[13px] text-muted-foreground tight:col-span-2 tight:row-start-3">
          {origin && (
            <Jump to={{ screen: "mcps", focus: mcp.connection }}>
              {unit ??
                (origin.madeFor
                  ? `Created for this agent${provider ? ` by ${provider}` : ""}`
                  : "Connected by you")}
            </Jump>
          )}
        </span>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${mcp.slot} tools`}
            className="tight:col-start-2 tight:row-start-1"
          >
            <ChevronRightIcon className="transition-transform group-data-[state=open]/mcp:rotate-90 motion-reduce:transition-none" />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="flex flex-wrap items-center gap-1.5 pb-3">
          {status.detail && (
            <span className="basis-full text-[13px] text-[var(--bad)]">{status.detail}</span>
          )}
          {status.tools.map((tool) => (
            <code
              key={tool.name}
              title={tool.description}
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

/** The model, read and set through the agent's chat, so it's there only while the agent runs. */
function ModelPicker({ slot }: { slot?: string }) {
  const [changed, setChanged] = useState(0);
  const act = useAct();
  const models = useLoad(
    () =>
      slot
        ? api.call<{ models: { id: string; name: string }[]; current?: string }>(slot, "models")
        : Promise.resolve(undefined),
    [],
    [slot, changed],
  ).value;
  return (
    <>
      <Select
        disabled={!models || act.busy}
        value={models ? (models.current ?? DEFAULT) : DEFAULT}
        onValueChange={(model) =>
          act.run(
            () => api.call(slot as string, "setModel", model === DEFAULT ? {} : { model }),
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

/** The latest of the record, newest first, each with when and through which MCP. */
function Activity({ messages }: { messages: readonly ChatMessage[] }) {
  useEvery(30_000);
  if (messages.length === 0) return <Nothing>Nothing yet</Nothing>;
  return (
    <ol className="mt-1 flex flex-col gap-3">
      {[...messages].reverse().map((message) => {
        const via = message.tool?.name.split("__")[0];
        return (
          <li key={message.id} className="text-[13px]">
            <div className="min-w-0 truncate">{lineOf(message)}</div>
            <div className="text-xs text-muted-foreground">
              {ago(message.at)}
              {via && message.tool?.name.includes("__") && ` · ${via}`}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
