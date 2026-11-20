// The search, from the bar or ⌘K: your conversations, found by their agent's name or their last
// words, then agents, found by name, from what the page already has. With nothing typed, the
// conversations, newest first. It reads no conversation's other messages.
import { go } from "../data.ts";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command.tsx";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog.tsx";
import { useAllChats } from "./all-chats.tsx";
import { Face } from "./face.tsx";
import { useAgents } from "./watch.tsx";

const ROW = "gap-3 rounded-xl px-2.5 py-2";

export function Search({
  open,
  onOpenChange,
  query,
  onQuery,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  query: string;
  onQuery(query: string): void;
}) {
  const { chats } = useAllChats();
  const agents = useAgents();
  const wanted = query.trim().toLowerCase();
  const holds = (words: string) => words.toLowerCase().includes(wanted);
  // Plain words, not the library's fuzzy match: a name or the last words that hold what is typed.
  const found = chats.filter((chat) => !wanted || holds(chat.agent.name) || holds(chat.words));
  const team = wanted ? agents.list.filter((entry) => holds(entry.name)) : [];
  const toneOf = (id: string) => agents.byId.get(id)?.now.tone ?? "idle";
  const pick = (to: Parameters<typeof go>[0]) => {
    onOpenChange(false);
    go(to);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="overflow-hidden p-0 sm:max-w-md"
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <Command
          shouldFilter={false}
          className="**:data-[slot=command-input-wrapper]:h-12 **:data-[slot=command-input-wrapper]:px-3.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:text-[13px]"
        >
          <CommandInput
            placeholder="Search"
            value={query}
            onValueChange={onQuery}
            className="border-0 text-[15px]"
          />
          <CommandList className="max-h-[360px] p-1.5">
            <CommandEmpty>No results</CommandEmpty>
            {found.length > 0 && (
              <CommandGroup heading="Chats">
                {found.map((chat) => (
                  <CommandItem
                    key={chat.agent.id}
                    value={`chat ${chat.agent.id}`}
                    className={ROW}
                    onSelect={() => pick({ screen: "chat", agent: chat.agent.id })}
                  >
                    <Face agent={chat.agent} size={32} plain />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px]">{chat.agent.name}</span>
                      <span className="block truncate text-[13px] text-muted-foreground">
                        {chat.words}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {team.length > 0 && (
              <CommandGroup heading="Team">
                {team.map((entry) => (
                  <CommandItem
                    key={entry.agent}
                    value={`agent ${entry.agent}`}
                    className={ROW}
                    onSelect={() => pick({ screen: "team", agent: entry.agent })}
                  >
                    <Face
                      agent={{ id: entry.agent, name: entry.name, tone: toneOf(entry.agent) }}
                      size={32}
                      plain
                    />
                    <span className="min-w-0 flex-1 truncate text-[15px]">{entry.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
