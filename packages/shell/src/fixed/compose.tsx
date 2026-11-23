// Who to message, from Chat's head: a "To" field over the person's agents, as a messenger's new
// message, in the library's Command. A pick opens that agent's conversation on Chat, or its empty
// one if none has begun, which its first message makes. Under the agents, whatever is typed, is
// the way to make one.
import { Command as CommandPrimitive } from "cmdk";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { go } from "../data.ts";
import { Command, CommandGroup, CommandItem, CommandList } from "../ui/command.tsx";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog.tsx";
import { useBuilding } from "./building.tsx";
import { Face } from "./face.tsx";
import { useAgents } from "./watch.tsx";

export function Compose({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="overflow-hidden p-0 sm:max-w-md"
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Message</DialogTitle>
        <To onPicked={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The field and its lines, begun anew each time the picker opens. The lines are kept in their
 * order here, not by the library: the agents whose names hold what is typed, as plain words, in
 * Team's order, and last the way to a new one.
 */
function To({ onPicked }: { onPicked(): void }) {
  const agents = useAgents();
  const building = useBuilding();
  const [typed, setTyped] = useState("");
  const wanted = typed.trim().toLowerCase();
  const found = agents.list.filter((entry) => entry.name.toLowerCase().includes(wanted));
  return (
    <Command shouldFilter={false}>
      {/* The library's input, with "To" where its search mark would be. */}
      <div
        data-slot="command-input-wrapper"
        className="flex h-12 items-center gap-2 border-b px-3.5"
      >
        <span className="text-[15px] text-muted-foreground">To</span>
        <CommandPrimitive.Input
          value={typed}
          onValueChange={setTyped}
          placeholder="Name"
          className="h-full w-full border-0 bg-transparent text-[15px] outline-hidden placeholder:text-muted-foreground"
        />
      </div>
      <CommandList className="max-h-[360px] p-1.5">
        {/* Each agent, its face and its name. */}
        {found.map((entry) => (
          <CommandItem
            key={entry.agent}
            value={entry.agent}
            className="gap-3 rounded-xl px-2.5 py-2"
            onSelect={() => {
              onPicked();
              go({ screen: "chat", agent: entry.agent });
            }}
          >
            <Face
              agent={{
                id: entry.agent,
                name: entry.name,
                tone: agents.byId.get(entry.agent)?.now.tone ?? "idle",
              }}
              size={32}
              plain
            />
            <span className="min-w-0 flex-1 truncate text-[15px]">{entry.name}</span>
          </CommandItem>
        ))}
        {/* Under a line: not one of the agents, the way to a new one. It opens the creation
            window, as Team's plus does. */}
        <CommandGroup className="mt-1.5 border-t p-0 pt-1.5">
          <CommandItem
            value="new-agent"
            className="gap-3 rounded-xl px-2.5 py-2"
            onSelect={() => {
              onPicked();
              building.show();
            }}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-[25%] bg-[var(--raised)] text-muted-foreground">
              <PlusIcon className="size-4" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[15px]">New agent</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
