// The jump palette: views, agents and open asks in one filtered list, each told apart by its mark.

import { ActivityIcon, MessageCircleQuestionIcon, UserRoundIcon } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { PaletteModel } from "../control/palette.tsx";
import { StateMark, StateName } from "./marks.tsx";
import { Route } from "./thread.tsx";

const VIEWS = [
  { to: "/", name: "You", Icon: UserRoundIcon },
  { to: "/activity", name: "Activity", Icon: ActivityIcon },
] as const;

export function PaletteView(model: PaletteModel) {
  return (
    <CommandDialog
      open={model.open}
      onOpenChange={model.onOpenChange}
      title="Jump to"
      description="An agent, an open ask or a view"
      className="sm:max-w-xl"
    >
      <Command>
        <CommandInput placeholder="Jump to…" />
        <CommandList>
          <CommandEmpty>No match</CommandEmpty>
          <CommandGroup>
            {VIEWS.map(({ to, name, Icon }) => (
              <CommandItem key={to} value={name} onSelect={() => model.onView(to)}>
                <Icon aria-hidden="true" />
                {name}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup>
            {model.agents.map((agent) => (
              <CommandItem
                key={agent.id}
                value={`${agent.title} ${agent.id}`}
                onSelect={() => model.onAgent(agent)}
              >
                <StateMark agent={agent} />
                <span className="truncate">{agent.title}</span>
                <StateName agent={agent} />
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup>
            {model.asks.map((ask) => (
              <CommandItem
                key={ask.id}
                value={`${ask.title} ${ask.id}`}
                onSelect={() => model.onAsk(ask)}
              >
                <MessageCircleQuestionIcon aria-hidden="true" className="text-state-waiting" />
                <span className="min-w-0 flex-1 truncate">{ask.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  <Route ask={ask} agents={model.byId} />
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
