import { ChevronLeftIcon, ChevronRightIcon, SparklesIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, go, useLoad } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { Item } from "../ui/item.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import {
  type ConnectionEntry,
  type Creatable,
  listAgents,
  listConnections,
  useAct,
} from "./data.ts";
import { Jump, Nothing, WhereIcon } from "./parts.tsx";

/** Create: a choice among what can be created, then only what that choice asks. */
export function CreateDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [choice, setChoice] = useState<Creatable>();
  useEffect(() => {
    if (open) setChoice(undefined);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="window flex h-[min(560px,88vh)] flex-col ring-0 sm:max-w-lg">
        {choice ? (
          <Details
            key={`${choice.provider}/${choice.id}`}
            choice={choice}
            onBack={() => setChoice(undefined)}
            onCreated={(agent) => {
              onClose();
              go({ screen: "agent", agent });
            }}
          />
        ) : (
          <Choose onPick={setChoice} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Choose({ onPick }: { onPick(choice: Creatable): void }) {
  const list = useLoad(
    () => api.call<{ creatables: Creatable[] }>("agents", "creatable").then((r) => r.creatables),
    ["actors"],
  );
  const creatables = list.value ?? [];
  return (
    <>
      <DialogHeader>
        <DialogTitle>Create</DialogTitle>
      </DialogHeader>
      <ul className="no-bar -mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto">
        {creatables.map((creatable) => (
          <li key={`${creatable.provider}/${creatable.id}`}>
            <Item asChild className="flex-nowrap gap-3 rounded-xl hover:bg-[var(--hover)]">
              <button type="button" onClick={() => onPick(creatable)}>
                <span className="flex min-w-0 flex-1 flex-col text-left">
                  <span className="font-medium">{creatable.title}</span>
                  <span className="truncate text-[13px] text-muted-foreground">
                    {creatable.description}
                  </span>
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </Item>
          </li>
        ))}
        {list.loaded && creatables.length === 0 && (
          <li>
            <Nothing>
              {list.error ? "This can't be read right now." : "Nothing to create yet."}
            </Nothing>
          </li>
        )}
      </ul>
    </>
  );
}

/** Connections the person made can be picked; one made for another agent goes with that agent. */
const pickable = (all: readonly ConnectionEntry[]) => all.filter((c) => !c.origin?.madeFor);

function Details({
  choice,
  onBack,
  onCreated,
}: {
  choice: Creatable;
  onBack(): void;
  onCreated(agent: string): void;
}) {
  const taken = useLoad(listAgents, ["actors"]).value;
  const connections = pickable(useLoad(listConnections, ["actors"]).value ?? []);
  const [typed, setTyped] = useState<string>();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [picks, setPicks] = useState<Record<string, string>>({});
  const act = useAct();

  let suggested = choice.title;
  const names = new Set(taken?.map((a) => a.name));
  for (let n = 2; names.has(suggested); n++) suggested = `${choice.title} ${n}`;
  const name = typed ?? suggested;

  const needs = choice.mcp.flatMap((need) => (need.how === "pick" ? [need] : []));
  const picked = (slot: string) => picks[slot] ?? connections[0]?.connection;
  const answered = choice.asks.every((ask) => ask.optional || answers[ask.id]?.trim());
  const ready = name.trim() && answered && needs.every((need) => picked(need.slot));

  const submit = () => {
    if (!ready) return;
    const given = Object.fromEntries(Object.entries(answers).filter(([, value]) => value.trim()));
    act.run(() =>
      api
        .call<{ agent: string }>("agents", "create", {
          provider: choice.provider,
          creatable: choice.id,
          name: name.trim(),
          answers: given,
          ...(needs.length > 0
            ? {
                connections: Object.fromEntries(
                  needs.map((need) => [need.slot, picked(need.slot)]),
                ),
              }
            : {}),
        })
        .then(({ agent }) => onCreated(agent)),
    );
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogHeader className="flex-row items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="-ml-1.5"
          aria-label="Back"
          onClick={onBack}
        >
          <ChevronLeftIcon />
        </Button>
        <DialogTitle>{choice.title}</DialogTitle>
      </DialogHeader>
      <div className="no-bar min-h-0 flex-1 overflow-y-auto">
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="create-name">Name</FieldLabel>
            <Input id="create-name" value={name} onChange={(e) => setTyped(e.target.value)} />
          </Field>
          {choice.asks.map((ask) => (
            <Field key={ask.id}>
              <FieldLabel htmlFor={`create-${ask.id}`}>{ask.title}</FieldLabel>
              <Input
                id={`create-${ask.id}`}
                required={!ask.optional}
                value={answers[ask.id] ?? ""}
                onChange={(e) => setAnswers({ ...answers, [ask.id]: e.target.value })}
              />
              {ask.description && <FieldDescription>{ask.description}</FieldDescription>}
            </Field>
          ))}
          {needs.map((need) => (
            <Field key={need.slot}>
              <FieldLabel>{need.title}</FieldLabel>
              {connections.length > 0 ? (
                <Select
                  value={picked(need.slot) ?? ""}
                  onValueChange={(id) => setPicks({ ...picks, [need.slot]: id })}
                >
                  <SelectTrigger aria-label={need.title} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {connections.map((c) => (
                      <SelectItem key={c.connection} value={c.connection}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <FieldDescription>
                  <Jump to={{ screen: "mcps", adding: true }}>Connect an MCP first</Jump>
                </FieldDescription>
              )}
            </Field>
          ))}
        </FieldGroup>

        {(choice.skills.length > 0 || choice.mcp.length > 0) && (
          <div className="mt-5 flex flex-col gap-2 border-t pt-4 text-[13px]">
            {choice.skills.length > 0 && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <SparklesIcon className="size-3.5 shrink-0" />
                <span className="truncate">{choice.skills.map((s) => s.name).join(", ")}</span>
              </div>
            )}
            {choice.mcp.map((need) => (
              <div key={need.slot} className="flex items-center gap-2">
                {need.how === "create" && <WhereIcon kind={need.kind} />}
                <span>{need.slot}</span>
                <span className="ml-auto truncate text-muted-foreground">
                  {need.how === "create" ? "Created for this agent" : "Connected by you"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <DialogFooter className="items-center">
        {act.failed && (
          <p role="alert" className="mr-auto min-w-0 text-[13px] text-[var(--bad)]">
            {act.failed}
          </p>
        )}
        <Button type="submit" disabled={!ready || act.busy}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
