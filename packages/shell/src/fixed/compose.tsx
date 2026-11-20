// Who to message, from Chat's head: a "To" field over the person's agents, as a messenger's new
// message, in the library's Command. A pick opens that agent's conversation on Chat, or its empty
// one if none has begun, which its first message makes.
import { Command as CommandPrimitive } from "cmdk";
import { go } from "../data.ts";
import { Command, CommandItem, CommandList } from "../ui/command.tsx";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog.tsx";
import { Face } from "./face.tsx";
import { useAgents } from "./watch.tsx";

/** The agents whose names hold what is typed: plain words, not the library's fuzzy match. */
const holds = (_value: string, search: string, keywords?: string[]) =>
  (keywords ?? []).join(" ").toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0;

export function Compose({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const agents = useAgents();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="overflow-hidden p-0 sm:max-w-md"
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Message</DialogTitle>
        <Command filter={holds}>
          {/* The library's input, with "To" where its search mark would be. */}
          <div
            data-slot="command-input-wrapper"
            className="flex h-12 items-center gap-2 border-b px-3.5"
          >
            <span className="text-[15px] text-muted-foreground">To</span>
            <CommandPrimitive.Input
              placeholder="Name"
              className="h-full w-full border-0 bg-transparent text-[15px] outline-hidden placeholder:text-muted-foreground"
            />
          </div>
          {/* All the agents, in Team's order, each its face and its name. */}
          <CommandList className="max-h-[360px] p-1.5">
            {agents.list.map((entry) => (
              <CommandItem
                key={entry.agent}
                value={entry.agent}
                keywords={[entry.name]}
                className="gap-3 rounded-xl px-2.5 py-2"
                onSelect={() => {
                  onOpenChange(false);
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
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
